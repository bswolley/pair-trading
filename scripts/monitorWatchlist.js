#!/usr/bin/env node

/**
 * Watchlist Monitor - Checks Z-scores for watchlist pairs and sends alerts
 * 
 * Reads watchlist.json, fetches current prices, computes Z-scores,
 * and sends Telegram notifications when entry/exit thresholds are crossed.
 * 
 * Usage: 
 *   node scripts/monitorWatchlist.js              # Run once
 *   node scripts/monitorWatchlist.js --dry-run    # Run without sending alerts
 * 
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN - Telegram bot token from @BotFather
 *   TELEGRAM_CHAT_ID   - Chat ID to send notifications to
 * 
 * Schedule with cron (every hour):
 *   0 * * * * cd /path/to/pair-trading && node scripts/monitorWatchlist.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../lib/pairAnalysis');

// Load environment variables
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

/**
 * Suppress console noise during SDK operations
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
async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️  Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
    return false;
  }
  
  if (DRY_RUN) {
    console.log('📱 [DRY RUN] Would send Telegram:', message);
    return true;
  }
  
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    return true;
  } catch (error) {
    console.error('❌ Telegram error:', error.message);
    return false;
  }
}

/**
 * Load watchlist from config
 */
function loadWatchlist() {
  const watchlistPath = path.join(__dirname, '../config/watchlist.json');
  if (!fs.existsSync(watchlistPath)) {
    throw new Error('Watchlist not found. Run: npm run scan');
  }
  return JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
}

/**
 * Load alert state (to avoid duplicate alerts)
 */
function loadAlertState() {
  const statePath = path.join(__dirname, '../config/alert_state.json');
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  return { lastAlerts: {} };
}

/**
 * Save alert state
 */
