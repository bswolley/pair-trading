# Pair Trading System - File Index & Navigation Guide

## CORE ANALYSIS ENGINE

### Main Library: `lib/pairAnalysis.js` (1820 lines)
**The heart of all statistical calculations**

Key Functions:
- `analyzePair(config)` - LINE 54: Main entry point (full pair analysis)
- `analyzeTimeframe(symbol1, symbol2, days, ...)` - LINE 632: Calculate metrics for specific timeframe
- `analyzeHistoricalDivergences(symbol1, symbol2, ...)` - LINE 901: Divergence profile & optimal entry
- `calculateHurst(prices, maxLag)` - LINE 1248: Hurst exponent (R/S analysis)
- `calculateDualBeta(prices1, prices2, halfLife)` - LINE 1355: Structural vs dynamic beta
- `detectRegime(zScore, entryThreshold, ...)` - LINE 1449: Market regime classification
- `calculateConvictionScore(params)` - LINE 1543: Quality score (0-100)
- `calculateCorrelation(prices1, prices2)` - LINE 1615: Pearson correlation & beta
- `testCointegration(prices1, prices2, beta)` - LINE 1657: ADF test, half-life, mean reversion
- `checkPairFitness(prices1, prices2)` - LINE 1747: Quick fitness check (used by scanner)

**What It Contains**:
- Correlation calculation (LINE 1615-1648)
- Beta calculation as hedge ratio (LINE 1615-1648)
- Spread calculation: ln(P1) - beta*ln(P2) (LINE 746, 1005, 1663)
- Z-score calculation (LINE 753, 1012, 1669)
- ADF test for cointegration (LINE 757-777, 1671-1687)
- Half-life via AR(1) regression (LINE 812-831, 1698-1733)
- Alternative: Autocorrelation half-life (LINE 1726-1732)
- Half-life via spread differences (LINE 276-323, 362-371)
- Gamma: beta stability measurement (LINE 779-810, 1764-1780)
- Theta: mean reversion speed per day (LINE 833-865, 1782-1793)
- OBV (On-Balance Volume) calculation (LINE 867-874)
- Hurst exponent using R/S analysis (LINE 1248-1342)
- Dual beta: structural vs dynamic (LINE 1355-1436)
- Historical divergence analysis (LINE 901-1235)
- Conviction scoring system (LINE 1543-1607)
- Regime detection (LINE 1449-1533)

---

## BACKEND SERVICES

### Pair Scanner: `server/services/scanner.js` (500+ lines)
**Discovers tradeable pairs automatically**

Key Functions:
- `fetchUniverse()` - LINE 151: Get all perpetuals from Hyperliquid
- `fetchHistoricalPrices(sdk, symbols)` - LINE 197: Batch price fetching
- `filterByLiquidity(assets, minVol, minOI)` - LINE 247: Liquidity filter
- `groupBySector(assets, symbolToSector)` - LINE 251: Organize by sector
- `generateCandidatePairs(sectorGroups, ...)` - LINE 268: Create pair combinations
- `evaluatePairs(candidatePairs, priceMap, ...)` - LINE 312: Calculate metrics & rank

**Key Constants**:
- `DEFAULT_MIN_VOLUME = 500_000` (LINE 95)
- `DEFAULT_MIN_OI = 100_000` (LINE 96)
- `DEFAULT_MIN_CORR = 0.6` (LINE 97)
- `DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7` (LINE 98)
- `MAX_HURST_THRESHOLD = 0.5` (LINE 99)
- `WINDOWS = { cointegration: 90, hurst: 60, reactive: 30 }` (LINE 102-106)
- `TOP_PER_SECTOR = 3` (LINE 107)
- `TOP_CROSS_SECTOR = 5` (LINE 108)

---

### Trade Monitor: `server/services/monitor.js` (600+ lines)
**Checks for entries & exits in real-time**

Key Functions:
- `calculateHealthScore(trade, currentFitness)` - LINE 49: Trade quality (0-10 scale)
- `validateEntry(prices, entryThreshold)` - LINE 214: Entry validation with layers
- `checkExits(sdk, trades, watchlist)` - LINE 299: Check for exit conditions
- `checkPartialExit(trade)` - LINE 450: Partial profit taking
- `monitorWatchlist(quiet)` - LINE 550: Main monitor loop

**Exit Logic** (LINE 299-450):
- Primary: Z < 0.5 (mean reversion reached)
- Stop-loss: Z > 1.2 * maxHistoricalZ
- Correlation breakdown: Corr < 0.4
- Hurst breakdown: H > 0.5 (trending detected)
- Partial exits: 3% PnL (50%), 5% PnL (100%)

**Health Score Components** (LINE 49-142):
- Z-score direction (-2 to +2)
- PnL trend (-2 to +2)
- Correlation stability (-2 to +1)
- Half-life change (-2 to +1)
- Hurst regime (-2 to +1)
- Beta drift (0 to -1)

