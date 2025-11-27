# Greeks Interpretation Guide for Pair Trading

## Quick Definitions

### **Gamma (Γ) - Beta Stability**
- **What it measures:** How much the hedge ratio (beta) is changing over time
- **Lower = Better:** Stable beta means you don't need to rebalance positions as often
- **Higher = Risk:** Beta drift means your hedge is becoming less effective

### **Theta (Θ) - Mean Reversion Speed**
- **What it measures:** How fast the Z-score is moving toward zero (mean reverting)
- **Positive = Good:** Faster mean reversion = quicker profit realization
- **Negative = Bad:** Z-score is diverging from mean (spread is getting worse, not better)
- **Zero = No reversion:** Spread is not mean reverting
- **Units:** Z-score points per day (e.g., Theta 0.10 = Z-score decreases by 0.10 per day, Theta -0.10 = Z-score increases by 0.10 per day)

---

## HYPE/ZEC Analysis

### **7-Day Period:**
- **Gamma: 0.670** ⚠️ **HIGH RISK**
  - Beta is very unstable in short term (0.504 overall, but varies significantly)
  - **Interpretation:** "The hedge ratio is highly volatile - this pair requires frequent rebalancing. The 0.67 gamma indicates beta can swing by 67% of its value, making delta-neutral positioning challenging."
  - **Action:** Monitor daily, consider wider position bands

- **Theta: 0.094** ✅ **GOOD**
  - Mean reverting at ~0.09 Z-score units per day
  - **Interpretation:** "Strong mean reversion signal - at current rate, a Z-score of -1.0 would revert to zero in ~10.6 days. This suggests the pair trade should resolve relatively quickly."
  - **Action:** Good for short-term trades (1-2 weeks)

### **30-Day Period:**
- **Gamma: 0.229** ⚠️ **MODERATE RISK**
  - Beta still changing, but more stable than 7d
  - **Interpretation:** "Beta stability improves over longer horizons, but still requires monitoring. The 0.229 gamma suggests the hedge ratio drifts by ~23% from its long-term average."
  - **Action:** Weekly rebalancing recommended

- **Theta: 0.023** ⚠️ **SLOW**
  - Very slow mean reversion (0.023 Z/day)
  - **Interpretation:** "Mean reversion is working but slow - a Z-score of -1.0 would take ~43 days to revert. This is a patient trade, not a quick scalp."
  - **Action:** Suitable for longer-term positions (1-2 months)

### **90-Day & 180-Day:**
- **Gamma: 0.102 / 0.038** ✅ **STABLE**
  - Beta becomes very stable over longer periods
  - **Interpretation:** "Excellent beta stability over longer horizons - the 0.038 gamma at 180d indicates the hedge ratio is highly reliable. This pair works well for longer-term strategies."
  
- **Theta: 0.024 / 0.021** ⚠️ **CONSISTENTLY SLOW**
  - Slow but consistent mean reversion across timeframes
  - **Interpretation:** "Mean reversion is consistent but slow across all timeframes - this is a patient pair trade, not a momentum play."

**Overall HYPE/ZEC Assessment:**
- **Best for:** Longer-term pair trades (30-90 days)
- **Risk:** High gamma in short term requires active management
- **Opportunity:** Strong cointegration (Yes) + stable beta at longer horizons = reliable pair

---

## LTC/BTC Analysis

### **7-Day Period:**
- **Gamma: 0.025** ✅ **EXCELLENT**
  - Beta is extremely stable (only 2.5% variation)
  - **Interpretation:** "Exceptional beta stability - the hedge ratio of 1.336 is rock-solid. This means your 57% LTC / 43% BTC position sizing will remain effective without frequent rebalancing."
  - **Action:** Low maintenance trade

- **Theta: 0.252** ✅ **EXCELLENT**
  - Very fast mean reversion (0.25 Z/day)
  - **Interpretation:** "Outstanding mean reversion speed - a Z-score of -0.36 would revert to zero in just ~1.4 days. This is one of the fastest-reverting pairs, ideal for quick trades."
  - **Action:** Perfect for short-term scalps (3-7 days)

### **30-Day Period:**
- **Gamma: 0.088** ✅ **STABLE**
  - Beta remains stable (8.8% variation)
  - **Interpretation:** "Beta stability remains strong - the 1.401 hedge ratio is reliable. This pair maintains its relationship well over medium-term horizons."
  
- **Theta: 0.014** ⚠️ **SLOW**
  - Mean reversion slows significantly (0.014 Z/day)
  - **Interpretation:** "Mean reversion slows over longer periods - a Z-score of 0.72 would take ~51 days to revert. The fast 7d theta suggests recent volatility, but longer-term is more patient."