function saveAlertState(state) {
  const statePath = path.join(__dirname, '../config/alert_state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Fetch historical prices for a pair
 */
async function fetchPairPrices(sdk, symbol1, symbol2, days = 30) {
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
  
  try {
    const [data1, data2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1d', startTime, endTime)
    ]);
    
    if (!data1?.length || !data2?.length) {
      return null;
    }
    
    // Build date maps
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
    
    // Get common dates
    const commonDates = [...map1.keys()].filter(d => map2.has(d)).sort();
    if (commonDates.length < 15) {
      return null;
    }
    
    const selectedDates = commonDates.slice(-days);
    const prices1 = selectedDates.map(d => map1.get(d));
    const prices2 = selectedDates.map(d => map2.get(d));
    
    return { prices1, prices2 };
    
  } catch (error) {
    return null;
  }
}

/**
 * Check a single pair and return signal status
 */
async function checkPair(sdk, pair) {
  const prices = await fetchPairPrices(sdk, pair.asset1, pair.asset2);
  
  if (!prices) {
    return { ...pair, error: 'Failed to fetch prices' };
  }
  
  try {
    const fitness = checkPairFitness(prices.prices1, prices.prices2);
    
    const signalStrength = Math.min(Math.abs(fitness.zScore) / pair.entryThreshold, 1.0);
    const direction = fitness.zScore < 0 ? 'long' : 'short';
    const isEntry = Math.abs(fitness.zScore) >= pair.entryThreshold;
    const isExit = Math.abs(fitness.zScore) <= pair.exitThreshold;
    
    return {
      pair: pair.pair,
      asset1: pair.asset1,
      asset2: pair.asset2,
      sector: pair.sector,
      qualityScore: pair.qualityScore,
      // Updated values
      zScore: fitness.zScore,
      signalStrength,
      direction,
      isEntry,
      isExit,
      // Thresholds
      entryThreshold: pair.entryThreshold,
      exitThreshold: pair.exitThreshold
    };
    
  } catch (error) {
    return { ...pair, error: error.message };
  }
}

/**
 * Format alert message for Telegram
 */
function formatAlertMessage(pair, type) {
  const emoji = type === 'entry' ? '🟢' : '🔴';
  const action = type === 'entry' ? 'ENTRY SIGNAL' : 'EXIT SIGNAL';
  
  const directionText = pair.direction === 'long'
    ? `Long ${pair.asset1} / Short ${pair.asset2}`
    : `Short ${pair.asset1} / Long ${pair.asset2}`;
  
  return `${emoji} <b>${action}</b>

<b>Pair:</b> ${pair.pair}
<b>Sector:</b> ${pair.sector}
<b>Z-Score:</b> ${pair.zScore.toFixed(2)}
<b>Signal:</b> ${(pair.signalStrength * 100).toFixed(0)}%

<b>Direction:</b> ${directionText}

<i>Quality: ${pair.qualityScore} | Threshold: ${pair.entryThreshold}</i>`;
}

/**
 * Main monitor function
 */
async function main() {
  const startTime = Date.now();
  console.log('📊 Watchlist Monitor\n');
  console.log(`Time: ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🔸 DRY RUN MODE - No alerts will be sent\n');
  
  // Load watchlist
  const watchlist = loadWatchlist();
  console.log(`Loaded ${watchlist.pairs.length} pairs from watchlist\n`);
  
  // Load alert state
  const alertState = loadAlertState();
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const saved = suppressConsole();
  await sdk.connect();
  restoreConsole(saved);
  
  console.log('Checking pairs...\n');
  
  const results = [];
  const alerts = [];
  
  // Check each pair with rate limiting
  for (const pair of watchlist.pairs) {
    const result = await checkPair(sdk, pair);
    results.push(result);
    
    if (result.error) {
      console.log(`  ❌ ${pair.pair}: ${result.error}`);
      continue;
    }
    
    const signalPct = (result.signalStrength * 100).toFixed(0);
    const status = result.isEntry ? '🟢 ENTRY' : result.isExit ? '🔴 EXIT' : '⏳ WAIT';
    console.log(`  ${status} ${pair.pair}: Z=${result.zScore.toFixed(2)} (${signalPct}%)`);
    
    // Check for alerts
    const lastAlert = alertState.lastAlerts[pair.pair];
    const now = Date.now();
    const ALERT_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours
    
    if (result.isEntry) {
      // Entry signal
      if (!lastAlert || lastAlert.type !== 'entry' || (now - lastAlert.time) > ALERT_COOLDOWN) {
        alerts.push({ pair: result, type: 'entry' });
        alertState.lastAlerts[pair.pair] = { type: 'entry', time: now, zScore: result.zScore };
      }
    } else if (result.isExit && lastAlert?.type === 'entry') {
      // Exit signal (only if we had an entry)
      alerts.push({ pair: result, type: 'exit' });
      alertState.lastAlerts[pair.pair] = { type: 'exit', time: now, zScore: result.zScore };
    }
    
    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Disconnect
  const saved2 = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved2);
  
  // Summary
  const entryCount = results.filter(r => r.isEntry).length;
  const exitCount = results.filter(r => r.isExit).length;
  const waitCount = results.filter(r => !r.isEntry && !r.isExit && !r.error).length;
  const errorCount = results.filter(r => r.error).length;
  
  console.log('\n--- Summary ---');
  console.log(`  🟢 Entry signals: ${entryCount}`);
  console.log(`  🔴 Exit signals: ${exitCount}`);
  console.log(`  ⏳ Waiting: ${waitCount}`);
  if (errorCount) console.log(`  ❌ Errors: ${errorCount}`);
  
  // Send alerts
  if (alerts.length > 0) {
    console.log(`\n📱 Sending ${alerts.length} alert(s)...`);
    
    for (const alert of alerts) {
      const message = formatAlertMessage(alert.pair, alert.type);
      const sent = await sendTelegramMessage(message);
      if (sent) {
        console.log(`  ✅ Sent: ${alert.pair.pair} (${alert.type})`);
      }
    }
    
    // Save alert state
    saveAlertState(alertState);
  } else {
    console.log('\n📭 No new alerts');
  }
  
  // Save results
  const resultsPath = path.join(__dirname, '../config/monitor_results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    summary: { entry: entryCount, exit: exitCount, wait: waitCount, errors: errorCount },
    pairs: results.map(r => ({
      pair: r.pair,
      zScore: r.zScore?.toFixed(2),
      signal: r.signalStrength ? (r.signalStrength * 100).toFixed(0) + '%' : null,
      status: r.isEntry ? 'entry' : r.isExit ? 'exit' : r.error ? 'error' : 'wait',
      direction: r.direction
    }))
  }, null, 2));
  
  console.log(`\n✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// Run
main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

