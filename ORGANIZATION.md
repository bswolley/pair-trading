# Project Organization

## Folder Structure

```
pair-trading/
├── lib/                    # Reusable core modules
│   └── pairAnalysis.js     # Main analysis library
│
├── scripts/                 # Executable scripts
│   ├── analyzePair.js      # Single pair CLI tool
│   ├── pair_obv_analysis.js # Batch analysis
│   └── [other scripts]     # Additional analysis scripts
│
├── docs/                   # Documentation
│   ├── definitions.md      # Metric definitions
│   ├── greeks_interpretation_guide.md
│   └── obv_timeframe_guide.md
│
├── reports/                # Generated reports
│   ├── README.md          # Reports directory info
│   └── [generated reports] # .md and .pdf files
│
├── archive/                # Old/historical files
│
├── README.md              # Main project documentation
├── package.json           # Project config
└── .gitignore            # Git ignore rules
```

## File Organization Rules

### Scripts (`scripts/`)
- All executable `.js` files
- CLI tools and batch processors
- Run via `npm run` commands or directly

### Reports (`reports/`)
- All generated `.md` and `.pdf` files
- Auto-created by scripts
- Historical analysis reports

### Documentation (`docs/`)
- Reference guides
- Metric definitions
- How-to guides

### Library (`lib/`)
- Reusable modules
- Core functions
- Imported by scripts

## Usage

### Single Pair Analysis
```bash
npm run analyze HYPE ZEC long
# Output: reports/HYPE_ZEC_TIMESTAMP.md
```

### Batch Analysis
```bash
npm run analyze-batch
# Output: reports/pair_obv_analysis.md
```




