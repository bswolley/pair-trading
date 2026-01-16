# pair-trading

Pair Trading Analysis Tool

A comprehensive tool for analyzing cryptocurrency trading pairs with statistical metrics, volume indicators, and mean reversion analysis.

## Purpose

This tool helps identify and analyze pair trading opportunities by calculating:
- **Correlation & Beta** - Relationship between two assets
- **Z-Score** - Undervalued/overvalued signals
- **Gamma & Theta** - Hedge stability and mean reversion speed
- **OBV** - Volume accumulation/distribution
- **Cointegration** - Long-term equilibrium relationship

## Project Structure

```
.
├── lib/
│   └── pairAnalysis.js      # Core analysis functions (reusable)
├── scripts/
│   ├── analyzePair.js       # CLI tool for single pair analysis
│   ├── analyzeMultiplePairs.js # Multi-pair analysis
│   ├── pair_obv_analysis.js # Batch analysis for multiple pairs
│   ├── backtestHistoricalROI.js # ROI prediction accuracy backtest
│   ├── backtestRollingWindows.js # Rolling window analysis
│   ├── analyzeTradeReversionAndDrift.js # Historical reversion + beta drift analysis
│   ├── generateReversionDriftReport.js # Generate analysis report from results
│   ├── analyzeBetaDrift.js # Beta drift analysis from ROI backtest
│   └── generate_comprehensive_trade_report.js # Individual trade reports
├── docs/
│   ├── definitions.md       # Key metric definitions
│   ├── greeks_interpretation_guide.md
│   └── obv_timeframe_guide.md
├── backtest_reports/        # Backtest and analysis reports
│   ├── trade_reversion_drift_*_ANALYSIS.md # Main analysis reports
│   ├── backtest_ALL_*.md # ROI backtest results
│   └── beta_drift_analysis_*.md # Beta drift analysis
└── README.md                # This file
```

## Quick Start

### Prerequisites

- Node.js (v14 or higher)
- Supabase account (for trade history storage)
- Hyperliquid API access (no key required, but needs network access)

### Setup

1. **Install Dependencies**

```bash
npm install
```

2. **Configure Environment Variables**

Create a `.env` file in the root directory:

```bash
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
```

**Note:** Hyperliquid API doesn't require authentication, but you need network access to their WebSocket endpoints.

3. **Database Setup**

The backtest scripts require a Supabase database with a `trade_history` table containing:
- `asset1`, `asset2` - Trading pair symbols
- `entry_time`, `exit_time` - Trade timestamps
- `entry_z_score`, `exit_z_score` - Z-scores at entry/exit
- `direction` - 'long' or 'short'
- `total_pnl` - ROI percentage
- Other trade metadata

See your Supabase project for the complete schema.

### Run Tests

```bash
npm test
```

### Analyze a Single Pair

```bash
# Analyze HYPE/ZEC (long HYPE)
npm run analyze HYPE ZEC long

# Analyze TAO/BTC (short TAO)
npm run analyze TAO BTC short
```

### Analyze Multiple Pairs (One Report)

```bash
npm run analyze-multi HYPE ZEC long SOL ETH long
```

### Batch Analysis (3 predefined pairs)

```bash
npm run analyze-batch
```

### Backtest & Analysis Scripts

```bash
# Backtest ROI predictions for all trades
npm run backtest-roi

# Backtest ROI with date range
npm run backtest-roi -- --startDate 2025-12-01 --endDate 2026-01-01

# Analyze historical reversion + beta drift for all trades
npm run analyze-trade-reversion-drift

# Analyze with limit (e.g., first 10 trades)
npm run analyze-trade-reversion-drift 10

# Generate report from analysis results
node scripts/generateReversionDriftReport.js backtest_reports/trade_reversion_drift_*_results.json

# Convert report to PDF
npx markdown-pdf backtest_reports/trade_reversion_drift_*_ANALYSIS.md -o report.pdf
```

## Key Files

### Core Library
- **`lib/pairAnalysis.js`** - Reusable analysis functions
  - `analyzePair(config)` - Main function to analyze any pair
  - Handles data fetching, calculations, and returns structured results

### CLI Tools
- **`scripts/analyzePair.js`** - Command-line tool for single pair analysis
- **`scripts/analyzeMultiplePairs.js`** - Analyze multiple pairs in one report
- **`scripts/pair_obv_analysis.js`** - Batch analysis for predefined pairs

### Backtest & Analysis Scripts
- **`scripts/backtestHistoricalROI.js`** - Backtest ROI prediction accuracy
- **`scripts/analyzeTradeReversionAndDrift.js`** - Analyze historical reversion rates and hourly beta drift during trades
- **`scripts/generateReversionDriftReport.js`** - Generate analysis report from trade data
- **`scripts/analyzeBetaDrift.js`** - Analyze beta drift patterns from ROI backtest
- **`scripts/backtestRollingWindows.js`** - Test different rolling window combinations

