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
const { fetchCurrentFunding, calculateNetFunding } = require('../lib/funding');

require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_CONCURRENT_TRADES = parseInt(process.env.MAX_CONCURRENT_TRADES) || 5;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MANUAL_MODE = args.includes('--manual');

// Thresholds
const DEFAULT_ENTRY_THRESHOLD = 2.0;  // Fallback if pair doesn't have dynamic threshold
const EXIT_THRESHOLD = 0.5;
const STOP_LOSS_THRESHOLD = 3.0;  // Exit if Z diverges too much
const MIN_CORRELATION_7D = 0.5;   // Looser for 7d
const MIN_CORRELATION_30D = 0.6;
const CORRELATION_BREAKDOWN = 0.4; // Exit if correlation collapses
const HALFLIFE_MULTIPLIER = 2;     // Exit if duration > 2x half-life

// Partial exit strategy
const PARTIAL_EXIT_1_PNL = 3.0;    // Exit 50% at +3%
const PARTIAL_EXIT_1_SIZE = 0.5;   // 50% of position
const FINAL_EXIT_PNL = 5.0;        // Exit remaining at +5%
const FINAL_EXIT_ZSCORE = 0.5;     // Or when |Z| < 0.5

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
 * @param {Object} prices - Price data for 7d and 30d
 * @param {number} entryThreshold - Dynamic entry threshold for this pair
 */