---

## COMMAND-LINE SCRIPTS

### Pair Scanner CLI: `scripts/scanPairs.js` (400+ lines)
**Manual trigger for pair discovery**

Usage:
```bash
node scripts/scanPairs.js [--min-volume 500000] [--min-oi 100000] [--min-corr 0.6] [--cross-sector]
```

What it does:
- Calls `scanner.js` or internal logic
- Filters by liquidity & correlation
- Ranks by conviction score
- Outputs to watchlist.json

---

### Enter Trade: `scripts/enterTrade.js` (150+ lines)
**Manual trade entry**

Usage:
```bash
node scripts/enterTrade.js XLM/HBAR
node scripts/enterTrade.js XLM HBAR
```

Process (LINE 138-200):
1. Check if already in trade
2. Fetch 30-day prices
3. Calculate: correlation, beta, z-score, half-life
4. Validate: Z > threshold AND corr > 0.6
5. If valid: Record entry, send Telegram
6. Position sizing: w1 = 1/(1+beta), w2 = beta/(1+beta)

---

### Exit Trade: `scripts/exitTrade.js` (150+ lines)
**Manual trade exit & history logging**

Usage:
```bash
node scripts/exitTrade.js XLM/HBAR
```

Process:
1. Find active trade
2. Calculate exit prices
3. Compute P&L
4. Move to trade history
5. Send Telegram notification

---

### Analyze Pair: `scripts/analyzePair.js`
**Generate detailed report for single pair**

Usage:
```bash
npm run analyze HYPE ZEC long
node scripts/analyzePair.js HYPE ZEC long
```

---

### Monitor Watchlist: `scripts/monitorWatchlist.js`
**Trigger monitor check (entry/exit signals)**

---

## DATABASE & PERSISTENCE

### Supabase Interface: `server/db/supabase.js`
**Database connection management**

Functions:
- `getClient()` - Get authenticated Supabase client
- `isSupabaseConfigured()` - Check if env vars set
- `testConnection()` - Validate connection

---

### Query Layer: `server/db/queries.js` (300+ lines)
**Abstract database operations**

Key Functions:
- `getWatchlist(filters)` - LINE 32: Fetch watchlist pairs
- `addWatchlistPair(pair)` - LINE 70: Add to watchlist
- `removeWatchlistPair(pair)` - LINE 89: Remove from watchlist
- `getTrades(status)` - LINE 107: Get trades by status
- `recordTrade(tradeData)` - LINE 152: Save new trade
- `updateTrade(pair, updates)` - LINE 175: Update active trade
- `getTradeHistory(filters)` - LINE 201: Fetch closed trades
- `getStats()` - LINE 245: Calculate win rate, PnL

Falls back to JSON files:
- `config/watchlist.json`
- `config/active_trades_sim.json`
- `config/trade_history.json`

---

## API SERVER & ROUTES

### Main Server: `server/index.js` (100+ lines)
**Express.js REST API**

Port: 3002 (configurable via PORT env var)

Routes:
- `/api/trades` → trades.js
- `/api/watchlist` → watchlist.js
- `/api/history` → history.js
- `/api/analyze/:asset1/:asset2` → analyze.js
- `/api/zscore/:pair` → zscore.js
- `/api/status` → status.js
- `/api/blacklist` → blacklist.js
- `/api/health` → health check

---

### Pair Analysis Route: `server/routes/analyze.js` (50+ lines)
**GET /api/analyze/:asset1/:asset2?direction=long**

Calls: `lib/pairAnalysis.js::analyzePair()`
Returns: 30+ metrics for pair

---

### Watchlist Route: `server/routes/watchlist.js`
**GET/POST/DELETE /api/watchlist**

---

### Trades Route: `server/routes/trades.js`
**GET/POST/PUT/DELETE /api/trades**

---

### History Route: `server/routes/history.js`
**GET /api/history[?sector=DeFi]**

---

### Z-Score Route: `server/routes/zscore.js`
**GET /api/zscore/:pair**

Returns current divergence

---

### Scheduler: `server/services/scheduler.js`
**Background job orchestration**

Tasks:
- Scanner: Every 12 hours
- Monitor: Every 15 minutes
- Telegram bot listener

---

### Telegram Bot: `server/services/telegram.js`
**Telegram command handler**

Commands:
- `/scan` - Trigger pair discovery
- `/monitor` - Trigger watchlist monitor
- `/status` - Current trades & P&L
- `/history` - Trade history stats

---

## FRONTEND (Next.js 16)

### Pages
- `frontend/src/app/page.tsx` - Dashboard
- `frontend/src/app/watchlist/page.tsx` - Pair list
- `frontend/src/app/history/page.tsx` - Trade history
- `frontend/src/app/profile/page.tsx` - Statistics
- `frontend/src/app/settings/page.tsx` - Configuration

