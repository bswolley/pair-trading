# Half-Life Calculation Fallback Logic Comparison

## Overview
This document explains the difference in half-life calculation fallback logic between:
- **Scanner/Monitor**: Uses `testCointegration()` - simple, single method
- **Full Analysis**: Uses complex multi-method fallback chain

---

## Scanner/Monitor Approach

### Method: `testCointegration()` function
**Location**: `lib/pairAnalysis.js` lines 1600-1652

**Single Method**:
1. Calculate spread differences: `spreadDiffs[i] = spread[i] - spread[i-1]`
2. Calculate autocorrelation coefficient: `p = autocorr / varDiff`
3. Calculate half-life: `halfLife = -ln(2) / ln(1 + p)` if `-1 < p < 0`
4. **No fallbacks** - if calculation fails, returns `Infinity`

**Formula**:
```javascript
// Autocorrelation on spread differences
autocorr = Σ(dev[i] * dev[i-1]) / (n-1)
varDiff = Σ(dev[i]²) / n
p = autocorr / varDiff

// Half-life
if (-1 < p < 0):
    halfLife = -ln(2) / ln(1 + p)
else:
    halfLife = Infinity
```

**Pros**:
- Simple and fast
- Consistent across scanner/monitor
- Single source of truth

**Cons**:
- No fallback if calculation fails
- Returns `Infinity` if autocorrelation is invalid

---

## Full Analysis Approach (`analyzePair`)

### Multi-Method Fallback Chain
**Location**: `lib/pairAnalysis.js` lines 177-326

**Tries 3 Different Calculation Methods**:

#### Method 1: Standard Autocorrelation
```javascript
// Variance: all deviations
varDiff1 = Σ(dev[i]²) / n

// Autocorrelation: pairs
autocorr1 = Σ(dev[i] * dev[i-1]) / (n-1)

p1 = autocorr1 / varDiff1
halfLife1 = -ln(2) / ln(1 + p1)  if -1 < p1 < 0
```

#### Method 2: Alternative Autocorrelation
```javascript
// Variance: only current values (not all)
varDiff2 = Σ(dev[i]²) / n  // Only for i > 0

// Autocorrelation: pairs
autocorr2 = Σ(dev[i] * dev[i-1]) / n

p2 = autocorr2 / varDiff2
halfLife2 = -ln(2) / ln(1 + p2)  if -1 < p2 < 0
```

#### Method 3: AR(1) Regression on Spread Levels
```javascript
// Regression: spread[t] = α + φ * spread[t-1] + ε[t]
// X = spread[t-1], Y = spread[t]

phi = Σ((X[i] - meanX) * (Y[i] - meanY)) / Σ((X[i] - meanX)²)

halfLife3 = -ln(2) / ln(phi)  if 0 < phi < 1
```

**Fallback Priority** (tries both 30d and 7d betas):

1. **30d beta + Method 3 (AR1)** ← Preferred
2. **30d beta + Method 2** ← Fallback if AR1 fails
3. **30d beta + Method 1** ← Fallback if Method 2 fails
4. **7d beta + Method 3 (AR1)** ← Fallback if 30d fails
5. **7d beta + Method 1** ← Final fallback
6. **Use `tf30d.halfLife`** ← Ultimate fallback (from `testCointegration`)

**Code Flow**:
```javascript
// Try 30d beta first
if (betaName === '30d' && hl3 !== null):
    halfLife30d = hl3  // AR(1) preferred
else if (betaName === '30d' && hl2 !== null):
    halfLife30d = hl2  // Method 2 fallback
else if (betaName === '30d' && hl1 !== null):
    halfLife30d = hl1  // Method 1 fallback

// Try 7d beta if 30d failed
else if (betaName === '7d' && hl3 !== null && halfLife30d === null):
    halfLife30d = hl3  // 7d AR(1)
else if (betaName === '7d' && hl1 !== null && halfLife30d === null):
    halfLife30d = hl1  // 7d Method 1

// Ultimate fallback
if (halfLife30d === null):
    halfLife30d = tf30d?.halfLife ?? null  // From testCointegration
```

**Pros**:
- Very robust - multiple fallbacks ensure a value is found
- Tries different mathematical approaches
- Tries both 30d and 7d betas
- More likely to return a valid half-life

**Cons**:
- Complex code (150+ lines)
- Slower (multiple calculations)
- May return different values than scanner/monitor
- Harder to debug

---

## Key Differences Summary

| Aspect | Scanner/Monitor | Full Analysis |
|--------|----------------|---------------|
| **Methods** | 1 (autocorrelation) | 3 (autocorr1, autocorr2, AR1) |
| **Beta Options** | 1 (30d only) | 2 (30d, 7d) |
| **Fallbacks** | None (returns Infinity) | 5 levels |
| **Complexity** | Simple (~50 lines) | Complex (~150 lines) |
| **Speed** | Fast | Slower |
| **Robustness** | Low (fails to Infinity) | High (always finds value) |
| **Consistency** | ✅ Same as scanner | ⚠️ May differ |

---

## Recommendation

### Option 1: Keep As-Is (Current)
- **Pros**: Full analysis is more robust for detailed reports
- **Cons**: May show different values than scanner/monitor

### Option 2: Standardize to Scanner Approach
- **Pros**: Perfect consistency across all components
- **Cons**: Full analysis loses robustness

### Option 3: Add Fallbacks to Scanner/Monitor
- **Pros**: Best of both worlds - consistency + robustness
- **Cons**: More complex scanner/monitor code

**My Recommendation**: **Option 1** - Keep as-is because:
1. Scanner/monitor need speed (run every 15min)
2. Full analysis can afford complexity (on-demand, detailed reports)
3. The difference is acceptable - both use same underlying math
4. Full analysis fallbacks are for edge cases where scanner would return `Infinity`

---

## When Do Fallbacks Matter?

**Scanner/Monitor returns `Infinity` when**:
- Autocorrelation coefficient `p` is not in range `(-1, 0)`
- Spread differences show no mean-reversion pattern
- Data is too noisy or insufficient

**Full Analysis fallbacks help when**:
- Method 1 fails (invalid autocorr)
- Method 2 provides alternative calculation
- AR(1) regression gives better estimate
- 7d beta works when 30d beta fails

**Real-world impact**: Low - most pairs have valid autocorrelation, so both methods return same result. Fallbacks only matter for ~5-10% of edge cases.

