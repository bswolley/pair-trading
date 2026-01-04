#!/usr/bin/env node

/**
 * Enter Trade - Record a new trade entry
 * 
 * Usage: 
 *   node scripts/enterTrade.js XLM/HBAR
 *   node scripts/enterTrade.js XLM HBAR
 * 
 * Records current prices, Z-score, beta, and position weights.
 * Sends Telegram confirmation.
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
  console.error('Usage: node scripts/enterTrade.js XLM/HBAR');
  console.error('       node scripts/enterTrade.js XLM HBAR');
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
  console.error('Invalid pair format. Use: XLM/HBAR or XLM HBAR');
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
 * Fetch prices for a pair
 */
async function fetchPrices(sdk, sym1, sym2, days = 30) {
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
  
  const [data1, data2] = await Promise.all([
    sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
    sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
  ]);
  
  if (!data1?.length || !data2?.length) {
    throw new Error('Failed to fetch price data');
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
 * Main
 */
async function main() {
  console.log(`\n📝 Entering trade: ${PAIR}\n`);
  
  // Check if already in trade
  const activeTrades = loadActiveTrades();
  const existing = activeTrades.trades.find(t => t.pair === PAIR);
  if (existing) {
    console.error(`❌ Already in trade for ${PAIR}`);
    console.error(`   Entered: ${existing.entryTime}`);
    console.error(`   Entry Z: ${existing.entryZScore.toFixed(2)}`);
    process.exit(1);
  }
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const originalLog = console.log;
  console.log = () => {};
  await sdk.connect();
  console.log = originalLog;
  
  // Fetch data
  console.log('Fetching price data...');
  const priceData = await fetchPrices(sdk, asset1, asset2);
  
  // Calculate fitness
  const fitness = checkPairFitness(priceData.prices1, priceData.prices2);
  
  // Calculate optimal entry threshold using percentage-based reversion
  const spreads = priceData.prices1.map((p1, i) => Math.log(p1) - fitness.beta * Math.log(priceData.prices2[i]));
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const stdDevSpread = Math.sqrt(spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length);
  const zScores = spreads.map(s => (s - meanSpread) / stdDevSpread);
  
  const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
  let optimalEntry = 2.0; // Safety floor - raised from 1.5 for better edge
  for (let i = thresholds.length - 1; i >= 0; i--) {
    const threshold = thresholds[i];
    const percentTarget = threshold * 0.5;
    let events = 0, reverted = 0;
    for (let j = 1; j < zScores.length; j++) {
      if (Math.abs(zScores[j - 1]) < threshold && Math.abs(zScores[j]) >= threshold) {
        events++;
        for (let k = j + 1; k < zScores.length; k++) {
          if (Math.abs(zScores[k]) < percentTarget) { reverted++; break; }
        }
      }
    }
    const rate = events > 0 ? (reverted / events) * 100 : 0;
    if (events >= 3 && rate >= 90) { optimalEntry = threshold; break; }
    if (optimalEntry === 2.0 && events >= 2 && rate >= 80) { optimalEntry = threshold; }
  }
  
  // Disconnect
  console.log = () => {};
  await sdk.disconnect();
  console.log = originalLog;
  
  // Calculate position weights
  const absBeta = Math.abs(fitness.beta);
  const weight1 = 1 / (1 + absBeta);
  const weight2 = absBeta / (1 + absBeta);
  
  // Determine direction
  const direction = fitness.zScore < 0 ? 'long' : 'short';
  const longAsset = direction === 'long' ? asset1 : asset2;
  const shortAsset = direction === 'long' ? asset2 : asset1;
  const longWeight = direction === 'long' ? weight1 : weight2;
  const shortWeight = direction === 'long' ? weight2 : weight1;
  const longPrice = direction === 'long' ? priceData.currentPrice1 : priceData.currentPrice2;
  const shortPrice = direction === 'long' ? priceData.currentPrice2 : priceData.currentPrice1;
  
  // Create trade record
  const trade = {
    pair: PAIR,
    asset1,
    asset2,
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
    entryThreshold: optimalEntry,
    exitThreshold: 0.5
  };
  
  // Save trade
  activeTrades.trades.push(trade);
  saveActiveTrades(activeTrades);
  
  // Display
  console.log('\n✅ Trade entered!\n');
  console.log(`  Pair: ${PAIR}`);
  console.log(`  Direction: ${direction === 'long' ? `Long ${asset1} / Short ${asset2}` : `Short ${asset1} / Long ${asset2}`}`);
  console.log(`  Entry Z-Score: ${fitness.zScore.toFixed(2)}`);
  console.log(`\n  Position Sizing (beta-weighted):`);
  console.log(`    Long ${longAsset}: ${(longWeight * 100).toFixed(1)}% @ $${longPrice.toFixed(6)}`);
  console.log(`    Short ${shortAsset}: ${(shortWeight * 100).toFixed(1)}% @ $${shortPrice.toFixed(6)}`);
  console.log(`\n  Statistics:`);
  console.log(`    Correlation: ${fitness.correlation.toFixed(3)}`);
  console.log(`    Beta: ${fitness.beta.toFixed(3)}`);
  console.log(`    Half-life: ${fitness.halfLife.toFixed(1)} days`);
  console.log(`    Cointegrated: ${fitness.isCointegrated ? 'Yes' : 'No'}`);
  console.log(`\n  Exit when |Z| < ${trade.exitThreshold}`);
  
  // Send Telegram
  const msg = `📝 <b>TRADE ENTERED</b>

<b>Pair:</b> ${PAIR}

💰 <b>Position</b>
├ Long ${longAsset}: <b>${(longWeight * 100).toFixed(1)}%</b> @ $${longPrice.toFixed(6)}
└ Short ${shortAsset}: <b>${(shortWeight * 100).toFixed(1)}%</b> @ $${shortPrice.toFixed(6)}

📊 <b>Entry</b>
├ Z-Score: ${fitness.zScore.toFixed(2)}
├ Correlation: ${fitness.correlation.toFixed(3)}
├ Beta: ${fitness.beta.toFixed(3)}
└ Half-life: ${fitness.halfLife.toFixed(1)}d

<i>Exit target: |Z| < ${trade.exitThreshold}</i>`;
  
  await sendTelegram(msg);
  
  console.log('\n📱 Telegram notification sent');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

