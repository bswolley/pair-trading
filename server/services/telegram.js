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
    const days = ((Date.now() - new Date(t.entryTime)) / (1000*60*60*24)).toFixed(1);
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
      msg += `${status} ${p.pair} (${p.sector})\n`;
      msg += `   Z: ${(p.zScore || 0).toFixed(2)} → entry@${p.entryThreshold} [${pct}%]\n\n`;
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
    msg += `Fitting pairs: ${result.fittingPairs}\n`;
    msg += `Watchlist: ${result.watchlistPairs} pairs\n`;
    if (result.crossSectorPairs > 0) {
      msg += `Cross-sector: ${result.crossSectorPairs} pairs\n`;
    }
    msg += `\nUse /watchlist to see updated pairs.`;
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
  
  const enabled = setCrossSectorEnabled(action === 'on');
  await sendMessage(
    `🔀 Cross-sector scanning: ${enabled ? 'ON ✅' : 'OFF ❌'}\n\n` +
    `Next scheduled scan will ${enabled ? 'include' : 'exclude'} cross-sector pairs.`,
    chatId
  );
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
  
  // Create trade
  const dir = direction.toLowerCase();
  const trade = {
    pair: watchPair.pair,
    asset1: watchPair.asset1,
    asset2: watchPair.asset2,
    sector: watchPair.sector,
    entryTime: new Date().toISOString(),
    entryZScore: watchPair.zScore || 0,
    direction: dir,
    longAsset: dir === 'long' ? watchPair.asset1 : watchPair.asset2,
    shortAsset: dir === 'long' ? watchPair.asset2 : watchPair.asset1,
    longWeight: 50,
    shortWeight: 50,
    longEntryPrice: 0,
    shortEntryPrice: 0,
    beta: watchPair.beta || 1,
    halfLife: watchPair.halfLife || 10,
    correlation: watchPair.correlation || 0.8,
    entryThreshold: watchPair.entryThreshold || 2.0,
    source: 'telegram'
  };
  
  await db.createTrade(trade);
  
  await sendMessage(
    `✅ Trade opened!\n\n` +
    `${trade.pair} (${trade.sector})\n` +
    `Long ${trade.longAsset} / Short ${trade.shortAsset}\n` +
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
  
  const pnl = trade.currentPnL || 0;
  const record = {
    ...trade,
    exitTime: new Date().toISOString(),
    exitReason: 'MANUAL',
    totalPnL: pnl,
    daysInTrade: ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1)
  };
  
  // Add to history (this also updates stats)
  await db.addToHistory(record);
  
  // Delete from active trades
  await db.deleteTrade(trade.pair);
  
  await sendMessage(
    `🔴 Trade closed!\n\n` +
    `${trade.pair}\n` +
    `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
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

/**
 * Handle /help command
 */
async function handleHelp(chatId) {
  const msg = `🤖 Pair Trading Bot Commands

📊 Status & Info
/status or /s - Run status check now
/trades or /t - Show active trades
/history or /h - Show trade history
/watchlist - Show pairs approaching entry

🔍 Discovery
/scan - Discover new pairs (same-sector)
/scan cross - Include cross-sector pairs
/cross [on|off] - Toggle cross-sector default

📈 Trading
/open <pair> <long|short> - Open trade
/close <pair> - Close trade
/partial <pair> - Take 50% partial profit

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

