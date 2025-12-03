/**
 * Telegram Bot Service - Command listener with trading commands
 * 
 * Commands:
 *   /status or /s  - Get current status
 *   /trades or /t  - Show active trades
 *   /history or /h - Show trade history
 *   /watchlist     - Show watchlist
 *   /scan          - Trigger pair scan
 *   /open <pair> <direction> - Open trade manually
 *   /close <pair>  - Close a trade
 *   /partial <pair> - Take 50% partial profit
 *   /blacklist [asset] - View or add to blacklist
 *   /help          - Show commands
 */

const axios = require('axios');
const db = require('../db/queries');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL = 2000;

let lastUpdateId = 0;
let isRunning = false;

async function sendMessage(text, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text.slice(0, 4000)
    });
    return true;
  } catch (e) {
    console.error('[TELEGRAM] Send error:', e.response?.data?.description || e.message);
    return false;
  }
}

/**
 * Handle /status command
 */
async function handleStatus(chatId) {
  const { runMonitorNow } = require('./scheduler');
  await sendMessage('⏳ Running status check...', chatId);
  await runMonitorNow();
}

/**
 * Handle /trades command
 */
async function handleTrades(chatId) {
  const trades = await db.getTrades();

  if (trades.length === 0) {
    return sendMessage('📈 No active trades', chatId);
  }

  let msg = `📈 ACTIVE TRADES (${trades.length})\n\n`;

  for (const t of trades) {
    const pnl = t.currentPnL || 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const days = ((Date.now() - new Date(t.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);
    const partial = t.partialExitTaken ? ' [50% closed]' : '';

    msg += `${pnl >= 0 ? '🟢' : '🔴'} ${t.pair} (${t.sector})${partial}\n`;
    msg += `   L ${t.longAsset} / S ${t.shortAsset}\n`;
    msg += `   ${pnlSign}${pnl.toFixed(2)}% | ${days}d\n\n`;
  }

  await sendMessage(msg, chatId);
}

/**
 * Handle /history command
 */
async function handleHistory(chatId) {
  const [history, stats] = await Promise.all([
    db.getHistory(),
    db.getStats()
  ]);

  let msg = `📜 TRADE HISTORY\n\n`;
  msg += `Total: ${stats.totalTrades || 0} trades\n`;
  msg += `Win Rate: ${stats.winRate || 0}% (${stats.wins || 0}W/${stats.losses || 0}L)\n`;
  msg += `Total P&L: ${(stats.totalPnL || 0) >= 0 ? '+' : ''}${(stats.totalPnL || 0).toFixed(2)}%\n\n`;

  // Last 5 trades
  const recent = history.slice(0, 5);
  if (recent.length > 0) {
    msg += `Recent:\n`;
    for (const t of recent) {
      const sign = (t.totalPnL || 0) >= 0 ? '+' : '';
      msg += `  ${t.pair}: ${sign}${(t.totalPnL || 0).toFixed(2)}% (${t.exitReason || 'CLOSED'})\n`;
    }
  }

  await sendMessage(msg, chatId);
}

/**
 * Handle /watchlist command
 */
async function handleWatchlist(chatId) {
  const pairs = await db.getWatchlist();

  // Get approaching entries (signal strength > 0.5)
  const approaching = pairs
    .filter(p => (p.signalStrength || 0) >= 0.5)
    .sort((a, b) => (b.signalStrength || 0) - (a.signalStrength || 0))
    .slice(0, 10);

  let msg = `📋 WATCHLIST (${pairs.length} pairs)\n\n`;

  if (approaching.length === 0) {
    msg += `No pairs near entry threshold\n`;
  } else {
    msg += `Approaching entry:\n\n`;
    for (const p of approaching) {
      const pct = ((p.signalStrength || 0) * 100).toFixed(0);
      const status = p.isReady ? '🟢 READY' : '⏳';
      const hurstStr = p.hurst ? `H:${p.hurst.toFixed(2)}` : '';
      const convStr = p.conviction ? `C:${Math.round(p.conviction)}` : '';
      const metricsStr = [hurstStr, convStr].filter(Boolean).join(' ');
      
      msg += `${status} ${p.pair} (${p.sector})\n`;
      msg += `   Z: ${(p.zScore || 0).toFixed(2)} → entry@${p.entryThreshold} [${pct}%]`;
      if (metricsStr) {
        msg += ` ${metricsStr}`;
      }
      msg += `\n\n`;
    }
  }

  await sendMessage(msg, chatId);
}

/**
 * Handle /scan command
 * Usage: /scan [cross]
 */
async function handleScan(chatId, args) {
  const { runScanNow, getCrossSectorEnabled } = require('./scheduler');

  // Check for cross-sector override
  const useCrossSector = args.includes('cross') || getCrossSectorEnabled();
  const scanType = useCrossSector ? 'with cross-sector' : 'same-sector only';

  await sendMessage(`🔍 Running pair scan (${scanType})...\nThis may take a few minutes.`, chatId);
  const result = await runScanNow({ crossSector: useCrossSector });

  if (result.success) {
    let msg = `✅ Scan complete!\n\n`;
    msg += `Total assets: ${result.totalAssets}\n`;
    msg += `Fitting pairs: ${result.fittingPairs} (Hurst < 0.5 filter)\n`;
    msg += `Watchlist: ${result.watchlistPairs} pairs\n`;
    if (result.crossSectorPairs > 0) {
      msg += `Cross-sector: ${result.crossSectorPairs} pairs\n`;
    }
    msg += `\n📊 Only mean-reverting pairs (H < 0.5) included.\n`;
    msg += `Use /watchlist to see updated pairs.`;
    await sendMessage(msg, chatId);
  } else {
    await sendMessage(`❌ Scan failed: ${result.error}`, chatId);
  }
}

/**
 * Handle /cross command - Toggle cross-sector scanning
 * Usage: /cross [on|off]
 */
async function handleCross(chatId, args) {
  const { setCrossSectorEnabled, getCrossSectorEnabled } = require('./scheduler');

  if (args.length === 0) {
    const enabled = getCrossSectorEnabled();
    return sendMessage(
      `🔀 Cross-sector scanning: ${enabled ? 'ON ✅' : 'OFF ❌'}\n\n` +
      `Use /cross on or /cross off to toggle.\n` +
      `Or use /scan cross to run a one-time cross-sector scan.`,
      chatId
    );
  }

  const action = args[0].toLowerCase();
  if (!['on', 'off'].includes(action)) {
    return sendMessage('Usage: /cross [on|off]', chatId);
  }

  const enabled = await setCrossSectorEnabled(action === 'on');
  await sendMessage(
    `🔀 Cross-sector scanning: ${enabled ? 'ON ✅' : 'OFF ❌'}\n\n` +
    `Next scheduled scan will ${enabled ? 'include' : 'exclude'} cross-sector pairs.`,
    chatId
  );
}

/**
 * Fetch current prices for a pair from Hyperliquid
 */
async function fetchCurrentPrices(asset1, asset2) {
  const { Hyperliquid } = require('hyperliquid');
  const sdk = new Hyperliquid();

  // Save original console functions
  const origLog = console.log;
  const origErr = console.error;

  try {
    // Suppress SDK console output during connect
    console.log = () => { };
    console.error = () => { };

    await sdk.connect();

    // Restore console for our operations
    console.log = origLog;
    console.error = origErr;

    const marketData = await sdk.info.perpetuals.getMetaAndAssetCtxs();
    const meta = await sdk.info.perpetuals.getMeta();

    const assetMap = {};
    meta.universe.forEach((asset, idx) => {
      assetMap[asset.name.replace('-PERP', '')] = idx;
    });

    const idx1 = assetMap[asset1];
    const idx2 = assetMap[asset2];

    let price1 = null, price2 = null;

    if (idx1 !== undefined && marketData[1][idx1]) {
      price1 = parseFloat(marketData[1][idx1].markPx);
    }
    if (idx2 !== undefined && marketData[1][idx2]) {
      price2 = parseFloat(marketData[1][idx2].markPx);
    }

    // Suppress during disconnect
    console.log = () => { };
    console.error = () => { };
    
    try {
      await sdk.disconnect();
    } catch (disconnectErr) {
      // Ignore disconnect errors
    }

    return { price1, price2 };
  } catch (err) {
    console.log = origLog;
    console.error = origErr;
    console.error('[TELEGRAM] Price fetch error:', err.message);
    
    // Try to disconnect on error
    try {
      await sdk.disconnect();
    } catch (disconnectErr) {
      // Ignore
    }
    
    return { price1: null, price2: null };
  } finally {
    // Always restore console
    console.log = origLog;
    console.error = origErr;
  }
}

/**
 * Handle /open command
 * Usage: /open BNB_BANANA long
 */
async function handleOpen(chatId, args) {
  if (args.length < 2) {
    return sendMessage('Usage: /open <pair> <long|short>\nExample: /open BNB_BANANA long', chatId);
  }

  const [pairArg, direction] = args;
  const pair = pairArg.replace('_', '/').toUpperCase();

  if (!['long', 'short'].includes(direction?.toLowerCase())) {
    return sendMessage('Direction must be "long" or "short"', chatId);
  }

  // Check if pair is in watchlist
  const watchlist = await db.getWatchlist();
  const watchPair = watchlist.find(p =>
    p.pair.toUpperCase() === pair || p.pair.toUpperCase() === pairArg.toUpperCase()
  );

  if (!watchPair) {
    return sendMessage(`❌ Pair ${pair} not in watchlist. Run /scan first.`, chatId);
  }

  // Check if already in active trades
  const activeTrades = await db.getTrades();
  if (activeTrades.some(t => t.pair === watchPair.pair)) {
    return sendMessage(`❌ Trade already open for ${watchPair.pair}`, chatId);
  }

  await sendMessage(`⏳ Fetching prices for ${watchPair.pair}...`, chatId);

  // Fetch current prices
  const { price1, price2 } = await fetchCurrentPrices(watchPair.asset1, watchPair.asset2);

  if (!price1 || !price2) {
    return sendMessage(`❌ Failed to fetch prices for ${watchPair.pair}`, chatId);
  }

  // Calculate current z-score using the spread
  const { checkPairFitness } = require('../../lib/pairAnalysis');

  let currentZ = watchPair.zScore || 0;
  let currentCorr = watchPair.correlation || 0.8;
  let currentHL = watchPair.halfLife || 10;

  // Try to get fresh z-score from recent price data
  const origLog2 = console.log;
  const origErr2 = console.error;
  let sdk2 = null;
  
  try {
    const { Hyperliquid: HL } = require('hyperliquid');
    sdk2 = new HL();
    
    console.log = () => { };
    console.error = () => { };
    await sdk2.connect();
    console.log = origLog2;
    console.error = origErr2;

    const endTime = Date.now();
    const startTime = endTime - (35 * 24 * 60 * 60 * 1000);

    const [candles1, candles2] = await Promise.all([
      sdk2.info.getCandleSnapshot(`${watchPair.asset1}-PERP`, '1d', startTime, endTime),
      sdk2.info.getCandleSnapshot(`${watchPair.asset2}-PERP`, '1d', startTime, endTime)
    ]);

    if (candles1?.length >= 20 && candles2?.length >= 20) {
      const prices1 = candles1.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const prices2 = candles2.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const minLen = Math.min(prices1.length, prices2.length);

      const fitness = checkPairFitness(prices1.slice(-minLen), prices2.slice(-minLen));
      currentZ = fitness.zScore;
      currentCorr = fitness.correlation;
      currentHL = fitness.halfLife;
    }
  } catch (err) {
    console.log = origLog2;
    console.error = origErr2;
    console.error('[TELEGRAM] Z-score calc error:', err.message);
  } finally {
    // Always restore console and disconnect
    console.log = origLog2;
    console.error = origErr2;
    if (sdk2) {
      try {
        console.log = () => { };
        console.error = () => { };
        await sdk2.disconnect();
      } catch (e) { /* ignore */ }
      console.log = origLog2;
      console.error = origErr2;
    }
  }

  // Calculate weights based on beta
  const beta = watchPair.beta || 1;
  const absBeta = Math.abs(beta);
  const w1 = (1 / (1 + absBeta)) * 100;
  const w2 = (absBeta / (1 + absBeta)) * 100;

  // Create trade
  const dir = direction.toLowerCase();
  const trade = {
    pair: watchPair.pair,
    asset1: watchPair.asset1,
    asset2: watchPair.asset2,
    sector: watchPair.sector,
    entryTime: new Date().toISOString(),
    entryZScore: currentZ,
    entryPrice1: price1,
    entryPrice2: price2,
    direction: dir,
    longAsset: dir === 'long' ? watchPair.asset1 : watchPair.asset2,
    shortAsset: dir === 'long' ? watchPair.asset2 : watchPair.asset1,
    longWeight: dir === 'long' ? w1 : w2,
    shortWeight: dir === 'long' ? w2 : w1,
    longEntryPrice: dir === 'long' ? price1 : price2,
    shortEntryPrice: dir === 'long' ? price2 : price1,
    beta: beta,
    halfLife: currentHL,
    correlation: currentCorr,
    entryThreshold: watchPair.entryThreshold || 2.0,
    currentZ: currentZ,
    currentCorrelation: currentCorr,
    currentHalfLife: currentHL,
    source: 'telegram'
  };

  await db.createTrade(trade);

  await sendMessage(
    `✅ Trade opened!\n\n` +
    `${trade.pair} (${trade.sector})\n` +
    `Long ${trade.longAsset} @ ${trade.longEntryPrice.toFixed(4)}\n` +
    `Short ${trade.shortAsset} @ ${trade.shortEntryPrice.toFixed(4)}\n` +
    `Weights: ${trade.longWeight.toFixed(0)}% / ${trade.shortWeight.toFixed(0)}%\n` +
    `Entry Z: ${trade.entryZScore.toFixed(2)}`,
    chatId
  );
}

/**
 * Handle /close command
 * Usage: /close BNB_BANANA
 */
async function handleClose(chatId, args) {
  if (args.length < 1) {
    return sendMessage('Usage: /close <pair>\nExample: /close BNB_BANANA', chatId);
  }

  const pairArg = args[0];
  const pair = pairArg.replace('_', '/').toUpperCase();

  const activeTrades = await db.getTrades();
  const trade = activeTrades.find(t =>
    t.pair.toUpperCase() === pair || t.pair.toUpperCase() === pairArg.toUpperCase()
  );

  if (!trade) {
    return sendMessage(`❌ No active trade for ${pair}`, chatId);
  }

  // Fetch real-time prices
  const { price1, price2 } = await fetchCurrentPrices(trade.asset1, trade.asset2);
  
  let realTimePnL = trade.currentPnL || 0;
  let exitZScore = trade.currentZ || null;
  
  if (price1 && price2) {
    // Calculate real-time P&L
    const curLong = trade.direction === 'long' ? price1 : price2;
    const curShort = trade.direction === 'long' ? price2 : price1;
    
    const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
    const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
    realTimePnL = longPnL + shortPnL;
  }
  
  // Calculate proper Z-score from historical data
  const { checkPairFitness } = require('../../lib/pairAnalysis');
  const origLog = console.log;
  const origErr = console.error;
  let sdk = null;
  
  try {
    const { Hyperliquid: HL } = require('hyperliquid');
    sdk = new HL();
    
    console.log = () => { };
    console.error = () => { };
    await sdk.connect();
    console.log = origLog;
    console.error = origErr;

    const endTime = Date.now();
    const startTime = endTime - (35 * 24 * 60 * 60 * 1000);

    const [candles1, candles2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${trade.asset1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${trade.asset2}-PERP`, '1d', startTime, endTime)
    ]);

    if (candles1?.length >= 20 && candles2?.length >= 20) {
      const prices1 = candles1.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const prices2 = candles2.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const minLen = Math.min(prices1.length, prices2.length);

      const fitness = checkPairFitness(prices1.slice(-minLen), prices2.slice(-minLen));
      exitZScore = fitness.zScore;
    }
  } catch (err) {
    console.log = origLog;
    console.error = origErr;
    console.error('[TELEGRAM] Exit Z-score calc error:', err.message);
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (sdk) {
      try {
        console.log = () => { };
        console.error = () => { };
        await sdk.disconnect();
      } catch (e) { /* ignore */ }
      console.log = origLog;
      console.error = origErr;
    }
  }

  const daysInTrade = parseFloat(((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1));
  
  const record = {
    ...trade,
    exitTime: new Date().toISOString(),
    exitReason: 'MANUAL',
    exitZScore: exitZScore,
    totalPnL: realTimePnL,
    daysInTrade: daysInTrade
  };

  // Add to history (this also updates stats)
  await db.addToHistory(record);

  // Delete from active trades
  await db.deleteTrade(trade.pair);

  const exitPriceInfo = price1 && price2 
    ? `\n${trade.asset1}: $${price1.toFixed(4)}\n${trade.asset2}: $${price2.toFixed(4)}`
    : '';

  // Beta drift summary
  let betaDriftInfo = '';
  if (trade.maxBetaDrift !== undefined && trade.maxBetaDrift !== null) {
    const maxDriftPct = (trade.maxBetaDrift * 100).toFixed(0);
    if (trade.maxBetaDrift > 0.15) {
      betaDriftInfo = `\n⚡ Max β drift: ${maxDriftPct}%`;
    }
  }

  await sendMessage(
    `🔴 Trade closed!\n\n` +
    `${trade.pair}${exitPriceInfo}\n` +
    `P&L: ${realTimePnL >= 0 ? '+' : ''}${realTimePnL.toFixed(2)}%` +
    (exitZScore !== null ? `\nExit Z: ${exitZScore.toFixed(2)}` : '') +
    `\nDays: ${daysInTrade}` +
    betaDriftInfo,
    chatId
  );
}

/**
 * Handle /partial command
 * Usage: /partial BNB_BANANA
 */
async function handlePartial(chatId, args) {
  if (args.length < 1) {
    return sendMessage('Usage: /partial <pair>\nExample: /partial BNB_BANANA', chatId);
  }

  const pairArg = args[0];
  const pair = pairArg.replace('_', '/').toUpperCase();

  const activeTrades = await db.getTrades();
  const trade = activeTrades.find(t =>
    t.pair.toUpperCase() === pair || t.pair.toUpperCase() === pairArg.toUpperCase()
  );

  if (!trade) {
    return sendMessage(`❌ No active trade for ${pair}`, chatId);
  }

  if (trade.partialExitTaken) {
    return sendMessage(`❌ Partial already taken for ${trade.pair}`, chatId);
  }

  const updates = {
    partialExitTaken: true,
    partialExitTime: new Date().toISOString(),
    partialExitPnL: trade.currentPnL || 0
  };

  await db.updateTrade(trade.pair, updates);

  await sendMessage(
    `💰 Partial exit recorded!\n\n` +
    `${trade.pair}\n` +
    `50% closed at ${updates.partialExitPnL >= 0 ? '+' : ''}${updates.partialExitPnL.toFixed(2)}%`,
    chatId
  );
}

/**
 * Handle /blacklist command
 * Usage: /blacklist [asset]
 */
async function handleBlacklist(chatId, args) {
  const blacklist = await db.getBlacklist();

  if (args.length === 0) {
    // Show current blacklist
    if (!blacklist.assets || blacklist.assets.length === 0) {
      return sendMessage('🚫 Blacklist is empty', chatId);
    }

    let msg = `🚫 BLACKLIST (${blacklist.assets.length})\n\n`;
    for (const asset of blacklist.assets) {
      const reason = blacklist.reasons?.[asset] || '';
      msg += `• ${asset}${reason ? ` - ${reason}` : ''}\n`;
    }
    return sendMessage(msg, chatId);
  }

  // Add to blacklist
  const asset = args[0].toUpperCase();
  const reason = args.slice(1).join(' ') || 'Added via Telegram';

  if (blacklist.assets?.includes(asset)) {
    return sendMessage(`${asset} already in blacklist`, chatId);
  }

  await db.addToBlacklist(asset, reason);

  await sendMessage(`✅ Added ${asset} to blacklist`, chatId);
}

// ============================================
// USER TRADES (separate from bot trades)
// Stored in Supabase with source='manual'
// ============================================

/**
 * Handle /mytrades command - Show user's manual trades
 */
async function handleMyTrades(chatId) {
  const allTrades = await db.getTrades();
  const myTrades = allTrades.filter(t => t.source === 'manual');

  if (myTrades.length === 0) {
    return sendMessage('👤 No manual trades', chatId);
  }

  let msg = `👤 MY TRADES (${myTrades.length})\n\n`;

  for (const t of myTrades) {
    const pnl = t.currentPnL || 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const days = ((Date.now() - new Date(t.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);

    msg += `${pnl >= 0 ? '🟢' : '🔴'} ${t.pair}\n`;
    msg += `   L ${t.longAsset} (${(t.longWeight || 50).toFixed(0)}%) @ ${t.longEntryPrice || 0}\n`;
    msg += `   S ${t.shortAsset} (${(t.shortWeight || 50).toFixed(0)}%) @ ${t.shortEntryPrice || 0}\n`;
    msg += `   ${pnlSign}${pnl.toFixed(2)}% | ${days}d\n\n`;
  }

  await sendMessage(msg, chatId);
}

/**
 * Handle /myopen command - Open a manual trade
 * Usage: /myopen BNB_BANANA 75 876.65 25 10.03 long
 */
async function handleMyOpen(chatId, args) {
  if (args.length < 6) {
    return sendMessage(
      'Usage: /myopen <pair> <w1%> <price1> <w2%> <price2> <long|short>\n' +
      'Example: /myopen BNB_BANANA 75 876.65 25 10.03 long',
      chatId
    );
  }

  const [pairArg, w1, p1, w2, p2, direction] = args;
  const pair = pairArg.toUpperCase().replace('_', '/');
  const [asset1, asset2] = pair.split('/');

  if (!asset1 || !asset2) {
    return sendMessage('Invalid pair format. Use: ASSET1_ASSET2', chatId);
  }

  const dir = direction?.toLowerCase();
  if (!['long', 'short'].includes(dir)) {
    return sendMessage('Direction must be "long" or "short"', chatId);
  }

  // Check if already exists
  const allTrades = await db.getTrades();
  if (allTrades.some(t => t.pair === pair && t.source === 'manual')) {
    return sendMessage(`❌ Manual trade already exists for ${pair}`, chatId);
  }

  const weight1 = parseFloat(w1);
  const weight2 = parseFloat(w2);
  const price1 = parseFloat(p1);
  const price2 = parseFloat(p2);

  const trade = {
    pair,
    asset1,
    asset2,
    sector: 'Manual',
    entryTime: new Date().toISOString(),
    entryZScore: 0,
    entryPrice1: price1,
    entryPrice2: price2,
    direction: dir,
    longAsset: dir === 'long' ? asset1 : asset2,
    shortAsset: dir === 'long' ? asset2 : asset1,
    longWeight: dir === 'long' ? weight1 : weight2,
    shortWeight: dir === 'long' ? weight2 : weight1,
    longEntryPrice: dir === 'long' ? price1 : price2,
    shortEntryPrice: dir === 'long' ? price2 : price1,
    correlation: 0,
    beta: 1,
    halfLife: 0,
    source: 'manual'
  };

  await db.createTrade(trade);

  await sendMessage(
    `✅ Manual trade opened!\n\n` +
    `${pair}\n` +
    `L ${trade.longAsset} (${trade.longWeight}%) @ ${trade.longEntryPrice}\n` +
    `S ${trade.shortAsset} (${trade.shortWeight}%) @ ${trade.shortEntryPrice}`,
    chatId
  );
}

/**
 * Handle /myclose command - Close a manual trade
 * Usage: /myclose BNB_BANANA
 */
async function handleMyClose(chatId, args) {
  if (args.length < 1) {
    return sendMessage('Usage: /myclose <pair>\nExample: /myclose BNB_BANANA', chatId);
  }

  const pairArg = args[0];
  const pair = pairArg.toUpperCase().replace('_', '/');

  const allTrades = await db.getTrades();
  const trade = allTrades.find(t =>
    (t.pair === pair || t.pair === pairArg.toUpperCase()) && t.source === 'manual'
  );

  if (!trade) {
    return sendMessage(`❌ No manual trade for ${pair}`, chatId);
  }

  // Fetch real-time prices
  const { price1, price2 } = await fetchCurrentPrices(trade.asset1, trade.asset2);
  
  let realTimePnL = trade.currentPnL || 0;
  let exitZScore = trade.currentZ || null;
  
  if (price1 && price2) {
    // Calculate real-time P&L
    const curLong = trade.direction === 'long' ? price1 : price2;
    const curShort = trade.direction === 'long' ? price2 : price1;
    
    const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
    const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
    realTimePnL = longPnL + shortPnL;
  }

  // Calculate proper Z-score from historical data
  const { checkPairFitness } = require('../../lib/pairAnalysis');
  const origLog = console.log;
  const origErr = console.error;
  let sdk = null;
  
  try {
    const { Hyperliquid: HL } = require('hyperliquid');
    sdk = new HL();
    
    console.log = () => { };
    console.error = () => { };
    await sdk.connect();
    console.log = origLog;
    console.error = origErr;

    const endTime = Date.now();
    const startTime = endTime - (35 * 24 * 60 * 60 * 1000);

    const [candles1, candles2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${trade.asset1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${trade.asset2}-PERP`, '1d', startTime, endTime)
    ]);

    if (candles1?.length >= 20 && candles2?.length >= 20) {
      const prices1 = candles1.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const prices2 = candles2.sort((a, b) => a.t - b.t).slice(-30).map(c => parseFloat(c.c));
      const minLen = Math.min(prices1.length, prices2.length);

      const fitness = checkPairFitness(prices1.slice(-minLen), prices2.slice(-minLen));
      exitZScore = fitness.zScore;
    }
  } catch (err) {
    console.log = origLog;
    console.error = origErr;
    console.error('[TELEGRAM] Exit Z-score calc error:', err.message);
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (sdk) {
      try {
        console.log = () => { };
        console.error = () => { };
        await sdk.disconnect();
      } catch (e) { /* ignore */ }
      console.log = origLog;
      console.error = origErr;
    }
  }

  const daysInTrade = parseFloat(((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1));

  // Add to history
  const record = {
    ...trade,
    exitTime: new Date().toISOString(),
    exitReason: 'MANUAL_CLOSE',
    exitZScore: exitZScore,
    totalPnL: realTimePnL,
    daysInTrade: daysInTrade
  };
  await db.addToHistory(record);

  // Delete from active
  await db.deleteTrade(trade.pair);

  const exitPriceInfo = price1 && price2 
    ? `\n${trade.asset1}: $${price1.toFixed(4)}\n${trade.asset2}: $${price2.toFixed(4)}`
    : '';

  // Beta drift summary
  let betaDriftInfo = '';
  if (trade.maxBetaDrift !== undefined && trade.maxBetaDrift !== null) {
    const maxDriftPct = (trade.maxBetaDrift * 100).toFixed(0);
    if (trade.maxBetaDrift > 0.15) {
      betaDriftInfo = `\n⚡ Max β drift: ${maxDriftPct}%`;
    }
  }

  await sendMessage(
    `🔴 Manual trade closed!\n\n` +
    `${trade.pair}${exitPriceInfo}\n` +
    `P&L: ${realTimePnL >= 0 ? '+' : ''}${realTimePnL.toFixed(2)}%` +
    (exitZScore !== null ? `\nExit Z: ${exitZScore.toFixed(2)}` : '') +
    `\nDuration: ${daysInTrade} days` +
    betaDriftInfo,
    chatId
  );
}

/**
 * Handle /help command
 */
async function handleHelp(chatId) {
  const msg = `🤖 Pair Trading Bot Commands

📊 Status & Info
/status or /s - Run status check now
/trades or /t - Show bot trades
/mytrades - Show your manual trades
/history or /h - Show trade history
/watchlist - Show pairs approaching entry

🔍 Discovery
/scan - Discover new pairs (same-sector)
/scan cross - Include cross-sector pairs
/cross [on|off] - Toggle cross-sector default

🤖 Bot Trading
/open <pair> <long|short> - Open bot trade
/close <pair> - Close bot trade
/partial <pair> - Take 50% partial profit

👤 Manual Trading
/myopen <pair> <w1%> <p1> <w2%> <p2> <dir>
/myclose <pair> - Close manual trade

🚫 Blacklist
/blacklist - View blacklist
/blacklist <asset> [reason] - Add to blacklist

Bot monitors every 15 min, scans every 12h.`;

  await sendMessage(msg, chatId);
}

/**
 * Handle incoming command
 */
async function handleCommand(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim() || '';
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase().replace('@', '').split('@')[0]; // Handle @botname suffix
  const args = parts.slice(1);

  console.log(`[TELEGRAM] Command: ${command} from ${chatId}`);

  // Only respond to authorized chat
  if (TELEGRAM_CHAT_ID && chatId.toString() !== TELEGRAM_CHAT_ID.toString()) {
    console.log(`[TELEGRAM] Unauthorized chat: ${chatId}`);
    return;
  }

  switch (command) {
    case '/status':
    case '/s':
      await handleStatus(chatId);
      break;

    case '/trades':
    case '/t':
      await handleTrades(chatId);
      break;

    case '/history':
    case '/h':
      await handleHistory(chatId);
      break;

    case '/watchlist':
    case '/w':
      await handleWatchlist(chatId);
      break;

    case '/scan':
      await handleScan(chatId, args);
      break;

    case '/cross':
      await handleCross(chatId, args);
      break;

    case '/open':
      await handleOpen(chatId, args);
      break;

    case '/close':
      await handleClose(chatId, args);
      break;

    case '/partial':
      await handlePartial(chatId, args);
      break;

    case '/blacklist':
    case '/bl':
      await handleBlacklist(chatId, args);
      break;

    case '/mytrades':
    case '/my':
      await handleMyTrades(chatId);
      break;

    case '/myopen':
      await handleMyOpen(chatId, args);
      break;

    case '/myclose':
      await handleMyClose(chatId, args);
      break;

    case '/help':
    case '/start':
      await handleHelp(chatId);
      break;

    default:
      if (text.startsWith('/')) {
        await sendMessage(`Unknown command: ${command}\nUse /help for commands.`, chatId);
      }
  }
}

/**
 * Poll for updates
 */
async function pollUpdates() {
  if (!isRunning) return;

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`,
      {
        params: {
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ['message']
        },
        timeout: 35000
      }
    );

    const updates = response.data.result || [];

    for (const update of updates) {
      lastUpdateId = update.update_id;
      if (update.message?.text) {
        await handleCommand(update.message);
      }
    }
  } catch (e) {
    if (e.code !== 'ECONNABORTED') {
      console.error('[TELEGRAM] Poll error:', e.message);
    }
  }

  // Continue polling
  setTimeout(pollUpdates, POLL_INTERVAL);
}

/**
 * Start Telegram bot
 */
async function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[TELEGRAM] No bot token, skipping');
    return;
  }

  console.log('[TELEGRAM] Starting bot...');
  console.log(`[TELEGRAM] Chat ID: ${TELEGRAM_CHAT_ID || 'Any'}`);

  isRunning = true;

  // Send startup message
  await sendMessage('🤖 Bot started! Use /help for commands.');

  // Start polling
  pollUpdates();
}

/**
 * Stop Telegram bot
 */
function stopTelegramBot() {
  isRunning = false;
  console.log('[TELEGRAM] Bot stopped');
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
  sendMessage
};