function validateEntry(prices, entryThreshold = DEFAULT_ENTRY_THRESHOLD) {
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
  const signal30d = Math.abs(fit30d.zScore) >= entryThreshold;
  const signal7d = fit7d && Math.abs(fit7d.zScore) >= entryThreshold * 0.8; // Slightly looser
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
 * Record partial exit (e.g., close 50% at +3%)
 * Does NOT remove trade from activeTrades - just logs the partial exit
 */
function recordPartialExit(trade, fitness, prices, exitSize, history) {
  const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
  const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;
  
  const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
  const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
  const totalPnL = longPnL + shortPnL;
  const partialPnL = totalPnL * exitSize; // Only count the exited portion
  const days = ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);
  
  const record = {
    pair: trade.pair,
    asset1: trade.asset1,
    asset2: trade.asset2,
    direction: trade.direction,
    entryTime: trade.entryTime,
    exitTime: new Date().toISOString(),
    exitType: 'PARTIAL',
    exitSize: `${(exitSize * 100).toFixed(0)}%`,
    exitZScore: fitness.zScore,
    partialPnL,
    totalPnLAtExit: totalPnL,
    daysInTrade: parseFloat(days)
  };
  
  // Record partial in history but don't count as full trade
  // NOTE: Don't add partialPnL to stats.totalPnL here - it will be counted
  // when the full trade exits (totalPnL includes the partial portion)
  if (!history.partialExits) history.partialExits = [];
  history.partialExits.push(record);
  
  return { ...record, isPartial: true };
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
 * Returns: { shouldExit: boolean, isPartial: boolean, exitSize: number, reason: string, emoji: string }
 */
function checkExitConditions(trade, fitness, currentPnL) {
  const currentZ = Math.abs(fitness.zScore);
  const daysInTrade = (Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24);
  const maxDuration = (trade.halfLife || 15) * HALFLIFE_MULTIPLIER;
  const partialTaken = trade.partialExitTaken || false;
  
  // 1. PARTIAL PROFIT - Exit 50% at +3%
  if (!partialTaken && currentPnL >= PARTIAL_EXIT_1_PNL) {
    return { 
      shouldExit: true,
      isPartial: true,
      exitSize: PARTIAL_EXIT_1_SIZE,
      reason: 'PARTIAL_TP', 
      emoji: '💰',
      message: `Partial TP: +${currentPnL.toFixed(1)}% (closing 50%)`
    };
  }
  
  // 2. FINAL PROFIT - Exit remaining at +5% or |Z| < 0.5
  if (partialTaken) {
    if (currentPnL >= FINAL_EXIT_PNL) {
      return { 
        shouldExit: true,
        isPartial: false,
        exitSize: 1.0,
        reason: 'FINAL_TP', 
        emoji: '🎯',
        message: `Final TP: +${currentPnL.toFixed(1)}% (closing remaining)`
      };
    }
    if (currentZ <= FINAL_EXIT_ZSCORE) {
      return { 
        shouldExit: true,
        isPartial: false,
        exitSize: 1.0,
        reason: 'TARGET', 
        emoji: '🎯',
        message: `Mean reversion complete (Z=${fitness.zScore.toFixed(2)})`
      };
    }
  }
  
  // 3. FULL EXIT if no partial taken yet and Z reaches target
  if (!partialTaken && currentZ <= EXIT_THRESHOLD) {
    return { 
      shouldExit: true,
      isPartial: false,
      exitSize: 1.0,
      reason: 'TARGET', 
      emoji: '🎯',
      message: `Mean reversion complete (Z=${fitness.zScore.toFixed(2)})`
    };
  }
  
  // 4. STOP LOSS - Divergence accelerating (always full exit)
  if (currentZ >= STOP_LOSS_THRESHOLD) {
    return { 
      shouldExit: true,
      isPartial: false,
      exitSize: 1.0,
      reason: 'STOP_LOSS', 
      emoji: '🛑',
      message: `Stop loss triggered (Z=${fitness.zScore.toFixed(2)} > ${STOP_LOSS_THRESHOLD})`
    };
  }
  
  // 5. TIME STOP - Exceeded 2x expected half-life (always full exit)
  if (daysInTrade > maxDuration) {
    return { 
      shouldExit: true,
      isPartial: false,
      exitSize: 1.0,
      reason: 'TIME_STOP', 
      emoji: '⏰',
      message: `Time stop (${daysInTrade.toFixed(1)}d > ${maxDuration.toFixed(0)}d max)`
    };
  }
  
  // 6. BREAKDOWN - Correlation collapsed (always full exit)
  if (fitness.correlation < CORRELATION_BREAKDOWN) {
    return { 
      shouldExit: true,
      isPartial: false,
      exitSize: 1.0,
      reason: 'BREAKDOWN', 
      emoji: '💔',
      message: `Correlation breakdown (${fitness.correlation.toFixed(2)} < ${CORRELATION_BREAKDOWN})`
    };
  }
  
  // No exit condition met
  return { shouldExit: false, isPartial: false, exitSize: 0, reason: null, emoji: null, message: null };
}

/**
 * Format status report for Telegram
 */
function formatStatusReport(activeTrades, entries, exits, history, approaching = [], fundingMap = new Map()) {
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
      // For new trades without currentZ yet, use entryZScore as fallback
      const currentZValue = t.currentZ ?? t.entryZScore;
      const zNow = currentZValue?.toFixed(2) || zEntry;
      const zDelta = currentZValue && t.entryZScore 
        ? (Math.abs(currentZValue) - Math.abs(t.entryZScore)).toFixed(2)
        : '0.00';
      const zArrow = parseFloat(zDelta) < 0 ? '↓' : parseFloat(zDelta) > 0 ? '↑' : '→';
      
      // Half-life delta (↓ = good, faster reversion)
      const hlEntry = t.halfLife?.toFixed(1) || '?';
      const hlNow = t.currentHalfLife?.toFixed(1) || hlEntry;
      const hlDelta = t.currentHalfLife && t.halfLife
        ? (t.currentHalfLife - t.halfLife).toFixed(1)
        : '0';
      const hlArrow = parseFloat(hlDelta) < 0 ? '↓' : parseFloat(hlDelta) > 0 ? '↑' : '→';
      
      // Time to mean reversion: halfLife * log(|z_current| / |z_target|) / log(2)
      const zTarget = EXIT_THRESHOLD; // 0.5
      const currentHL = t.currentHalfLife || t.halfLife || 15;
      const entryHL = t.halfLife || 15;
      // Use currentZ if available, otherwise fall back to entryZScore for new trades
      const absZ = Math.abs(t.currentZ ?? t.entryZScore ?? 0);
      let etaStr = '?';
      let etaValue = null;
      if (absZ > zTarget && currentHL > 0) {
        const halfLivesToExit = Math.log(absZ / zTarget) / Math.log(2);
        etaValue = currentHL * halfLivesToExit;
        etaStr = etaValue.toFixed(1);
      } else if (absZ <= zTarget) {
        etaStr = '0'; // Already at target
        etaValue = 0;
      }
      
      // Time stop calculation: (entryHalfLife × 2) - daysInTrade
      const timeStopMax = entryHL * HALFLIFE_MULTIPLIER;
      const timeStopRemaining = timeStopMax - parseFloat(days);
      const showTimeStop = timeStopRemaining < (etaValue ?? Infinity) || timeStopRemaining < 3;
      const timeStopUrgent = timeStopRemaining < 1;
      
      // Correlation delta (↓ = bad, relationship weakening)
      const corrEntry = t.correlation?.toFixed(2) || '?';
      const corrNow = t.currentCorrelation?.toFixed(2) || corrEntry;
      const corrDelta = t.currentCorrelation && t.correlation
        ? (t.currentCorrelation - t.correlation).toFixed(2)
        : '0';
      const corrArrow = parseFloat(corrDelta) > 0 ? '↑' : parseFloat(corrDelta) < 0 ? '↓' : '→';
      
      // Net funding calculation
      const netFunding = calculateNetFunding(t.longAsset, t.shortAsset, fundingMap);
      let fundingStr = '';
      if (netFunding.netFunding8h !== null) {
        const fundSign = netFunding.netFunding8h >= 0 ? '+' : '';
        const fund8h = (netFunding.netFunding8h * 100).toFixed(4);
        fundingStr = `Fund: ${fundSign}${fund8h}% / 8h`;
      }
      
      const partialTag = t.partialExitTaken ? ' [50% closed]' : '';
      msg += `${pnlEmoji} ${t.pair} (${t.sector})${partialTag}\n`;
      msg += `   L ${t.longAsset} ${t.longWeight?.toFixed(0)}% / S ${t.shortAsset} ${t.shortWeight?.toFixed(0)}%\n`;
      msg += `   Z: ${zEntry}→${zNow} (${zArrow}${Math.abs(parseFloat(zDelta)).toFixed(2)})\n`;
      msg += `   HL: ${hlEntry}→${hlNow}d | ETA: ${etaStr}d\n`;
      if (showTimeStop) {
        const urgentEmoji = timeStopUrgent ? '⚠️ ' : '';
        msg += `   ⏰ ${urgentEmoji}Time limit: ${timeStopRemaining.toFixed(1)}d\n`;
      }
      if (fundingStr) {
        msg += `   ${fundingStr}\n`;
      }
      msg += `   ${pnlSign}${pnl.toFixed(2)}% | ${days}d in trade\n\n`;
    });
    
    const pSign = portfolioPnL >= 0 ? '+' : '';
    const pEmoji = portfolioPnL >= 0 ? '💰' : '📉';
    msg += `${pEmoji} Total: ${pSign}${portfolioPnL.toFixed(2)}%\n`;
  }
  
  // Approaching entry (top 3)
  if (approaching.length > 0) {
    msg += `\n🎯 APPROACHING ENTRY\n\n`;
    approaching.slice(0, 3).forEach(p => {
      const pct = (p.proximity * 100).toFixed(0);
      const entryAt = p.entryThreshold || 2.0;
      let status = p.proximity >= 1 ? '🟡 READY' : '⏳';
      let overlapNote = '';
      if (p.hasOverlap) {
        status = '🚫 SKIP';
        overlapNote = ` [${p.overlappingAsset} in use]`;
      }
      
      // Net funding for approaching pair
      const netFunding = calculateNetFunding(p.longAsset, p.shortAsset, fundingMap);
      let fundingStr = '';
      if (netFunding.netFunding8h !== null) {
        const fundSign = netFunding.netFunding8h >= 0 ? '+' : '';
        const fund8h = (netFunding.netFunding8h * 100).toFixed(4);
        fundingStr = `Fund: ${fundSign}${fund8h}% / 8h`;
      }
      
      msg += `${status} ${p.pair} (${p.sector})${overlapNote}\n`;
      msg += `   L ${p.longAsset} ${p.longWeight?.toFixed(0)}% / S ${p.shortAsset} ${p.shortWeight?.toFixed(0)}%\n`;
      msg += `   Z: ${p.zScore.toFixed(2)} → entry@${entryAt} [${pct}%]\n`;
      msg += `   HL: ${p.halfLife?.toFixed(1)}d\n`;
      if (fundingStr) {
        msg += `   ${fundingStr}\n`;
      }
      msg += `\n`;
    });
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
  
  // Fetch current funding rates
  console.log('Fetching funding rates...');
  const fundingMap = await fetchCurrentFunding();
  console.log(`Got funding for ${fundingMap.size} assets\n`);
  
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
      
      // Check all exit conditions (including partial exits)
      const exitCheck = checkExitConditions(trade, fit, trade.currentPnL);
      const sign = trade.currentPnL >= 0 ? '+' : '';
      const daysIn = ((Date.now() - new Date(trade.entryTime)) / (1000*60*60*24)).toFixed(1);
      
      if (exitCheck.shouldExit) {
        console.log(`  ${exitCheck.emoji} ${trade.pair}: ${exitCheck.reason} (${sign}${trade.currentPnL.toFixed(2)}%)`);
        console.log(`     ${exitCheck.message}`);
        if (!MANUAL_MODE && !DRY_RUN) {
          if (exitCheck.isPartial) {
            // Handle partial exit - close 50%, keep position open
            const partialResult = recordPartialExit(trade, fit, prices, exitCheck.exitSize, history);
            if (partialResult) {
              partialResult.exitReason = exitCheck.reason;
              partialResult.exitEmoji = exitCheck.emoji;
              exits.push(partialResult);
              // Mark trade as having taken partial exit
              trade.partialExitTaken = true;
              trade.partialExitPnL = trade.currentPnL;
              trade.partialExitTime = new Date().toISOString();
            }
          } else {
            // Full exit
            const exited = exitTrade(trade, fit, prices, activeTrades, history);
            if (exited) {
              exited.exitReason = exitCheck.reason;
              exited.exitEmoji = exitCheck.emoji;
              exits.push(exited);
            }
          }
        }
      } else {
        const partialNote = trade.partialExitTaken ? ' [50% closed]' : '';
        console.log(`  ⏳ ${trade.pair}: Z=${fit.zScore.toFixed(2)}, Corr=${fit.correlation.toFixed(2)}, ${sign}${trade.currentPnL.toFixed(2)}% (${daysIn}d)${partialNote}`);
      }
      
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('');
  }
  
  // ===== CHECK WATCHLIST FOR ENTRIES =====
  console.log('📊 Checking watchlist...\n');
  
  const approaching = []; // Track pairs approaching entry
  
  // Build set of all assets currently in open positions (to prevent overlap)
  const assetsInPositions = new Set();
  for (const trade of activeTrades.trades) {
    assetsInPositions.add(trade.asset1);
    assetsInPositions.add(trade.asset2);
  }
  
  const atMaxTrades = activeTrades.trades.length >= MAX_CONCURRENT_TRADES;
  if (atMaxTrades) {
    console.log(`  ⚠️ Max trades (${MAX_CONCURRENT_TRADES}) reached - scanning for approaching only\n`);
  }
  
  for (const pair of watchlist.pairs) {
    if (activePairs.has(pair.pair)) continue;
    
    // Use pair-specific entry threshold (dynamic) or fallback to default
    const entryThreshold = pair.entryThreshold || DEFAULT_ENTRY_THRESHOLD;
    
    // Check for asset overlap with existing positions
    const hasOverlap = assetsInPositions.has(pair.asset1) || assetsInPositions.has(pair.asset2);
    const overlappingAsset = assetsInPositions.has(pair.asset1) ? pair.asset1 : 
                             assetsInPositions.has(pair.asset2) ? pair.asset2 : null;
    
    const prices = await fetchPrices(sdk, pair.asset1, pair.asset2);
    if (!prices) {
      console.log(`  ❌ ${pair.pair}: fetch failed`);
      continue;
    }
    
    let validation;
    try {
      validation = validateEntry(prices, entryThreshold);
    } catch (e) {
      console.log(`  ❌ ${pair.pair}: validation error`);
      continue;
    }
    
    const z = validation.fit30d.zScore;
    const signal = Math.abs(z) >= entryThreshold;
    
    if (signal && validation.valid) {
      const dir = z < 0 ? 'Long' : 'Short';
      
      if (hasOverlap) {
        // Skip entry due to asset overlap with existing position
        console.log(`  ⚠️ ${pair.pair}: SKIP - ${overlappingAsset} already in position`);
      } else if (atMaxTrades) {
        console.log(`  🟡 ${pair.pair}: READY (Z=${z.toFixed(2)}, entry@${entryThreshold}, ${dir}) - at max trades`);
        // Still track as approaching (at 100%) with full stats
        const fit = validation.fit30d;
        const absBeta = Math.abs(fit.beta);
        const w1 = (1 / (1 + absBeta)) * 100;
        const w2 = (absBeta / (1 + absBeta)) * 100;
        approaching.push({
          pair: pair.pair,
          asset1: pair.asset1,
          asset2: pair.asset2,
          sector: pair.sector,
          zScore: z,
          entryThreshold,
          proximity: Math.abs(z) / entryThreshold,
          correlation: fit.correlation,
          halfLife: fit.halfLife,
          beta: fit.beta,
          direction: z < 0 ? 'long' : 'short',
          longAsset: z < 0 ? pair.asset1 : pair.asset2,
          shortAsset: z < 0 ? pair.asset2 : pair.asset1,
          longWeight: z < 0 ? w1 : w2,
          shortWeight: z < 0 ? w2 : w1
        });
      } else {
        console.log(`  🟢 ${pair.pair}: ENTRY (Z=${z.toFixed(2)}, entry@${entryThreshold}, ${dir} ${pair.asset1})`);
        
        if (!MANUAL_MODE && !DRY_RUN) {
          const trade = enterTrade(pair, validation.fit30d, prices, activeTrades);
          trade.entryThreshold = entryThreshold;  // Store the threshold used
          entries.push(trade);
          activePairs.add(pair.pair);
          // Also add new assets to the overlap set to prevent double entries in same cycle
          assetsInPositions.add(pair.asset1);
          assetsInPositions.add(pair.asset2);
          console.log(`     ✅ Entered`);
        }
      }
    } else if (signal && !validation.valid) {
      console.log(`  ⚠️ ${pair.pair}: Signal but failed validation (${validation.reason})`);
    } else {
      const pct = (Math.abs(z) / entryThreshold * 100).toFixed(0);
      console.log(`  ⏳ ${pair.pair}: Z=${z.toFixed(2)} (${pct}% of entry@${entryThreshold})`);
      
      // Track approaching pairs (>50% toward entry)
      if (Math.abs(z) >= entryThreshold * 0.5) {
        const fit = validation.fit30d;
        const absBeta = Math.abs(fit.beta);
        const w1 = (1 / (1 + absBeta)) * 100;
        const w2 = (absBeta / (1 + absBeta)) * 100;
        approaching.push({
          pair: pair.pair,
          asset1: pair.asset1,
          asset2: pair.asset2,
          sector: pair.sector,
          zScore: z,
          entryThreshold,
          proximity: Math.abs(z) / entryThreshold,
          correlation: fit.correlation,
          halfLife: fit.halfLife,
          beta: fit.beta,
          direction: z < 0 ? 'long' : 'short',
          longAsset: z < 0 ? pair.asset1 : pair.asset2,
          shortAsset: z < 0 ? pair.asset2 : pair.asset1,
          longWeight: z < 0 ? w1 : w2,
          shortWeight: z < 0 ? w2 : w1,
          hasOverlap,
          overlappingAsset
        });
      }
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Sort approaching by proximity to entry (highest first)
  approaching.sort((a, b) => b.proximity - a.proximity);
  
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
  
  const report = formatStatusReport(tradesWithPnL, entries, exits, history, approaching, fundingMap);
  console.log(report);
  
  if (!DRY_RUN && (entries.length > 0 || exits.length > 0 || activeTrades.trades.length > 0 || approaching.length > 0)) {
    await sendTelegram(report);
    console.log('📱 Status sent to Telegram\n');
  }
  
  console.log('✅ Done\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
