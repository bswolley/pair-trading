# Statistical Methods for Pair Selection & Validation

This document explains every statistical method used in the scanner and monitor for pairs trading.

---

## Overview: The Statistical Arbitrage Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SCANNER (Discovery)                          │
├─────────────────────────────────────────────────────────────────────┤
│  1. Correlation Filter     → Do assets move together?               │
│  2. Cointegration Test     → Is the spread stationary?              │
│  3. Half-Life Check        → How fast does it revert?               │
│  4. Hurst Exponent         → Is it mean-reverting or trending?      │
│  5. Conviction Score       → Overall quality ranking                │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         MONITOR (Entry/Exit)                         │
├─────────────────────────────────────────────────────────────────────┤
│  6. Z-Score Signal         → Is spread diverged enough to trade?    │
│  7. Volatility Ratio       → Is the hedge actually reducing risk?   │
│  8. Entry Validation       → Confirm all metrics still valid        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Beta (Hedge Ratio) - OLS Regression on Log Prices

### What it measures
The hedge ratio β tells us how many units of Asset 2 to trade for every 1 unit of Asset 1 to create a market-neutral position.

### Method
**Ordinary Least Squares (OLS) regression on log prices:**

```
log(P₁) = α + β × log(P₂) + ε
```

Where:
- P₁ = Price of Asset 1
- P₂ = Price of Asset 2
- β = Hedge ratio (slope)
- α = Intercept
- ε = Residuals (the spread)

### Formula
```javascript
β = Cov(log(P₁), log(P₂)) / Var(log(P₂))
```

### Why log prices?
- **Returns are additive in log space**: log(Pₜ/Pₜ₋₁) is the continuously compounded return
- **Handles different price scales**: BTC at $100k vs DOGE at $0.30
- **Proper for percentage hedging**: β represents the elasticity (% change in P₁ for 1% change in P₂)

### Data Used
- **Scanner**: 90-day hourly (2,160 points)
- **Monitor**: 90-day hourly (2,160 points)

---

## 2. Correlation - Pearson on Returns

### What it measures
How closely the two assets move together. High correlation (>0.6) suggests assets respond to similar market forces.

### Method
**Pearson correlation coefficient on price returns:**

```
r = Cov(R₁, R₂) / (σ₁ × σ₂)
```

Where:
- R₁, R₂ = Simple returns: (Pₜ - Pₜ₋₁) / Pₜ₋₁
- σ = Standard deviation

### Thresholds
| Correlation | Assessment |
|-------------|------------|
| ≥ 0.6 | Acceptable (same sector) |
| ≥ 0.7 | Required (cross-sector) |
| ≥ 0.8 | Strong co-movement |

### Why returns, not prices?
- Prices are non-stationary (trend over time)
- Returns are (approximately) stationary
- Correlation on prices would give spurious high values

### Data Used
- **Scanner**: 60-day hourly (1,440 points)

---

## 3. Cointegration Test - Engle-Granger Two-Step Method

### What it measures
Whether a linear combination of two non-stationary price series produces a stationary spread. This is the **foundation of statistical arbitrage**.

### The Key Insight
> Two prices can be individually random walks, but their *spread* can be stationary (mean-reverting).

### Method: Engle-Granger Two-Step

**Step 1: Estimate the cointegrating relationship**
```
log(P₁) = α + β × log(P₂) + εₜ    (OLS regression)
```

**Step 2: Test residuals for stationarity using ADF test**
```
Δεₜ = γ × εₜ₋₁ + Σ(δᵢ × Δεₜ₋ᵢ) + error
```

Where:
- γ = Adjustment coefficient (must be negative for mean-reversion)
- The lagged differences control for autocorrelation

### ADF Test Statistic
```
t-statistic = γ̂ / SE(γ̂)
```

If t-stat < critical value → **Cointegrated** (spread is stationary)

### Critical Values (Engle-Granger, 5% significance)
| Sample Size | Critical Value |
|-------------|----------------|
| 50 | -3.46 |
| 100 | -3.37 |
| 250 | -3.31 |
| 500+ | -3.29 |

### Example
```
ADF stat = -4.37  →  Less than -3.37  →  COINTEGRATED ✓
ADF stat = -2.91  →  Greater than -3.37  →  NOT cointegrated ✗
```

### Data Used
- **Scanner**: 90-day hourly (2,160 points)

---

## 4. Half-Life of Mean Reversion

### What it measures
How many time periods (hours or days) until the spread reverts halfway to its mean. Shorter = better for trading.

### Method: AR(1) Model
Model the spread as an autoregressive process:

```
εₜ = φ × εₜ₋₁ + noise
```

Where φ is the autocorrelation coefficient (0 < φ < 1 for mean-reverting).

### Formula
```
Half-Life = -ln(2) / ln(φ)
```

### Alternative: From ADF Gamma
The ADF test's γ coefficient also gives half-life:
```
φ = 1 + γ
Half-Life = -ln(2) / ln(1 + γ)
```

### Thresholds
| Half-Life | Assessment |
|-----------|------------|
| 1-3 days | Excellent - quick reversion |
| 3-7 days | Good |
| 7-10 days | Acceptable |
| >10 days | Too slow - rejected |

### Data Used
- **Scanner**: 90-day hourly → converted to days (÷24)

---

