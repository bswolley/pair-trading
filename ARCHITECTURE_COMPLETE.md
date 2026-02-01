# Hyperliquid Pair Trading System - Complete Architecture

## 1. OVERALL SYSTEM STRUCTURE

### High-Level Components
```
pair-trading/
├── Backend (Node.js)
│   ├── server/               # Express.js REST API
│   ├── lib/                  # Core analysis library
│   └── scripts/              # CLI tools for trading
├── Frontend (Next.js 16)
│   ├── src/app/              # React pages
│   └── src/components/       # Reusable components
├── Database
│   └── Supabase (PostgreSQL) with JSON fallback
└── Configuration
    └── config/               # Pairs, sectors, blacklist
```

### Technology Stack
- **Backend**: Express.js with Node.js
- **Frontend**: Next.js 16.0.7 with React + TypeScript
- **Data Source**: Hyperliquid perpetuals API
- **Database**: Supabase (PostgreSQL) with local JSON fallback
- **Analysis**: Native JavaScript (no external ML/stats libraries)
- **Exchange Integration**: Hyperliquid SDK

---

## 2. KEY COMPONENTS BREAKDOWN

### A. PAIR DISCOVERY & SCANNING (`server/services/scanner.js`, `scripts/scanPairs.js`)

**Purpose**: Identifies tradeable pairs from Hyperliquid universe

**Input Process**:
1. Fetch universe: All perpetuals with price, volume, funding rate, open interest
2. Filter by liquidity thresholds:
   - 24h volume > $500k (configurable)
   - Open interest > $100k
3. Load sector mapping from `config/sectors.json`
4. Load blacklist from `config/blacklist.json`

**Pair Generation**:
- Same-sector pairs: All combinations within each sector
- Cross-sector pairs (optional): Top 5 most liquid per sector pairing

**Quality Metrics Calculated**:
```javascript
FOR EACH PAIR:
  - Correlation (30-day window)
  - Beta (hedge ratio)
  - Cointegration test (90-day window)
  - Hurst Exponent (60-day window)
  - Z-score at current divergence
  - Half-life calculation
  - Conviction score
```

**Filtering Thresholds**:
- `DEFAULT_MIN_CORR = 0.6` (same-sector)
- `DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7` (cross-sector)
- `MAX_HURST_THRESHOLD = 0.5` (mean-reverting pairs only)
- Minimum data points: 25 days for 30-day metrics

**Output**: Watchlist of qualified pairs stored in:
- Supabase `watchlist` table
- `config/watchlist.json` (local backup)

---

### B. PAIR ANALYSIS (`lib/pairAnalysis.js`) - CORE MATHEMATICS

**Main Function**: `analyzePair(config)` - comprehensive pair analysis

#### Data Fetching
```javascript
SOURCES:
1. Hyperliquid (mandatory) - via SDK
   - Daily candlesticks from perpetual contracts
   - Price, volume for each asset
2. CryptoCompare (optional) - for additional context
   - Market cap, 24h volume
   - Historical OHLCV data (180 days max)
```

#### KEY STATISTICAL CALCULATIONS

##### 1. CORRELATION & BETA (Per Timeframe)
```
Returns = (Price[t] - Price[t-1]) / Price[t-1]

Covariance(asset1, asset2) = Σ(r1 - mean1) * (r2 - mean2) / n

Beta = Covariance(asset1, asset2) / Variance(asset2)

Correlation = Covariance / (σ1 * σ2)
```
- Calculated for 7d, 30d, 90d, 180d windows
- Beta used as hedge ratio for spread calculation

##### 2. SPREAD & Z-SCORE (PRIMARY SIGNAL)
```
Spread[t] = ln(Price1[t]) - Beta * ln(Price2[t])

Mean_Spread = Σ Spread[i] / n

StdDev_Spread = √(Σ (Spread[i] - Mean) ² / n)

Z-Score[t] = (Spread[t] - Mean_Spread) / StdDev_Spread
```
- Z-score window: Last 20 days by default (from config)
- Positive Z = Asset1 overvalued
- Negative Z = Asset1 undervalued
- Entry signal: |Z| > 1.5 to 2.5 (dynamic by pair)

