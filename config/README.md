# Configuration - Single Source of Truth

This directory contains the single source of truth for all pair trading configuration.

## Files

- **`pairs.json`** - All pairs, timeframes, and settings
- **`index.js`** - Configuration loader (use this to import config)
- **`active_trades.json`** - Your actual active trades (entry prices, dates, position sizing)
- **`simulated_trades.json`** - Hypothetical/simulated trades for backtesting and analysis
- **`active_trades.json.example`** - Template for active trades

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

