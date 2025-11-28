#!/usr/bin/env node

/**
 * Exit Trade - Close a trade and record to history
 * 
 * Usage: 
 *   node scripts/exitTrade.js XLM/HBAR
 *   node scripts/exitTrade.js XLM HBAR
 * 
 * Calculates final P&L, moves trade to history, sends Telegram notification.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../lib/pairAnalysis');

require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node scripts/exitTrade.js XLM/HBAR');
  process.exit(1);
}

let asset1, asset2;
if (args[0].includes('/')) {
  [asset1, asset2] = args[0].split('/');
} else {
  asset1 = args[0];
  asset2 = args[1];
}

if (!asset1 || !asset2) {
  console.error('Invalid pair format');
  process.exit(1);
}

asset1 = asset1.toUpperCase();
asset2 = asset2.toUpperCase();

// Handle k-prefixed tokens
if (asset1.startsWith('K') && ['KSHIB', 'KBONK', 'KPEPE', 'KFLOKI', 'KNEIRO', 'KDOGS', 'KLUNC'].includes(asset1)) {
  asset1 = 'k' + asset1.slice(1);
}
if (asset2.startsWith('K') && ['KSHIB', 'KBONK', 'KPEPE', 'KFLOKI', 'KNEIRO', 'KDOGS', 'KLUNC'].includes(asset2)) {
  asset2 = 'k' + asset2.slice(1);
}

const PAIR = `${asset1}/${asset2}`;

/**
 * Send Telegram message
 */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

/**
 * Load active trades
 */
function loadActiveTrades() {
  const filepath = path.join(__dirname, '../config/active_trades_sim.json');
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }
  return { trades: [] };
}

/**
 * Save active trades
 */
function saveActiveTrades(data) {
  const filepath = path.join(__dirname, '../config/active_trades_sim.json');
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

/**
 * Load trade history
 */
function loadTradeHistory() {
  const filepath = path.join(__dirname, '../config/trade_history.json');
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }
  return { trades: [], stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } };
}

/**
 * Save trade history
 */
