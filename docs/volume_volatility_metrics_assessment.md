# Volume & Volatility Metrics: Enhancement Assessment

**Date:** December 11, 2025  
**Status:** Proposal for Review

---

## Current State

| Metric | Calculated | Frequency | Used For |
|--------|-----------|-----------|----------|
| `volume1`, `volume2` | Scanner | Every 12h | Informational display |
| `spreadVol`, `volRatio` | Scanner | Every 12h | Informational display |

Both metrics are currently **static snapshots** captured at scan time and preserved through monitor cycles.

---

## Questions to Address

### 1. Should we recalculate each monitor run?

**Volume (24h notional):**

| Option | Pros | Cons |
|--------|------|------|
| **Scanner only** (current) | No extra API calls, simple | Stale after 12h |
| **Monitor recalculation** | Fresh data every 15min | Requires additional API call per pair |

**Recommendation:** ⚠️ **Not recommended for monitor**

- Monitor already makes API calls for prices; adding volume requires `metaAndAssetCtxs` call
- 24h volume doesn't change drastically within 15min
- Better approach: Flag if volume at entry vs current differs significantly (see Relative Volume below)

**Volatility Ratio:**

| Option | Pros | Cons |
|--------|------|------|
| **Scanner only** (current) | Uses 30d data, stable | May drift over trade lifetime |
| **Monitor recalculation** | Detects regime changes | We already have 30d prices in monitor |

**Recommendation:** ✅ **Consider for active trades only**

- Monitor already fetches 30d prices for active trades
- Could recalculate `volRatio` to detect volatility regime changes
- Low implementation cost

---

### 2. Should we track these for active trades?

**Current Active Trade Monitoring:**
```
currentZ, currentPnL, currentCorrelation, currentHalfLife, 
currentBeta, currentHurst, betaDrift, healthScore
```

**Proposed Additions:**

| Metric | Purpose | Health Impact |
|--------|---------|---------------|
| `currentVolRatio` | Detect spread volatility regime change | If volRatio increases >50% from entry → spread becoming riskier |
| `entryVolume` | Record volume at trade entry | Compare to current for context |
| `volumeAtDivergence` | Was this a quiet or noisy entry? | Historical analysis |

**Implementation Approach:**

```javascript
// At trade entry (enterTrade function)
trade.entryVolRatio = pair.volRatio;
trade.entryVolume1 = pair.volume1;
trade.entryVolume2 = pair.volume2;

// During monitoring
trade.currentVolRatio = calculateVolatilityMetrics(prices1, prices2, beta).volRatio;
trade.volRatioDrift = (trade.currentVolRatio - trade.entryVolRatio) / trade.entryVolRatio;
```

**Recommendation:** ✅ **Yes - implement for active trades**

---

### 3. Should these affect health status?

**Current Health Score Calculation:**
```
+3 Z reverting >50%
+2 Z reverting 25-50%
+1 Z reverting 10-25%
+2 PnL positive
-2 PnL < -3%
-3 Hurst > 0.55 (trending)
-1 Hurst 0.5-0.55
```

**Proposed Health Signals:**

| Condition | Signal | Score Impact |
|-----------|--------|--------------|
| `volRatioDrift > 0.5` | "Spread vol +50%" | -1 (volatility expanding) |
| `volRatioDrift > 1.0` | "Spread vol doubled" | -2 (major regime change) |
| `volRatio > 0.6` | "Poor beta neutralization" | -1 (spread nearly as volatile as assets) |

**Recommendation:** ✅ **Yes - add to health calculation**

Volatility regime changes are a legitimate risk signal. If the spread becomes significantly more volatile mid-trade, it suggests:
- Correlation may be breaking down
- One leg may be experiencing idiosyncratic volatility
- The "beta neutralization" benefit is degrading

---

### 4. Should we add Relative Volume?

**Concept:**
```
relativeVolume = currentVolume24h / avgVolume20d

< 0.5  = "Quiet"     🟢  (noise, high reversion probability)
0.5-1.5 = "Normal"   ⚪
1.5-3  = "Elevated"  🟡  (increased attention)
> 3    = "Spike"     🔴  (news event, skip entry)
```

**Implementation Options:**

| Option | Data Source | Complexity |
|--------|-------------|------------|
| **A) From Hyperliquid candles** | Daily OHLCV already fetched | Medium - parse `v` field |
| **B) Rolling average in DB** | Store and compute ourselves | High - need history table |
| **C) External API** | CoinGecko/CryptoCompare volume | Medium - rate limits |

**Recommended Approach: Option A**

Hyperliquid candle data includes volume. We already fetch 30-90 days of candles in the scanner.

```javascript
// In scanner's fetchHistoricalPrices
const data = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTime, endTime);

// Currently we only extract close prices:
const allPrices = sorted.map(c => parseFloat(c.c));

// We could also extract volumes:
const allVolumes = sorted.map(c => parseFloat(c.v || 0));
const avgVolume20d = allVolumes.slice(-20).reduce((a,b) => a+b, 0) / 20;
const currentVolume = allVolumes[allVolumes.length - 1];
const relativeVolume = currentVolume / avgVolume20d;
```

**Use Cases:**

1. **Pre-entry filter:** Skip entries where `relativeVolume > 3` (major news event)
2. **Entry context:** Log whether entry was "quiet" vs "noisy"
3. **Historical analysis:** Correlate quiet entries with win rate

**Recommendation:** ✅ **Yes - implement relative volume**

---

## Implementation Roadmap

### Phase 1: Immediate (Low Effort)
- [x] Volume tracking in watchlist
- [x] Volatility ratio in watchlist
- [ ] Monitor preserves these fields ← **Just fixed**

### Phase 2: Active Trade Tracking (Medium Effort)
- [ ] Add `entryVolRatio`, `entryVolume1`, `entryVolume2` to trades table
- [ ] Calculate `currentVolRatio` in monitor for active trades
- [ ] Add `volRatioDrift` to trade state

### Phase 3: Health Integration (Medium Effort)
- [ ] Add volatility signals to health score calculation
- [ ] Display in Telegram trade status

### Phase 4: Relative Volume (Higher Effort)
- [ ] Extract volume from Hyperliquid candles in scanner
- [ ] Calculate 20d average and relative volume
- [ ] Add to watchlist display
- [ ] Consider as entry filter (optional)

---

## Database Schema Changes Required

### Trades Table
```sql
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_vol_ratio DECIMAL(5,3);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_volume1 DECIMAL(20,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_volume2 DECIMAL(20,2);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS current_vol_ratio DECIMAL(5,3);
```

### Watchlist Table (for relative volume)
```sql
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS avg_volume1 DECIMAL(20,2);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS avg_volume2 DECIMAL(20,2);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS relative_vol1 DECIMAL(5,2);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS relative_vol2 DECIMAL(5,2);
```

---

## Summary of Recommendations

| Question | Recommendation | Priority |
|----------|---------------|----------|
| Recalculate in monitor? | Only `volRatio` for active trades | Medium |
| Track for active trades? | **Yes** - entry values + current | High |
| Affect health status? | **Yes** - volRatio drift signals | Medium |
| Add relative volume? | **Yes** - from existing candle data | Medium |

---

## Next Steps

1. Review and approve this assessment
2. Decide which phases to implement
3. Create migration scripts
4. Implement in order of priority


