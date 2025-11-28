# Configuration - Single Source of Truth

This directory contains the single source of truth for all pair trading configuration.

## Files

- **`pairs.json`** - All pairs, timeframes, and settings
- **`index.js`** - Configuration loader (use this to import config)
- **`sectors.json`** - Sector mapping for Hyperliquid perpetuals
- **`discovered_pairs.json`** - All fitting pairs from scanner (auto-generated)
- **`watchlist.json`** - Top 3 pairs per sector for monitoring (auto-generated)
- **`active_trades.json`** - Your actual active trades (entry prices, dates, position sizing)
- **`simulated_trades.json`** - Hypothetical/simulated trades for backtesting and analysis

## Telegram Setup

To receive alerts, configure Telegram:

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Save the bot token
3. Start a chat with your bot and send any message
4. Get your chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. Create `.env` file in project root:

```
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run scan` | Discover pairs, update watchlist |
| `npm run monitor` | Check watchlist, send alerts |
| `npm run monitor:dry` | Check without sending alerts |

## Scheduling

Add to crontab (`crontab -e`):

```bash
# Scan for new pairs daily at midnight UTC
0 0 * * * cd /path/to/pair-trading && npm run scan >> logs/scan.log 2>&1

# Monitor watchlist every hour
0 * * * * cd /path/to/pair-trading && npm run monitor >> logs/monitor.log 2>&1
```

## Usage

### In Scripts

```javascript
const config = require('../config');

// Get default pairs
const pairs = config.getDefaultPairs();

// Get timeframes
const timeframes = config.getTimeframes();

// Get API settings
const apiSettings = config.getAPISettings();
```

### Adding/Modifying Pairs

Edit `pairs.json`:

```json
{
  "defaultPairs": [
    {
      "name": "SOL/ETH",
      "symbol1": "SOL",
      "symbol2": "ETH",
      "direction": "long",
      "leftSide": "SOL"
    }
  ]
}
```

All scripts will automatically use the updated pairs.

## Benefits

- **Single source of truth** - Update pairs in one place
- **Easy collaboration** - Team members can update config without touching code
- **Consistent settings** - All scripts use same timeframes and settings
- **Version controlled** - Config changes are tracked in git

