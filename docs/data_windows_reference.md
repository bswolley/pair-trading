# Data Windows & Lookback Reference

This document details the time windows and data sources used across different components of the pair trading system.

## Overview

Different parts of the system use different lookback windows for calculating metrics. This can cause discrepancies when comparing values between components (e.g., watchlist table vs chart modal).

---

## Scanner (`server/services/scanner.js`)

The scanner runs periodically to evaluate pairs and populate the watchlist.

| Metric | Candle Type | Window | Data Points | Notes |
|--------|-------------|--------|-------------|-------|
| **Cointegration (ADF)** | 1-hour | 90 days | 2,160 | Engle-Granger two-step test |
| **Beta (Hedge Ratio)** | 1-hour | 90 days | 2,160 | OLS regression on log prices |
| **Z-Score** | 1-hour | 90 days | 2,160 | From cointegration residuals |
| **Half-Life** | 1-hour | 90 days | 2,160 | AR(1) on spread, converted to days (÷24) |
| **Correlation** | 1-hour | 60 days | 1,440 | Pearson on log returns |
| **Hurst Exponent** | 1-day | 60 days | 60 | R/S analysis on daily spread |
| **Divergence Analysis** | 1-hour | 30 days | 720 | For optimal entry calculation |

### Entry Threshold
- **Fixed at 2.5** for all pairs (as of 2026-02-02)
- Signal strength = |Z-Score| / 2.5

---

## Monitor (`server/services/monitor.js`)

The monitor validates entries and manages active trades.

| Metric | Candle Type | Window | Data Points | Notes |
|--------|-------------|--------|-------------|-------|
| **Cointegration** | 1-hour | 90 days | 2,160 | Same as scanner |
| **Z-Score (90d)** | 1-hour | 90 days | 2,160 | Primary entry signal |
| **Z-Score (7d)** | 1-hour | 7 days | 168 | Confirmation signal (80% threshold) |
| **Hurst** | 1-day | 60 days | 60 | Trading-horizon behavior |

### Entry Criteria
- |Z-Score 90d| >= 2.5 (fixed threshold)
- |Z-Score 7d| >= 2.0 (80% of threshold, same direction)
- Both must agree on direction

---

## Chart API (`server/routes/zscore.js`)

Called when user clicks a pair in the watchlist to view the chart.

| Resolution | Lookback | Data Points | Sample Rate |
|------------|----------|-------------|-------------|
| **Daily (1d)** | 20 days | 20 | Every candle |
| **Hourly (1h)** | 30 days | ~180 | Every 4 hours |

### ⚠️ Known Discrepancy

The chart API uses **shorter lookback windows** than the scanner:
- Scanner: 90-day hourly (2,160 points)
- Chart: 20-day daily (20 points) or 30-day hourly (720 points)

This causes different beta/z-score values between watchlist table and chart modal.

**Example:**
```
Watchlist (90-day): beta=1.20, z=-2.53
Chart (20-day):     beta=1.05, z=-1.80
```

---

## Analysis API (`server/routes/analyze.js`)

Called for full pair analysis report.

| Metric | Candle Type | Window |
|--------|-------------|--------|
| Multiple timeframes | 1-day | 7d, 14d, 30d |
| Divergence analysis | 1-hour | 60 days |

---

## Rate Limits (Hyperliquid API)

From [Hyperliquid Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits):

- **1,200 weight per minute** limit
- `candleSnapshot` weight = 20 + floor(items / 60)
- 2,160 hourly candles = 20 + 36 = **56 weight per call**
- 60 daily candles = 20 + 1 = **21 weight per call**

### Scanner Rate Limiting
- Sequential fetching (not parallel)
- 3-second delay between symbols
- ~66 symbols × 3s = ~3.3 minutes per scan

---

## Configuration Constants

### Scanner (`server/services/scanner.js`)
```javascript
const WINDOWS = {
    cointegration: 90,  // days (×24 for hourly points)
    correlation: 60,
    hurst: 60,
    risk: 180
};

const MIN_ENTRY_THRESHOLD = 2.5;
const MAX_HURST_THRESHOLD = 0.50;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7;
```

### Monitor (`server/services/monitor.js`)
```javascript
const DEFAULT_ENTRY_THRESHOLD = 2.5;
const MIN_ENTRY_THRESHOLD = 2.5;
const FINAL_EXIT_ZSCORE = 0.5;
const STOP_LOSS_MULTIPLIER = 1.2;
```

---

## Future Improvements

1. **Align chart lookback** to 90 days hourly to match scanner
2. **Cache scanner metrics** and display in chart instead of recalculating
3. **Add "Scanner Z" vs "Live Z"** columns in watchlist for transparency

---

*Last updated: 2026-02-02*
