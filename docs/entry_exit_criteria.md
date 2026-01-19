# Entry & Exit Criteria

## Overview

This document describes the automated entry and exit criteria used by the pair trading monitor.

---

## 📥 Entry Criteria

### Constants

| Parameter | Value | Description |
|-----------|-------|-------------|
| `DEFAULT_ENTRY_THRESHOLD` | 2.5 | Z-score required for entry signal (raised from 2.0) |
| `MIN_ENTRY_THRESHOLD` | 2.5 | Safety floor - never enter below this Z-score (raised from 2.0) |
| `MIN_CORRELATION_30D` | 0.6 | Minimum 30-day correlation |
| `MAX_CONCURRENT_TRADES` | 5 | Maximum simultaneous positions (env var) |

### Entry Conditions (ALL must pass)

| # | Condition | Check | Timeframe | Reason |
|---|-----------|-------|-----------|--------|
| 1 | **Z-Score Signal** | `\|Z\| >= entryThreshold` | 30d | Spread is diverged enough |
| 2 | **Correlation** | `correlation >= 0.6` | 30d | Assets still move together |
| 3 | **Cointegration** | `isCointegrated = true` | 90d | Long-term structural relationship |
| 4 | **Half-Life** | `halfLife <= 30 days` | 30d | Reversion is fast enough |
| 5 | **7d Confirmation** | `\|Z_7d\| >= threshold × 0.8` AND same direction | 7d | Recent momentum confirms signal |
| 6 | **Hurst Exponent** | `H < 0.5` | 60d | Pair is mean-reverting, not trending |
| 7 | **No Asset Overlap** | Neither asset in existing trade | - | Avoid correlated positions |
| 8 | **Under Max Trades** | `activeTrades < MAX_CONCURRENT_TRADES` | - | Risk management |

### Direction Logic

```javascript
direction = zScore < 0 ? 'long' : 'short'
```

| Z-Score | Direction | Action |
|---------|-----------|--------|
| Negative (< 0) | Long | Asset1 undervalued → Long Asset1, Short Asset2 |
| Positive (> 0) | Short | Asset1 overvalued → Short Asset1, Long Asset2 |

### Position Sizing (Beta-Weighted)

```javascript
weight1 = 1 / (1 + |beta|)
weight2 = |beta| / (1 + |beta|)
```

Example: If beta = 1.5
- Asset1 weight: 40%
- Asset2 weight: 60%

---

## 📤 Exit Criteria

### Constants

| Parameter | Value | Description |
|-----------|-------|-------------|
| `EXIT_THRESHOLD` | 0.5 | Target Z-score for mean reversion |
| `PARTIAL_EXIT_1_PNL` | 3.0% | PnL threshold for partial take-profit |
| `PARTIAL_EXIT_1_SIZE` | 50% | Size of partial exit |
| `FINAL_EXIT_PNL` | 5.0% | PnL threshold for final take-profit (after partial) |
| `FINAL_EXIT_ZSCORE` | 0.5 | Z-score for final exit (after partial) |
| `STOP_LOSS_MULTIPLIER` | 1.2 | 20% beyond maxHistoricalZ |
| `STOP_LOSS_ENTRY_MULTIPLIER` | 1.5 | 50% beyond entryZ |
| `STOP_LOSS_FLOOR` | 3.0 | Minimum stop-loss threshold |
| `HALFLIFE_MULTIPLIER` | 1.5 | Time stop = halfLife × 1.5 |
| `CORRELATION_BREAKDOWN` | 0.4 | Exit if correlation drops below |
| `HURST_EXIT_THRESHOLD` | 0.55 | Exit if Hurst indicates trending regime |
| `BETA_DRIFT_REDUCE_RATIO` | 0.8 | Partial reduce when drift is elevated and reversion is weak |
| `BETA_DRIFT_EXIT_LOSS_RATIO` | 0.9 | Hard exit if drift is high and PnL is negative |
| `BETA_DRIFT_EXIT_RATIO` | 1.0 | Hard exit if drift exceeds prior max |

### Exit Conditions (checked in order)

| Priority | Condition | Trigger | Action | Emoji |
|----------|-----------|---------|--------|-------|
| 1 | **Partial Take-Profit** | PnL ≥ +3% AND no partial taken | Close 50% of position | 💰 |
| 2 | **Final Take-Profit** | PnL ≥ +5% AND partial taken | Close remaining position | 🎯 |
| 3 | **Mean Reversion Target** | \|Z\| ≤ 0.5 | Full exit | 🎯 |
| 4 | **Dynamic Stop-Loss** | Z > dynamicStopLoss | Full exit | 🛑 |
| 5 | **Beta Drift Reduce** | driftRatio ≥ 0.8 AND Z improvement < 40% | Close 50% of position | ⚠️ |
| 6 | **Beta Drift Exit** | driftRatio ≥ 0.9 AND PnL < 0 | Full exit | ⚠️ |
| 7 | **Beta Drift Hard Exit** | driftRatio ≥ 1.0 | Full exit | ⚠️ |
| 8 | **Time Stop** | daysInTrade > halfLife × 1.5 | Full exit | ⏰ |
| 9 | **Correlation Breakdown** | correlation < 0.4 | Full exit | 💔 |
| 10 | **Hurst Regime Exit** | Hurst ≥ 0.55 | Full exit | 📈 |

