# Insights from Krauss (2015) - Statistical Arbitrage Pairs Trading Review

**Paper**: Krauss, Christopher (2015). "Statistical Arbitrage Pairs Trading Strategies: Review and Outlook"  
**Source**: IWQW Discussion Papers, No. 09/2015

---

## Executive Summary

This paper reviews 90+ papers on pairs trading, categorizing approaches into:
1. **Distance approach** (GGR baseline)
2. **Cointegration approach** (more rigorous)
3. **Time series approach** (OU processes, optimal thresholds)
4. **Stochastic control approach** (optimal position sizing)
5. **Other approaches** (ML, copula, PCA)

**Key Finding**: Current implementation is well-aligned with best practices, but several enhancements could improve profitability.

---

## 1. Pair Selection Improvements

### Current Implementation ✅
- Uses correlation (Pearson on returns) - **GOOD** (Section 2.3)
- Uses cointegration (Engle-Granger) - **EXCELLENT** (Section 3)
- Filters by half-life, Hurst, beta drift - **GOOD**

### Recommended Enhancements

#### 1.1 Spread Variance Maximization (Section 2.1)
**Problem**: GGR's SSD metric minimizes spread variance, limiting profit potential.

**Current**: We use correlation + cointegration (better than SSD)

**Enhancement**: Add spread variance as a **positive selection criterion**:
```javascript
// After cointegration test passes, rank by:
spreadVariance = variance(spreads)  // Higher = more profit opportunity
conviction = f(correlation, cointegration, halfLife, hurst, spreadVariance)
```

**Rationale**: Higher variance spreads = more frequent + larger divergences = higher profit potential (if mean-reverting).

**Action**: Add `spreadVariance` to conviction score calculation.

---

#### 1.2 Multiple Comparison Control (Section 3.1.3)
**Problem**: Testing 1225 pairs at 5% significance = ~61 false positives expected.

**Current**: We test many pairs but don't explicitly control familywise error rate.

**Enhancement**: Use **Bonferroni correction** or **FDR control**:
```javascript
// For N pairs tested, adjust critical value:
adjustedCritical = getEngleGrangerCriticalValue(n, '5%') - adjustment
// Or use FDR (False Discovery Rate) control
```

**Action**: Add multiple comparison adjustment to cointegration testing in scanner.

---

#### 1.3 Granger Causality (Section 3.1.3)
**Finding**: Gutierrez & Tse (2011) show majority of profitability from Granger-follower.

**Enhancement**: Identify Granger-leader vs follower, prioritize pairs where:
- Leader is more liquid (easier to trade)
- Follower has stronger mean-reversion signal

**Action**: Add Granger causality test to pair analysis (optional enhancement).

---

## 2. Entry/Exit Threshold Optimization

### Current Implementation ✅
- Fixed entry threshold: 2.5 Z-score
- Dynamic optimal threshold from historical analysis
- Exit at 0.5 Z-score

### Recommended Enhancements

#### 2.1 Bertram (2010) Optimal Thresholds (Section 4.2)
**Finding**: Closed-form solutions for optimal entry/exit thresholds using OU process.

**Current**: We use historical analysis (good heuristic)

**Enhancement**: Implement Bertram's analytical optimization:
```javascript
// For OU process: dX = -κX dt + σ dW
// Optimal entry a* and exit m* maximize Sharpe ratio:
// μ(a,m,c) = (m-a-c) / E[T]
// σ²(a,m,c) = (m-a-c)² * VAR(T) / E³(T)
// Sharpe = μ / σ
// Optimize: max Sharpe(a, m, c) where c = transaction costs
```

**Action**: Add Bertram-style threshold optimization as alternative to historical analysis.

---

#### 2.2 Time-Varying Thresholds (Section 4.1)
**Finding**: Triantafyllopoulos & Montana (2011) use time-dependent OU parameters.

**Enhancement**: Adapt thresholds based on:
- Current volatility regime
- Recent half-life changes
- Market conditions

**Action**: Make thresholds adaptive to recent spread dynamics.

---

## 3. Position Sizing Improvements

### Current Implementation ✅
- Beta-weighted delta-neutral positions
- Fixed sizing based on hedge ratio

### Recommended Enhancements

#### 3.1 Stochastic Control Optimal Sizing (Section 5)
**Finding**: Liu & Timmermann (2013) show optimal strategy may:
- Hold both assets long (or short) simultaneously
- Hold only one asset
- Vary position sizes dynamically

**Current**: Always delta-neutral (1:β ratio)

**Enhancement**: Consider non-delta-neutral positions when:
- One asset has stronger mean-reversion signal
- Diversification benefits exist
- Transaction costs favor asymmetric sizing

**Action**: Research optimal position sizing beyond delta-neutral (advanced feature).

---

