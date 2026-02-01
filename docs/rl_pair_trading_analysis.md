# RL Pair Trading Analysis: Yang & Malik (2024)

**Paper:** "Reinforcement Learning Pair Trading: A Dynamic Scaling Approach"  
**Authors:** Yang & Malik, University of Auckland (Dec 2024)

---

## Executive Summary

| Aspect | Their System | Our System | Gap |
|--------|--------------|------------|-----|
| **Entry Decision** | RL agent decides | Z-score threshold | They're more adaptive |
| **Position Sizing** | RL agent decides (0-100%) | Fixed by beta weights | **Major gap** |
| **Exit Decision** | RL agent decides | Fixed threshold (0.5) | They're more adaptive |
| **Pair Selection** | Correlation + Cointegration | + Hurst + Conviction + Half-life | We're better |
| **Risk Management** | Transaction punishment only | Health score, limits, drift | We're better |

**Their Key Result:** RL2 (dynamic sizing) achieved **31.53%** vs 8.33% traditional - **3.8x improvement**

---

## Their Approach

### Two RL Strategies

**RL1 - Timing Only (Discrete Actions):**
```
Actions: {Long Leg, Short Leg, Close}
Result: 9.94% annualized (vs 8.33% traditional)
Improvement: 1.19x
```

**RL2 - Timing + Quantity (Continuous Actions):**
```
Actions: [-1, 1] representing position size
Result: 31.53% annualized
Improvement: 3.78x over traditional!
```

### Their Observation Space
```
Position ∈ [-1, 1]     Current portfolio allocation
Spread ∈ R             Z-score of spread
Zone ∈ {5 zones}       Based on threshold crossings
```

### Their Zone Classification
```
Short Zone:        S > +OT         → Short signal
Neutral Short:     +CT < S < +OT   → Weak short
Close Zone:        -CT < S < +CT   → Exit
Neutral Long:      -OT < S < -CT   → Weak long  
Long Zone:         S < -OT         → Long signal
```

### Their Reward Function
```python
reward = portfolio_reward + action_reward - transaction_punishment

# Portfolio reward: P&L when position closes
# Action reward: Bonus for taking "correct" action in zone
# Transaction punishment: |position_change| penalty
```

---

## Key Findings

### 1. Dynamic Position Sizing Matters Most

| Method | Return | Sharpe | Win/Loss Ratio |
|--------|--------|--------|----------------|
| Traditional (Gatev) | 8.33% | 25.91 | 1.38 |
| RL1 (A2C) | 9.94% | 32.74 | 26.67 |
| RL2 (A2C) | 31.53% | 94.34 | 2.42 |

**RL2 insight:** Fewer trades, but much higher average win because it invests MORE on better opportunities.

### 2. Algorithm Selection Matters

| Algorithm | RL1 Return | RL2 Return |
|-----------|------------|------------|
| A2C | 9.94% ✓ | 31.53% ✓ |
| PPO | 1.89% | -77.81% |
| DQN | -31.99% | N/A |
| SAC | N/A | -87.12% |

**A2C (Advantage Actor-Critic) dominates** - others overtrade and lose money.

### 3. Transaction Costs Are Critical

At 0% fees, RL2 achieved **80.92%** return (vs 31.53% at 0.02%).

---

## Comparison With Our System

### What They Do Better

| Feature | Theirs | Ours | Impact |
|---------|--------|------|--------|
| **Position Sizing** | RL decides 0-100% | Fixed beta weights | High |
| **Entry Timing** | RL decides | Threshold trigger | Medium |
| **Exit Timing** | RL decides | Fixed 0.5 threshold | Medium |
| **Adaptability** | Learns from market | Static rules | High |

### What We Do Better

| Feature | Ours | Theirs | Impact |
|---------|------|--------|--------|
| **Pair Selection** | Hurst + Conviction + Half-life | Correlation only | High |
| **Risk Management** | Health score, max trades, sector limits | None | High |
| **Regime Detection** | Hurst monitoring | None | Medium |
| **Beta Stability** | Dual beta, drift tracking | None | Medium |
| **Funding Rates** | Integrated | N/A (spot) | Medium |

### Critical Difference: Their Pairs vs Ours

**Their pairs:** BTC-EUR vs BTC-GBP
- Same underlying asset (BTC)
- Different quote currencies (EUR, GBP)
- Correlation: 0.87+ (very high, by construction)
- Spread = FX rate difference, essentially

**Our pairs:** ETH vs SOL, ARB vs OP, etc.
- Different underlying assets
- Same quote currency (USD)
- Correlation: 0.65-0.85 (lower, more variable)
- Spread = actual price relationship

