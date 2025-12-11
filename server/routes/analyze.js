/**
 * Pair Analysis API
 * 
 * Generates comprehensive analysis reports for trading pairs.
 * Uses the same logic as scripts/analyzePair.js (analyzePair function)
 */

const express = require('express');
const router = express.Router();
const { analyzePair } = require('../../lib/pairAnalysis');
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
    const direction = req.query.direction || 'long';
    
    if (!['long', 'short'].includes(direction.toLowerCase())) {
      return res.status(400).json({ error: 'Direction must be "long" or "short"' });
    }

    // Use analyzePair() - same logic as CLI script
    const result = await analyzePair({
      symbol1: asset1,
      symbol2: asset2,
      direction: direction.toLowerCase(),
      timeframes: [7, 30, 90, 180],
      obvTimeframes: [7, 30]
    });

    // Use normalized symbols from result (handles k-prefix correctly)
    const sym1 = result.symbol1;
    const sym2 = result.symbol2;

    // Fetch funding rates (use normalized symbols for Hyperliquid lookup)
    let funding = null;
    try {
      const fundingMap = await fetchCurrentFunding();
      const longAsset = direction === 'long' ? sym1 : sym2;
      const shortAsset = direction === 'long' ? sym2 : sym1;
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

    // Transform analyzePair result to API response format
    const response = {
      pair: result.pair,
      asset1: sym1,
      asset2: sym2,
      direction: result.direction,
      generatedAt: new Date().toISOString(),
      processingTimeMs: Date.now() - startTime,

      // Current state
      currentPrices: {
        [sym1]: result.currentPrice1,
        [sym2]: result.currentPrice2
      },

      // Signal
      signal: {
        zScore30d: result.standardized?.zScore30d || result.timeframes[30]?.zScore || 0,
        isReady: result.standardized?.zScore30d 
          ? Math.abs(result.standardized.zScore30d) >= (result.standardized?.optimalEntryThreshold || 1.5)
          : false,
        direction: result.direction,
        strength: Math.abs(result.standardized?.zScore30d || result.timeframes[30]?.zScore || 0)
      },

      // Advanced Analytics
      advanced: result.advancedMetrics ? {
        regime: result.advancedMetrics.regime,
        hurst: result.advancedMetrics.hurst,
        dualBeta: result.advancedMetrics.dualBeta,
        conviction: result.advancedMetrics.conviction
      } : null,

      // Standardized Metrics
      standardized: result.standardized ? {
        beta: result.standardized.beta30d,
        correlation: result.standardized.correlation30d,
        zScore: result.standardized.zScore30d,
        halfLife: result.standardized.halfLife30d,
        isCointegrated: result.standardized.isCointegrated90d,
        positionSizing: result.positionSizing ? {
          weight1: Math.round(result.positionSizing.weight1 * 100 * 10) / 10, // Round to 1 decimal
          weight2: Math.round(result.positionSizing.weight2 * 100 * 10) / 10
        } : null
      } : null,

      // Multi-timeframe - transform from analyzePair format
      timeframes: Object.values(result.timeframes || {})
        .filter(tf => !tf.error && [7, 30, 90, 180].includes(tf.days))
        .reduce((acc, tf) => {
          acc[tf.days] = {
            days: tf.days,
            correlation: tf.correlation,
            beta: tf.beta,
            zScore: tf.zScore,
            halfLife: tf.halfLife === Infinity ? null : tf.halfLife,
            isCointegrated: tf.isCointegrated,
            gamma: tf.gamma || null,
            theta: tf.theta || null,
            price1Start: tf.price1Start,
            price1End: tf.price1End,
            price2Start: tf.price2Start,
            price2End: tf.price2End
          };
          return acc;
        }, {}),

      // Divergence analysis
      divergence: result.standardized?.divergenceProfile ? {
        optimalEntry: result.standardized.optimalEntryThreshold || 1.5,
        // Calculate maxHistoricalZ as highest threshold with events, or current Z if higher
        maxHistoricalZ: (() => {
          const currentZ = Math.abs(result.standardized.zScore30d || 0);
          let maxThreshold = 0;
          if (result.standardized.divergenceProfile) {
            for (const [threshold, stats] of Object.entries(result.standardized.divergenceProfile)) {
              if (threshold !== 'currentZROI' && stats.events > 0) {
                maxThreshold = Math.max(maxThreshold, parseFloat(threshold));
              }
            }
          }
          return Math.max(maxThreshold, currentZ);
        })(),
        currentZ: result.standardized.zScore30d || 0,
        thresholds: Object.entries(result.standardized.divergenceProfile)
          .filter(([key]) => key !== 'maxHistoricalZ' && key !== 'currentZ' && key !== 'currentZROI')
          .reduce((acc, [threshold, stats]) => {
            // Parse rate from string like "93.8%" to number (0.938)
            let reversionRate = null;
            if (stats.rate) {
              if (typeof stats.rate === 'string') {
                const rateNum = parseFloat(stats.rate.replace('%', ''));
                reversionRate = isNaN(rateNum) ? null : rateNum / 100;
              } else if (typeof stats.rate === 'number') {
                reversionRate = stats.rate;
              }
            }
            
            // Parse avgTimeToRevert from string to number
            let avgDuration = null;
            if (stats.avgTimeToRevert) {
              if (typeof stats.avgTimeToRevert === 'string') {
                const durationNum = parseFloat(stats.avgTimeToRevert);
                avgDuration = isNaN(durationNum) ? null : durationNum;
              } else if (typeof stats.avgTimeToRevert === 'number') {
                avgDuration = stats.avgTimeToRevert;
              }
            }
            
            acc[threshold] = {
              totalEvents: stats.events || 0,
              revertedEvents: stats.reverted || 0,
              reversionRate,
              avgDuration,
              avgPeakZ: stats.avgPeakZ || null
            };
            return acc;
          }, {})
      } : null,

      // Expected ROI
      expectedROI: result.standardized?.currentZROI ? {
        currentZ: parseFloat(result.standardized.currentZROI.currentZ) || 0,
        fixedExitZ: parseFloat(result.standardized.currentZROI.fixedExitZ) || 0.5,
        roiFixed: result.standardized.currentZROI.roiFixed || '0%',
        timeToFixed: result.standardized.currentZROI.timeToFixed 
          ? (typeof result.standardized.currentZROI.timeToFixed === 'string' 
              ? parseFloat(result.standardized.currentZROI.timeToFixed) 
              : result.standardized.currentZROI.timeToFixed)
          : null,
        percentExitZ: parseFloat(result.standardized.currentZROI.percentExitZ) || 0,
        roiPercent: result.standardized.currentZROI.roiPercent || '0%',
        timeToPercent: result.standardized.currentZROI.timeToPercent
          ? (typeof result.standardized.currentZROI.timeToPercent === 'string'
              ? parseFloat(result.standardized.currentZROI.timeToPercent)
              : result.standardized.currentZROI.timeToPercent)
          : null
      } : null,

      // Percentage-based reversion
      percentageReversion: result.standardized?.divergenceProfilePercent ? 
        Object.entries(result.standardized.divergenceProfilePercent).reduce((acc, [threshold, stats]) => {
          // Parse rate from string like "93.8%" to number (0.938)
          let reversionRate = null;
          if (stats.rate) {
            if (typeof stats.rate === 'string') {
              const rateNum = parseFloat(stats.rate.replace('%', ''));
              reversionRate = isNaN(rateNum) ? null : rateNum / 100;
            } else if (typeof stats.rate === 'number') {
              reversionRate = stats.rate;
            }
          }
          
          // Parse avgTimeToRevert from string to number
          let avgDuration = null;
          if (stats.avgTimeToRevert) {
            if (typeof stats.avgTimeToRevert === 'string') {
              const durationNum = parseFloat(stats.avgTimeToRevert);
              avgDuration = isNaN(durationNum) ? null : durationNum;
            } else if (typeof stats.avgTimeToRevert === 'number') {
              avgDuration = stats.avgTimeToRevert;
            }
          }
          
          acc[threshold] = {
            exitZ: parseFloat(threshold) * 0.5,
            totalEvents: stats.events || 0,
            revertedEvents: stats.reverted || 0,
            reversionRate,
            avgDuration
          };
          return acc;
        }, {}) : null,

      // Funding
      funding,

      // OBV
      obv: Object.values(result.timeframes || {})
        .filter(tf => !tf.error && tf.obv1Change !== null && [7, 30].includes(tf.days))
        .reduce((acc, tf) => {
          acc[tf.days] = {
            [sym1]: tf.obv1Change,
            [sym2]: tf.obv2Change
          };
          return acc;
        }, {})
    };

    res.json(response);

  } catch (error) {
    console.error('[ANALYZE API] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
