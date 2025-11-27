# Project Structure & Organization

## What Was Created

### Core Library
- **`lib/pairAnalysis.js`** - Reusable analysis module
  - `analyzePair(config)` function
  - Handles all calculations (correlation, beta, z-score, gamma, theta, OBV, cointegration)
  - Can be imported and used programmatically

### CLI Tools
- **`scripts/analyzePair.js`** - Single pair analysis tool
  - Usage: `node scripts/analyzePair.js BASE UNDERLYING [direction]`
  - Generates formatted markdown reports
  - Saves to `reports/` directory

### Documentation
- **`README.md`** - Complete project documentation
  - Quick start guide
  - Usage examples
  - Metric explanations
  - File structure

- **`docs/definitions.md`** - Comprehensive metric definitions
  - All statistical metrics explained
  - Trading strategy guidance
  - Interpretation guidelines

### Directories
- **`lib/`** - Reusable code modules
- **`scripts/`** - CLI tools
- **`docs/`** - Documentation
- **`reports/`** - Generated analysis reports (auto-created)

## Key Files Reference

### For Single Pair Analysis
```bash
node scripts/analyzePair.js HYPE ZEC long
# or
npm run analyze HYPE ZEC long
```

### For Batch Analysis (3 pairs)
```bash
node pair_obv_analysis.js
# or
npm run analyze-batch
```

### Using the Library Programmatically
```javascript
const { analyzePair } = require('./lib/pairAnalysis');
const result = await analyzePair({
  symbol1: 'HYPE',
  symbol2: 'ZEC',
  direction: 'long'
});
```

## Workflow

1. **Quick Analysis:** Use `scripts/analyzePair.js` for one-off analysis
2. **Batch Analysis:** Use `pair_obv_analysis.js` for multiple pairs
3. **Custom Integration:** Import `lib/pairAnalysis.js` in your own code

## Report Locations

- Single pair reports: `reports/BASE_UNDERLYING_TIMESTAMP.md`
- Batch reports: `pair_obv_analysis.md` (root directory)

## NPM Scripts

- `npm run analyze BASE UNDERLYING [direction]` - Single pair analysis
- `npm run analyze-batch` - Batch analysis (3 pairs)

## Documentation Files

- `README.md` - Main project documentation
- `docs/definitions.md` - Metric definitions
- `greeks_interpretation_guide.md` - Gamma/Theta guide (existing)

---

## Usage

1. Read `README.md` to understand the project
2. Use `scripts/analyzePair.js` to analyze any pair
3. Reference `docs/definitions.md` for metric explanations
4. Import `lib/pairAnalysis.js` for custom integrations