### Documentation
- **`docs/definitions.md`** - Complete definitions of all metrics
- **`docs/greeks_interpretation_guide.md`** - Detailed Gamma/Theta guide

## Understanding the Metrics

### Z-Score (Most Important)
- **Negative Z (< -1)**: Left asset undervalued → Good for **LONG**
- **Positive Z (> +1)**: Left asset overvalued → Good for **SHORT**
- **Near 0**: No strong signal

### Gamma (Beta Stability)
- **Lower = Better**: Stable hedge ratio means less rebalancing
- **Higher = Worse**: Unstable hedge requires frequent adjustments

### Theta (Mean Reversion Speed)
- **Higher = Better**: Faster convergence to mean
- **Negative = Bad**: Spread diverging (avoid trade)

### Cointegration
- **Yes**: Assets move together (preferred for pair trading)
- **No**: Assets may drift apart (riskier)

See `docs/definitions.md` for complete explanations.

## Usage Examples

### Example 1: Quick Analysis

```bash
npm run analyze HYPE ZEC long
```

Output: `pair_reports/HYPE_ZEC_TIMESTAMP.md` and `pair_reports_pdf/HYPE_ZEC_TIMESTAMP.pdf`

### Example 2: Multiple Pairs

```bash
npm run analyze-multi HYPE ZEC long SOL ETH long LTC BTC long
```

Output: `pair_reports/MULTI_HYPE_ZEC_SOL_ETH_LTC_BTC_TIMESTAMP.md` and PDF

### Example 3: Using the Library Programmatically

```javascript
const { analyzePair } = require('./lib/pairAnalysis');

const result = await analyzePair({
  symbol1: 'HYPE',
  symbol2: 'ZEC',
  direction: 'long',
  timeframes: [7, 30, 90, 180],
  obvTimeframes: [7, 30]
});

console.log(result.timeframes[30].zScore); // Z-score for 30d
```

## Report Format

### Pair Analysis Reports
Reports include:
1. **Executive Summary** - Quick signal status
2. **Statistical Metrics** - Correlation, Beta, Z-score, Gamma, Theta
3. **Price Movement** - Historical prices with % changes
4. **OBV Analysis** - Volume accumulation/distribution
5. **Trade Signals** - READY or WAIT indicators

### Backtest Reports
Located in `backtest_reports/`:
- **`trade_reversion_drift_*_ANALYSIS.md`** - Main analysis report with:
  - Historical reversion rates vs actual performance
  - Beta drift patterns during trades
  - ROI trajectory analysis
  - Z-score reversion tracking
- **`backtest_ALL_*.md`** - ROI prediction accuracy analysis
- **`beta_drift_analysis_*.md`** - Beta drift impact on prediction accuracy

## Interpreting Results

### Trade Ready Signals

**For LONG strategy:**
- Z-score < -1 across multiple timeframes
- Cointegrated
- Low Gamma (< 0.3)
- Positive Theta
- OBV confirming accumulation

**For SHORT strategy:**
- Z-score > +1 across multiple timeframes
- Cointegrated
- Low Gamma (< 0.3)
- Positive Theta
- OBV confirming distribution

### Wait Signals

- Z-score between -1 and +1 (weak signal)
- Not cointegrated
- High Gamma (> 0.5)
- Negative Theta (diverging)

## Dependencies

- `@supabase/supabase-js` - Supabase client for trade history
- `axios` - HTTP requests
- `hyperliquid` - Hyperliquid API client
- `indicatorts` - Technical indicators (OBV)
- `markdown-pdf` - Convert markdown reports to PDF

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Data Sources

- **Hyperliquid** (primary): Price data from perpetual futures (MANDATORY)
- **CryptoCompare** (fallback): OBV/volume data (optional)

## Additional Resources

- **`docs/definitions.md`** - Complete metric definitions
- **`docs/greeks_interpretation_guide.md`** - Gamma/Theta deep dive
- **`docs/obv_timeframe_guide.md`** - OBV analysis guide
- **`backtest_reports/`** - Backtest and analysis reports (markdown and PDF)
- **`EXPLANATION.md`** - Explanation of trade reversion and drift analysis

## Important Notes

1. **Z-Score Calculation**: Uses rolling 30-day window (pair protocol standard)
2. **OBV Timeframes**: Only calculated for 7d and 30d (longer periods less meaningful)
3. **Data Availability**: Some tokens may not have sufficient historical data
4. **Rate Limiting**: Scripts include delays to respect API limits (1s between requests, exponential backoff on errors)
5. **Hyperliquid Required**: Price data MUST come from Hyperliquid (no fallback)
6. **Hourly Candle Limit**: Hyperliquid API returns max ~5000 hourly candles (~208 days)
7. **Incremental Saving**: Backtest scripts save progress every 5 trades and can resume if interrupted

## Support

For questions about metrics or interpretation, see:
- `docs/definitions.md` - Metric definitions
- `docs/greeks_interpretation_guide.md` - Advanced metrics
- `docs/obv_timeframe_guide.md` - OBV analysis

---

**Last Updated:** January 2026