**Implication:** Their RL has an easier job - pairs are mechanically correlated. Our pairs require more careful selection (which we do better).

---

## What We Could Implement

### Priority 1: Dynamic Position Sizing (High Impact)

**Current approach:**
```javascript
// Fixed weights based on beta
weight1 = 1 / (1 + beta);
weight2 = beta / (1 + beta);
// Always allocate same % of portfolio
```

**RL-inspired approach:**
```javascript
// Scale position by opportunity quality
function calculatePositionSize(pair) {
  let baseSize = 0.2; // 20% base allocation
  
  // Quality multipliers
  let zStrength = Math.min(Math.abs(pair.zScore) / 3, 1);     // 0-1
  let hurstQuality = (0.5 - pair.hurst) / 0.5;                 // 0-1
  let volRatioQuality = (0.5 - pair.volRatio) / 0.5;          // 0-1
  let convictionFactor = pair.conviction / 100;                // 0-1
  
  // Composite quality score
  let quality = (zStrength + hurstQuality + volRatioQuality + convictionFactor) / 4;
  
  // Scale position: 10% to 40% based on quality
  return baseSize + (quality * 0.2);
}
```

**Without RL:** We could implement a rule-based version:
- Low quality (Q < 0.3): 15% allocation
- Medium quality (0.3 ≤ Q < 0.6): 25% allocation  
- High quality (Q ≥ 0.6): 35% allocation

### Priority 2: Zone-Based Decision Framework

**Map our metrics to zones:**
```javascript
function classifyZone(pair) {
  const z = Math.abs(pair.zScore);
  const entry = pair.entryThreshold;
  const exit = pair.exitThreshold;
  
  if (z > entry * 1.5) return 'STRONG_SIGNAL';      // High conviction entry
  if (z > entry) return 'ENTRY_ZONE';               // Standard entry
  if (z > entry * 0.8) return 'APPROACHING';        // Current "approaching"
  if (z > exit) return 'NEUTRAL';                   // Hold if in trade
  return 'EXIT_ZONE';                               // Close position
}
```

### Priority 3: Adaptive Exit Thresholds

**Paper insight:** They don't use fixed exit threshold - RL decides.

**Our improvement:**
```javascript
// Dynamic exit based on trade age and reversion progress
function calculateExitThreshold(trade) {
  const baseExit = 0.5;
  const daysInTrade = trade.duration;
  const expectedHL = trade.entryHalfLife;
  
  // Tighten exit if trade is taking too long
  if (daysInTrade > expectedHL * 2) {
    return baseExit * 1.5;  // Exit at Z = 0.75 instead of 0.5
  }
  
  // Loosen exit if converging well
  if (trade.reversionProgress > 0.7) {
    return baseExit * 0.8;  // Exit at Z = 0.4, lock in more profit
  }
  
  return baseExit;
}
```

---

## Implementation Roadmap

### Phase 1: Rule-Based Dynamic Sizing (No ML)
```
Effort: Low
Impact: Medium-High

- Add quality score for entry opportunities
- Scale position size by quality (15-35%)
- Track position sizes in trade history
```

### Phase 2: Zone-Based Entry Logic
```
Effort: Medium
Impact: Medium

- Classify pairs into zones
- Different handling per zone
- More aggressive in STRONG_SIGNAL zone
```

### Phase 3: Adaptive Exits
```
Effort: Medium
Impact: Medium

- Dynamic exit threshold based on trade progress
- Time-based tightening
- Momentum-based adjustments
```

### Phase 4: Full RL Integration (Future)
```
Effort: High
Impact: High (if done right)

- Train A2C agent on historical trades
- Observation: [position, zScore, zone, hurst, volRatio, ...]
- Action: position size [-1, 1]
- Requires: Significant backtesting infrastructure
```

---

## Conclusion

**The paper validates our core approach** (correlation + cointegration + Z-score) but shows that **dynamic position sizing can 3-4x returns**.

**Key Insight:** 
> "RL2 produces higher profits because of higher average wins from the position adjustment mechanism"

We're over-engineering pair selection (which is good for crypto) but under-utilizing position sizing.

**Recommended Next Step:** 
Implement rule-based dynamic sizing (Phase 1) as a stepping stone. If it improves results, consider RL integration later.

**Risk Warning:**
Their results are on BTC/EUR vs BTC/GBP - essentially an FX arb with very high correlation. Our cross-asset pairs are fundamentally different and may not see the same improvement magnitude.