##### 3. COINTEGRATION TEST (ADF - Augmented Dickey-Fuller)
```
Spread_Diff[t] = Spread[t] - Spread[t-1]

Autocorrelation = Σ(diff[i] - mean_diff) * (diff[i-1] - mean_diff) / Variance

ADF_Stat = -Autocorr_Coefficient * √(n)

Mean_Reversion_Rate = % of periods where spread reverted to mean

IS_COINTEGRATED = (ADF < -2.5) OR (MRR > 50% AND |Autocorr| < 0.3)
```
- Tests: Can prices diverge indefinitely or will they mean-revert?
- ADF < -2.5: Strong evidence of mean reversion
- Used for 90-day structural validation

##### 4. HALF-LIFE (Mean Reversion Speed)

**Method 1: AR(1) Regression** (Primary - academic standard)
```
Spread[t] = φ * Spread[t-1] + α + ε

φ = covariance(Spread[t-1], Spread[t]) / variance(Spread[t-1])

Half_Life = -ln(2) / ln(φ)    [where 0 < φ < 1]
```

**Method 2: Autocorrelation Fallback**
```
p = autocorrelation(ΔSpread)

Half_Life = -ln(2) / ln(1 + p)   [where p < 0]
```

- **Interpretation**:
  - HL = 7 days: Z-score reverts 50% in 7 days
  - HL = 30 days: Slow reversion, more noise
  - Invalid: HL > 100 or undefined (no mean reversion)

- **Timeframes**:
  - 30-day data with 30-day beta (most stable)
  - Fallback: 7-day beta if insufficient data
  - Used for: Entry timing, position sizing, risk management

##### 5. HURST EXPONENT (Market Regime Detection)

**Rescaled Range (R/S) Analysis**:
```
FOR EACH LAG SIZE:
  - Divide returns into blocks
  - Calculate cumulative deviation for each block
  - Range = max(cumDev) - min(cumDev)
  - R/S = Range / StdDev

Plot: log(R/S) vs log(lag)

Hurst = slope of linear regression
```

**Classification**:
- H < 0.4: **STRONG mean reversion** ✓ Excellent
- 0.4 ≤ H < 0.5: **Mean reverting** ✓ Good
- 0.45 ≤ H < 0.55: **Random walk** ✗ Avoid
- 0.55 ≤ H < 0.65: **Weak trend** ✗ Avoid
- H ≥ 0.65: **Trending** ✗ Bad for pairs

