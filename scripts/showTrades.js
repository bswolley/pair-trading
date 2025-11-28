#!/usr/bin/env node

/**
 * Show Trades - Display active trades with live P&L
 * 
 * Usage: node scripts/showTrades.js
 * 
 * Shows all active simulated trades with current prices and unrealized P&L.
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../lib/pairAnalysis');

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
 * Fetch current prices
 */
async function fetchCurrentPrices(sdk, sym1, sym2, days = 30) {
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
 * Calculate P&L for a trade
 */
function calculatePnL(trade, currentLongPrice, currentShortPrice) {
  // Long leg P&L: (current - entry) / entry * weight
  const longPnL = ((currentLongPrice - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100);
  
  // Short leg P&L: (entry - current) / entry * weight (profit when price goes down)
  const shortPnL = ((trade.shortEntryPrice - currentShortPrice) / trade.shortEntryPrice) * (trade.shortWeight / 100);
  
  // Total P&L
  const totalPnL = (longPnL + shortPnL) * 100; // as percentage
  
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
  console.log('\n📊 Active Trades\n');
  
  const activeTrades = loadActiveTrades();
  
  if (activeTrades.trades.length === 0) {
    console.log('  No active trades.\n');
    console.log('  Enter a trade with: npm run enter XLM/HBAR');
    return;
  }
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  await sdk.connect();
  console.log = originalLog;
  console.error = originalError;
  
  console.log(`  Found ${activeTrades.trades.length} active trade(s)\n`);
  console.log('─'.repeat(80));
  
  let totalPortfolioPnL = 0;
  
  for (const trade of activeTrades.trades) {
    // Fetch current prices
    const priceData = await fetchCurrentPrices(sdk, trade.asset1, trade.asset2);
    
    if (!priceData) {
      console.log(`\n  ❌ ${trade.pair} - Failed to fetch prices`);
      continue;
    }
    
    // Calculate current Z-score
    const fitness = checkPairFitness(priceData.prices1, priceData.prices2);
    
    // Get current prices for long/short legs
    const currentLongPrice = trade.direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
    const currentShortPrice = trade.direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
    
    // Calculate P&L
    const pnl = calculatePnL(trade, currentLongPrice, currentShortPrice);
    totalPortfolioPnL += pnl.totalPnL;
    
    // Time in trade
    const entryDate = new Date(trade.entryTime);
    const now = new Date();
    const hoursInTrade = Math.round((now - entryDate) / (1000 * 60 * 60));
    const daysInTrade = (hoursInTrade / 24).toFixed(1);
    
    // Exit signal check
    const isExitSignal = Math.abs(fitness.zScore) <= trade.exitThreshold;
    const signalStatus = isExitSignal ? '🔴 EXIT SIGNAL' : '⏳ In trade';
    
    // P&L color
    const pnlEmoji = pnl.totalPnL >= 0 ? '🟢' : '🔴';
    const pnlSign = pnl.totalPnL >= 0 ? '+' : '';
    
    console.log(`
  ${trade.pair} ${signalStatus}
  ├ Direction: ${trade.direction === 'long' ? `Long ${trade.asset1}` : `Short ${trade.asset1}`}
  ├ Entry: Z=${trade.entryZScore.toFixed(2)} | Now: Z=${fitness.zScore.toFixed(2)}
  ├ Time in trade: ${daysInTrade}d (${hoursInTrade}h)
  │
  ├ Long ${trade.longAsset}:  $${trade.longEntryPrice.toFixed(6)} → $${currentLongPrice.toFixed(6)} (${pnl.longPnL >= 0 ? '+' : ''}${pnl.longPnL.toFixed(2)}%)
  ├ Short ${trade.shortAsset}: $${trade.shortEntryPrice.toFixed(6)} → $${currentShortPrice.toFixed(6)} (${pnl.shortPnL >= 0 ? '+' : ''}${pnl.shortPnL.toFixed(2)}%)
  │
  └ ${pnlEmoji} Total P&L: <b>${pnlSign}${pnl.totalPnL.toFixed(2)}%</b>
`);
    console.log('─'.repeat(80));
    
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Disconnect
  console.log = () => {};
  console.error = () => {};
  await sdk.disconnect();
  console.log = originalLog;
  console.error = originalError;
  
  // Portfolio summary
  const portfolioEmoji = totalPortfolioPnL >= 0 ? '🟢' : '🔴';
  const portfolioSign = totalPortfolioPnL >= 0 ? '+' : '';
  console.log(`\n  ${portfolioEmoji} Portfolio P&L: ${portfolioSign}${totalPortfolioPnL.toFixed(2)}%\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

