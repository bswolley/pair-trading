# Key Definitions

## Pair Trading Metrics

### **Correlation**
- **Definition:** Measures how closely two assets move together (-1 to +1)
- **Interpretation:**
  - `+1.0`: Perfect positive correlation (move in lockstep)
  - `0.0`: No correlation (independent movement)
  - `-1.0`: Perfect negative correlation (move opposite)
- **For Pair Trading:** Higher correlation (0.5+) is generally better, as it indicates the pair moves together

### **Beta**
- **Definition:** Sensitivity of asset1's returns to asset2's returns
- **Formula:** `Beta = Covariance(asset1, asset2) / Variance(asset2)`
- **Interpretation:**
  - `Beta = 1.0`: Asset1 moves 1:1 with asset2
  - `Beta > 1.0`: Asset1 is more volatile than asset2
  - `Beta < 1.0`: Asset1 is less volatile than asset2
- **For Pair Trading:** Used as the hedge ratio (how much of asset2 to hedge per $1 of asset1)

### **Z-Score**
- **Definition:** Standardized measure of how far the current spread is from its mean
- **Formula:** `Z = (Current Spread - Mean Spread) / Std Dev of Spread`
- **Interpretation:**
  - `Z < -1`: Left asset is **undervalued** relative to right asset (good for LONG)
  - `Z > +1`: Left asset is **overvalued** relative to right asset (good for SHORT)
  - `-1 < Z < +1`: Near mean (weak signal)
- **For Pair Trading:** 
  - **LONG strategy:** Look for Z < -1 (left asset undervalued)
  - **SHORT strategy:** Look for Z > +1 (left asset overvalued)

### **Hedge Ratio**
- **Definition:** Optimal ratio of asset2 to hold per $1 of asset1 for delta-neutrality
- **Formula:** `Hedge Ratio = Beta`
- **Example:** If Beta = 0.5, for every $1 long in asset1, short $0.50 of asset2

### **Gamma (Beta Stability)**
- **Definition:** Measures how much the hedge ratio (beta) changes over time
- **Interpretation:**
  - **Lower Gamma = Better:** Stable hedge ratio means less rebalancing needed
  - **Higher Gamma = Worse:** Unstable hedge ratio means frequent rebalancing
- **For Pair Trading:** Lower gamma indicates more reliable hedge, reducing risk

### **Theta (Mean Reversion Speed)**
- **Definition:** Estimated speed at which Z-score moves toward zero (mean reverts)
- **Units:** Z-score units per day
- **Interpretation:**
  - **Positive Theta:** Spread is mean reverting (good for pair trading)
  - **Higher Theta = Better:** Faster mean reversion = quicker profit
  - **Negative Theta:** Spread is diverging from mean (bad - avoid trade)
- **For Pair Trading:** Higher positive theta means the pair will likely converge faster

### **Cointegration**
- **Definition:** Statistical property indicating two assets have a long-term equilibrium relationship
- **Test:** Augmented Dickey-Fuller (ADF) test on the spread
- **Interpretation:**
  - **✅ Cointegrated:** Assets move together over time (good for pair trading)
  - **❌ Not Cointegrated:** Assets may drift apart permanently (risky for pair trading)
- **For Pair Trading:** Cointegrated pairs are preferred as they're more likely to revert to mean

### **Mean Reversion Rate**
- **Definition:** Percentage of time the spread moves back toward its mean
- **Range:** 0% to 100%
- **Interpretation:**
  - `> 50%`: Strong mean reversion tendency
  - `< 50%`: Weak mean reversion (may trend instead)
- **For Pair Trading:** Higher mean reversion rate indicates better pair trading opportunity

## Volume Metrics

### **On-Balance Volume (OBV)**
- **Definition:** Cumulative momentum indicator that relates volume to price change
- **Calculation:**
  - If price closes higher: Add volume to OBV
  - If price closes lower: Subtract volume from OBV
  - If price unchanged: OBV unchanged
- **Interpretation:**
  - **Positive OBV Change:** Accumulation (buying pressure)
  - **Negative OBV Change:** Distribution (selling pressure)
  - **OBV Rising + Price Rising:** Confirms uptrend (bullish)
  - **OBV Falling + Price Rising:** Divergence (potential reversal)
- **For Pair Trading:** 
  - Look for OBV confirming price direction
  - Divergences can signal entry/exit points

## Trading Strategy

### **LONG Strategy** (Left Asset Undervalued)
- **Entry Signal:** Z-score < -1 (left asset undervalued)
- **Position:** LONG left asset / SHORT right asset
- **Exit Signal:** Z-score returns to 0 (mean reversion complete)

### **SHORT Strategy** (Left Asset Overvalued)
- **Entry Signal:** Z-score > +1 (left asset overvalued)
- **Position:** SHORT left asset / LONG right asset
- **Exit Signal:** Z-score returns to 0 (mean reversion complete)

## Data Sources

- **Hyperliquid:** Primary source for price data (perpetual futures)
- **CryptoCompare:** Fallback for prices, primary source for OBV/volume data

## Timeframes

- **7d:** Short-term signal (high volatility, less reliable)
- **30d:** Medium-term signal (balanced view)
- **90d:** Long-term signal (more stable, less sensitive)
- **180d:** Very long-term signal (most stable, slowest to change)

**Note:** OBV is calculated for 7d and 30d only, as longer periods may not be as meaningful for volume analysis.