### Dynamic Stop-Loss Formula

```javascript
dynamicStopLoss = MAX(
    entryZ × 1.5,           // 50% beyond entry Z
    maxHistoricalZ × 1.2,   // 20% beyond historical max
    3.0                     // Minimum floor
)
```

Example: Entry at Z = 2.0, maxHistoricalZ = 2.5
- Option 1: 2.0 × 1.5 = 3.0
- Option 2: 2.5 × 1.2 = 3.0
- Option 3: 3.0
- Stop-loss = 3.0

---

## 📊 Metrics Tracked During Trade

### Updated Every Monitor Run

| Metric | Description | Warning Levels |
|--------|-------------|----------------|
| `currentZ` | Current 30-day Z-score | - |
| `currentPnL` | Unrealized P&L percentage | - |
| `currentCorrelation` | Current 30-day correlation | < 0.4 = exit |
| `currentHalfLife` | Current 30-day half-life (AR1 method) | Displayed with entry comparison |
| `currentHurst` | Current 60-day Hurst exponent | ≥ 0.45 warning, ≥ 0.5 trending alert |
| `currentBeta` | Current 30-day beta | - |
| `betaDrift` | % change from entry beta | > 15% warning, > 30% critical |
| `maxBetaDrift` | Maximum drift seen during trade | - |

### Beta Drift Alerts

| Drift Level | Display | Meaning |
|-------------|---------|---------|
| < 15% | Normal | Hedge ratio stable |
| 15-30% | ⚡ Warning | Relationship weakening |
| > 30% | ⚠️ Critical | Hedge ratio significantly different |

### Beta Drift Exit Logic

| Drift Ratio | Condition | Action |
|-------------|-----------|--------|
| ≥ 0.8 | Z improvement < 40% and no partial | 50% reduce |
| ≥ 0.9 | PnL < 0 | Full exit |
| ≥ 1.0 | Any | Full exit |

### Hurst Drift Alerts

| Hurst Level | Classification | Alert |
|-------------|----------------|-------|
| < 0.45 | Mean-reverting | ✅ Normal |
| 0.45-0.50 | Borderline | ⚡ Watch |
| ≥ 0.50 | Trending | 📈 Alert |

---

## 🔄 Flow Diagrams

### Entry Flow

```
Watchlist Pair
     ↓
Z-score ≥ threshold? ──────── NO → Skip
     ↓ YES
Correlation ≥ 0.6? ────────── NO → Skip (reason: low_corr)
     ↓ YES
Cointegrated (90d)? ───────── NO → Skip (reason: not_coint)
     ↓ YES
Half-life ≤ 30d? ──────────── NO → Skip (reason: slow_reversion)
     ↓ YES
7d confirms direction? ────── NO → Skip (reason: conflicting_tf)
     ↓ YES
Hurst < 0.5? ──────────────── NO → Skip (reason: trending)
     ↓ YES
No asset overlap? ─────────── NO → Skip (reason: overlap)
     ↓ YES
Under max trades? ─────────── NO → Skip (reason: max_trades)
     ↓ YES
✅ ENTER TRADE
```

### Exit Flow

```
Active Trade
     ↓
PnL ≥ +3% & no partial? ───── YES → 💰 Close 50%
     ↓ NO
PnL ≥ +5% & partial taken? ── YES → 🎯 Final TP
     ↓ NO
|Z| ≤ 0.5? ────────────────── YES → 🎯 Mean reversion
     ↓ NO
Z > dynamic stop? ─────────── YES → 🛑 Stop loss
     ↓ NO
Beta drift ≥ 0.8 & weak Z? ── YES → ⚠️ Reduce 50%
    ↓ NO
Beta drift ≥ 0.9 & PnL < 0? ─ YES → ⚠️ Exit
    ↓ NO
Beta drift ≥ 1.0? ─────────── YES → ⚠️ Exit
    ↓ NO
Days > halfLife × 1.5? ────── YES → ⏰ Time stop
     ↓ NO
Correlation < 0.4? ────────── YES → 💔 Breakdown
     ↓ NO
Hurst ≥ 0.55? ─────────────── YES → 📈 Hurst regime shift
     ↓ NO
📊 HOLD POSITION
```

---

## 📝 Notes

### Why These Thresholds?

1. **Entry Z = 2.0**: ~2 standard deviations, statistically significant divergence
2. **Exit Z = 0.5**: Close enough to mean, captures most of the move
3. **Correlation 0.6**: Strong enough relationship for hedging
4. **Half-life 30d**: Trade should resolve within reasonable timeframe
5. **Hurst < 0.5**: Mathematical confirmation of mean-reversion

### Future Considerations

Currently tracked but NOT used for automatic exit:
- **Half-life drift**: Displayed, no auto-exit (threshold TBD: 4×?)

These metrics are monitored and displayed to support manual intervention decisions.

### Hurst Regime Exit (NEW - January 2026)

**Rationale**: Analysis of 62 closed trades showed that trades exiting with Hurst > 0.5 (trending regime) had significantly worse outcomes. The mean-reversion strategy fundamentally relies on H < 0.5. When Hurst rises above 0.55 during a trade, it indicates the spread has shifted from mean-reverting to trending behavior, violating the strategy's core assumption.

**Threshold**: 0.55 (slightly above 0.5 to avoid noisy exits)

---

*Last updated: January 2026*

