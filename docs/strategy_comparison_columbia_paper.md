# Strategy Comparison: Our System vs Columbia Paper

**Paper:** "Parameters Optimization of Pair Trading Algorithm"  
**Authors:** Barthelemy, Chen, Lucyszyn (Columbia Engineering, Dec 2024)

---

## Executive Summary

| Aspect | Columbia Paper | Our System | Assessment |
|--------|---------------|------------|------------|
| **Core Strategy** | Classic pair trading | Classic pair trading | Same |
| **Pair Selection** | Correlation + Cointegration | Correlation + Cointegration + Hurst + Conviction | We're more rigorous |
| **Entry Signal** | Fixed Z-Score threshold | Dynamic threshold per pair | We're more sophisticated |
| **Exit Signal** | Fixed threshold | Fixed 0.5 threshold | Similar |
| **Parameter Optimization** | Bayesian (Optuna) | Historical divergence analysis | Different approach |
| **Market** | Equities (S&P 500) | Crypto perpetuals | Different asset class |
| **Additional Factors** | None | Hurst, Half-life, Beta drift, Funding, Volume, Vol Ratio | We have more signals |

**Verdict:** Our system implements the same core methodology but with significantly more filtering and risk management.

---

## Detailed Comparison

### 1. Pair Selection Process

**Columbia Paper:**
- Correlation > 0.8 filter
- Engle-Granger cointegration (p < 0.05)
- Result: 872 pairs from S&P 500

**Our System:**
- Correlation > 0.65
- Cointegration test (90d structural)
- Hurst exponent < 0.5 (mean-reverting only)
- Conviction score ranking
- Sector diversification
- Result: ~15-20 high-quality pairs

**Key Difference:** We add Hurst exponent filter (they don't mention this)

---

### 2. Z-Score Calculation

Both use identical formula:
```
Spread:   Z_t = X_t - beta * Y_t
Z-Score:  z_t = (Z_t - mean) / std
```

---

### 3. Entry/Exit Thresholds

**Columbia Paper:**
- Fixed: theta_in = 2.0, theta_out = 1.0
- Optimized: theta_in = 1.42, theta_out = 0.37

**Our System:**
- Dynamic entry threshold per pair (based on historical divergence)
- Fixed exit at 0.5
- Additional gates: Hurst check, max trades, sector limits

**Paper's Key Finding:** "We would NOT optimize parameters since it reduces standard deviation, providing more stable returns."

---

### 4. Metrics We Have That Paper Lacks

| Metric | Purpose |
|--------|---------|
| Hurst Exponent | Verify mean-reversion tendency |
| Half-Life | Expected reversion time |
| Dual Beta | Structural vs dynamic hedge ratio |
| Beta Drift | Hedge ratio stability |
| Funding Rates | Carry cost/benefit |
| Volume | Liquidity context |
| Volatility Ratio | Beta neutralization quality |
| Health Score | Active trade monitoring |
| Conviction Score | Composite quality metric |

---

### 5. Risk Management

**Columbia Paper:**
- No explicit risk management
- No position limits
- No stop-loss

**Our System:**
- Max 5 concurrent trades
- Max 2 per sector
- Health monitoring with alerts
- Beta drift warnings
- Hurst regime detection

---

### 6. Results

**Columbia Paper:**
- 5.2% avg return over 3 months
- 6.2% std deviation (high variance)
- Range: -62% to +45%

---

## What We Could Learn

1. **Lower entry thresholds** - Paper found 1.42 optimal (we use 1.5-2.0)
2. **Walk-forward optimization** - Rolling parameter updates
3. **Sharpe ratio consideration** - Risk-adjusted returns

## What Paper Could Learn From Us

1. **Hurst filtering** - Critical for regime changes
2. **Half-life** - Expected reversion timing
3. **Funding rates** - Crypto-specific carry
4. **Health monitoring** - Active management

---

## Conclusion

Our system implements a **more sophisticated version** of the same strategy:

- Same theoretical foundation
- More rigorous pair selection (Hurst, conviction)
- Better risk management
- Active monitoring (paper has none)

**Key Insight:** Paper's finding that optimization didn't improve returns suggests **pair quality selection** (which we do extensively) matters more than threshold tuning.












