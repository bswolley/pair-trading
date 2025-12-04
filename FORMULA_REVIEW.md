# Formula & Time Window Review

## Overview
This document compares formulas and time windows used across:
- **Scanner** (`server/services/scanner.js`)
- **Monitor** (`server/services/monitor.js`)
- **Full Analysis** (`lib/pairAnalysis.js` → `analyzePair()` → `/api/analyze`)

---

## Time Windows

### Scanner & Monitor (CONSISTENT ✅)
```javascript
const WINDOWS = {
    cointegration: 90,  // Structural test - longer window for confidence
    hurst: 60,          // Needs 40+ data points for R/S analysis
    reactive: 30        // Z-score, correlation, beta - responsive to recent market
};
```

### Full Analysis (`analyzePair`)
- Uses multiple timeframes: `[7, 30, 90, 180]` days
- **Standardized metrics**:
  - Beta: **30d** ✅ (matches scanner/monitor reactive)
  - Correlation: **30d** ✅ (matches scanner/monitor reactive)
  - Z-Score: **30d** ✅ (matches scanner/monitor reactive)
  - Half-Life: **30d** ✅ (matches scanner/monitor reactive)
  - Cointegration: **90d** ✅ (matches scanner/monitor structural)

**Status**: ✅ **CONSISTENT** - All use same windows for standardized metrics

---

## Formulas Comparison

### 1. Beta (Hedge Ratio)

#### Scanner
```javascript
// Line 276-279: Uses calculateCorrelation() on 30d prices
const { beta } = calculateCorrelation(prices1_30d, prices2_30d);
```

#### Monitor
```javascript
// Line 114: Uses checkPairFitness() which internally uses calculateCorrelation()
const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
// fit30d.beta comes from calculateCorrelation()
```

#### Full Analysis
```javascript
// Uses calculateCorrelation() on 30d prices for standardized.beta30d
const tf30d = calculateTimeframeMetrics(prices1, prices2, 30);
// tf30d.beta comes from calculateCorrelation()
```

**Formula**: `beta = covariance / variance2` (OLS regression)
**Status**: ✅ **IDENTICAL** - All use `calculateCorrelation()` function

---

### 2. Correlation

#### Scanner
```javascript
// Line 276: Uses calculateCorrelation() on 30d prices
const { correlation } = calculateCorrelation(prices1_30d, prices2_30d);
```

#### Monitor
```javascript
// Line 114: Uses checkPairFitness() → calculateCorrelation()
const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
// fit30d.correlation
```

#### Full Analysis
```javascript
// Uses calculateCorrelation() on 30d prices
const tf30d = calculateTimeframeMetrics(prices1, prices2, 30);
// tf30d.correlation
```

**Formula**: `correlation = covariance / (sqrt(variance1) * sqrt(variance2))`
**Status**: ✅ **IDENTICAL** - All use `calculateCorrelation()` function

---

### 3. Z-Score

#### Scanner
```javascript
// Line 283: Uses testCointegration() which calculates z-score
const reactive = testCointegration(prices1_30d, prices2_30d, beta);
// reactive.zScore
```

#### Monitor
```javascript
// Line 114: Uses checkPairFitness() which internally calls testCointegration()
const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
// fit30d.zScore
```

#### Full Analysis
```javascript
// Uses testCointegration() on 30d prices with 30d beta
const tf30d = calculateTimeframeMetrics(prices1, prices2, 30);
// tf30d.zScore
```

**Formula**: 
1. Calculate spread: `spread = log(p1) - beta * log(p2)`
2. Z-score: `z = (currentSpread - meanSpread) / stdDevSpread`
**Status**: ✅ **IDENTICAL** - All use `testCointegration()` or `checkPairFitness()` (which calls it)

---

### 4. Half-Life

#### Scanner
```javascript
// Line 283: Uses testCointegration() on 30d prices with 30d beta
const reactive = testCointegration(prices1_30d, prices2_30d, beta);
// reactive.halfLife
```

#### Monitor
```javascript
// Line 114: Uses checkPairFitness() → testCointegration()
const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
// fit30d.halfLife
```

#### Full Analysis
```javascript
// Complex logic (lines 177-326):
// 1. Tries AR(1) regression with 30d beta (preferred)
// 2. Falls back to method 2, then method 1
// 3. Uses 30d prices and 30d beta
halfLife30d = calculateHalfLifeAR1(prices1_30d, prices2_30d, beta30d);
```

**Formula**: 
- Scanner/Monitor: Uses `testCointegration()` → AR(1) regression
- Full Analysis: Uses AR(1) regression with fallbacks

**Status**: ⚠️ **MOSTLY IDENTICAL** - Both use AR(1), but full analysis has more fallback logic

---

### 5. Cointegration (ADF Test)

#### Scanner
```javascript
// Line 275-279: Uses 90d prices with 90d beta
const { beta: beta90d } = calculateCorrelation(prices1_90d, prices2_90d);
const coint = testCointegration(prices1_90d, prices2_90d, beta90d);
// coint.isCointegrated
```

#### Monitor
```javascript
// Line 119-121: Uses 90d prices with 90d beta
const { beta: beta90d } = calculateCorrelation(prices.prices1_90d, prices.prices2_90d);
const coint90d = testCointegration(prices.prices1_90d, prices.prices2_90d, beta90d);
// coint90d.isCointegrated
```

#### Full Analysis
```javascript
// Uses 90d prices with 90d beta
const tf90d = calculateTimeframeMetrics(prices1, prices2, 90);
// tf90d.isCointegrated
```

