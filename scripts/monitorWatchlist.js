#!/usr/bin/env node

/**
 * Pair Trading Bot - Automated monitoring and trading
 * 
 * Hourly: Check watchlist for entries, check active trades for exits
 * Sends a single status report to Telegram after each run.
 * 
 * Usage: 
 *   node scripts/monitorWatchlist.js              # Auto-trade mode
 *   node scripts/monitorWatchlist.js --manual     # Alert-only mode
 *   node scripts/monitorWatchlist.js --dry-run    # Test mode
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../lib/pairAnalysis');

require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_CONCURRENT_TRADES = parseInt(process.env.MAX_CONCURRENT_TRADES) || 5;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MANUAL_MODE = args.includes('--manual');

// Thresholds
const ENTRY_THRESHOLD = 1.5;
const EXIT_THRESHOLD = 0.5;
const STOP_LOSS_THRESHOLD = 3.0;  // Exit if Z diverges too much
const MIN_CORRELATION_7D = 0.5;   // Looser for 7d
const MIN_CORRELATION_30D = 0.6;
const CORRELATION_BREAKDOWN = 0.4; // Exit if correlation collapses
const HALFLIFE_MULTIPLIER = 2;     // Exit if duration > 2x half-life

/**
 * Helpers
 */
function suppressConsole() {
  const orig = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return orig;
}

function restoreConsole(orig) {
  console.log = orig.log;
  console.error = orig.error;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || DRY_RUN) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    });
    return true;
  } catch (e) {
    console.error('Telegram:', e.response?.data?.description || e.message);
    return false;
  }
}

function loadJSON(filename) {
  const fp = path.join(__dirname, '../config', filename);
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
}

function saveJSON(filename, data) {
  fs.writeFileSync(path.join(__dirname, '../config', filename), JSON.stringify(data, null, 2));
}

/**
 * Fetch prices (7d and 30d)
 */
async function fetchPrices(sdk, sym1, sym2) {
  const endTime = Date.now();
  const startTime = endTime - (35 * 24 * 60 * 60 * 1000);
  
  try {
    const [d1, d2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
    ]);
    
    if (!d1?.length || !d2?.length) return null;
    
    const m1 = new Map(), m2 = new Map();
    d1.forEach(c => m1.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
    d2.forEach(c => m2.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
    
    const dates = [...m1.keys()].filter(d => m2.has(d)).sort();
    if (dates.length < 10) return null;
    
    return {
      prices1_30d: dates.slice(-30).map(d => m1.get(d)),
      prices2_30d: dates.slice(-30).map(d => m2.get(d)),
      prices1_7d: dates.slice(-7).map(d => m1.get(d)),
      prices2_7d: dates.slice(-7).map(d => m2.get(d)),
      currentPrice1: m1.get(dates[dates.length - 1]),
      currentPrice2: m2.get(dates[dates.length - 1])
    };
  } catch (e) {
    return null;
  }
}

/**
 * Validate entry signal on multiple timeframes
 */
function validateEntry(prices) {
  const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
  
  let fit7d = null;
  try {
    if (prices.prices1_7d.length >= 7 && prices.prices2_7d.length >= 7) {
      fit7d = checkPairFitness(prices.prices1_7d, prices.prices2_7d);
    }
  } catch (e) {
    // 7d validation is optional
  }
  
  // Both timeframes must show signal in same direction
  const signal30d = Math.abs(fit30d.zScore) >= ENTRY_THRESHOLD;
  const signal7d = fit7d && Math.abs(fit7d.zScore) >= ENTRY_THRESHOLD * 0.8; // Slightly looser
  const sameDirection = fit7d && (fit30d.zScore * fit7d.zScore > 0);
  
  // Validation checks
  const valid = signal30d && 
                fit30d.correlation >= MIN_CORRELATION_30D &&
                fit30d.isCointegrated &&
                fit30d.halfLife <= 30 &&
                (!fit7d || (signal7d && sameDirection)); // 7d confirms if available
  
  return {
    valid,
    fit30d,
    fit7d,
    reason: !signal30d ? 'no_signal' :
            fit30d.correlation < MIN_CORRELATION_30D ? 'low_corr' :
            !fit30d.isCointegrated ? 'not_coint' :
            fit30d.halfLife > 30 ? 'slow_reversion' :
            (fit7d && !sameDirection) ? 'conflicting_tf' : 'ok'
  };
}

/**
 * Enter trade
 */
function enterTrade(pair, fitness, prices, activeTrades) {
  const absBeta = Math.abs(fitness.beta);
  const w1 = 1 / (1 + absBeta), w2 = absBeta / (1 + absBeta);
  const dir = fitness.zScore < 0 ? 'long' : 'short';
  
  const trade = {
    pair: pair.pair,
    asset1: pair.asset1,
    asset2: pair.asset2,
    sector: pair.sector,
    entryTime: new Date().toISOString(),
    entryZScore: fitness.zScore,
    entryPrice1: prices.currentPrice1,
    entryPrice2: prices.currentPrice2,
    correlation: fitness.correlation,
    beta: fitness.beta,
    halfLife: fitness.halfLife,
    direction: dir,
    longAsset: dir === 'long' ? pair.asset1 : pair.asset2,
    shortAsset: dir === 'long' ? pair.asset2 : pair.asset1,
    longWeight: (dir === 'long' ? w1 : w2) * 100,
    shortWeight: (dir === 'long' ? w2 : w1) * 100,
    longEntryPrice: dir === 'long' ? prices.currentPrice1 : prices.currentPrice2,
    shortEntryPrice: dir === 'long' ? prices.currentPrice2 : prices.currentPrice1
  };
  
  activeTrades.trades.push(trade);
  return trade;
}

/**
 * Exit trade and record to history
 */
function exitTrade(trade, fitness, prices, activeTrades, history) {
  const idx = activeTrades.trades.findIndex(t => t.pair === trade.pair);
  if (idx === -1) return null;
  
  const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
  const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;
  
  const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
  const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
  const totalPnL = longPnL + shortPnL;
  const days = ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);
  
  const record = {
    ...trade,
    exitTime: new Date().toISOString(),
    exitZScore: fitness.zScore,
    totalPnL,
    daysInTrade: parseFloat(days)
  };
  
  history.trades.push(record);
  history.stats.totalTrades++;
  if (totalPnL >= 0) history.stats.wins++; else history.stats.losses++;
  history.stats.totalPnL = (history.stats.totalPnL || 0) + totalPnL;
  history.stats.winRate = ((history.stats.wins / history.stats.totalTrades) * 100).toFixed(1);
  
  activeTrades.trades.splice(idx, 1);
  return { ...record, totalPnL };
}