**Why It Matters**:
- H = 0.5 means prices move randomly (no trading edge)
- H < 0.5 means prices revert (pairs trade opportunity)
- H > 0.5 means prices trend (don't use for mean reversion)

##### 6. GAMMA (Beta Stability)
```
Beta_Early = correlation(returns_first_half)
Beta_Late = correlation(returns_second_half)
Beta_Overall = correlation(all_returns)

Gamma = (|Beta_Early - Beta_Overall| + |Beta_Late - Beta_Overall|) / 2
```
- Measures how much hedge ratio changes over time
- Lower gamma = more stable relationship
- High gamma = hedge ratio drift (risky)

##### 7. THETA (Mean Reversion Speed per Day)
```
IF HalfLife exists:
  Theta = |Z_Current| / HalfLife
ELSE IF MeanReversionRate > 40%:
  Theta = MeanReversionRate * |Z| / min(days, 30)
```
- Expected Z-score improvement per day
- Used for: Position decay, risk calculations

##### 8. OBV (On-Balance Volume)
```
OBV[0] = Volume[0]
OBV[t] = OBV[t-1] + (Volume[t] if Close[t] > Close[t-1] else -Volume[t])
```
- Tracks if volume supports price moves
- Confirms strength of divergence signal

##### 9. DUAL BETA (Structural vs Dynamic)
```
STRUCTURAL BETA: Last 90 days OLS regression
  - Long-term relationship baseline

DYNAMIC BETA: Window = 2x Half-Life (min 7, max 30 days)
  - Adapts to current market conditions

Drift = |Dynamic_Beta - Structural_Beta| / Structural_Beta
```

##### 10. CONVICTION SCORE (0-100 Quality Metric)
```
BREAKDOWN:
- Correlation (0-20): Higher correlation = better
- R² (0-15): Better model fit = more reliable
- Half-Life (0-20): 1-10 days = sweet spot
- Hurst (0-25): H < 0.5 = highest points
- Cointegration (0-15): ADF < -3.5 = bonus
- Beta Stability (0 to -10): High drift = penalty

SCORING:
- 80+: Excellent
- 60-79: Good
- 40-59: Fair
- <40: Poor
```

##### 11. HISTORICAL DIVERGENCE ANALYSIS
```
FOR EACH Z-SCORE THRESHOLD (1.0, 1.5, 2.0, 2.5, 3.0):
  - Count crossings: |Z| goes from < threshold to >= threshold
  - Track reversion events: When does |Z| < 0.5 again?
  - Calculate: Reversion Rate % = reverted / total_events
  - Track: Average time to reversion (hours)
  - Calculate: % that ever revert vs still diverged

OUTPUT:
  optimalEntry: Highest threshold with ≥50% reversion rate
  maxHistoricalZ: Furthest divergence ever observed
```
- **Purpose**: Dynamic entry thresholds based on pair history
- **Used for**: Risk management, position sizing

---

### C. TRADING LOGIC - ENTRY & EXIT

#### Entry Validation (`server/services/monitor.js::validateEntry()`)

**30-Day Reactive Check**:
```
Signal = |Z_30d| >= Entry_Threshold (default 2.0)

Requirements:
  ✓ Correlation >= 0.6
  ✓ Cointegrated (90-day ADF test)
  ✓ Half-Life <= 30 days
  ✓ 7-day confirmation (same direction, |Z| > 0.8 * threshold)
```

**Validation Layers**:
1. **Signal Strength**: Is divergence strong enough?
2. **Structural Integrity**: Will prices revert (ADF test)?
3. **Speed of Reversion**: Can we profit in reasonable time (HL)?
4. **Recent Confirmation**: Is 7-day data confirming the thesis?

#### Entry Decision (`scripts/enterTrade.js`)

**Process**:
```
1. Fetch 30-day price history for pair
2. Calculate correlation, beta, z-score
3. Check: |Z| >= entry threshold AND correlation >= 0.6
4. If valid:
   - Record entry timestamp
   - Record entry Z-score
   - Calculate position weights: w1 = 1/(1+beta), w2 = beta/(1+beta)
   - Store in active_trades_sim.json
   - Send Telegram notification
5. If invalid: Reject trade with reason
```

**Position Sizing**:
```
Long Asset Weight = 1 / (1 + Beta)
Short Asset Weight = Beta / (1 + Beta)

Example: Beta = 1.5
  Long: 1/(1+1.5) = 40%
  Short: 1.5/(1+1.5) = 60%

Interpretation:
  For every $1 of long, need $1.50 of short to hedge
```

#### Exit Triggers (`server/services/monitor.js::checkExits()`)

**Primary Exit: Z-Score Reversion**
```
Exit when |Z| < 0.5 (reached mean)
```

**Stop-Loss (Risk Management)**
```
HARD STOPS:
1. Max Divergence Stop:
   Exit if |Z| > max(1.2 * maxHistoricalZ, 1.5 * entryZ)
   
2. Half-Life Stop:
   Exit if |Z| > 0.5 + (2 * halfLife / 30)
   (More time = accept higher Z)

3. Correlation Breakdown:
   Exit if correlation < 0.4 (link broken)

4. Hurst Breakdown:
   Exit if H > 0.5 (trend regime detected)
```

**Partial Exit Strategy**
```
Exit 50% position at 3% PnL
Exit remaining 50% at 5% PnL or |Z| < 0.5

Purpose: Lock in early profits, reduce risk
```

**Trade Health Score** (0-10):
```
COMPONENTS:
1. Z-Score Direction (-2 to +2)
   - Reverting? +2
   - Stable? 0
   - Diverging? -2

2. PnL (-2 to +2)
   - Positive? +2
   - Breakeven? 0
   - Losing? -2

3. Correlation (-2 to +1)
   - Stable? +1
   - Breaking? -2

4. Half-Life (-2 to +1)
   - Same as entry? +1
   - 3x entry? -2

5. Hurst (-2 to +1)
   - < 0.45? +1
   - > 0.5? -2

6. Beta Drift (0 to -1)
   - <10% drift? 0
   - >25% drift? -1

ACTION: Liquidate if score < 0 consistently
```

---

### D. MATHEMATICAL FORMULAS - QUICK REFERENCE

| Formula | Use Case | Definition |
|---------|----------|-----------|
| **Correlation** | Relationship strength | Covariance / (σ₁ × σ₂) |
| **Beta** | Hedge ratio | Cov(A₁, A₂) / Var(A₂) |
| **Z-Score** | Divergence magnitude | (Spread - μ) / σ |
| **ADF Stat** | Mean reversion test | -ρ × √n (autocorr) |
| **Half-Life** | Reversion speed | -ln(2) / ln(φ) where φ ∈ (0,1) |
| **Hurst** | Market regime | Slope of log(R/S) vs log(lag) |
| **Gamma** | Beta stability | Δbeta between periods |
| **Theta** | Daily Z decay | \|Z\| / HalfLife |

---

## 3. ENTRY/EXIT SIGNAL FLOW

```
SCANNER (every 12 hours)
├─ Fetch universe
├─ Filter by liquidity
├─ Generate pair combinations
├─ Calculate: correlation, cointegration, hurst, conviction
└─ Update watchlist

MONITOR (every 15 minutes)
├─ For each watchlist pair:
│  ├─ Fetch latest 30d prices
│  ├─ Calculate: Z-score, beta, correlation
│  ├─ Check: Signal valid? (Z > threshold, corr > 0.6, cointegrated?)
│  ├─ If valid → ENTRY SIGNAL
│  │  └─ Record entry, send alert
│  └─
├─ For each active trade:
│  ├─ Calculate current: Z-score, PnL, correlation, half-life
│  ├─ Calculate: Health score
│  ├─ Check exit conditions:
│  │  ├─ Z < 0.5? → EXIT (profit taken)
│  │  ├─ Stop-loss triggered? → EXIT (risk mgmt)
│  │  ├─ |Z| > 3σ? → EXIT (extreme divergence)
│  │  ├─ Corr < 0.4? → EXIT (link broken)
│  │  ├─ Partial profit targets? → PARTIAL EXIT
│  │  └─
│  └─
└─ Send Telegram updates

FRONTEND (real-time)
├─ Display: Watchlist (color-coded by signal strength)
├─ Display: Active trades (with health scores)
├─ Display: Trade history (with stats)
└─ Display: Detailed pair analysis (30 metrics)
```

---

## 4. DATA STORAGE

### Supabase Tables
```sql
watchlist(
  pair TEXT PRIMARY KEY,
  asset1, asset2, sector,
  correlation, beta, hurst,
  z_score, signal_strength,
  is_ready BOOLEAN,
  updated_at TIMESTAMP
)

trades(
  id UUID PRIMARY KEY,
  pair TEXT,
  entry_time TIMESTAMP,
  entry_z_score FLOAT,
  correlation, beta, half_life,
  current_z, current_pnl,
  status ('active'|'closed'|'exited'),
  exit_time, exit_z_score, exit_reason,
  created_at TIMESTAMP
)

price_history(
  id UUID,
  symbol TEXT,
  timestamp TIMESTAMP,
  close FLOAT,
  volume FLOAT
)
```

### JSON Fallback Files
```
config/
├─ watchlist.json         # Discovered pairs
├─ active_trades_sim.json # Current positions
├─ trade_history.json     # Closed trades + stats
├─ sectors.json          # Symbol→sector mapping
├─ blacklist.json        # Excluded assets
└─ pairs.json            # Default config
```

---

## 5. REST API ENDPOINTS

### Pair Analysis
- `GET /api/analyze/:asset1/:asset2?direction=long` → 30 metrics

### Watchlist Management
- `GET /api/watchlist` → Ready-to-trade pairs
- `POST /api/watchlist` → Add pair
- `DELETE /api/watchlist/:pair` → Remove pair

### Active Trades
- `GET /api/trades` → Current positions
- `POST /api/trades` → Record entry
- `PUT /api/trades/:pair` → Update position
- `DELETE /api/trades/:pair` → Record exit

### Trade History
- `GET /api/history` → Closed trades + stats
- `GET /api/history/stats` → Win rate, PnL

### Status & Health
- `GET /api/status` → System status, active P&L
- `GET /api/zscore/:pair` → Current divergence

---

## 6. FRONTEND COMPONENTS

**Pages**:
- `/` - Dashboard with active trades, watchlist summary
- `/watchlist` - Filterable list of discovered pairs
- `/profile` - Trade statistics, performance graphs
- `/history` - Closed trades with entry/exit details
- `/settings` - Configuration (thresholds, limits)

**Key Components**:
- `PairAnalysisReport.tsx` - 30-metric detailed report
- `ZScoreChart.tsx` - Z-score visualization over time
- `TradesTable.tsx` - Active positions with health scores
- `StatCard.tsx` - Performance KPIs
- `ApproachingList.tsx` - Pairs nearing entry threshold

---

## 7. RISK PARAMETERS

**Configurable via `config/pairs.json`**:
```javascript
MIN_CORRELATION = 0.6         // Same-sector threshold
MIN_CORRELATION_CROSS = 0.7   // Cross-sector threshold
DEFAULT_ENTRY_THRESHOLD = 2.0 // Entry Z-score
EXIT_THRESHOLD = 0.5          // Mean reversion target
STOP_LOSS_MULTIPLIER = 1.2    // Max historical Z × 1.2
MAX_HALFLIFE = 30             // Days (slower = less liquid)
MAX_CONCURRENT_TRADES = 5     // Portfolio limit
HURST_MAX = 0.5               // Reject trending pairs
```

---

## 8. KEY FILES REFERENCE

| File | Purpose |
|------|---------|
| `lib/pairAnalysis.js` | All statistical calculations (1800 lines) |
| `server/services/scanner.js` | Pair discovery algorithm |
| `server/services/monitor.js` | Entry/exit signal generation |
| `scripts/scanPairs.js` | CLI pair scanner |
| `scripts/enterTrade.js` | Manual entry recording |
| `scripts/exitTrade.js` | Manual exit + history logging |
| `server/index.js` | Express API server |
| `frontend/src/lib/api.ts` | API client |
| `config/index.js` | Central configuration loader |

---

## 9. EXECUTION FLOW

### Step 1: Discover Pairs (Every 12 hours)
```
scanPairs.js OR scheduler → scanner.js
  ↓
  Fetch 200+ perpetuals from Hyperliquid
  ↓
  Filter: vol > $500k, OI > $100k
  ↓
  Calculate correlation, cointegration, hurst
  ↓
  Keep: Corr > 0.6, ADF < -2.5, H < 0.5
  ↓
  Store in watchlist (Supabase + JSON)
```

### Step 2: Monitor Entries (Every 15 minutes)
```
scheduler → monitor.js
  ↓
  FOR each watchlist pair:
    - Fetch latest 30-day prices
    - Calculate Z-score, beta, correlation
    - IF |Z| >= 2.0 AND corr >= 0.6 AND cointegrated:
      → Entry signal!
      → Send Telegram alert
      → Wait for user/bot to confirm
      ↓
  FOR each active trade:
    - Calculate current Z, PnL, correlation, health
    - IF |Z| < 0.5: EXIT (profit taken)
    - IF Z diverges more: CHECK stop-loss
    - IF correlation breaks: EXIT (risk)
    - IF partial profit target: PARTIAL EXIT
    → Update trade record
    → Send Telegram update
```

### Step 3: Display in Frontend
```
Frontend polls /api/trades every 30 seconds
  ↓
  Displays:
  - Watchlist: 50 pairs ranked by signal strength
  - Active Trades: 5 positions with health scores
  - History: All closed trades + P&L stats
```

---

## 10. EXAMPLE: COMPLETE PAIR ANALYSIS

**Input**: "Analyze ETH vs BTC"

**Process** (2-3 seconds):
1. Fetch 185 days of daily prices (Hyperliquid)
2. Calculate 7d, 30d, 90d, 180d metrics in parallel
3. For 30-day window:
   ```
   - Correlation: 0.85 ✓ (strong link)
   - Beta: 1.2 (ETH 20% more volatile)
   - Z-Score: -1.8 (ETH undervalued by 1.8σ)
   - Cointegrated? Yes (ADF = -3.2)
   - Half-Life: 8 days (reverts in ~8 days)
   - Hurst: 0.42 (mean reverting)
   - Gamma: 0.15 (stable relationship)
   - Theta: 0.225/day (Z improves 0.225 per day)
   - Conviction: 78/100 (excellent)
   - Optimal Entry: 1.5 (reversion 75% of time)
   - Max Historical Z: 2.8
   ```
4. Predict: "ETH should outperform BTC by 0.225/day, reaching +0.5 Z in ~6 days"
5. Risk: "Stop if Z < -3.4 (1.2x max) or correlation < 0.4"

**Output**: Trade signal with 30 metrics + confidence interval

---

## SUMMARY

This system combines:
- **Academic rigor**: Proper cointegration testing, Hurst exponent, AR(1) half-life
- **Practical trading**: Dynamic thresholds, partial exits, stop-loss
- **Real-time monitoring**: 15min updates, Telegram alerts, health scores
- **Robust architecture**: Supabase + JSON fallback, RESTful API, modular services

The key innovation is calculating ALL metrics from raw prices using native JavaScript, allowing flexible iteration and transparency about every calculation.