### **90-Day & 180-Day:**
- **Gamma: 0.135 / 0.075** ✅ **STABLE**
  - Beta stability remains good
  - **Interpretation:** "Beta stability is consistent across timeframes - this is a reliable pair for systematic strategies."
  
- **Theta: 0.014** ⚠️ **CONSISTENTLY SLOW**
  - Slow mean reversion at longer horizons
  - **Interpretation:** "Mean reversion is slow but consistent - this pair requires patience for longer-term trades."

**Overall LTC/BTC Assessment:**
- **Best for:** Short-term trades (7-14 days) due to high 7d Theta
- **Risk:** Low - excellent beta stability
- **Opportunity:** Fast mean reversion in short term + stable beta = ideal for active trading

---

## TAO/BTC Analysis

### **7-Day Period:**
- **Gamma: 3.301** 🔴 **EXTREME RISK**
  - Beta is extremely unstable (330% variation!)
  - **Interpretation:** "CRITICAL: Beta instability is extreme - the hedge ratio of 2.309 can swing wildly. This pair is NOT suitable for delta-neutral strategies without constant rebalancing. The 3.3 gamma indicates the relationship is breaking down."
  - **Action:** Avoid or use very wide position bands

- **Theta: 0.023** ⚠️ **SLOW**
  - Slow mean reversion
  - **Interpretation:** "Mean reversion exists but is slow - combined with extreme gamma, this pair is high-risk, low-reward in the short term."

### **30-Day Period:**
- **Gamma: 0.280** ⚠️ **MODERATE-HIGH RISK**
  - Beta still unstable (28% variation)
  - **Interpretation:** "Beta stability improves but remains concerning - the 0.280 gamma suggests the hedge ratio is still unreliable. This pair requires active management."
  
- **Theta: 0.005** ⚠️ **VERY SLOW**
  - Extremely slow mean reversion (0.005 Z/day)
  - **Interpretation:** "Mean reversion is nearly non-existent - a Z-score of 0.20 would take ~40 days to revert. This is a very patient trade."

### **90-Day Period:**
- **Gamma: 0.399** ⚠️ **HIGH RISK**
  - Beta instability increases (40% variation)
  - **Interpretation:** "Beta stability deteriorates at 90d - the relationship between TAO and BTC is weakening. This suggests fundamental divergence, not just temporary volatility."
  
- **Theta: 0.017** ⚠️ **SLOW**
  - Slow mean reversion
  - **Interpretation:** "Mean reversion is slow - this pair requires significant patience."

### **180-Day Period:**
- **Gamma: 0.008** ✅ **STABLE**
  - Beta becomes stable over very long term
  - **Interpretation:** "Beta stability finally emerges at 180d - the relationship exists but requires very long timeframes to be reliable."
  
- **Theta: 0.000** ❌ **NO MEAN REVERSION**
  - No mean reversion detected
  - **Interpretation:** "No mean reversion detected at 180d - this pair may be fundamentally diverging rather than mean reverting. Consider if this is still a valid pair trade."

**Overall TAO/BTC Assessment:**
- **Best for:** Very long-term trades (180+ days) or avoid entirely
- **Risk:** EXTREME - high gamma, slow/no theta
- **Warning:** "This pair shows signs of fundamental divergence. The extreme gamma at 7d (3.3) and lack of theta at 180d suggest TAO and BTC may be decoupling. This is NOT a reliable pair trade in the short-to-medium term."

---

## Key Insights for Sounding Smart

### **When Explaining Gamma:**
- "Gamma measures hedge ratio stability - think of it as the 'slippage' in your delta-neutral position. Low gamma means your hedge stays effective; high gamma means you're constantly fighting beta drift."
- "A gamma of 0.5 means beta can swing by 50% - that's like your hedge ratio changing from 1.0 to 1.5, which would require significant rebalancing."

### **When Explaining Theta:**
- "Theta is the 'time decay' of your pair trade - it tells you how fast the mispricing corrects. A theta of 0.10 means your Z-score decreases by 0.10 per day, so a -2.0 Z-score would take 20 days to revert to zero."
- "High theta = fast money, low theta = patient capital. A theta of 0.25 is exceptional - that's mean reversion happening in days, not weeks."

### **Combining Both:**
- **Ideal Pair:** Low Gamma (<0.1) + High Theta (>0.1) = "Stable hedge, fast profits"
- **Risky Pair:** High Gamma (>0.3) + Low Theta (<0.02) = "Unstable hedge, slow profits = avoid"
- **Dangerous Pair:** Any Gamma + Negative Theta = "Spread is diverging - EXIT IMMEDIATELY"
- **Your Best Pair:** LTC/BTC 7d (Gamma 0.025, Theta 0.252) = "This is the gold standard - rock-solid hedge with lightning-fast mean reversion"

