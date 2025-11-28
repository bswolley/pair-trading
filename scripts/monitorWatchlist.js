#!/usr/bin/env node

/**
 * Watchlist Monitor - Automated pair trading system
 * 
 * Monitors watchlist pairs, automatically enters trades on entry signals,
 * and exits trades on exit signals. Sends Telegram notifications.
 * 
 * Usage: 
 *   node scripts/monitorWatchlist.js              # Auto-trade mode
 *   node scripts/monitorWatchlist.js --manual     # Alert-only mode (no auto-trading)
 *   node scripts/monitorWatchlist.js --dry-run    # Test mode (no alerts, no trades)
 * 
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN - Telegram bot token
 *   TELEGRAM_CHAT_ID   - Chat ID for notifications
 *   MAX_CONCURRENT_TRADES - Max simultaneous trades (default: 5)
 * 
 * Schedule with cron (every hour):
 *   0 * * * * cd /path/to/pair-trading && node scripts/monitorWatchlist.js
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

// CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MANUAL_MODE = args.includes('--manual');

/**
 * Console helpers
 */
function suppressConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  return { originalLog, originalError };
}

function restoreConsole({ originalLog, originalError }) {
  console.log = originalLog;
  console.error = originalError;
}

/**
 * Send Telegram message
 */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  if (DRY_RUN) {
    console.log('📱 [DRY RUN] Would send:', message.substring(0, 50) + '...');
    return true;
  }
  
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    });
    return true;
  } catch (e) {
    console.error('Telegram error:', e.response?.data?.description || e.message);
    return false;
  }
}

/**
 * File operations
 */
function loadJSON(filename) {
  const filepath = path.join(__dirname, '../config', filename);
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }
  return null;
}

