# Pair Trading Bot - Complete System Documentation

> **Version:** 1.0.0  
> **Branch:** `pairs-scanner`  
> **Last Updated:** November 28, 2025

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Data Sources](#3-data-sources)
4. [Pair Discovery](#4-pair-discovery)
5. [Statistical Analysis](#5-statistical-analysis)
6. [Trading Logic](#6-trading-logic)
7. [Position Sizing](#7-position-sizing)
8. [Monitoring & Alerts](#8-monitoring--alerts)
9. [Configuration Files](#9-configuration-files)
10. [Scripts Reference](#10-scripts-reference)
11. [Thresholds & Parameters](#11-thresholds--parameters)
12. [Formulas](#12-formulas)

---

## 1. System Overview

An automated statistical arbitrage system for Hyperliquid perpetual futures. The bot discovers cointegrated pairs, monitors for entry signals, executes simulated trades, and sends status updates via Telegram.

### Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DAILY CYCLE                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │   DISCOVER  │───▶│   FILTER    │───▶│  WATCHLIST  │             │
│  │   Universe  │    │  & Score    │    │  Top 3/sect │             │
│  └─────────────┘    └─────────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        HOURLY CYCLE                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │   MONITOR   │───▶│   ENTRY/    │───▶│  TELEGRAM   │             │
│  │  Watchlist  │    │   EXIT      │    │   REPORT    │             │
│  └─────────────┘    └─────────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture

### Directory Structure

```
pair-trading/
├── scripts/                    # Executable scripts
│   ├── scanPairs.js           # Pair discovery (daily)
│   ├── monitorWatchlist.js    # Monitor & trade (hourly)
│   ├── analyzePair.js         # Deep single-pair analysis
│   ├── enterTrade.js          # Manual trade entry
│   ├── exitTrade.js           # Manual trade exit
│   ├── showTrades.js          # View active trades
│   └── showHistory.js         # View trade history
├── lib/
│   └── pairAnalysis.js        # Core statistical functions
├── config/
│   ├── sectors.json           # Sector mapping (hardcoded)
│   ├── discovered_pairs.json  # All discovered pairs
│   ├── watchlist.json         # Selected top pairs
│   ├── active_trades_sim.json # Open simulated trades
│   └── trade_history.json     # Closed trades + stats
├── logs/
│   └── monitor.log            # Background loop logs
└── docs/
    └── SYSTEM_DOCUMENTATION.md
```

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run scan` | Discover pairs (daily) |
| `npm run monitor` | Auto-trade mode (hourly) |
| `npm run monitor:dry` | Test mode (no trades) |
| `npm run analyze <A> <B>` | Analyze single pair |
| `npm run trades` | Show active trades |
| `npm run history` | Show trade history |

---

## 3. Data Sources

### Primary: Hyperliquid SDK

| Data | Endpoint | Timeframe |
|------|----------|-----------|
| Price candles | `getCandleSnapshot()` | 1d candles, up to 35 days |
| Current prices | Derived from latest candle close | Real-time |
| Volume | Candle volume field | 24h |
| Open Interest | `getAssetCtx()` | Real-time |
| Funding Rate | `getAssetCtx()` | Real-time (8h rate) |

**Symbol Format:**
- Standard: `BTC-PERP`, `ETH-PERP`
- Kilo tokens: `kSHIB-PERP`, `kBONK-PERP` (lowercase 'k')

### Secondary: CryptoCompare API (Optional)

| Data | Endpoint | Usage |
|------|----------|-------|
| Market Cap | `/data/pricemultifull` | Display only |
| Historical OHLCV | `/data/v2/histoday` | OBV calculation |

**Note:** CryptoCompare is optional. System works fully with Hyperliquid data only.

---

## 4. Pair Discovery

### Process: `scripts/scanPairs.js`

#### Step 1: Fetch Universe

```javascript
// Fetches all Hyperliquid perpetuals
const meta = await sdk.info.getMeta();
const ctxs = await sdk.info.getAssetCtxs();
```

**Data collected per asset:**
- Symbol name
- Mark price
- 24h volume (USD)
- Open interest (USD)
- Funding rate (8h)

#### Step 2: Liquidity Filter

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_VOLUME` | $500,000 | Minimum 24h trading volume |
| `MIN_OI` | $100,000 | Minimum open interest |

```javascript
const liquid = assets.filter(a => 
  a.volume24h >= MIN_VOLUME && 
  a.openInterest >= MIN_OI
);
```

#### Step 3: Sector Grouping

Assets are grouped by sector from `config/sectors.json`:

| Sector | Example Assets |
|--------|----------------|
| L1 | BTC, ETH, SOL, SUI, AVAX, ATOM |
| L2 | ARB, OP, MATIC, LINEA, BASE |
| DeFi | AAVE, UNI, CRV, LDO, MKR |
| Meme | DOGE, SHIB, PEPE, BONK, WIF |
| AI | FET, RENDER, TAO, VIRTUAL, WLD |
| Gaming | AXS, SAND, MANA, IMX, GALA |
| Infrastructure | LINK, GRT, FIL, AR, RNDR |
| Exchange | BNB, CRO, HYPE, BANANA |
| RWA | ONDO, OM, STBL |
| NFT | BLUR, ZORA, ME |
| Other | Uncategorized assets |

#### Step 4: Pair Generation

Pairs are generated **within sectors only**:

```javascript
for (let i = 0; i < assets.length; i++) {
  for (let j = i + 1; j < assets.length; j++) {
    if (assets[i].sector === assets[j].sector) {
      pairs.push({ asset1: assets[i], asset2: assets[j] });
    }
  }
}
```

#### Step 5: Statistical Filtering

Each pair is analyzed with 30 days of price history:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Correlation | ≥ 0.6 | Keep |
| Cointegration | ADF < -2.5 OR MRR > 50% | Keep |
| Half-life | ≤ 45 days | Keep |

#### Step 6: Composite Scoring

```javascript
score = correlation × (1 / halfLife) × meanReversionRate × 100
```

**Interpretation:**
- Higher correlation → higher score
- Shorter half-life → higher score (faster reversion)
- Higher mean reversion rate → higher score

#### Step 7: Watchlist Selection

Top 3 pairs per sector are selected for the watchlist:

```javascript
pairsBySector[sector].sort((a, b) => b.score - a.score);
watchlist = pairsBySector[sector].slice(0, 3);
```

---

## 5. Statistical Analysis

### Core Function: `checkPairFitness()`

Located in `lib/pairAnalysis.js`, used by both scanner and monitor.

#### Input
- `prices1`: Array of daily close prices for asset 1
- `prices2`: Array of daily close prices for asset 2
- Minimum: 10 data points
- Recommended: 30 data points

#### Output

```javascript
{
  correlation: 0.85,      // Pearson correlation of returns
  beta: 1.23,             // Hedge ratio
  zScore: 1.67,           // Current spread deviation
  isCointegrated: true,   // Passed ADF test
  meanReversionRate: 0.62,// % of days reverting toward mean
  halfLife: 3.2,          // Days to half mean reversion
  spreads: [...]          // Log spread series
}
```

### Calculation Details

#### 5.1 Returns

```javascript
returns[i] = (price[i] - price[i-1]) / price[i-1]
```

#### 5.2 Correlation (Pearson)

```
          Σ(r1 - μ1)(r2 - μ2)
ρ = ─────────────────────────────
    √[Σ(r1 - μ1)²] × √[Σ(r2 - μ2)²]
```

#### 5.3 Beta (Hedge Ratio)

```
        Cov(r1, r2)
β = ─────────────────
        Var(r2)
```

#### 5.4 Spread

```javascript
spread[i] = ln(price1[i]) - β × ln(price2[i])
```

Using log prices for percentage-based interpretation.

#### 5.5 Z-Score

```javascript
zScoreWindow = 20;  // Rolling window
μ = mean(spread[-20:])
σ = stdDev(spread[-20:])
Z = (currentSpread - μ) / σ
```

#### 5.6 Cointegration (Simplified ADF)

```javascript
spreadDiffs[i] = spread[i] - spread[i-1]
autocorrCoeff = autocorrelation(spreadDiffs)
adfStat = -autocorrCoeff × √(n)

// Cointegrated if:
isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && |autocorrCoeff| < 0.3)
```

#### 5.7 Half-Life

```javascript
// From Ornstein-Uhlenbeck process
halfLife = -ln(2) / ln(1 + autocorrCoeff)
```

**Interpretation:**
- Half-life of 3 days → Spread takes ~3 days to revert halfway to mean
- Lower is better (faster reversion = more trades)

#### 5.8 Mean Reversion Rate

```javascript
// Percentage of days where spread moved toward mean
reversionDays = days where |spread - mean| decreased
meanReversionRate = reversionDays / totalDays
```

---

## 6. Trading Logic

### Entry Conditions

A trade is entered when **ALL** conditions are met:

| Condition | Threshold | Timeframe |
|-----------|-----------|-----------|
| Z-Score | \|Z\| ≥ 1.5 | 30d |
| Correlation | ≥ 0.6 | 30d |
| Cointegrated | Yes | 30d |
| Half-life | ≤ 30 days | 30d |
| 7d Confirmation | Same direction | 7d (if available) |

#### Direction Logic

```javascript
if (zScore > 0) {
  // Spread is ABOVE mean → expect to decrease
  // Short asset1, Long asset2
  direction = 'short';
} else {
  // Spread is BELOW mean → expect to increase
  // Long asset1, Short asset2
  direction = 'long';
}
```

### Exit Conditions

A trade is exited when **ANY** condition is met:

| Exit Type | Condition | Emoji |
|-----------|-----------|-------|
| **TARGET** | \|Z\| ≤ 0.5 | 🎯 |
| **STOP_LOSS** | \|Z\| ≥ 3.0 | 🛑 |
| **TIME_STOP** | Duration > 2 × half-life | ⏰ |
| **BREAKDOWN** | Correlation < 0.4 | 💔 |

### Trade Lifecycle

```
WATCHLIST              ACTIVE                 HISTORY
┌─────────┐           ┌─────────┐            ┌─────────┐
│ Z: 0.8  │           │ Entry   │            │ Exit    │
│ Wait... │──|Z|≥1.5─▶│ Z: 1.6  │──Exit──▶   │ P&L: +% │
│         │           │ Track   │  Cond.     │ Stats   │
└─────────┘           └─────────┘            └─────────┘
```

---

## 7. Position Sizing

### Beta-Weighted Allocation

For a pair position totaling 100%:

```javascript
absBeta = |β|
weight1 = 1 / (1 + absBeta)      // Asset 1 weight
weight2 = absBeta / (1 + absBeta) // Asset 2 weight
```

### Example

For β = 0.31:
```
Asset 1 (Long):  1 / (1 + 0.31) = 76%
Asset 2 (Short): 0.31 / (1 + 0.31) = 24%
```

This ensures dollar-neutral exposure adjusted for beta.

---

## 8. Monitoring & Alerts

### Script: `monitorWatchlist.js`

#### Modes

| Flag | Mode | Description |
|------|------|-------------|
| (none) | Auto-trade | Full automation |
| `--manual` | Manual | Alerts only, no trades |
| `--dry-run` | Test | No trades, no Telegram |

#### Hourly Process

1. **Check Active Trades**
   - Fetch current prices
   - Recalculate Z-score
   - Update P&L
   - Check all exit conditions

2. **Check Watchlist**
   - Skip pairs already in active trades
   - Fetch prices (7d and 30d)
   - Validate entry conditions
   - Enter if valid

3. **Send Telegram Report**
   - Single consolidated message
   - Shows actions, positions, history

### Telegram Message Format

```
━━━━━━━━━━━━━━━━━━━━
📊 STATUS • Nov 28, 12:48 UTC
━━━━━━━━━━━━━━━━━━━━

⚡ ACTIONS
✅ XLM/HBAR → Short XLM
🎯 SOL/ETH [TARGET] +1.24%

📈 POSITIONS (3)

🟢 XLM/HBAR
   S HBAR 41%/XLM 59%
   Z:1.56 HL:1.1d +0.05% 0.0d

💰 Total: +0.12%

📜 5W/2L • +8.42%
```

### Environment Variables

```bash
# .env file
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
MAX_CONCURRENT_TRADES=5
```

---

## 9. Configuration Files

### `config/sectors.json`

Hardcoded sector mapping. Edit to recategorize assets.

```json
{
  "_sectors": ["L1", "L2", "DeFi", "Meme", "AI", ...],
  "L1": ["BTC", "ETH", "SOL", ...],
  "DeFi": ["AAVE", "UNI", "CRV", ...]
}
```

### `config/watchlist.json`

Generated by `scanPairs.js`. Contains top pairs per sector.

```json
{
  "generatedAt": "2025-11-28T10:00:00.000Z",
  "pairs": [
    {
      "pair": "XLM/HBAR",
      "asset1": "XLM",
      "asset2": "HBAR",
      "sector": "L1",
      "correlation": 0.94,
      "beta": 1.42,
      "halfLife": 1.1,
      "isCointegrated": true,
      "score": 85.2,
      "entryThreshold": 1.5,
      "exitThreshold": 0.5
    }
  ]
}
```

### `config/active_trades_sim.json`

Stores open simulated trades.

```json
{
  "trades": [
    {
      "pair": "XLM/HBAR",
      "asset1": "XLM",
      "asset2": "HBAR",
      "sector": "L1",
      "entryTime": "2025-11-28T11:48:00.000Z",
      "entryZScore": 1.56,
      "entryPrice1": 0.52,
      "entryPrice2": 0.14,
      "correlation": 0.94,
      "beta": 1.42,
      "halfLife": 1.1,
      "direction": "short",
      "longAsset": "HBAR",
      "shortAsset": "XLM",
      "longWeight": 41,
      "shortWeight": 59,
      "longEntryPrice": 0.14,
      "shortEntryPrice": 0.52
    }
  ]
}
```

### `config/trade_history.json`

Stores completed trades and cumulative statistics.

```json
{
  "trades": [
    {
      "pair": "SOL/ETH",
      "entryTime": "...",
      "exitTime": "...",
      "entryZScore": 1.72,
      "exitZScore": 0.34,
      "totalPnL": 2.34,
      "daysInTrade": 3.2,
      "exitReason": "TARGET"
    }
  ],
  "stats": {
    "totalTrades": 7,
    "wins": 5,
    "losses": 2,
    "totalPnL": 8.42,
    "winRate": "71.4"
  }
}
```

---

## 10. Scripts Reference

### `scanPairs.js`

**Purpose:** Discover and score tradeable pairs

**Usage:**
```bash
node scripts/scanPairs.js [options]

Options:
  --min-volume <n>   Min 24h volume (default: 500000)
  --min-oi <n>       Min open interest (default: 100000)
  --min-corr <n>     Min correlation (default: 0.6)
```

**Output:**
- `config/discovered_pairs.json` - All fitting pairs
- `config/watchlist.json` - Top 3 per sector

---

### `monitorWatchlist.js`

**Purpose:** Monitor watchlist and manage trades

**Usage:**
```bash
node scripts/monitorWatchlist.js [options]

Options:
  --manual     Alert-only mode (no auto-trade)
  --dry-run    Test mode (no trades, no Telegram)
```

**Process:**
1. Load watchlist and active trades
2. Check active trades for exit conditions
3. Check watchlist for entry signals
4. Send consolidated Telegram report

---

### `analyzePair.js`

**Purpose:** Deep analysis of a single pair

**Usage:**
```bash
node scripts/analyzePair.js <SYMBOL1> <SYMBOL2>

Example:
  node scripts/analyzePair.js BTC ETH
  node scripts/analyzePair.js kSHIB kBONK
```

**Output:** Generates detailed report in `pair_reports/`

---

## 11. Thresholds & Parameters

### Discovery (`scanPairs.js`)

| Parameter | Value | Configurable |
|-----------|-------|--------------|
| MIN_VOLUME | $500,000 | CLI flag |
| MIN_OI | $100,000 | CLI flag |
| MIN_CORRELATION | 0.6 | CLI flag |
| MAX_HALFLIFE | 45 days | Hardcoded |
| LOOKBACK_DAYS | 30 | Hardcoded |
| TOP_PER_SECTOR | 3 | Hardcoded |

### Trading (`monitorWatchlist.js`)

| Parameter | Value | Description |
|-----------|-------|-------------|
| ENTRY_THRESHOLD | 1.5 | \|Z\| required for entry |
| EXIT_THRESHOLD | 0.5 | \|Z\| target for profit |
| STOP_LOSS_THRESHOLD | 3.0 | \|Z\| max before stop |
| MIN_CORRELATION_30D | 0.6 | Correlation for 30d validation |
| MIN_CORRELATION_7D | 0.5 | Correlation for 7d validation |
| CORRELATION_BREAKDOWN | 0.4 | Exit if correlation drops below |
| HALFLIFE_MULTIPLIER | 2 | Exit if duration > 2× half-life |
| MAX_CONCURRENT_TRADES | 5 | Max simultaneous positions |

### Analysis (`pairAnalysis.js`)

| Parameter | Value | Description |
|-----------|-------|-------------|
| Z_SCORE_WINDOW | 20 | Rolling window for Z calculation |
| MIN_DATA_POINTS | 10 | Minimum required for analysis |

---

## 12. Formulas

### Summary Table

| Metric | Formula |
|--------|---------|
| Daily Return | `(P_t - P_{t-1}) / P_{t-1}` |
| Correlation | `Cov(R1, R2) / (σ1 × σ2)` |
| Beta | `Cov(R1, R2) / Var(R2)` |
| Log Spread | `ln(P1) - β × ln(P2)` |
| Z-Score | `(S - μ_S) / σ_S` |
| ADF Statistic | `-ρ × √n` |
| Half-Life | `-ln(2) / ln(1 + ρ)` |
| Mean Rev. Rate | `RevertingDays / TotalDays` |
| Composite Score | `ρ × (1/HL) × MRR × 100` |
| Position Weight | `W1 = 1/(1+\|β\|), W2 = \|β\|/(1+\|β\|)` |
| Long P&L | `(P_exit - P_entry) / P_entry × W` |
| Short P&L | `(P_entry - P_exit) / P_entry × W` |

---

## Appendix A: Data Flow Diagram

```
                    HYPERLIQUID API
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
      Universe        Candles          AssetCtx
      (symbols)      (30d daily)      (OI, funding)
          │               │               │
          └───────────────┼───────────────┘
                          ▼
                    ┌─────────────┐
                    │  SCANNER    │
                    │ scanPairs   │
                    └─────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    discovered       watchlist         sectors
    _pairs.json       .json            .json
          │               │
          │               ▼
          │         ┌─────────────┐
          │         │  MONITOR    │
          │         │ monitorWL   │
          │         └─────────────┘
          │               │
          │   ┌───────────┼───────────┐
          │   ▼           ▼           ▼
          │ active     history     TELEGRAM
          │ trades      .json        📱
          │ .json
          ▼
    ┌─────────────┐
    │  ANALYZER   │
    │ analyzePair │
    └─────────────┘
          │
          ▼
    pair_reports/
    *.md
```

---

## Appendix B: Running in Production

### Start Infinite Monitor

```bash
cd /Users/dorian/Documents/pair-trading

# Clear and start fresh
echo '{"trades":[]}' > config/active_trades_sim.json
echo '{"trades":[],"stats":{"totalTrades":0,"wins":0,"losses":0,"totalPnL":0}}' > config/trade_history.json

# Start infinite loop
nohup bash -c '
while true; do
  npm run monitor >> logs/monitor.log 2>&1
  sleep 3600
done
' &
```

### Monitor Commands

```bash
tail -f logs/monitor.log    # Watch live
pkill -f monitorWatchlist   # Stop
npm run trades              # View positions
npm run history             # View history
```

### Daily Discovery (Optional Cron)

```bash
# Add to crontab -e
0 6 * * * cd /path/to/pair-trading && npm run scan >> logs/scan.log 2>&1
```

---

*Documentation generated for pairs-scanner branch*