#### 3.2 Dynamic Rebalancing (Section 5.1)
**Finding**: Jurek & Yang (2007) show daily rebalancing outperforms passive rules (but with higher costs).

**Current**: Passive threshold-based entry/exit

**Enhancement**: Consider dynamic rebalancing for:
- High-conviction pairs
- Fast mean-reversion (short half-life)
- Low transaction cost environments

**Action**: Add optional dynamic rebalancing mode (experimental).

---

## 4. Pair Quality Metrics

### Current Implementation ✅
- Conviction score (correlation, cointegration, half-life, Hurst, R², beta drift)
- Regime detection
- Dual beta analysis

### Recommended Enhancements

#### 4.1 Zero-Crossing Frequency (Section 3.1.1)
**Finding**: Vidyamurthy (2004) uses zero-crossing rate as proxy for mean-reversion strength.

**Enhancement**: Add zero-crossing count to conviction score:
```javascript
zeroCrossings = count(spread crosses mean)
zeroCrossingRate = zeroCrossings / timePeriod
// Higher rate = stronger mean-reversion
```

**Action**: Add zero-crossing metric to pair analysis.

---

#### 4.2 Spread Volatility vs Directional Volatility (Section 2.4)
**Current**: We calculate volatility ratio (volRatio)

**Enhancement**: Use as selection criterion (not just validation):
- Prefer pairs with volRatio < 0.5 (excellent hedging)
- Avoid pairs with volRatio > 0.75 (poor hedging)

**Action**: Already implemented in scanner ✅

---

## 5. Advanced Approaches (Future Research)

### 5.1 Copula Approach (Section 6.2)
**Finding**: Captures non-Gaussian dependence (skewness, kurtosis).

**Enhancement**: For pairs with non-normal returns, use copula-based signals.

**Action**: Research copula implementation for crypto pairs (experimental).

---

### 5.2 Quasi-Multivariate Pairs (Section 2.3)
**Finding**: Chen et al. (2012) show pairing one asset vs portfolio of 50 correlated assets outperforms univariate.

**Enhancement**: Consider:
- Pairing major (BTC/ETH/SOL) vs portfolio of altcoins
- Dynamic portfolio construction based on correlation

**Action**: Research portfolio-based pairs (experimental).

---

### 5.3 Machine Learning (Section 6.1)
**Finding**: Huck (2009, 2010) uses neural networks + ELECTRE III ranking.

**Note**: Paper critiques MCDM value-add - simpler ranking may be better.

**Action**: Research ML for pair selection (experimental, low priority).

---

## 6. Implementation Priority

### High Priority (Immediate Impact)
1. ✅ **Spread variance in conviction score** - Easy, high impact
2. ✅ **Multiple comparison control** - Important for large-scale scanning
3. ✅ **Zero-crossing frequency** - Simple addition, good signal

### Medium Priority (Significant Improvement)
4. **Bertram optimal thresholds** - Analytical improvement over heuristics
5. **Time-varying thresholds** - Adapt to market conditions
6. **Granger causality** - Better pair prioritization

### Low Priority (Research/Experimental)
7. **Stochastic control sizing** - Complex, may not outperform delta-neutral
8. **Copula approach** - Only if non-Gaussian issues arise
9. **Quasi-multivariate** - Requires portfolio construction infrastructure
10. **ML approaches** - Unclear value-add vs current methods

---

## 7. Key Takeaways

### What We're Doing Well ✅
1. **Cointegration approach** - More rigorous than distance method
2. **Proper Engle-Granger test** - Correct statistical framework
3. **Multiple filters** - Correlation, cointegration, half-life, Hurst
4. **Dynamic threshold optimization** - Historical analysis approach
5. **Beta-weighted positions** - Proper hedge ratio calculation

### What We Can Improve 🎯
1. **Spread variance** - Maximize profit opportunity (not just minimize distance)
2. **Multiple testing** - Control false positives in large-scale scanning
3. **Optimal thresholds** - Analytical optimization vs heuristics
4. **Zero-crossings** - Additional mean-reversion signal
5. **Adaptive thresholds** - Time-varying based on market conditions

### What to Avoid ⚠️
1. **SSD metric** - Already avoided (using correlation + cointegration)
2. **Spurious correlations** - Already controlled (cointegration test)
3. **Over-optimization** - Current approach balances simplicity and rigor
4. **Complex ML without validation** - Paper critiques MCDM value-add

---

## 8. References from Paper

### Key Papers to Review
1. **Bertram (2010)** - Optimal thresholds (OU process)
2. **Liu & Timmermann (2013)** - Optimal position sizing
3. **Cummins & Bucca (2012)** - Multiple comparison control
4. **Gutierrez & Tse (2011)** - Granger causality
5. **Chen et al. (2012)** - Quasi-multivariate pairs

---

*Last updated: 2026-01-XX*