function saveJSON(filename, data) {
  const filepath = path.join(__dirname, '../config', filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

/**
 * Fetch prices for a pair
 */
async function fetchPrices(sdk, sym1, sym2, days = 30) {
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
  
  try {
    const [data1, data2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
    ]);
    
    if (!data1?.length || !data2?.length) return null;
    
    const map1 = new Map();
    const map2 = new Map();
    
    data1.forEach(c => {
      const date = new Date(c.t).toISOString().split('T')[0];
      map1.set(date, parseFloat(c.c));
    });
    
    data2.forEach(c => {
      const date = new Date(c.t).toISOString().split('T')[0];
      map2.set(date, parseFloat(c.c));
    });
    
    const commonDates = [...map1.keys()].filter(d => map2.has(d)).sort();
    if (commonDates.length < 15) return null;
    
    const selectedDates = commonDates.slice(-days);
    
    return {
      prices1: selectedDates.map(d => map1.get(d)),
      prices2: selectedDates.map(d => map2.get(d)),
      currentPrice1: map1.get(commonDates[commonDates.length - 1]),
      currentPrice2: map2.get(commonDates[commonDates.length - 1])
    };
  } catch (e) {
    return null;
  }
}

/**
 * Enter a trade
 */
async function enterTrade(pair, fitness, priceData) {
  const activeTrades = loadJSON('active_trades_sim.json') || { trades: [] };
  
  // Check if already in trade
  if (activeTrades.trades.find(t => t.pair === pair.pair)) {
    console.log(`  ⚠️  Already in trade for ${pair.pair}`);
    return false;
  }
  
  // Check max trades
  if (activeTrades.trades.length >= MAX_CONCURRENT_TRADES) {
    console.log(`  ⚠️  Max concurrent trades (${MAX_CONCURRENT_TRADES}) reached`);
    return false;
  }
  
  // Calculate position weights
  const absBeta = Math.abs(fitness.beta);
  const weight1 = 1 / (1 + absBeta);
  const weight2 = absBeta / (1 + absBeta);
  
  const direction = fitness.zScore < 0 ? 'long' : 'short';
  const longAsset = direction === 'long' ? pair.asset1 : pair.asset2;
  const shortAsset = direction === 'long' ? pair.asset2 : pair.asset1;
  const longWeight = direction === 'long' ? weight1 : weight2;
  const shortWeight = direction === 'long' ? weight2 : weight1;
  const longPrice = direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
  const shortPrice = direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
  
  const trade = {
    pair: pair.pair,
    asset1: pair.asset1,
    asset2: pair.asset2,
    sector: pair.sector,
    entryTime: new Date().toISOString(),
    entryZScore: fitness.zScore,
    entryPrice1: priceData.currentPrice1,
    entryPrice2: priceData.currentPrice2,
    correlation: fitness.correlation,
    beta: fitness.beta,
    halfLife: fitness.halfLife,
    isCointegrated: fitness.isCointegrated,
    direction,
    longAsset,
    shortAsset,
    longWeight: longWeight * 100,
    shortWeight: shortWeight * 100,
    longEntryPrice: longPrice,
    shortEntryPrice: shortPrice,
    entryThreshold: 1.5,
    exitThreshold: 0.5
  };
  
  if (!DRY_RUN) {
    activeTrades.trades.push(trade);
    saveJSON('active_trades_sim.json', activeTrades);
  }
  
  // Send Telegram
  const msg = `🤖 AUTO ENTRY

Pair: ${pair.pair}
Sector: ${pair.sector}

💰 Position
  Long ${longAsset}: ${(longWeight * 100).toFixed(1)}% @ $${longPrice.toFixed(6)}
  Short ${shortAsset}: ${(shortWeight * 100).toFixed(1)}% @ $${shortPrice.toFixed(6)}

📊 Stats
  Z-Score: ${fitness.zScore.toFixed(2)}
  Correlation: ${fitness.correlation.toFixed(3)}
  Beta: ${fitness.beta.toFixed(3)}
  Half-life: ${fitness.halfLife.toFixed(1)}d

Exit when |Z| drops below 0.5`;
  
  await sendTelegram(msg);
  
  return true;
}

/**
 * Exit a trade
 */
async function exitTrade(trade, fitness, priceData) {
  const activeTrades = loadJSON('active_trades_sim.json') || { trades: [] };
  const tradeIndex = activeTrades.trades.findIndex(t => t.pair === trade.pair);
  
  if (tradeIndex === -1) return false;
  
  // Get current prices
  const currentLongPrice = trade.direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
  const currentShortPrice = trade.direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
  
  // Calculate P&L
  const longPnL = ((currentLongPrice - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100);
  const shortPnL = ((trade.shortEntryPrice - currentShortPrice) / trade.shortEntryPrice) * (trade.shortWeight / 100);
  const totalPnL = (longPnL + shortPnL) * 100;
  
  // Time in trade
  const entryDate = new Date(trade.entryTime);
  const daysInTrade = ((Date.now() - entryDate) / (1000 * 60 * 60 * 24)).toFixed(1);
  
  // Update history
  const history = loadJSON('trade_history.json') || { trades: [], stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } };
  
  const historyRecord = {
    ...trade,
    exitTime: new Date().toISOString(),
    exitZScore: fitness.zScore,
    exitPrice1: priceData.currentPrice1,
    exitPrice2: priceData.currentPrice2,
    longExitPrice: currentLongPrice,
    shortExitPrice: currentShortPrice,
    longPnL: longPnL * 100,
    shortPnL: shortPnL * 100,
    totalPnL,
    daysInTrade: parseFloat(daysInTrade)
  };
  
  if (!DRY_RUN) {
    history.trades.push(historyRecord);
    history.stats.totalTrades++;
    if (totalPnL >= 0) history.stats.wins++;
    else history.stats.losses++;
    history.stats.totalPnL += totalPnL;
    history.stats.winRate = (history.stats.wins / history.stats.totalTrades * 100).toFixed(1);
    history.stats.avgPnL = (history.stats.totalPnL / history.stats.totalTrades).toFixed(2);
    saveJSON('trade_history.json', history);
    
    // Remove from active trades
    activeTrades.trades.splice(tradeIndex, 1);
    saveJSON('active_trades_sim.json', activeTrades);
  }
  
  // Send Telegram
  const pnlEmoji = totalPnL >= 0 ? '✅' : '❌';
  const pnlSign = totalPnL >= 0 ? '+' : '';
  
  const msg = `🤖 AUTO EXIT ${pnlEmoji}

Pair: ${trade.pair}
Duration: ${daysInTrade} days

📊 Result
  Entry Z: ${trade.entryZScore.toFixed(2)} → Exit Z: ${fitness.zScore.toFixed(2)}
  Long ${trade.longAsset}: ${longPnL * 100 >= 0 ? '+' : ''}${(longPnL * 100).toFixed(2)}%
  Short ${trade.shortAsset}: ${shortPnL * 100 >= 0 ? '+' : ''}${(shortPnL * 100).toFixed(2)}%
  Total: ${pnlSign}${totalPnL.toFixed(2)}%

📈 Stats
  Win Rate: ${history.stats.winRate}% (${history.stats.wins}W/${history.stats.losses}L)
  Cumulative: ${history.stats.totalPnL >= 0 ? '+' : ''}${history.stats.totalPnL.toFixed(2)}%`;
  
  await sendTelegram(msg);
  
  return true;
}

/**
 * Main
 */
async function main() {
  const startTime = Date.now();
  
  console.log('🤖 Pair Trading Bot\n');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : MANUAL_MODE ? 'MANUAL (alerts only)' : 'AUTO-TRADE'}`);
  console.log(`Max concurrent trades: ${MAX_CONCURRENT_TRADES}\n`);
  
  // Load data
  const watchlist = loadJSON('watchlist.json');
  if (!watchlist) {
    console.error('❌ Watchlist not found. Run: npm run scan');
    process.exit(1);
  }
  
  const activeTrades = loadJSON('active_trades_sim.json') || { trades: [] };
  
  console.log(`Watchlist: ${watchlist.pairs.length} pairs`);
  console.log(`Active trades: ${activeTrades.trades.length}\n`);
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const saved = suppressConsole();
  await sdk.connect();
  restoreConsole(saved);
  
  let entriesExecuted = 0;
  let exitsExecuted = 0;
  
  // ========== CHECK ACTIVE TRADES FOR EXIT SIGNALS ==========
  if (activeTrades.trades.length > 0) {
    console.log('📋 Checking active trades...\n');
    
    for (const trade of [...activeTrades.trades]) {
      const priceData = await fetchPrices(sdk, trade.asset1, trade.asset2);
      
      if (!priceData) {
        console.log(`  ❌ ${trade.pair}: Failed to fetch prices`);
        continue;
      }
      
      const fitness = checkPairFitness(priceData.prices1, priceData.prices2);
      const isExitSignal = Math.abs(fitness.zScore) <= trade.exitThreshold;
      
      // Calculate current P&L
      const currentLongPrice = trade.direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
      const currentShortPrice = trade.direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
      const longPnL = ((currentLongPrice - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100);
      const shortPnL = ((trade.shortEntryPrice - currentShortPrice) / trade.shortEntryPrice) * (trade.shortWeight / 100);
      const totalPnL = (longPnL + shortPnL) * 100;
      const pnlSign = totalPnL >= 0 ? '+' : '';
      
      if (isExitSignal) {
        console.log(`  🔴 ${trade.pair}: EXIT SIGNAL (Z=${fitness.zScore.toFixed(2)}, P&L=${pnlSign}${totalPnL.toFixed(2)}%)`);
        
        if (!MANUAL_MODE && !DRY_RUN) {
          const exited = await exitTrade(trade, fitness, priceData);
          if (exited) {
            console.log(`     ✅ Auto-exited`);
            exitsExecuted++;
          }
        } else if (MANUAL_MODE) {
          console.log(`     ⚠️  Manual mode - run: npm run exit ${trade.pair}`);
        }
      } else {
        console.log(`  ⏳ ${trade.pair}: Holding (Z=${fitness.zScore.toFixed(2)}, P&L=${pnlSign}${totalPnL.toFixed(2)}%)`);
      }
      
      await new Promise(r => setTimeout(r, 300));
    }
    console.log('');
  }
  
  // ========== CHECK WATCHLIST FOR ENTRY SIGNALS ==========
  console.log('📊 Checking watchlist...\n');
  
  // Get pairs we're already in
  const activePairs = new Set(activeTrades.trades.map(t => t.pair));
  
  for (const pair of watchlist.pairs) {
    // Skip if already in trade
    if (activePairs.has(pair.pair)) {
      continue;
    }
    
    const priceData = await fetchPrices(sdk, pair.asset1, pair.asset2);
    
    if (!priceData) {
      console.log(`  ❌ ${pair.pair}: Failed to fetch prices`);
      continue;
    }
    
    const fitness = checkPairFitness(priceData.prices1, priceData.prices2);
    const signalStrength = Math.min(Math.abs(fitness.zScore) / 1.5, 1.0);
    const isEntrySignal = Math.abs(fitness.zScore) >= 1.5;
    
    if (isEntrySignal) {
      const direction = fitness.zScore < 0 ? 'Long' : 'Short';
      console.log(`  🟢 ${pair.pair}: ENTRY SIGNAL (Z=${fitness.zScore.toFixed(2)}, ${direction} ${pair.asset1})`);
      
      if (!MANUAL_MODE && !DRY_RUN) {
        const entered = await enterTrade(pair, fitness, priceData);
        if (entered) {
          console.log(`     ✅ Auto-entered`);
          entriesExecuted++;
          activePairs.add(pair.pair);
        }
      } else if (MANUAL_MODE) {
        console.log(`     ⚠️  Manual mode - run: npm run enter ${pair.pair}`);
      }
    } else {
      const signalPct = (signalStrength * 100).toFixed(0);
      console.log(`  ⏳ ${pair.pair}: Z=${fitness.zScore.toFixed(2)} (${signalPct}%)`);
    }
    
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Disconnect
  const saved2 = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved2);
  
  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log('\n📈 Summary\n');
  
  const finalTrades = loadJSON('active_trades_sim.json') || { trades: [] };
  const history = loadJSON('trade_history.json') || { stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } };
  
  console.log(`  Entries executed: ${entriesExecuted}`);
  console.log(`  Exits executed: ${exitsExecuted}`);
  console.log(`  Active trades: ${finalTrades.trades.length}`);
  
  if (history.stats.totalTrades > 0) {
    console.log(`\n  📊 Historical Performance`);
    console.log(`     Win Rate: ${history.stats.winRate}% (${history.stats.wins}W/${history.stats.losses}L)`);
    console.log(`     Cumulative P&L: ${history.stats.totalPnL >= 0 ? '+' : ''}${history.stats.totalPnL.toFixed(2)}%`);
  }
  
  console.log(`\n✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
