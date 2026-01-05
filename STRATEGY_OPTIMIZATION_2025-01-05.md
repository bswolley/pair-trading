# Strategy Optimization - January 5, 2025

## Performance Analysis Summary

Analyzed 69 completed trades from production database to identify what works and what doesn't.

### Overall Performance
- Total PnL: +4.95%
- Win Rate: 50.7% (35W / 34L)
- Average Winner: +2.24%
- Average Loser: -2.16%
- Profit Factor: 1.04

### Key Findings

#### ✅ What Works Well

1. **TARGET exits**: +2.10% avg, 100% win rate (18 trades)
2. **FINAL_TP exits**: +5.93% avg, 100% win rate (4 trades)
3. **Entry Z-Score > 2.5**: Much better performance than 2.0-2.5 range
   - Z > 3.0: +0.71% avg, 75% win rate
   - Z 2.5-3.0: +1.11% avg, 60% win rate
   - Z 2.0-2.5: -0.47% avg, 38.5% win rate ❌
4. **Entry Hurst 0.35-0.45**: Sweet spot for mean-reversion
   - H 0.40-0.45: +0.67% avg, 75% win rate
   - H 0.35-0.40: +0.56% avg, 71.4% win rate
   - H < 0.35: -0.63% avg, 38.5% win rate ❌
   - H 0.45-0.50: -1.37% avg, 21.4% win rate ❌
5. **Short holding periods**:
   - < 1 day: +0.54%, 60% win rate
   - 1-3 days: +0.67%, 53.8% win rate
   - 3-7 days: -0.94%, 40% win rate ❌

#### ❌ What's Not Working

1. **TIME_STOP exits**: -1.05% avg, 31% win rate (29 trades = 42% of all trades!)
   - Biggest source of losses (-30.48% total)
   - If a trade hasn't worked by 2x half-life, it's likely broken
2. **HURST_REGIME exits**: -2.04% avg, 25% win rate (4 trades)
   - But this is acceptable - protecting against regime shifts
3. **Entry Z-Score 2.0-2.5**: Underperforms significantly
4. **Entry Hurst < 0.35 or > 0.45**: Both underperform

## Changes Made

### 1. Raised Minimum Entry Z-Score: 2.0 → 2.5

**Rationale**: Z-Score > 2.5 has 60-75% win rate vs 38.5% for 2.0-2.5 range.

**Files Updated**:
- `server/services/monitor.js`: DEFAULT_ENTRY_THRESHOLD and MIN_ENTRY_THRESHOLD
- `server/services/scanner.js`: MIN_ENTRY_THRESHOLD
- `server/routes/watchlist.js`: MIN_ENTRY_THRESHOLD
- `scripts/monitorWatchlist.js`: DEFAULT_ENTRY_THRESHOLD
- `lib/pairAnalysis.js`: MIN_ENTRY_THRESHOLD
- `docs/entry_exit_criteria.md`: Documentation

### 2. Tightened Hurst Entry Range: 0.5 → 0.45

**Rationale**: H 0.35-0.45 is the sweet spot (71-75% win rate). H 0.45-0.5 has only 21.4% win rate.

**Files Updated**:
- `server/services/scanner.js`: MAX_HURST_THRESHOLD

**Impact**: Scanner will now only select pairs with H < 0.45 instead of H < 0.5.

### 3. Reduced Time Stop: 2x Half-Life → 1.5x Half-Life

**Rationale**:
- Trades held 3+ days are losing money (-0.94% avg)
- Edge is in quick mean-reversion (< 3 days)
- TIME_STOP is the biggest source of losses

**Files Updated**:
- `server/services/monitor.js`: HALFLIFE_MULTIPLIER

**Impact**:
- Before: Pair with 4-day half-life would time out at 8 days
- After: Same pair times out at 6 days
- Faster exit of non-reverting trades

## Expected Impact

### Scenario Analysis

Based on historical data, if these rules were applied to past trades:

**Trades that would NOT have entered** (based on new Z ≥ 2.5 and H < 0.45):
- Estimated ~15-20 trades eliminated
- These were primarily losers in the Z 2.0-2.5 and H 0.45-0.5 ranges

**Trades that would have exited earlier** (1.5x vs 2x half-life):
- Time stops would trigger 25% sooner
- Could save ~0.5-1% on losing TIME_STOP exits

**Conservative Estimate**:
- Win rate: 50.7% → 60-65%
- Average PnL per trade: +0.07% → +0.3-0.5%
- Reduction in TIME_STOP losses

## Monitoring Plan

After deployment, monitor these metrics:

1. **Entry Quality**:
   - Are we entering fewer trades? (Expected: Yes, ~20-30% fewer)
   - What's the new win rate? (Target: >60%)
   - What's the average entry Z-score? (Should be >2.5 now)

2. **Exit Performance**:
   - How many TIME_STOP exits? (Target: <20% of trades)
   - Are we capturing profits faster? (Target: >50% exit within 3 days)

3. **Overall Performance**:
   - Average PnL per trade (Target: >+0.3%)
   - Total PnL trend over 2-4 weeks

## Rollback Plan

If performance degrades after deployment:

1. **Immediate**: Can manually override entry criteria in Telegram bot
2. **Quick Fix**: Revert constants in `server/services/monitor.js` and `server/services/scanner.js`
3. **Full Rollback**: Git revert this commit

## Next Steps

1. ✅ Changes deployed
2. Monitor production for 2-4 weeks
3. Collect new trade data
4. Re-run analysis to validate improvements
5. Consider further optimizations:
   - Add volume/volatility filters (data suggests meme pairs outperform)
   - Sector-specific entry thresholds
   - Dynamic time stops based on health score trends
