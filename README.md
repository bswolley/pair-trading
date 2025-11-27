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
│   └── pair_obv_analysis.js # Batch analysis for multiple pairs
├── docs/
│   ├── definitions.md       # Key metric definitions
│   ├── greeks_interpretation_guide.md
│   └── obv_timeframe_guide.md
├── __tests__/               # Test files
├── pair_reports/            # Generated markdown reports
├── pair_reports_pdf/        # Generated PDF reports
├── reports/                 # Batch analysis reports
└── README.md                # This file
```

## Quick Start

### Install Dependencies

```bash
npm install
```

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

## Key Files

### Core Library
- **`lib/pairAnalysis.js`** - Reusable analysis functions
  - `analyzePair(config)` - Main function to analyze any pair
  - Handles data fetching, calculations, and returns structured results

### CLI Tools
- **`scripts/analyzePair.js`** - Command-line tool for single pair analysis
- **`scripts/analyzeMultiplePairs.js`** - Analyze multiple pairs in one report
- **`scripts/pair_obv_analysis.js`** - Batch analysis for predefined pairs

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

Reports include:
1. **Executive Summary** - Quick signal status
2. **Statistical Metrics** - Correlation, Beta, Z-score, Gamma, Theta
3. **Price Movement** - Historical prices with % changes
4. **OBV Analysis** - Volume accumulation/distribution
5. **Trade Signals** - READY or WAIT indicators

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

- `axios` - HTTP requests
- `hyperliquid` - Hyperliquid API client
- `indicatorts` - Technical indicators (OBV)

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
- **`pair_reports/`** - Generated analysis reports
- **`pair_reports_pdf/`** - PDF versions of reports

## Important Notes

1. **Z-Score Calculation**: Uses rolling 30-day window (pair protocol standard)
2. **OBV Timeframes**: Only calculated for 7d and 30d (longer periods less meaningful)
3. **Data Availability**: Some tokens may not have sufficient historical data
4. **Rate Limiting**: Scripts include delays to respect API limits
5. **Hyperliquid Required**: Price data MUST come from Hyperliquid (no fallback)

## Support

For questions about metrics or interpretation, see:
- `docs/definitions.md` - Metric definitions
- `docs/greeks_interpretation_guide.md` - Advanced metrics
- `docs/obv_timeframe_guide.md` - OBV analysis

---

**Last Updated:** November 2025
