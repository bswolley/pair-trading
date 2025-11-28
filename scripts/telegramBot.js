#!/usr/bin/env node

/**
 * Telegram Bot - Command listener for pair trading bot
 * 
 * Commands:
 *   /status  - Run monitor and get status
 *   /trades  - Show active trades
 *   /history - Show trade history
 *   /scan    - Run pair discovery
 *   /help    - Show commands
 * 
 * Usage: node scripts/telegramBot.js
 */

const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');

require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL = 2000; // 2 seconds

if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
}

let lastUpdateId = 0;

/**
 * Send message to Telegram
 */
async function sendMessage(text, chatId = TELEGRAM_CHAT_ID) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text.slice(0, 4000) // Telegram limit
        });
    } catch (e) {
        console.error('Send error:', e.response?.data?.description || e.message);
    }
}

/**
 * Run a script and return output
 */
function runScript(scriptName, args = []) {
    return new Promise((resolve) => {
        const scriptPath = path.join(__dirname, scriptName);
        const cmd = `node ${scriptPath} ${args.join(' ')}`;

        exec(cmd, { cwd: path.join(__dirname, '..'), timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                resolve(`Error: ${error.message}`);
            } else {
                resolve(stdout || stderr || 'Done');
            }
        });
    });
}

/**
 * Handle incoming command
 */
async function handleCommand(message) {
    const chatId = message.chat.id;
    const text = message.text?.trim() || '';
    const command = text.split(' ')[0].toLowerCase();

    console.log(`[${new Date().toISOString()}] Command: ${command} from ${chatId}`);

    // Only respond to authorized chat
    if (TELEGRAM_CHAT_ID && chatId.toString() !== TELEGRAM_CHAT_ID.toString()) {
        console.log(`  Unauthorized chat: ${chatId}`);
        return;
    }

    switch (command) {
        case '/status':
        case '/s':
            await sendMessage('⏳ Running monitor...', chatId);
            await runScript('monitorWatchlist.js');
            break;

        case '/trades':
        case '/t':
            const tradesOutput = await runScript('showTrades.js');
            await sendMessage(formatOutput(tradesOutput), chatId);
            break;

        case '/history':
        case '/h':
            const historyOutput = await runScript('showHistory.js');
            await sendMessage(formatOutput(historyOutput), chatId);
            break;

        case '/scan':
            await sendMessage('⏳ Running pair scan (this takes a few minutes)...', chatId);
            const scanOutput = await runScript('scanPairs.js');
            await sendMessage('✅ Scan complete! Use /status to see updated watchlist.', chatId);
            break;

        case '/help':
        case '/start':
            await sendMessage(
                `Pair Trading Bot Commands:

/status or /s - Run monitor now
/trades or /t - Show active trades
/history or /h - Show trade history
/scan - Discover new pairs (slow)
/help - Show this message

Bot runs automatically every hour.`,
                chatId
            );
            break;

        default:
            if (text.startsWith('/')) {
                await sendMessage(`Unknown command: ${command}\nUse /help for commands.`, chatId);
            }
    }
}

/**
 * Format script output for Telegram
 */
function formatOutput(output) {
    return output
        // Remove ANSI colors
        .replace(/\x1b\[[0-9;]*m/g, '')
        // Remove dotenv noise
        .replace(/\[dotenv.*?\n/g, '')
        // Remove WebSocket noise
        .replace(/Native WebSocket.*?\n/g, '')
        .replace(/WebSocket disconnected.*?\n/g, '')
        .replace(/Manual disconnect.*?\n/g, '')
        // Remove box drawing characters
        .replace(/[├└│─]/g, ' ')
        .replace(/────+/g, '---')
        // Remove HTML tags (we're not using HTML parse mode)
        .replace(/<\/?b>/g, '')
        .replace(/<\/?i>/g, '')
        // Clean up extra whitespace
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 4000);
}

/**
 * Poll for updates
 */
async function pollUpdates() {
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
            console.error('Poll error:', e.message);
        }
    }

    // Continue polling
    setTimeout(pollUpdates, POLL_INTERVAL);
}

/**
 * Main
 */
async function main() {
    console.log('🤖 Telegram Bot Started');
    console.log(`Chat ID: ${TELEGRAM_CHAT_ID || 'Any'}`);
    console.log('Listening for commands...\n');

    await sendMessage('🤖 Bot started! Use /help for commands.');

    pollUpdates();
}

main().catch(console.error);