function saveTradeHistory(data) {
  const filepath = path.join(__dirname, '../config/trade_history.json');
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

/**
 * Fetch current prices
 */
async function fetchCurrentPrices(sdk, sym1, sym2, days = 30) {
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
  
  const [data1, data2] = await Promise.all([
    sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
    sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
  ]);
  
  if (!data1?.length || !data2?.length) {
    throw new Error('Failed to fetch prices');
  }
  
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
  const selectedDates = commonDates.slice(-days);
  
  return {
    prices1: selectedDates.map(d => map1.get(d)),
    prices2: selectedDates.map(d => map2.get(d)),
    currentPrice1: map1.get(commonDates[commonDates.length - 1]),
    currentPrice2: map2.get(commonDates[commonDates.length - 1])
  };
}

/**
 * Calculate P&L
 */
function calculatePnL(trade, currentLongPrice, currentShortPrice) {
  const longPnL = ((currentLongPrice - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100);
  const shortPnL = ((trade.shortEntryPrice - currentShortPrice) / trade.shortEntryPrice) * (trade.shortWeight / 100);
  const totalPnL = (longPnL + shortPnL) * 100;
  
  return {
    longPnL: longPnL * 100,
    shortPnL: shortPnL * 100,
    totalPnL
  };
}

/**
 * Main
 */
async function main() {
  console.log(`\n📤 Exiting trade: ${PAIR}\n`);
  
  // Find trade
  const activeTrades = loadActiveTrades();
  const tradeIndex = activeTrades.trades.findIndex(t => t.pair === PAIR);
  
  if (tradeIndex === -1) {
    console.error(`❌ No active trade found for ${PAIR}`);
    console.error('\nActive trades:');
    if (activeTrades.trades.length === 0) {
      console.error('  (none)');
    } else {
      activeTrades.trades.forEach(t => console.error(`  - ${t.pair}`));
    }
    process.exit(1);
  }
  
  const trade = activeTrades.trades[tradeIndex];
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const originalLog = console.log;
  console.log = () => {};
  await sdk.connect();
  console.log = originalLog;
  
  // Fetch current prices
  console.log('Fetching current prices...');
  const priceData = await fetchCurrentPrices(sdk, trade.asset1, trade.asset2);
  
  // Calculate Z-score
  const fitness = checkPairFitness(priceData.prices1, priceData.prices2);
  
  // Disconnect
  console.log = () => {};
  await sdk.disconnect();
  console.log = originalLog;
  
  // Get current prices for long/short legs
  const currentLongPrice = trade.direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
  const currentShortPrice = trade.direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
  
  // Calculate P&L
  const pnl = calculatePnL(trade, currentLongPrice, currentShortPrice);
  
  // Time in trade
  const entryDate = new Date(trade.entryTime);
  const exitDate = new Date();
  const hoursInTrade = Math.round((exitDate - entryDate) / (1000 * 60 * 60));
  const daysInTrade = (hoursInTrade / 24).toFixed(1);
  
  // Create history record
  const historyRecord = {
    ...trade,
    exitTime: exitDate.toISOString(),
    exitZScore: fitness.zScore,
    exitPrice1: priceData.currentPrice1,
    exitPrice2: priceData.currentPrice2,
    longExitPrice: currentLongPrice,
    shortExitPrice: currentShortPrice,
    longPnL: pnl.longPnL,
    shortPnL: pnl.shortPnL,
    totalPnL: pnl.totalPnL,
    daysInTrade: parseFloat(daysInTrade)
  };
  
  // Update history
  const history = loadTradeHistory();
  history.trades.push(historyRecord);
  history.stats.totalTrades++;
  if (pnl.totalPnL >= 0) {
    history.stats.wins++;
  } else {
    history.stats.losses++;
  }
  history.stats.totalPnL += pnl.totalPnL;
  history.stats.winRate = (history.stats.wins / history.stats.totalTrades * 100).toFixed(1);
  history.stats.avgPnL = (history.stats.totalPnL / history.stats.totalTrades).toFixed(2);
  saveTradeHistory(history);
  
  // Remove from active trades
  activeTrades.trades.splice(tradeIndex, 1);
  saveActiveTrades(activeTrades);
  
  // Display
  const pnlEmoji = pnl.totalPnL >= 0 ? '🟢' : '🔴';
  const pnlSign = pnl.totalPnL >= 0 ? '+' : '';
  
  console.log('\n✅ Trade closed!\n');
  console.log(`  Pair: ${PAIR}`);
  console.log(`  Time in trade: ${daysInTrade} days (${hoursInTrade}h)`);
  console.log(`  Entry Z: ${trade.entryZScore.toFixed(2)} → Exit Z: ${fitness.zScore.toFixed(2)}`);
  console.log(`\n  P&L Breakdown:`);
  console.log(`    Long ${trade.longAsset}:  $${trade.longEntryPrice.toFixed(6)} → $${currentLongPrice.toFixed(6)} (${pnl.longPnL >= 0 ? '+' : ''}${pnl.longPnL.toFixed(2)}%)`);
  console.log(`    Short ${trade.shortAsset}: $${trade.shortEntryPrice.toFixed(6)} → $${currentShortPrice.toFixed(6)} (${pnl.shortPnL >= 0 ? '+' : ''}${pnl.shortPnL.toFixed(2)}%)`);
  console.log(`\n  ${pnlEmoji} Total P&L: ${pnlSign}${pnl.totalPnL.toFixed(2)}%`);
  console.log(`\n  📈 Stats: ${history.stats.wins}W/${history.stats.losses}L (${history.stats.winRate}% WR) | Cumulative: ${history.stats.totalPnL >= 0 ? '+' : ''}${history.stats.totalPnL.toFixed(2)}%`);
  
  // Send Telegram
  const resultEmoji = pnl.totalPnL >= 0 ? '✅' : '❌';
  const msg = `${resultEmoji} <b>TRADE CLOSED</b>

<b>Pair:</b> ${PAIR}
<b>Duration:</b> ${daysInTrade} days

📊 <b>Result</b>
├ Entry Z: ${trade.entryZScore.toFixed(2)} → Exit Z: ${fitness.zScore.toFixed(2)}
├ Long ${trade.longAsset}: ${pnl.longPnL >= 0 ? '+' : ''}${pnl.longPnL.toFixed(2)}%
├ Short ${trade.shortAsset}: ${pnl.shortPnL >= 0 ? '+' : ''}${pnl.shortPnL.toFixed(2)}%
└ <b>Total: ${pnlSign}${pnl.totalPnL.toFixed(2)}%</b>

📈 <b>Stats</b>
├ Win Rate: ${history.stats.winRate}% (${history.stats.wins}W/${history.stats.losses}L)
└ Cumulative P&L: ${history.stats.totalPnL >= 0 ? '+' : ''}${history.stats.totalPnL.toFixed(2)}%`;
  
  await sendTelegram(msg);
  
  console.log('\n📱 Telegram notification sent');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

