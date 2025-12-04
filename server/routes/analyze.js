/**
 * Pair Analysis API
 * 
 * Generates comprehensive analysis reports for trading pairs.
 * Matches the output format of scripts/analyzePair.js
 */

const express = require('express');
const router = express.Router();
const { Hyperliquid } = require('hyperliquid');
const {
  analyzePair,
  calculateCorrelation,
  checkPairFitness,
  analyzeHistoricalDivergences,
  calculateHurst,
  calculateDualBeta,
  detectRegime,
  calculateConvictionScore,
  testCointegration
} = require('../../lib/pairAnalysis');
const { fetchCurrentFunding, calculateNetFunding } = require('../../lib/funding');

/**
 * GET /api/analyze/:asset1/:asset2
 * Returns comprehensive analysis for a pair
 * 
 * @param asset1 - First asset symbol (e.g., "ETH")
 * @param asset2 - Second asset symbol (e.g., "BTC")
 * @query direction - Trade direction: "long" or "short" (default: auto-detect based on z-score)
 */
router.get('/:asset1/:asset2', async (req, res) => {
  const startTime = Date.now();
  
  try {
    let { asset1, asset2 } = req.params;
    asset1 = asset1.toUpperCase();
    asset2 = asset2.toUpperCase();
    
    // Initialize Hyperliquid SDK
    const sdk = new Hyperliquid();
    
    // Suppress console output from SDK
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    
    try {
      await sdk.connect();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // Fetch 200 days of data for multi-timeframe analysis
    const endTime = Date.now();
    const fetchStart = endTime - (200 * 24 * 60 * 60 * 1000);
    
    const [candles1, candles2] = await Promise.all([
      sdk.info.getCandleSnapshot(`${asset1}-PERP`, '1d', fetchStart, endTime),
      sdk.info.getCandleSnapshot(`${asset2}-PERP`, '1d', fetchStart, endTime)
    ]);

    // Disconnect SDK
    console.log = () => {};
    console.error = () => {};
    try {
      await sdk.disconnect();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    if (!candles1?.length || !candles2?.length) {
      return res.status(404).json({ error: 'Could not fetch price data' });
    }

    // Sort and align candles
    const map1 = new Map();
    const map2 = new Map();
    candles1.forEach(c => map1.set(new Date(c.t).toISOString().split('T')[0], {
      close: parseFloat(c.c),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      open: parseFloat(c.o),
      volume: parseFloat(c.v)
    }));
    candles2.forEach(c => map2.set(new Date(c.t).toISOString().split('T')[0], {
      close: parseFloat(c.c),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      open: parseFloat(c.o),
      volume: parseFloat(c.v)
    }));

    // Find common dates
    const commonDates = [...map1.keys()].filter(d => map2.has(d)).sort();
    
    if (commonDates.length < 30) {
      return res.status(400).json({ error: 'Insufficient overlapping data (need 30+ days)' });
    }

    // Helper to get price arrays for a window
    const getPrices = (days) => {
      const dates = commonDates.slice(-days);
      return {
        dates,
        prices1: dates.map(d => map1.get(d).close),
        prices2: dates.map(d => map2.get(d).close),
        data1: dates.map(d => map1.get(d)),
        data2: dates.map(d => map2.get(d))
      };
    };

    // Calculate multi-timeframe metrics
    const timeframes = {};
    for (const days of [7, 30, 90, 180]) {
      if (commonDates.length >= days) {
        const { dates, prices1, prices2 } = getPrices(days);
        try {
          const fitness = checkPairFitness(prices1, prices2);
          const coint = days >= 30 ? testCointegration(prices1, prices2, fitness.beta) : { isCointegrated: false };
          
          timeframes[days] = {
            days,
            correlation: fitness.correlation,
            beta: fitness.beta,
            zScore: fitness.zScore,
            halfLife: fitness.halfLife === Infinity ? null : fitness.halfLife,
            isCointegrated: coint.isCointegrated,
            gamma: fitness.gamma || null,
            theta: fitness.theta || null,
            price1Start: prices1[0],
            price1End: prices1[prices1.length - 1],
            price2Start: prices2[0],
            price2End: prices2[prices2.length - 1]
          };
        } catch (e) {
          timeframes[days] = { days, error: e.message };
        }
      }
    }

    // Get 30-day and 90-day data for core calculations
    const data30 = getPrices(30);
    const data60 = commonDates.length >= 60 ? getPrices(60) : null;
    const data90 = commonDates.length >= 90 ? getPrices(90) : null;

    // Core 30-day fitness
    const fitness30 = checkPairFitness(data30.prices1, data30.prices2);
    
    // Auto-detect direction based on z-score
    const direction = req.query.direction || (fitness30.zScore < 0 ? 'long' : 'short');

    // === ADVANCED METRICS ===
    
    // 1. Hurst Exponent (60-day)
    let hurstResult = { hurst: null, classification: 'UNKNOWN' };
    if (data60) {
      const spread60 = data60.prices1.map((p, i) => p - fitness30.beta * data60.prices2[i]);
      const hurst = calculateHurst(spread60);
      hurstResult = {
        hurst: hurst !== null ? parseFloat(hurst.toFixed(3)) : null,
        classification: hurst === null ? 'UNKNOWN' : 
          hurst < 0.4 ? 'STRONG_REVERSION' :
          hurst < 0.5 ? 'MEAN_REVERTING' :
          hurst < 0.6 ? 'RANDOM_WALK' : 'TRENDING'
      };
    }

    // 2. Dual Beta Analysis
    let dualBeta = null;
    if (data90) {
      const halfLife = fitness30.halfLife || 7;
      dualBeta = calculateDualBeta(data90.prices1, data90.prices2, halfLife);
    }

    // 3. Regime Detection
    const recentZScores = [];
    for (let i = Math.max(0, commonDates.length - 10); i < commonDates.length; i++) {
      const windowDates = commonDates.slice(Math.max(0, i - 29), i + 1);
      if (windowDates.length >= 15) {
        const p1 = windowDates.map(d => map1.get(d).close);
        const p2 = windowDates.map(d => map2.get(d).close);
        try {
          const f = checkPairFitness(p1, p2);
          recentZScores.push(f.zScore);
        } catch (e) {}
      }
    }
    
    const regime = detectRegime(
      fitness30.zScore,
      1.5, // entry threshold
      recentZScores,
      hurstResult.hurst
    );

    // 4. Cointegration (90-day)
    let coint90 = { isCointegrated: false, pValue: null };
    if (data90) {
      const beta90 = checkPairFitness(data90.prices1, data90.prices2).beta;
      coint90 = testCointegration(data90.prices1, data90.prices2, beta90);
    }

    // 5. Conviction Score
    const conviction = calculateConvictionScore({
      correlation: fitness30.correlation,
      rSquared: dualBeta?.structural?.r2 || fitness30.correlation ** 2,
      halfLife: fitness30.halfLife,
      hurst: hurstResult.hurst,
      isCointegrated: coint90.isCointegrated,
      betaDrift: dualBeta?.drift || 0
    });

    // 6. Divergence Analysis (30-day)
    const divergenceProfile = analyzeHistoricalDivergences(
      data30.prices1, 
      data30.prices2, 
      fitness30.beta
    );

    // 7. Position Sizing
    const beta = fitness30.beta;
    const w1 = 1 / (1 + beta);
    const w2 = beta / (1 + beta);
    const positionSizing = {
      weight1: parseFloat((w1 * 100).toFixed(1)),
      weight2: parseFloat((w2 * 100).toFixed(1))
    };

    // 8. Funding rates
    let funding = null;
    try {
      const fundingMap = await fetchCurrentFunding();
      const longAsset = direction === 'long' ? asset1 : asset2;
      const shortAsset = direction === 'long' ? asset2 : asset1;
      const netFunding = calculateNetFunding(longAsset, shortAsset, fundingMap);
      
      if (netFunding.netFunding8h !== null) {
        funding = {
          longAsset,
          shortAsset,
          longRate: fundingMap.get(longAsset)?.funding || 0,
          shortRate: fundingMap.get(shortAsset)?.funding || 0,
          net8h: netFunding.netFunding8h,
          netDaily: netFunding.netFundingDaily,
          netMonthly: netFunding.netFundingMonthly,
          favorable: netFunding.netFunding8h >= 0
        };
      }
    } catch (e) {
      // Funding optional
    }

    // 9. OBV (On-Balance Volume) - 7d and 30d
    const obv = {};
    for (const days of [7, 30]) {
      if (commonDates.length >= days) {
        const { data1, data2 } = getPrices(days);
        
        let obv1 = 0, obv2 = 0;
        for (let i = 1; i < data1.length; i++) {
          if (data1[i].close > data1[i-1].close) obv1 += data1[i].volume;
          else if (data1[i].close < data1[i-1].close) obv1 -= data1[i].volume;
          
          if (data2[i].close > data2[i-1].close) obv2 += data2[i].volume;
          else if (data2[i].close < data2[i-1].close) obv2 -= data2[i].volume;
        }
        
        obv[days] = {
          [asset1]: Math.round(obv1),
          [asset2]: Math.round(obv2)
        };
      }
    }

    // 10. Current prices
    const currentPrice1 = data30.prices1[data30.prices1.length - 1];
    const currentPrice2 = data30.prices2[data30.prices2.length - 1];

    // === BUILD RESPONSE ===
    const response = {
      pair: `${asset1}/${asset2}`,
      asset1,
      asset2,
      direction,
      generatedAt: new Date().toISOString(),
      processingTimeMs: Date.now() - startTime,

      // Current state
      currentPrices: {
        [asset1]: currentPrice1,
        [asset2]: currentPrice2
      },

      // Signal
      signal: {
        zScore30d: fitness30.zScore,
        isReady: Math.abs(fitness30.zScore) >= (divergenceProfile?.optimalEntry || 1.5),
        direction: fitness30.zScore < 0 ? 'long' : 'short',
        strength: Math.abs(fitness30.zScore)
      },

      // Advanced Analytics
      advanced: {
        regime,
        hurst: hurstResult,
        dualBeta,
        conviction
      },

      // Standardized Metrics (30d/90d)
      standardized: {
        beta: fitness30.beta,
        correlation: fitness30.correlation,
        zScore: fitness30.zScore,
        halfLife: fitness30.halfLife === Infinity ? null : fitness30.halfLife,
        isCointegrated: coint90.isCointegrated,
        positionSizing
      },

      // Multi-timeframe
      timeframes,

      // Divergence analysis
      divergence: divergenceProfile,

      // Funding
      funding,

      // OBV
      obv
    };

    res.json(response);

  } catch (error) {
    console.error('[ANALYZE API] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