/**
 * Calculate current P&L for a trade
 */
function calcPnL(trade, prices) {
  const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
  const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;
  const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
  const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
  return longPnL + shortPnL;
}

/**
 * Check all exit conditions for a trade
 * Returns: { shouldExit: boolean, reason: string, emoji: string }
 */
function checkExitConditions(trade, fitness) {
  const currentZ = Math.abs(fitness.zScore);
  const daysInTrade = (Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24);
  const maxDuration = (trade.halfLife || 15) * HALFLIFE_MULTIPLIER;
  
  // 1. PROFIT TARGET - Mean reversion complete
  if (currentZ <= EXIT_THRESHOLD) {
    return { 
      shouldExit: true, 
      reason: 'TARGET', 
      emoji: '🎯',
      message: `Mean reversion complete (Z=${fitness.zScore.toFixed(2)})`
    };
  }
  
  // 2. STOP LOSS - Divergence accelerating
  if (currentZ >= STOP_LOSS_THRESHOLD) {
    return { 
      shouldExit: true, 
      reason: 'STOP_LOSS', 
      emoji: '🛑',
      message: `Stop loss triggered (Z=${fitness.zScore.toFixed(2)} > ${STOP_LOSS_THRESHOLD})`
    };
  }
  
  // 3. TIME STOP - Exceeded 2x expected half-life
  if (daysInTrade > maxDuration) {
    return { 
      shouldExit: true, 
      reason: 'TIME_STOP', 
      emoji: '⏰',
      message: `Time stop (${daysInTrade.toFixed(1)}d > ${maxDuration.toFixed(0)}d max)`
    };
  }
  
  // 4. BREAKDOWN - Correlation collapsed
  if (fitness.correlation < CORRELATION_BREAKDOWN) {
    return { 
      shouldExit: true, 
      reason: 'BREAKDOWN', 
      emoji: '💔',
      message: `Correlation breakdown (${fitness.correlation.toFixed(2)} < ${CORRELATION_BREAKDOWN})`
    };
  }
  
  // No exit condition met
  return { shouldExit: false, reason: null, emoji: null, message: null };
}

/**
 * Format status report for Telegram
 */