### Components
- `PairAnalysisReport.tsx` - 30-metric detailed report
- `ZScoreChart.tsx` - Z-score time series
- `TradesTable.tsx` - Active positions
- `ApproachingList.tsx` - Pairs near entry
- `StatCard.tsx` - KPI cards
- `Navigation.tsx` - Menu/navigation

### API Client
- `frontend/src/lib/api.ts` - Type-safe API calls

---

## CONFIGURATION

### Central Config: `config/index.js`
**Single source of truth for settings**

Loads from: `config/pairs.json`

Exports:
- `getDefaultPairs()` - Default pairs for analysis
- `getTimeframes()` - [7, 30, 90, 180] days
- `getOBVTimeframes()` - [7, 30]
- `getZScoreWindow()` - 20 days
- `getAPISettings()` - API config
- `getPDFSettings()` - PDF generation config

---

### Sector Mapping: `config/sectors.json`
```json
{
  "_sectors": ["DeFi", "Layer1", "Layer2", ...],
  "DeFi": ["AAVE", "CURVE", ...],
  "Layer1": ["SOL", "AVAX", ...],
  ...
}
```

---

### Blacklist: `config/blacklist.json`
```json
{
  "assets": ["SHIB", "DOGE", ...]  // Excluded from scanning
}
```

---

### Watchlist: `config/watchlist.json`
```json
{
  "pairs": [
    {
      "pair": "AAVE/CURVE",
      "correlation": 0.82,
      "zScore": 1.8,
      "signalStrength": 85,
      "isReady": true
    }
  ]
}
```

---

### Active Trades: `config/active_trades_sim.json`
```json
{
  "trades": [
    {
      "pair": "AAVE/CURVE",
      "entryTime": "2024-12-07T10:00:00Z",
      "entryZScore": 1.8,
      "beta": 1.2,
      "correlation": 0.82,
      "currentZ": 0.8,
      "currentPnL": 2.5
    }
  ]
}
```

---

### Trade History: `config/trade_history.json`
```json
{
  "trades": [
    {
      "pair": "AAVE/CURVE",
      "entryTime": "2024-12-07T10:00:00Z",
      "exitTime": "2024-12-08T14:00:00Z",
      "totalPnL": 3.2
    }
  ],
  "stats": {
    "totalTrades": 25,
    "wins": 18,
    "losses": 7,
    "totalPnL": 45.6
  }
}
```

---

## TESTING

### Unit Tests
- `__tests__/pairAnalysis.test.js` - Statistical calculation tests
- `__tests__/statistics.test.js` - Math function tests

---

## DOCUMENTATION

### Key Docs
- `README.md` - Project overview
- `ORGANIZATION.md` - File organization
- `PROJECT_STRUCTURE.md` - Architecture
- `FORMULA_REVIEW.md` - Mathematical formulas
- `HALFLIFE_FALLBACKS.md` - Half-life calculation methods

---

## QUICK NAVIGATION

**To understand cointegration**: `lib/pairAnalysis.js` LINE 1657-1739

**To understand half-life**: `lib/pairAnalysis.js` LINE 812-831 (main), LINE 1698-1733 (full)

**To understand Z-score entry signal**: `lib/pairAnalysis.js` LINE 745-753

**To understand position sizing**: `scripts/enterTrade.js` LINE 190-210

**To understand exit logic**: `server/services/monitor.js` LINE 299-450

**To understand Hurst exponent**: `lib/pairAnalysis.js` LINE 1248-1342

**To understand conviction score**: `lib/pairAnalysis.js` LINE 1543-1607

**To understand health score**: `server/services/monitor.js` LINE 49-142

**To understand pair scanning**: `server/services/scanner.js` LINE 312-400

**To understand entry validation**: `server/services/monitor.js` LINE 214-298

---

## KEY ALGORITHMS

1. **Correlation & Beta** - `lib/pairAnalysis.js` LINE 1615-1648
2. **Z-Score Calculation** - `lib/pairAnalysis.js` LINE 745-753
3. **Cointegration (ADF)** - `lib/pairAnalysis.js` LINE 1657-1687
4. **Half-Life (AR1)** - `lib/pairAnalysis.js` LINE 1698-1733
5. **Hurst Exponent** - `lib/pairAnalysis.js` LINE 1248-1342
6. **Dual Beta** - `lib/pairAnalysis.js` LINE 1355-1436
7. **Conviction Score** - `lib/pairAnalysis.js` LINE 1543-1607
8. **Historical Divergence** - `lib/pairAnalysis.js` LINE 901-1235
9. **Health Score** - `server/services/monitor.js` LINE 49-142
10. **Entry Validation** - `server/services/monitor.js` LINE 214-298

