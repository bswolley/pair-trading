# Trade Reversion & Drift Analysis - What It Does

## Trade Data (From Supabase)

For each **closed trade** in your database, it gets:
- `entry_time` - When you entered the trade
- `exit_time` - When you exited the trade  
- `entry_z_score` - Z-score at entry (e.g., -2.5)
- `exit_z_score` - Z-score at exit (e.g., -1.2)
- `asset1` / `asset2` - The pair (e.g., XRP/VIRTUAL)
- `direction` - long or short
- `total_pnl` - Actual ROI from the trade

## Historical Data Analysis

### 1. Historical Reversion (BEFORE Trade Entry)

**What it does:**
- Fetches **60 days of hourly candles** ending at `entry_time` (only data BEFORE the trade)
- For each hour in that 60-day period, calculates:
  - Beta (using rolling 30-day window)
  - Z-score (how far spread is from mean)
- Tracks when Z-score crosses different thresholds (1.0, 1.5, 2.0, 2.5, 3.0)
- For each threshold, calculates: **% of times it reverted** (back to < 0.5 or < 50% of threshold)
- **Both metrics:** Fixed reversion (< 0.5) AND Percent reversion (50% of threshold)

**Example:**
- Trade entered at Z = -2.5
- Looks at 60 days BEFORE entry
- Finds: "When Z-score hit 2.5 historically, it reverted 80% of the time"
- This is the **historical reversion rate** for that threshold

**Question it answers:** "Does high historical reversion rate predict better trade outcomes?"

### 2. Hourly Beta Drift (DURING Trade)

**What it does:**
- Fetches hourly candles from **30 days before entry to exit**
- For **each hour during the trade** (entry → exit):
  - Calculates beta using rolling 30-day window
  - Calculates Z-score
  - **Calculates ROI** (based on price changes and current beta for position sizing)
  - Tracks beta drift from entry beta
  - Tracks Z-score reversion progress

**Example:**
- Entry: beta = 0.48, Z = -2.5, ROI = 0%
- Hour 1: beta = 0.482, Z = -2.3, drift = 0.002, ROI = 0.5%
- Hour 2: beta = 0.485, Z = -2.1, drift = 0.005, ROI = 1.2%
- ...
- Exit: beta = 0.52, Z = -1.2, drift = 0.04, ROI = 2.1%

**Metrics calculated:**
- `maxBetaDrift` - Maximum beta change during trade
- `avgBetaDrift` - Average beta drift
- `driftAt24h` - Beta drift after 24 hours
- `revertedAtExit` - Did Z-score revert to < 0.5 by exit?
- `maxReversion` - Maximum % reversion achieved
- `maxROI` - Maximum ROI reached during trade
- `minROI` - Minimum ROI (worst drawdown)
- `roiAt24h` - ROI after 24 hours
- `roiAt48h` - ROI after 48 hours
- `finalROI` - ROI at exit (should match actual ROI)
- `hourlyROI` - ROI at each hour during trade

**Question it answers:** "Does beta drift during trade predict failure? Does early drift predict outcome?"

## Output

For each trade, you get:
1. **Historical reversion rate** at entry threshold (from 60 days before)
   - Fixed reversion (< 0.5) rate
   - Percent reversion (50% of threshold) rate
2. **Hourly beta drift data** (every hour during trade)
3. **Hourly ROI data** (every hour during trade)
4. **Z-score reversion progress** (every hour during trade)
5. **Actual trade outcome** (ROI, won/lost)

Then it analyzes:
- Do trades with high historical reversion perform better?
- Do trades with low beta drift perform better?
- Does early beta drift (24h, 48h) predict outcome?
- Do trades that revert during the trade perform better?
- Does ROI trajectory (max, min, 24h, 48h) predict final outcome?
- What's the relationship between beta drift and ROI changes?