## 5. Hurst Exponent - Rescaled Range (R/S) Analysis

### What it measures
Whether the spread exhibits mean-reversion, random walk, or trending behavior over time.

### Method: R/S Analysis
For blocks of size n:

1. Calculate block mean (μ)
2. Calculate cumulative deviation from mean
3. Calculate range: R = max(cumdev) - min(cumdev)
4. Calculate standard deviation: S
5. Calculate R/S ratio
6. Regress log(R/S) on log(n) → slope = Hurst exponent

### Formula
```
log(R/S) = H × log(n) + c
```

Where H is the Hurst exponent.

### Interpretation
| Hurst | Behavior | Good for Stat Arb? |
|-------|----------|-------------------|
| 0 - 0.4 | Strong mean-reversion | ✓ Excellent |
| 0.4 - 0.5 | Mean-reverting | ✓ Good |
| 0.5 | Random walk | ✗ Avoid |
| 0.5 - 0.6 | Weak trending | ✗ Avoid |
| 0.6 - 1.0 | Strong trending | ✗ Avoid |

### Threshold
- **MAX_HURST = 0.50** (anything higher is rejected)

### Data Used
- **Scanner**: 60-day **daily** data (60 points)
- Why daily? Hurst should reflect behavior at **trading horizon** (days, not hours)

---

## 6. Z-Score - Spread Standardization

### What it measures
How many standard deviations the current spread is from its historical mean.

### Method
```
Z = (Spreadₜ - μ_spread) / σ_spread
```

Where:
- Spread = log(P₁) - β × log(P₂)
- μ = Mean spread over lookback window
- σ = Standard deviation of spread

### Trading Logic
| Z-Score | Direction | Action |
|---------|-----------|--------|
| Z < -2.5 | Long spread | Long Asset1, Short Asset2 |
| Z > +2.5 | Short spread | Short Asset1, Long Asset2 |
| |Z| < 0.5 | Neutral | Exit position |

### Threshold
- **Entry**: |Z| ≥ 2.5
- **Exit**: |Z| < 0.5

### Data Used
- Calculated from 90-day hourly cointegration residuals

---

## 7. Volatility Ratio - Beta Neutralization Quality

### What it measures
How much the hedge reduces volatility compared to trading each asset individually.

### Method
```javascript
// Individual asset volatilities
vol₁ = StdDev(returns₁)
vol₂ = StdDev(returns₂)
avgDirectionalVol = (vol₁ + vol₂) / 2

// Spread volatility (hedged position)
spreadReturns = spreadₜ - spreadₜ₋₁
spreadVol = StdDev(spreadReturns)

// Ratio
volRatio = spreadVol / avgDirectionalVol
```

### Interpretation
| volRatio | Meaning |
|----------|---------|
| < 0.5 | Excellent - hedge cuts vol by 50%+ |
| 0.5 - 0.75 | Good - decent hedging |
| > 0.75 | Poor - hedge isn't working |

### Threshold
- **MAX_VOL_RATIO = 0.75**

### Data Used
- **Scanner**: 30-day hourly (720 points)

---

## 8. Conviction Score - Quality Ranking

### What it measures
Overall pair quality combining multiple factors into a single score.

### Components
```javascript
conviction = weighted_sum(
  correlation_score,      // Higher correlation = better
  cointegration_score,    // More negative ADF = better  
  halfLife_score,         // Shorter half-life = better
  hurst_score,            // Lower Hurst = better
  r2_score,               // Higher R² = better
  betaDrift_score         // Lower drift = better
)
```

### Usage
- Ranks pairs for watchlist selection
- Top pairs by conviction get priority

---

## 9. Dual Beta Analysis

### What it measures
Whether the hedge ratio (β) is stable over time or drifting.

### Method
Calculate two betas:
1. **Structural Beta**: From full history (90 days) - baseline relationship
2. **Dynamic Beta**: From recent window (~2× half-life) - current relationship

```
Beta Drift = |β_dynamic - β_structural| / |β_structural|
```

### Why it matters
- High drift (>15%) = unstable relationship
- May indicate regime change or broken cointegration

---

## Summary: Scanner Filter Pipeline

```
Candidate Pairs (702)
        ↓
[Correlation ≥ 0.6] → 426 pass
        ↓
[Cointegrated (ADF < -3.4)] → 82 pass
        ↓
[Half-Life ≤ 10 days] → 75 pass
        ↓
[Hurst < 0.50] → 32 pass
        ↓
Watchlist (32 pairs)
```

## Summary: Monitor Entry Validation

```
Watchlist Pair
        ↓
[Z-Score ≥ 2.5] → Signal triggered
        ↓
[Hurst < 0.50] → Still mean-reverting
        ↓
[volRatio ≤ 0.75] → Hedge working
        ↓
[No overlap/cooldown] → Capital available
        ↓
ENTER TRADE
```

---

## References

1. Engle, R.F. & Granger, C.W.J. (1987). "Co-integration and Error Correction"
2. MacKinnon, J.G. (1991). "Critical Values for Cointegration Tests"
3. Hurst, H.E. (1951). "Long-term Storage Capacity of Reservoirs"
4. Vidyamurthy, G. (2004). "Pairs Trading: Quantitative Methods and Analysis"

---

*Last updated: 2026-02-02*
