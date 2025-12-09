/**
 * Z-Score History API
 * 
 * Fetches historical prices and calculates rolling z-scores for charting.
 * Supports both daily (1d) and hourly (1h) resolutions.
 */

const express = require('express');
const router = express.Router();
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../../lib/pairAnalysis');

/**
 * GET /api/zscore/:pair
 * Returns rolling z-score history for a pair
 * 
 * @param pair - Pair in format "LDO_UMA" or "LDO/UMA"
 * @query days - Number of days (default: 30, max: 90 for daily, 60 for hourly)
 * @query resolution - '1d' for daily (default) or '1h' for hourly
 */
router.get('/:pair', async (req, res) => {
  try {
    const pairParam = req.params.pair;
    const resolution = req.query.resolution === '1h' ? '1h' : '1d';
    const maxDays = resolution === '1h' ? 60 : 90;
    const days = Math.min(parseInt(req.query.days) || 30, maxDays);
    
    // Parse pair
    const [asset1, asset2] = pairParam.replace('_', '/').split('/');
    if (!asset1 || !asset2) {
      return res.status(400).json({ error: 'Invalid pair format. Use ASSET1_ASSET2' });
    }

    // Initialize Hyperliquid SDK
    const sdk = new Hyperliquid();
    
    // Suppress console output from SDK
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    
    await sdk.connect();
    
    console.log = origLog;
    console.error = origErr;

    // Fetch historical candles
    const endTime = Date.now();
    // For hourly, we need extra buffer for the lookback window
    const bufferDays = resolution === '1h' ? 35 : 10;
    const startTime = endTime - ((days + bufferDays) * 24 * 60 * 60 * 1000);
    
    const [candles1, candles2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${asset1}-PERP`, resolution, startTime, endTime),
      sdk.info.getCandleSnapshot(`${asset2}-PERP`, resolution, startTime, endTime)
    ]);

    // Disconnect SDK
    console.log = () => {};
    console.error = () => {};
    await sdk.disconnect();
    console.log = origLog;
    console.error = origErr;

    if (!candles1?.length || !candles2?.length) {
      return res.status(404).json({ error: 'Could not fetch price data' });
    }

    // Sort and align candles
    const sorted1 = candles1.sort((a, b) => a.t - b.t);
    const sorted2 = candles2.sort((a, b) => a.t - b.t);

    // Create time-indexed maps
    const map1 = new Map(sorted1.map(c => [c.t, parseFloat(c.c)]));
    const map2 = new Map(sorted2.map(c => [c.t, parseFloat(c.c)]));

    // Find common timestamps
    const commonTimes = [...map1.keys()].filter(t => map2.has(t)).sort((a, b) => a - b);
    
    // For hourly, we need 30 days of data (720 hours) for lookback
    // For daily, we need 20 days
    const minDataPoints = resolution === '1h' ? 30 * 24 : 15;
    if (commonTimes.length < minDataPoints) {
      return res.status(400).json({ 
        error: `Insufficient data: ${commonTimes.length} points (need ${minDataPoints})` 
      });
    }

    // Calculate rolling z-scores
    // For hourly: 30-day lookback (720 hours) - matches divergence analysis
    // For daily: 20-day lookback
    const lookback = resolution === '1h' ? 30 * 24 : 20;
    const zScoreData = [];

    // For hourly data, we may want to sample every N hours to reduce data points
    // Let's sample every 4 hours for hourly view (6 points per day instead of 24)
    const sampleRate = resolution === '1h' ? 4 : 1;

    for (let i = lookback; i < commonTimes.length; i += sampleRate) {
      const windowTimes = commonTimes.slice(Math.max(0, i - lookback), i + 1);
      const prices1 = windowTimes.map(t => map1.get(t));
      const prices2 = windowTimes.map(t => map2.get(t));

      // For hourly, convert prices to daily-equivalent for fitness calculation
      // by taking the lookback window and calculating beta/correlation properly
      try {
        const fitness = checkPairFitness(prices1, prices2);
        const timestamp = commonTimes[i];
        
        const dateStr = resolution === '1h' 
          ? new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')  // "2025-12-09 14:00"
          : new Date(timestamp).toISOString().split('T')[0];  // "2025-12-09"
        
        zScoreData.push({
          timestamp,
          date: dateStr,
          zScore: parseFloat(fitness.zScore.toFixed(4)),
          price1: prices1[prices1.length - 1],
          price2: prices2[prices2.length - 1]
        });
      } catch (e) {
        // Skip if calculation fails
      }
    }

    // Get current stats from latest calculation
    const latestWindow = resolution === '1h' ? 30 * 24 : 30;
    const latestPrices1 = commonTimes.slice(-latestWindow).map(t => map1.get(t));
    const latestPrices2 = commonTimes.slice(-latestWindow).map(t => map2.get(t));
    let currentStats = {};
    
    try {
      const fitness = checkPairFitness(latestPrices1, latestPrices2);
      // Half-life is returned in data point units
      // For hourly data, convert from hours to days (÷24)
      const halfLifeDays = resolution === '1h' && fitness.halfLife !== null
        ? fitness.halfLife / 24
        : fitness.halfLife;
      
      // Calculate optimal entry threshold using percentage-based reversion (to 50% of threshold)
      // Option B: Highest threshold with >= 90% reversion rate and min 3 events
      const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
      const reversionProfile = {};
      
      for (const threshold of thresholds) {
        let events = 0;
        let reverted = 0;
        let activeEpisode = null;
        const percentReversionTarget = threshold * 0.5; // 50% of threshold
        
        for (let i = 0; i < zScoreData.length; i++) {
          const absZ = Math.abs(zScoreData[i].zScore);
          const currentTime = zScoreData[i].timestamp;
          
          // Start new episode only if no active episode
          if (absZ >= threshold && activeEpisode === null) {
            events++;
            activeEpisode = { startTime: currentTime };
          }
          
          // Exit divergence: reversion to < 50% of threshold (percentage-based)
          if (activeEpisode !== null && absZ < percentReversionTarget) {
            reverted++;
            activeEpisode = null;
          }
        }
        
        const rate = events > 0 ? (reverted / events) * 100 : 0;
        reversionProfile[threshold] = { events, reverted, rate };
      }
      
      // Find optimal entry: highest threshold with >= 90% reversion and min 3 events
      let optimalEntry = 1.5;
      for (let i = thresholds.length - 1; i >= 0; i--) {
        const threshold = thresholds[i];
        const stats = reversionProfile[threshold];
        if (stats.events >= 3 && stats.rate >= 90) {
          optimalEntry = threshold;
          break;
        }
      }
      // Fallback: if no threshold meets criteria, find highest with >= 80% and min 2 events
      if (optimalEntry === 1.5) {
        for (let i = thresholds.length - 1; i >= 0; i--) {
          const threshold = thresholds[i];
          const stats = reversionProfile[threshold];
          if (stats.events >= 2 && stats.rate >= 80) {
            optimalEntry = threshold;
            break;
          }
        }
      }
      
      currentStats = {
        correlation: parseFloat(fitness.correlation.toFixed(4)),
        beta: parseFloat(fitness.beta.toFixed(4)),
        halfLife: halfLifeDays !== null ? parseFloat(halfLifeDays.toFixed(2)) : null,
        currentZ: parseFloat(fitness.zScore.toFixed(4)),
        optimalEntry: optimalEntry
      };
      
      // Add current Z as final data point
      const now = Date.now();
      const nowStr = resolution === '1h'
        ? new Date(now).toISOString().slice(0, 16).replace('T', ' ')
        : new Date().toISOString().split('T')[0];
      const lastDataPoint = zScoreData[zScoreData.length - 1];
      
      // Only add if it's significantly different time
      if (!lastDataPoint || (now - lastDataPoint.timestamp) > (resolution === '1h' ? 3600000 : 86400000)) {
        zScoreData.push({
          timestamp: now,
          date: nowStr,
          zScore: currentStats.currentZ,
          price1: latestPrices1[latestPrices1.length - 1],
          price2: latestPrices2[latestPrices2.length - 1]
        });
      } else {
        // Update the last point with current Z
        lastDataPoint.zScore = currentStats.currentZ;
      }
    } catch (e) {}

    res.json({
      pair: `${asset1}/${asset2}`,
      asset1,
      asset2,
      days,
      resolution,
      dataPoints: zScoreData.length,
      data: zScoreData,
      stats: currentStats
    });

  } catch (error) {
    console.error('[ZSCORE API] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