### **Negative Theta - What It Means:**
- **Negative Theta = Divergence:** The spread is moving AWAY from the mean, not toward it
- **Example:** Theta -0.05 means Z-score is INCREASING by 0.05 per day (getting worse)
- **Action:** If you see negative theta, the pair trade is failing - consider exiting
- **Why it happens:** Fundamental relationship breakdown, one asset outperforming the other permanently, or the pair was never truly cointegrated

### **Trading Implications:**
1. **HYPE/ZEC:** Use for longer-term trades (30-90d), monitor gamma closely in short term
2. **LTC/BTC:** Best for short-term scalps (7-14d), excellent for active trading
3. **TAO/BTC:** Avoid or use only for very long-term (180d+), high risk of divergence

---

## Quick Reference Table

| Pair | Timeframe | Gamma | Theta | Assessment |
|------|-----------|-------|-------|------------|
| HYPE/ZEC | 7d | 0.670 ⚠️ | 0.094 ✅ | High gamma risk, decent theta |
| HYPE/ZEC | 30d | 0.229 ⚠️ | 0.023 ⚠️ | Moderate risk, slow theta |
| HYPE/ZEC | 90d | 0.103 ✅ | 0.024 ⚠️ | Stable beta, slow but consistent |
| HYPE/ZEC | 180d | 0.038 ✅ | 0.021 ⚠️ | Very stable beta, slow theta |
| LTC/BTC | 7d | 0.020 ✅ | 0.258 ✅ | **IDEAL - Best pair** |
| LTC/BTC | 30d | 0.088 ✅ | 0.014 ⚠️ | Stable beta, slow theta |
| LTC/BTC | 90d | 0.135 ✅ | 0.014 ⚠️ | Stable beta, slow theta |
| LTC/BTC | 180d | 0.075 ✅ | 0.014 ⚠️ | Stable beta, slow theta |
| TAO/BTC | 7d | 3.314 🔴 | 0.016 ⚠️ | **AVOID - Extreme risk** |
| TAO/BTC | 30d | 0.280 ⚠️ | 0.005 ⚠️ | High risk, very slow |
| TAO/BTC | 90d | 0.398 ⚠️ | 0.018 ⚠️ | High risk, slow |
| TAO/BTC | 180d | 0.008 ✅ | 0.018 ⚠️ | Stable but slow mean reversion |

---

---

## When Are Gamma & Theta Most Useful? (General Answer)

### **Short-Term View (7-30 days) - More Actionable**

**Gamma (Short-term):**
- **More useful for:** Active trading, rebalancing decisions
- **Why:** Shows immediate beta drift - tells you when to adjust positions
- **Action:** High short-term gamma = rebalance frequently, Low = set and forget
- **Limitation:** Can be noisy/volatile, might not reflect true relationship

**Theta (Short-term):**
- **More useful for:** Entry/exit timing, profit target setting
- **Why:** Shows immediate mean reversion speed - tells you how fast profits will come
- **Action:** High short-term theta = quick trades, Low = be patient
- **Limitation:** Might reflect temporary momentum, not structural mean reversion

**Bottom line:** Short-term metrics are **more actionable** - they tell you what to do RIGHT NOW.

---

### **Long-Term View (90-180 days) - More Important**

**Gamma (Long-term):**
- **More useful for:** Pair selection, strategy validation
- **Why:** Shows structural beta stability - tells you if the relationship is fundamentally sound
- **Action:** High long-term gamma = avoid this pair, Low = reliable pair
- **Advantage:** Filters out noise, reveals true relationship quality

**Theta (Long-term):**
- **More useful for:** Pair validation, avoiding broken relationships
- **Why:** Shows if mean reversion actually exists - tells you if the pair trade strategy works at all
- **Action:** Zero long-term theta = pair doesn't mean revert, avoid it
- **Advantage:** Separates real mean reversion from temporary price movements

**Bottom line:** Long-term metrics are **more important** - they tell you if the pair is worth trading at all.

---

### **General Rule:**

**For Trading Decisions (Entry/Exit/Rebalancing):**
- **Use short-term metrics** - they're more actionable
- Short-term tells you HOW to trade

**For Pair Selection (Should I Trade This?):**
- **Use long-term metrics** - they're more reliable
- Long-term tells you IF you should trade

**Best Practice:**
1. **Check long-term first** - validate the pair is fundamentally sound
2. **Then use short-term** - optimize your entry/exit timing
3. **If long-term is bad, don't trade** - even if short-term looks good

**Analogy:**
- **Short-term = Weather forecast** (what to do today)
- **Long-term = Climate** (is this place habitable?)

You need both, but long-term is more important for survival.