function formatStatusReport(activeTrades, entries, exits, history) {
  const time = new Date().toLocaleString('en-US', { 
    timeZone: 'UTC', 
    hour12: false,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  let msg = `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 STATUS • ${time} UTC\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // Actions this run
  if (entries.length > 0 || exits.length > 0) {
    msg += `⚡ ACTIONS\n`;
    entries.forEach(e => {
      const dir = e.direction === 'long' ? `Long ${e.asset1}` : `Short ${e.asset1}`;
      msg += `✅ ${e.pair} → ${dir}\n`;
    });
    exits.forEach(e => {
      const sign = e.totalPnL >= 0 ? '+' : '';
      const emoji = e.exitEmoji || '🔴';
      const reason = e.exitReason || 'EXIT';
      msg += `${emoji} ${e.pair} [${reason}] ${sign}${e.totalPnL.toFixed(2)}%\n`;
    });
    msg += `\n`;
  }
  
  // Active trades - compact format
  if (activeTrades.length === 0) {
    msg += `📈 No active trades\n`;
  } else {
    let portfolioPnL = 0;
    msg += `📈 POSITIONS (${activeTrades.length})\n\n`;
    
    activeTrades.forEach(t => {
      const pnl = t.currentPnL || 0;
      portfolioPnL += pnl;
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      const days = ((Date.now() - new Date(t.entryTime)) / (1000*60*60*24)).toFixed(1);
      
      // Z-score delta (↓ = good, moving to exit)
      const zEntry = t.entryZScore?.toFixed(2) || '?';
      const zNow = t.currentZ?.toFixed(2) || '?';
      const zDelta = t.currentZ && t.entryZScore 
        ? (Math.abs(t.currentZ) - Math.abs(t.entryZScore)).toFixed(2)
        : '?';
      const zArrow = parseFloat(zDelta) < 0 ? '↓' : parseFloat(zDelta) > 0 ? '↑' : '→';
      
      // Half-life delta (↓ = good, faster reversion)
      const hlEntry = t.halfLife?.toFixed(1) || '?';
      const hlNow = t.currentHalfLife?.toFixed(1) || hlEntry;
      const hlDelta = t.currentHalfLife && t.halfLife
        ? (t.currentHalfLife - t.halfLife).toFixed(1)
        : '0';
      const hlArrow = parseFloat(hlDelta) < 0 ? '↓' : parseFloat(hlDelta) > 0 ? '↑' : '→';
      
      // Correlation delta (↓ = bad, relationship weakening)
      const corrEntry = t.correlation?.toFixed(2) || '?';
      const corrNow = t.currentCorrelation?.toFixed(2) || corrEntry;
      const corrDelta = t.currentCorrelation && t.correlation
        ? (t.currentCorrelation - t.correlation).toFixed(2)
        : '0';
      const corrArrow = parseFloat(corrDelta) > 0 ? '↑' : parseFloat(corrDelta) < 0 ? '↓' : '→';
      
      msg += `${pnlEmoji} ${t.pair} (${t.sector})\n`;
      msg += `   L ${t.longAsset} ${t.longWeight?.toFixed(0)}% / S ${t.shortAsset} ${t.shortWeight?.toFixed(0)}%\n`;
      msg += `   Z: ${zEntry}→${zNow} (${zArrow}${Math.abs(parseFloat(zDelta)).toFixed(2)})\n`;
      msg += `   HL: ${hlEntry}→${hlNow}d | Corr: ${corrEntry}→${corrNow}\n`;
      msg += `   ${pnlSign}${pnl.toFixed(2)}% | ${days}d\n\n`;
    });
    
    const pSign = portfolioPnL >= 0 ? '+' : '';
    const pEmoji = portfolioPnL >= 0 ? '💰' : '📉';
    msg += `${pEmoji} Total: ${pSign}${portfolioPnL.toFixed(2)}%\n`;
  }
  
  // Historical stats
  if (history.stats.totalTrades > 0) {
    const cumSign = history.stats.totalPnL >= 0 ? '+' : '';
    msg += `\n📜 ${history.stats.wins}W/${history.stats.losses}L • ${cumSign}${history.stats.totalPnL.toFixed(2)}%\n`;
  }
  
  return msg;
}

/**
 * Main
 */
async function main() {
  console.log('🤖 Pair Trading Bot\n');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : MANUAL_MODE ? 'MANUAL' : 'AUTO-TRADE'}\n`);
  
  const watchlist = loadJSON('watchlist.json');
  if (!watchlist) {
    console.error('❌ No watchlist. Run: npm run scan');
    process.exit(1);
  }
  
  let activeTrades = loadJSON('active_trades_sim.json') || { trades: [] };
  let history = loadJSON('trade_history.json') || { trades: [], stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } };
  
  console.log(`Watchlist: ${watchlist.pairs.length} pairs`);
  console.log(`Active trades: ${activeTrades.trades.length}\n`);
  
  const sdk = new Hyperliquid();
  const saved = suppressConsole();
  await sdk.connect();
  restoreConsole(saved);
  
  const entries = [];
  const exits = [];
  const activePairs = new Set(activeTrades.trades.map(t => t.pair));
  
  // ===== CHECK ACTIVE TRADES FOR EXITS =====
  if (activeTrades.trades.length > 0) {
    console.log('📋 Checking active trades...\n');
    
    for (const trade of [...activeTrades.trades]) {
      const prices = await fetchPrices(sdk, trade.asset1, trade.asset2);
      if (!prices) {
        console.log(`  ❌ ${trade.pair}: fetch failed`);
        continue;
      }
      
      const fit = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
      trade.currentZ = fit.zScore;
      trade.currentPnL = calcPnL(trade, prices);
      trade.currentCorrelation = fit.correlation;
      trade.currentHalfLife = fit.halfLife;
      
      // Check all exit conditions
      const exitCheck = checkExitConditions(trade, fit);
      const sign = trade.currentPnL >= 0 ? '+' : '';
      const daysIn = ((Date.now() - new Date(trade.entryTime)) / (1000*60*60*24)).toFixed(1);
      
      if (exitCheck.shouldExit) {
        console.log(`  ${exitCheck.emoji} ${trade.pair}: ${exitCheck.reason} (${sign}${trade.currentPnL.toFixed(2)}%)`);
        console.log(`     ${exitCheck.message}`);
        if (!MANUAL_MODE && !DRY_RUN) {
          const exited = exitTrade(trade, fit, prices, activeTrades, history);
          if (exited) {
            exited.exitReason = exitCheck.reason;
            exited.exitEmoji = exitCheck.emoji;
            exits.push(exited);
          }
        }
      } else {
        console.log(`  ⏳ ${trade.pair}: Z=${fit.zScore.toFixed(2)}, Corr=${fit.correlation.toFixed(2)}, ${sign}${trade.currentPnL.toFixed(2)}% (${daysIn}d)`);
      }
      
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('');
  }
  
  // ===== CHECK WATCHLIST FOR ENTRIES =====
  console.log('📊 Checking watchlist...\n');
  
  for (const pair of watchlist.pairs) {
    if (activePairs.has(pair.pair)) continue;
    if (activeTrades.trades.length >= MAX_CONCURRENT_TRADES) {
      console.log(`  ⚠️ Max trades (${MAX_CONCURRENT_TRADES}) reached`);
      break;
    }
    
    const prices = await fetchPrices(sdk, pair.asset1, pair.asset2);
    if (!prices) {
      console.log(`  ❌ ${pair.pair}: fetch failed`);
      continue;
    }
    
    let validation;
    try {
      validation = validateEntry(prices);
    } catch (e) {
      console.log(`  ❌ ${pair.pair}: validation error`);
      continue;
    }
    
    const z = validation.fit30d.zScore;
    const signal = Math.abs(z) >= ENTRY_THRESHOLD;
    
    if (signal && validation.valid) {
      const dir = z < 0 ? 'Long' : 'Short';
      console.log(`  🟢 ${pair.pair}: ENTRY (Z=${z.toFixed(2)}, ${dir} ${pair.asset1})`);
      
      if (!MANUAL_MODE && !DRY_RUN) {
        const trade = enterTrade(pair, validation.fit30d, prices, activeTrades);
        entries.push(trade);
        activePairs.add(pair.pair);
        console.log(`     ✅ Entered`);
      }
    } else if (signal && !validation.valid) {
      console.log(`  ⚠️ ${pair.pair}: Signal but failed validation (${validation.reason})`);
    } else {
      const pct = (Math.abs(z) / ENTRY_THRESHOLD * 100).toFixed(0);
      console.log(`  ⏳ ${pair.pair}: Z=${z.toFixed(2)} (${pct}%)`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Disconnect
  const saved2 = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved2);
  
  // Save state
  if (!DRY_RUN) {
    saveJSON('active_trades_sim.json', activeTrades);
    saveJSON('trade_history.json', history);
  }
  
  // ===== SEND STATUS REPORT =====
  console.log('\n' + '─'.repeat(50) + '\n');
  
  // Update current P&L for report
  const tradesWithPnL = activeTrades.trades.map(t => ({
    ...t,
    currentZ: t.currentZ,
    currentPnL: t.currentPnL || 0
  }));
  
  const report = formatStatusReport(tradesWithPnL, entries, exits, history);
  console.log(report);
  
  if (!DRY_RUN && (entries.length > 0 || exits.length > 0 || activeTrades.trades.length > 0)) {
    await sendTelegram(report);
    console.log('📱 Status sent to Telegram\n');
  }
  
  console.log('✅ Done\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
