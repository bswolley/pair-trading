/**
 * Z-Score History API
 * 
 * Fetches historical prices and calculates rolling z-scores for charting.
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
 * @query days - Number of days (default: 30, max: 90)
 */
router.get('/:pair', async (req, res) => {
  try {
    const pairParam = req.params.pair;
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    
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
    const startTime = endTime - ((days + 10) * 24 * 60 * 60 * 1000);
    
    const [candles1, candles2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${asset1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${asset2}-PERP`, '1d', startTime, endTime)
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
    
    if (commonTimes.length < 15) {
      return res.status(400).json({ error: 'Insufficient overlapping data' });
    }

    // Calculate rolling z-scores with a 20-day lookback
    const lookback = 20;
    const zScoreData = [];

    for (let i = lookback; i < commonTimes.length; i++) {
      const windowTimes = commonTimes.slice(i - lookback, i + 1);
      const prices1 = windowTimes.map(t => map1.get(t));
      const prices2 = windowTimes.map(t => map2.get(t));

      try {
        const fitness = checkPairFitness(prices1, prices2);
        const timestamp = commonTimes[i];
        
        zScoreData.push({
          timestamp,
          date: new Date(timestamp).toISOString().split('T')[0],
          zScore: parseFloat(fitness.zScore.toFixed(4)),
          price1: prices1[prices1.length - 1],
          price2: prices2[prices2.length - 1]
        });
      } catch (e) {
        // Skip if calculation fails
      }
    }

    // Get current stats from latest calculation
    const latestPrices1 = commonTimes.slice(-30).map(t => map1.get(t));
    const latestPrices2 = commonTimes.slice(-30).map(t => map2.get(t));
    let currentStats = {};
    
    try {
      const fitness = checkPairFitness(latestPrices1, latestPrices2);
      currentStats = {
        correlation: parseFloat(fitness.correlation.toFixed(4)),
        beta: parseFloat(fitness.beta.toFixed(4)),
        halfLife: parseFloat(fitness.halfLife.toFixed(2)),
        currentZ: parseFloat(fitness.zScore.toFixed(4))
      };
      
      // Add current Z as final data point (today, even if candle is open)
      const now = Date.now();
      const today = new Date().toISOString().split('T')[0];
      const lastDataPoint = zScoreData[zScoreData.length - 1];
      
      // Only add if it's a different date or significantly different Z
      if (!lastDataPoint || lastDataPoint.date !== today) {
        zScoreData.push({
          timestamp: now,
          date: today,
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