**Formula**: ADF test on residuals of `log(p1) - beta * log(p2)`
**Status**: ✅ **IDENTICAL** - All use `testCointegration()` with 90d window

---

### 6. Hurst Exponent

#### Scanner
```javascript
// Line 289-290: Uses 60d prices
const hurstLen = Math.min(prices1_60d.length, 60);
const hurst = calculateHurst(prices1_60d.slice(-hurstLen));
```

#### Monitor
```javascript
// Line 514-518: Uses 60d prices
if (prices.prices1_60d && prices.prices1_60d.length >= 40) {
    const hurstResult = calculateHurst(prices.prices1_60d);
}
```

#### Full Analysis
```javascript
// Line 508: Was using 90d prices ❌ (FIXED)
// const hurst = calculateHurst(fullPrices1.slice(-90));  // OLD - WRONG
const hurst = calculateHurst(fullPrices1.slice(-60));     // FIXED - Now matches
```

**Formula**: R/S analysis (Rescaled Range)
**Status**: ✅ **NOW IDENTICAL** - Fixed to use 60d window (was 90d before)

---

### 7. Dual Beta

#### Scanner
```javascript
// Line 298: Uses 90d prices with reactive half-life
const dualBeta = calculateDualBeta(prices1_90d, prices2_90d, reactive.halfLife);
```

#### Monitor
```javascript
// NOT CALCULATED - Only used in scanner
```

#### Full Analysis
```javascript
// Line 512: Uses full prices (180d) with 30d half-life
const dualBeta = calculateDualBeta(fullPrices1, fullPrices2, halfLife);
```

**Status**: ⚠️ **DIFFERENT** - Scanner uses 90d, Full Analysis uses 180d

---

### 8. Conviction Score

#### Scanner
```javascript
// Line 301-309: Uses reactive metrics + dualBeta
const conviction = calculateConvictionScore({
    correlation: correlation,           // 30d
    r2: dualBeta.structural.r2,         // 90d structural
    halfLife: reactive.halfLife,        // 30d
    hurst: hurst.hurst,                 // 60d
    isCointegrated: coint.isCointegrated, // 90d
    adfStat: coint.adfStat,             // 90d
    betaDrift: dualBeta.drift
});
```

#### Monitor
```javascript
// Line 601-609: Uses reactive metrics + 90d cointegration
const conviction = calculateConvictionScore({
    correlation: fit.correlation,       // 30d
    r2: 0.7,                            // ⚠️ DEFAULT VALUE (not calculated)
    halfLife: fit.halfLife,             // 30d
    hurst: hurst,                       // 60d
    isCointegrated: validation.isCointegrated90d, // 90d
    betaDrift: betaDrift || 0
});
```

#### Full Analysis
```javascript
// Line 520-528: Uses 30d metrics + dualBeta
const conviction = calculateConvictionScore({
    correlation: tf30d?.correlation || 0,     // 30d
    r2: dualBeta.structural.r2,                // 180d structural
    halfLife: tf30d?.halfLife || halfLife30d, // 30d
    hurst: hurst.hurst,                        // 60d
    isCointegrated: tf30d?.isCointegrated || isCointegrated90d, // 90d
    adfStat: tf30d?.adfStat || -2.5,
    betaDrift: dualBeta.drift
});
```

**Status**: ⚠️ **MOSTLY CONSISTENT** - Monitor uses default R² (0.7) instead of calculating

---

## Key Differences Summary

### ✅ Consistent (All Match)
1. **Beta**: 30d, OLS regression
2. **Correlation**: 30d, Pearson correlation
3. **Z-Score**: 30d, spread-based
4. **Half-Life**: 30d, AR(1) regression
5. **Cointegration**: 90d, ADF test
6. **Hurst**: 60d, R/S analysis

### ⚠️ Minor Differences
1. **Dual Beta**:
   - Scanner: 90d prices
   - Full Analysis: 180d prices
   - Monitor: Not calculated

2. **Conviction Score**:
   - Scanner: Uses dualBeta.structural.r2 (90d)
   - Monitor: Uses default R² = 0.7 ⚠️
   - Full Analysis: Uses dualBeta.structural.r2 (180d)

3. **Half-Life Calculation**:
   - Scanner/Monitor: Direct AR(1) via `testCointegration()`
   - Full Analysis: AR(1) with multiple fallback methods

---

## Recommendations

### ✅ Fixed
**Monitor Conviction Score**: Now uses actual R² from dualBeta calculation
- **Status**: Fixed - Monitor now calculates dualBeta and uses actual R²
- **Implementation**: Matches scanner approach exactly (90d prices, reactive half-life)

### 🟡 Minor Issues
1. **Dual Beta Window**: Scanner uses 90d, Full Analysis uses 180d
   - **Recommendation**: Standardize to 90d (matches cointegration window)

2. **Half-Life Fallbacks**: Full Analysis has more fallback logic
   - **Recommendation**: Consider adding same fallbacks to scanner/monitor for robustness

---

## Verification Checklist

- [x] Beta calculation matches across all three
- [x] Correlation calculation matches across all three
- [x] Z-Score calculation matches across all three
- [x] Half-Life calculation matches (with minor fallback differences)
- [x] Cointegration test matches across all three
- [x] Hurst calculation matches across all three (FIXED: was 90d in full analysis, now 60d)
- [ ] Dual Beta window standardized
- [x] Monitor conviction score R² fixed

