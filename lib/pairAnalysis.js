/**
 * Core Pair Trading Analysis Module
 * 
 * Reusable functions for analyzing trading pairs
 * Calculates: correlation, beta, z-score, gamma, theta, OBV, cointegration
 */

const axios = require('axios');
const { obv } = require('indicatorts');
const { Hyperliquid } = require('hyperliquid');
// const { generateZScoreChart } = require('./generateZScoreChart'); // COMMENTED OUT - chart generation

/**
 * Analyze a single trading pair
 * @param {Object} config - Pair configuration
 * @param {string} config.symbol1 - Base asset symbol (e.g., 'HYPE')
 * @param {string} config.symbol2 - Underlying asset symbol (e.g., 'ZEC')
 * @param {string} config.direction - 'long' or 'short' (for base asset)
 * @param {Array<number>} config.timeframes - Array of days to analyze (e.g., [7, 30, 90, 180])
 * @param {Array<number>} config.obvTimeframes - Array of days for OBV calculation (e.g., [7, 30])
 * @returns {Promise<Object>} Analysis results
 */
async function analyzePair(config) {
  const defaultConfig = require('../config');
  const {
    symbol1,
    symbol2,
    direction = 'long',
    timeframes = defaultConfig.getTimeframes(),
    obvTimeframes = defaultConfig.getOBVTimeframes()
  } = config;

  const pairResults = {
    pair: `${symbol1}/${symbol2}`,
    symbol1,
    symbol2,
    leftSide: symbol1,
    direction,
    timeframes: {},
    currentPrice1: null,
    currentPrice2: null,
    currentMcap1: null,
    currentMcap2: null
  };

  // Fetch market caps
  try {
    const [mcap1, mcap2] = await Promise.all([
      axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symbol1}&tsyms=USD`),
      axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symbol2}&tsyms=USD`)
    ]);
    if (mcap1.data.RAW?.[symbol1]?.USD) {
      pairResults.currentMcap1 = mcap1.data.RAW[symbol1].USD.MKTCAP;
    }
    if (mcap2.data.RAW?.[symbol2]?.USD) {
      pairResults.currentMcap2 = mcap2.data.RAW[symbol2].USD.MKTCAP;
    }
  } catch (error) {
    console.log(`Market cap fetch failed: ${error.message}`);
  }

  // Fetch full 180 days for OBV (with rate limit handling)
  let fullOBV1, fullOBV2, fullPrices1, fullPrices2;
  try {
    const limit = 185;
    const toTs = Math.floor(Date.now() / 1000);

    // Add delay between requests to avoid rate limits
    const [cc1] = await Promise.all([
      axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
        params: { fsym: symbol1, tsym: 'USD', limit, toTs }
      })
    ]);

    // Wait before second request
    await new Promise(resolve => setTimeout(resolve, 2000));

    const cc2 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
      params: { fsym: symbol2, tsym: 'USD', limit, toTs }
    });

    if (cc1.data.Response === 'Error' || cc2.data.Response === 'Error') {
      throw new Error(`CryptoCompare error: ${cc1.data.Message || cc2.data.Message}`);
    }

    const data1 = cc1.data.Data.Data || [];
    const data2 = cc2.data.Data.Data || [];

    const data1Map = new Map();
    const data2Map = new Map();

    data1.forEach(d => {
      const date = new Date(d.time * 1000).toISOString().split('T')[0];
      data1Map.set(date, d);
    });

    data2.forEach(d => {
      const date = new Date(d.time * 1000).toISOString().split('T')[0];
      data2Map.set(date, d);
    });

    const commonDates = [...data1Map.keys()].filter(d => data2Map.has(d)).sort();
    const selectedDates = commonDates.slice(-180);

    fullPrices1 = selectedDates.map(date => data1Map.get(date).close);
    fullPrices2 = selectedDates.map(date => data2Map.get(date).close);
    const fullVolumes1 = selectedDates.map(date => data1Map.get(date).volumeto || data1Map.get(date).volumefrom || 0);
    const fullVolumes2 = selectedDates.map(date => data2Map.get(date).volumeto || data2Map.get(date).volumefrom || 0);

    if (fullPrices1.length >= 180 && fullVolumes1.length >= 180) {
      fullOBV1 = obv(fullPrices1, fullVolumes1);
      fullOBV2 = obv(fullPrices2, fullVolumes2);
      pairResults.currentPrice1 = fullPrices1[fullPrices1.length - 1];
      pairResults.currentPrice2 = fullPrices2[fullPrices2.length - 1];
    }
  } catch (error) {
    // OBV data is optional - analysis can continue without it
    if (error.message.includes('rate limit')) {
      console.log(`⚠️  CryptoCompare rate limit hit - OBV data unavailable (analysis will continue without OBV)`);
    } else {
      console.log(`⚠️  OBV data unavailable: ${error.message} (analysis will continue without OBV)`);
    }
  }

  // Reuse Hyperliquid connection for all timeframes to reduce WebSocket noise
  let sdk = null;
  let originalLog, originalError;
  try {
    // Suppress WebSocket noise from Hyperliquid SDK
    originalLog = console.log;
    originalError = console.error;
    const noop = () => { };
    console.log = noop;
    console.error = noop;

    sdk = new Hyperliquid();
    await sdk.connect();

    // Restore console
    console.log = originalLog;
    console.error = originalError;
  } catch (error) {
    // Restore console before throwing error
    if (originalLog) console.log = originalLog;
    if (originalError) console.error = originalError;
    throw new Error(`Hyperliquid connection failed (MANDATORY for prices): ${error.message}`);
  }

  // Analyze each timeframe
  for (const days of timeframes) {
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
      const timeframeResult = await analyzeTimeframe(symbol1, symbol2, days, fullOBV1, fullOBV2, obvTimeframes, sdk);
      timeframeResult.days = days;
      timeframeResult.leftSideUndervalued = direction === 'long' ? timeframeResult.zScore < -1 : false;
      timeframeResult.leftSideOvervalued = direction === 'short' ? timeframeResult.zScore > 1 : false;
      timeframeResult.tradeReady = direction === 'short' ? timeframeResult.leftSideOvervalued : timeframeResult.leftSideUndervalued;

      pairResults.timeframes[days] = timeframeResult;
    } catch (error) {
      pairResults.timeframes[days] = { days, error: error.message };
    }
  }

  // Calculate standardized metrics (as per partner's spec)
  // - Beta/Hedge Ratio: 30 days (changed from 7d for stability)
  // - Correlation & Z-Score: 30 days
  // - Cointegration: 90 days
  // - Half-life: 30 days of data with 30-day beta using AR(1) regression
  try {
    const tf7d = pairResults.timeframes[7];
    const tf30d = pairResults.timeframes[30];
    const tf90d = pairResults.timeframes[90];

    // Calculate half-life with multiple combinations to find what matches partner
    let halfLife30d = null;
    const halfLifeVariations = {};

    if (tf7d?.beta !== null && tf30d?.beta !== null) {
      try {
        const endTime = Date.now();
        const startTime = endTime - ((30 + 5) * 24 * 60 * 60 * 1000);

        const [hl1Data, hl2Data] = await Promise.all([
          sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1d', startTime, endTime),
          sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1d', startTime, endTime)
        ]);

        if (hl1Data?.length > 0 && hl2Data?.length > 0) {
          const dailyMap1 = new Map();
          const dailyMap2 = new Map();

          hl1Data.forEach(c => {
            const date = new Date(c.t).toISOString().split('T')[0];
            dailyMap1.set(date, parseFloat(c.c));
          });

          hl2Data.forEach(c => {
            const date = new Date(c.t).toISOString().split('T')[0];
            dailyMap2.set(date, parseFloat(c.c));
          });

          const commonDates = [...dailyMap1.keys()].filter(d => dailyMap2.has(d)).sort();
          if (commonDates.length >= 30) {
            const selectedDates = commonDates.slice(-30);
            const prices30d_1 = selectedDates.map(d => dailyMap1.get(d));
            const prices30d_2 = selectedDates.map(d => dailyMap2.get(d));

            // Try different beta combinations
            const betas = {
              '7d': tf7d.beta,
              '30d': tf30d.beta
            };

            // Try different autocorrelation methods
            for (const [betaName, beta] of Object.entries(betas)) {
              const spreads30d = prices30d_1.map((p1, i) => Math.log(p1) - beta * Math.log(prices30d_2[i]));

              // Calculate delta (spread changes)
              const spreadDiffs30d = [];
              for (let i = 1; i < spreads30d.length; i++) {
                spreadDiffs30d.push(spreads30d[i] - spreads30d[i - 1]);
              }

              if (spreadDiffs30d.length >= 10) {
                const meanDiff = spreadDiffs30d.reduce((sum, d) => sum + d, 0) / spreadDiffs30d.length;

                // Method 1: Standard autocorrelation (current)
                let autocorr1 = 0, varDiff1 = 0;
                for (let i = 0; i < spreadDiffs30d.length; i++) {
                  const dev = spreadDiffs30d[i] - meanDiff;
                  varDiff1 += dev * dev;
                }
                for (let i = 1; i < spreadDiffs30d.length; i++) {
                  const dev = spreadDiffs30d[i] - meanDiff;
                  const devPrev = spreadDiffs30d[i - 1] - meanDiff;
                  autocorr1 += dev * devPrev;
                }
                varDiff1 /= spreadDiffs30d.length;
                autocorr1 /= (spreadDiffs30d.length - 1);
                const p1 = varDiff1 > 0 ? autocorr1 / varDiff1 : 0;

                // Method 2: Alternative autocorrelation (variance of current, autocov of pairs)
                // This matches partner's calculation better
                let autocorr2 = 0, varDiff2 = 0;
                for (let i = 1; i < spreadDiffs30d.length; i++) {
                  const dev = spreadDiffs30d[i] - meanDiff;
                  const devPrev = spreadDiffs30d[i - 1] - meanDiff;
                  autocorr2 += dev * devPrev;
                  varDiff2 += dev * dev; // Use current value variance, not previous
                }
                const n = spreadDiffs30d.length - 1;
                autocorr2 /= n;
                varDiff2 /= n;
                const p2 = varDiff2 > 0 ? autocorr2 / varDiff2 : 0;

                // Calculate half-life for each method
                const calculateHalfLife = (p) => {
                  if (p < 0 && p > -1) {
                    const hl = -Math.log(2) / Math.log(1 + p);
                    if (hl > 0 && isFinite(hl) && hl < 1000) {
                      return hl;
                    }
                  }
                  return null;
                };

                // Method 3: AR(1) regression on spread levels (alternative approach)
                // spread[t] = α + φ * spread[t-1] + ε[t]
                // half_life = -ln(2) / ln(φ) where 0 < φ < 1
                let phi = null;
                if (spreads30d.length >= 10) {
                  const spreadLevels = spreads30d.slice(0, -1); // X: spread[t-1]
                  const spreadNext = spreads30d.slice(1);       // Y: spread[t]

                  const meanX = spreadLevels.reduce((sum, s) => sum + s, 0) / spreadLevels.length;
                  const meanY = spreadNext.reduce((sum, s) => sum + s, 0) / spreadNext.length;

                  let numerator = 0, denominator = 0;
                  for (let i = 0; i < spreadLevels.length; i++) {
                    numerator += (spreadLevels[i] - meanX) * (spreadNext[i] - meanY);
                    denominator += Math.pow(spreadLevels[i] - meanX, 2);
                  }

                  phi = denominator > 0 ? numerator / denominator : null;
                }

                const hl1 = calculateHalfLife(p1);
                const hl2 = calculateHalfLife(p2);
                const hl3 = phi !== null && phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : null;
                if (hl3 !== null && (!isFinite(hl3) || hl3 < 0 || hl3 > 1000)) {
                  hl3 = null;
                }

                halfLifeVariations[`${betaName}_method1`] = { p: p1, halfLife: hl1 };
                halfLifeVariations[`${betaName}_method2`] = { p: p2, halfLife: hl2 };
                halfLifeVariations[`${betaName}_method3_ar1`] = { p: phi, halfLife: hl3 };

                // Default: use 30d beta with method 3 (AR1) - matches partner's numbers
                if (betaName === '30d' && hl3 !== null) {
                  halfLife30d = hl3;
                } else if (betaName === '30d' && hl2 !== null) {
                  // Fallback to method 2 if AR(1) fails
                  halfLife30d = hl2;
                } else if (betaName === '30d' && hl1 !== null) {
                  // Fallback to method 1 if method 2 fails
                  halfLife30d = hl1;
                } else if (betaName === '7d' && hl3 !== null && halfLife30d === null) {
                  // Try 7d AR(1) as fallback
                  halfLife30d = hl3;
                } else if (betaName === '7d' && hl1 !== null && halfLife30d === null) {
                  // Final fallback to 7d method 1
                  halfLife30d = hl1;
                }
              }
            }
          }
        }
      } catch (error) {
        // Fallback
        halfLife30d = tf30d?.halfLife ?? null;
      }
    } else {
      halfLife30d = tf30d?.halfLife ?? null;
    }

    // Calculate expected time to mean reversion (0.5 z-score threshold)
    let timeToMeanReversion = null;
    if (halfLife30d !== null && tf30d?.zScore !== null) {
      const currentZ = Math.abs(tf30d.zScore);
      const targetZ = 0.5; // Mean reversion threshold

      // Only calculate if current z-score is above threshold
      if (currentZ > targetZ && halfLife30d > 0) {
        // Exponential decay: time = half_life * log(|z_current| / |z_target|) / log(2)
        // This estimates time to reach target z-score based on half-life
        const timeToTarget = halfLife30d * Math.log(currentZ / targetZ) / Math.log(2);
        if (timeToTarget > 0 && isFinite(timeToTarget) && timeToTarget < 1000) {
          timeToMeanReversion = timeToTarget;
        }
      }
    }

    // Analyze historical divergences for dynamic thresholds
    let divergenceProfile = null;
    let divergenceProfilePercent = null;
    let optimalEntryThreshold = null;
    // let zScoreChart = null; // COMMENTED OUT - chart generation
    try {
      const divergenceAnalysis = await analyzeHistoricalDivergences(symbol1, symbol2, sdk, tf30d?.stdDevSpread, tf30d?.zScore);
      divergenceProfile = divergenceAnalysis.profile;
      divergenceProfilePercent = divergenceAnalysis.profilePercent;
      optimalEntryThreshold = divergenceAnalysis.optimalEntry;
      currentZROI = divergenceAnalysis.currentZROI;

      // Calculate time to reversion for current z-score ROI (if available)
      if (currentZROI && halfLife30d !== null && tf30d?.zScore !== null) {
        const currentZ = Math.abs(tf30d.zScore);
        const fixedExitZ = 0.5;
        const percentExitZ = currentZ * 0.5;

        // Time to fixed exit (0.5)
        if (currentZ > fixedExitZ && halfLife30d > 0) {
          const timeToFixed = halfLife30d * Math.log(currentZ / fixedExitZ) / Math.log(2);
          if (timeToFixed > 0 && isFinite(timeToFixed) && timeToFixed < 1000) {
            currentZROI.timeToFixed = timeToFixed.toFixed(1);
          }
        }

        // Time to percentage exit (50% of current z)
        if (currentZ > percentExitZ && halfLife30d > 0) {
          const timeToPercent = halfLife30d * Math.log(currentZ / percentExitZ) / Math.log(2);
          if (timeToPercent > 0 && isFinite(timeToPercent) && timeToPercent < 1000) {
            currentZROI.timeToPercent = timeToPercent.toFixed(1);
          }
        }
      }
      // Generate chart if we have z-score data
      // COMMENTED OUT - chart generation
      // if (divergenceAnalysis.zScores && divergenceAnalysis.zScores.length > 0) {
      //   zScoreChart = generateZScoreChart(divergenceAnalysis.zScores, divergenceProfile);
      // }
    } catch (error) {
      console.log(`Divergence analysis failed: ${error.message}`);
    }

    // Compare forward prediction vs historical average (validation)
    let predictionVsHistorical = null;
    if (timeToMeanReversion !== null && divergenceProfile) {
      // Find closest threshold to current z-score for comparison
      const currentZ = Math.abs(tf30d?.zScore ?? 0);
      const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
      let closestThreshold = null;
      let minDiff = Infinity;

      for (const threshold of thresholds) {
        if (currentZ >= threshold) {
          const diff = currentZ - threshold;
          if (diff < minDiff) {
            minDiff = diff;
            closestThreshold = threshold;
          }
        }
      }

      if (closestThreshold && divergenceProfile[closestThreshold.toString()]?.avgTimeToRevert) {
        const historicalAvg = parseFloat(divergenceProfile[closestThreshold.toString()].avgTimeToRevert);
        const prediction = timeToMeanReversion;
        const difference = Math.abs(prediction - historicalAvg);
        const percentDiff = historicalAvg > 0 ? (difference / historicalAvg) * 100 : null;

        predictionVsHistorical = {
          threshold: closestThreshold,
          forwardPrediction: prediction.toFixed(1),
          historicalAverage: historicalAvg.toFixed(1),
          difference: difference.toFixed(1),
          percentDifference: percentDiff !== null ? percentDiff.toFixed(1) + '%' : null,
          // If within 20%, prediction is reasonably accurate
          isAccurate: percentDiff !== null && percentDiff < 20
        };
      }
    }

    // Calculate expected ROI from z-score mean reversion (assuming constant beta)
    // Formula: spread_change = (z_entry - z_exit) * stdDevSpread
    // ROI ≈ spread_change (in log space, which approximates percentage return for small changes)
    let expectedROI = null;
    let expectedROIInfo = null;
    if (tf30d?.zScore !== null && tf30d?.beta !== null && tf30d?.stdDevSpread !== null) {
      const currentZ = Math.abs(tf30d.zScore);
      const targetZ = 0.5; // Exit at 0.5 z-score

      if (currentZ > targetZ) {
        // Calculate spread change from z-score reversion
        // spread_change = (z_entry - z_exit) * stdDevSpread
        const zChange = currentZ - targetZ;
        const spreadChange = zChange * tf30d.stdDevSpread;

        // Convert spread change (in log space) to ROI percentage
        // Spread is in log space: spread = ln(P1) - beta * ln(P2)
        // To convert to percentage: ROI = (exp(spreadChange) - 1) * 100
        const estimatedROIPercent = (Math.exp(spreadChange) - 1) * 100;

        // Annualized ROI (if we have time to reversion)
        let annualizedROI = null;
        if (timeToMeanReversion !== null && timeToMeanReversion > 0) {
          const daysToExit = timeToMeanReversion;
          const periodsPerYear = 365 / daysToExit;
          annualizedROI = estimatedROIPercent * periodsPerYear;
        }

        expectedROI = {
          entryZ: currentZ.toFixed(2),
          exitZ: targetZ.toFixed(2),
          zChange: zChange.toFixed(2),
          spreadChange: spreadChange.toFixed(4),
          stdDevSpread: tf30d.stdDevSpread.toFixed(4),
          estimatedROIPercent: estimatedROIPercent.toFixed(2) + '%',
          daysToExit: timeToMeanReversion !== null ? timeToMeanReversion.toFixed(1) : null,
          annualizedROI: annualizedROI !== null ? annualizedROI.toFixed(1) + '%' : null,
          note: 'Assumes constant beta and linear spread reversion. Actual ROI may vary due to path dependency.'
        };

        expectedROIInfo = expectedROI;
      }
    }

    pairResults.standardized = {
      beta30d: tf30d?.beta ?? null, // Changed to 30-day beta for stability
      correlation30d: tf30d?.correlation ?? null,
      zScore30d: tf30d?.zScore ?? null,
      isCointegrated90d: tf90d?.isCointegrated ?? false,
      halfLife30d: halfLife30d, // Half-life from 30 days of data using 30-day beta with AR(1) regression
      halfLifeVariations: halfLifeVariations, // All combinations for comparison
      timeToMeanReversion: timeToMeanReversion, // Expected days to reach 0.5 z-score (forward prediction)
      predictionVsHistorical: predictionVsHistorical, // Comparison of forward prediction vs historical average
      expectedROI: expectedROIInfo, // Estimated ROI from z-score mean reversion
      divergenceProfile: divergenceProfile, // Historical divergence analysis (revert to < 0.5)
      divergenceProfilePercent: divergenceProfilePercent, // Percentage-based reversion (revert to < 50% of threshold)
      optimalEntryThreshold: optimalEntryThreshold, // Optimal entry Z-score threshold
      currentZROI: currentZROI // ROI from current z-score position
      // zScoreChart: zScoreChart // COMMENTED OUT - Z-score visualization
    };

    // Calculate position sizing from 30-day beta (beta-adjusted sizing)
    // Using 30d for more stability, less frequent rebalancing needed
    if (tf30d?.beta !== null) {
      const beta = Math.abs(tf30d.beta);
      pairResults.positionSizing = {
        weight1: 1 / (1 + beta),
        weight2: beta / (1 + beta),
        hedgeRatio: tf30d.beta
      };
    }
  } catch (error) {
    console.log(`Standardized metrics calculation failed: ${error.message}`);
    pairResults.standardized = null;
    pairResults.positionSizing = null;
  }

  // Calculate advanced metrics (Hurst, Dual Beta, Regime, Conviction)
  try {
    if (fullPrices1?.length >= 30 && fullPrices2?.length >= 30) {
      const tf30d = pairResults.timeframes[30];

      // Hurst Exponent (on first asset prices)
      const hurst = calculateHurst(fullPrices1.slice(-90));

      // Dual Beta
      const halfLife = tf30d?.halfLife || pairResults.standardized?.halfLife30d || 7;
      const dualBeta = calculateDualBeta(fullPrices1, fullPrices2, halfLife);

      // Regime Detection
      const zScore = tf30d?.zScore || pairResults.standardized?.zScore30d || 0;
      const entryThreshold = pairResults.standardized?.optimalEntryThreshold || 1.5;
      const regime = detectRegime(zScore, entryThreshold, [], hurst.hurst);

      // Conviction Score
      const conviction = calculateConvictionScore({
        correlation: tf30d?.correlation || 0,
        r2: dualBeta.structural.r2,
        halfLife: halfLife,
        hurst: hurst.hurst,
        isCointegrated: tf30d?.isCointegrated || pairResults.standardized?.isCointegrated90d || false,
        adfStat: tf30d?.adfStat || -2.5,
        betaDrift: dualBeta.drift
      });

      pairResults.advancedMetrics = {
        hurst,
        dualBeta,
        regime,
        conviction
      };

      // Also store raw prices for potential use
      pairResults.rawPrices = {
        prices1: fullPrices1,
        prices2: fullPrices2
      };
    }
  } catch (error) {
    console.log(`Advanced metrics calculation failed: ${error.message}`);
    pairResults.advancedMetrics = null;
  }

  // Disconnect Hyperliquid if we connected (suppress WebSocket noise)
  if (sdk) {
    try {
      const originalLog = console.log;
      const originalError = console.error;
      const noop = () => { };
      console.log = noop;
      console.error = noop;

      await sdk.disconnect();

      console.log = originalLog;
      console.error = originalError;
    } catch (error) {
      // Restore console
      console.log = originalLog;
      console.error = originalError;
      // Ignore disconnect errors
    }
  }

  return pairResults;
}

/**
 * Analyze a specific timeframe
 */
async function analyzeTimeframe(symbol1, symbol2, days, fullOBV1, fullOBV2, obvTimeframes, sharedSdk = null) {
  let prices1, prices2, volumes1, volumes2, currentPrice1, currentPrice2;

  // Try Hyperliquid first (reuse connection if provided)
  try {
    let sdk = sharedSdk;
    let shouldDisconnect = false;

    if (!sdk) {
      // Suppress WebSocket noise
      const originalLog = console.log;
      const originalError = console.error;
      const noop = () => { };
      console.log = noop;
      console.error = noop;

      sdk = new Hyperliquid();
      await sdk.connect();
      shouldDisconnect = true;

      console.log = originalLog;
      console.error = originalError;
    }

    const endTime = Date.now();
    const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);

    const [hl1Data, hl2Data] = await Promise.all([
      sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1d', startTime, endTime),
      sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1d', startTime, endTime)
    ]);

    if (shouldDisconnect) {
      // Suppress WebSocket noise
      const originalLog = console.log;
      const originalError = console.error;
      const noop = () => { };
      console.log = noop;
      console.error = noop;

      await sdk.disconnect();

      console.log = originalLog;
      console.error = originalError;
    }

    if (hl1Data?.length > 0 && hl2Data?.length > 0) {
      const hl1Map = new Map();
      const hl2Map = new Map();

      hl1Data.forEach(c => {
        const date = new Date(c.t).toISOString().split('T')[0];
        hl1Map.set(date, { close: parseFloat(c.c), volume: parseFloat(c.v) });
      });

      hl2Data.forEach(c => {
        const date = new Date(c.t).toISOString().split('T')[0];
        hl2Map.set(date, { close: parseFloat(c.c), volume: parseFloat(c.v) });
      });

      const commonDates = [...hl1Map.keys()].filter(d => hl2Map.has(d)).sort();

      if (commonDates.length >= days) {
        const selectedDates = commonDates.slice(-days);
        prices1 = selectedDates.map(date => hl1Map.get(date).close);
        prices2 = selectedDates.map(date => hl2Map.get(date).close);
        volumes1 = selectedDates.map(date => hl1Map.get(date).volume || 0);
        volumes2 = selectedDates.map(date => hl2Map.get(date).volume || 0);
        currentPrice1 = prices1[prices1.length - 1];
        currentPrice2 = prices2[prices2.length - 1];
      } else {
        throw new Error(`Insufficient Hyperliquid data: ${commonDates.length} days`);
      }
    } else {
      throw new Error('No Hyperliquid data');
    }
  } catch (error) {
    // Hyperliquid is MANDATORY for prices - no fallback to CryptoCompare
    throw new Error(`Hyperliquid failed (MANDATORY for prices): ${error.message}`);
  }

  if (!prices1 || prices1.length < days || !prices2 || prices2.length < days) {
    throw new Error(`Insufficient data: ${prices1?.length || 0} days`);
  }

  // Calculate returns
  const returns = [];
  for (let i = 1; i < prices1.length; i++) {
    returns.push({
      asset1: (prices1[i] - prices1[i - 1]) / prices1[i - 1],
      asset2: (prices2[i] - prices2[i - 1]) / prices2[i - 1]
    });
  }

  // Correlation & Beta
  const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
  const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;

  let covariance = 0, variance1 = 0, variance2 = 0;
  for (const ret of returns) {
    const dev1 = ret.asset1 - mean1;
    const dev2 = ret.asset2 - mean2;
    covariance += dev1 * dev2;
    variance1 += dev1 * dev1;
    variance2 += dev2 * dev2;
  }
  covariance /= returns.length;
  variance1 /= returns.length;
  variance2 /= returns.length;

  const correlation = covariance / (Math.sqrt(variance1) * Math.sqrt(variance2));
  const beta = covariance / variance2;

  // Spread & Z-score
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
  const defaultConfig = require('../config');
  const zScoreWindow = defaultConfig.getZScoreWindow();
  const recentSpreads = spreads.slice(-Math.min(zScoreWindow, spreads.length));
  const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
  const stdDevSpread = Math.sqrt(recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length);
  const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
  const zScore = (currentSpread - meanSpread) / stdDevSpread;

  // Cointegration
  const spreadDiffs = [];
  for (let i = 1; i < spreads.length; i++) {
    spreadDiffs.push(spreads[i] - spreads[i - 1]);
  }
  const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
  let autocorr = 0, varDiff = 0;
  for (let i = 0; i < spreadDiffs.length; i++) {
    const dev = spreadDiffs[i] - meanDiff;
    varDiff += dev * dev;
    if (i > 0) autocorr += (spreadDiffs[i] - meanDiff) * (spreadDiffs[i - 1] - meanDiff);
  }
  varDiff /= spreadDiffs.length;
  autocorr /= (spreadDiffs.length - 1);
  const autocorrCoeff = varDiff > 0 ? autocorr / varDiff : 0;
  const adfStat = -autocorrCoeff * Math.sqrt(spreads.length);
  const meanReversionRate = spreadDiffs.filter((d, i) => {
    if (i === 0) return false;
    const prevDev = spreads[i - 1] - meanSpread;
    const currDev = spreads[i] - meanSpread;
    return (prevDev > 0 && currDev < prevDev) || (prevDev < 0 && currDev > prevDev);
  }).length / (spreads.length - 1);
  const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && Math.abs(autocorrCoeff) < 0.3);

  // Gamma (beta stability)
  let gamma = 0;
  if (days === 7 && returns.length >= 6) {
    const mid = Math.floor(returns.length / 2);
    const calcBeta = (retArray) => {
      const m1 = retArray.reduce((sum, r) => sum + r.asset1, 0) / retArray.length;
      const m2 = retArray.reduce((sum, r) => sum + r.asset2, 0) / retArray.length;
      let cov = 0, var2 = 0;
      for (const ret of retArray) {
        cov += (ret.asset1 - m1) * (ret.asset2 - m2);
        var2 += Math.pow(ret.asset2 - m2, 2);
      }
      return (cov / retArray.length) / (var2 / retArray.length);
    };
    const beta1 = calcBeta(returns.slice(0, mid));
    const beta2 = calcBeta(returns.slice(mid));
    gamma = (Math.abs(beta1 - beta) + Math.abs(beta2 - beta)) / 2;
  } else if (returns.length >= 15) {
    const shortWindow = Math.max(7, Math.floor(returns.length / 3));
    const shortReturns = returns.slice(-shortWindow);
    if (shortReturns.length >= 7) {
      const shortMean1 = shortReturns.reduce((sum, r) => sum + r.asset1, 0) / shortReturns.length;
      const shortMean2 = shortReturns.reduce((sum, r) => sum + r.asset2, 0) / shortReturns.length;
      let shortCov = 0, shortVar2 = 0;
      for (const ret of shortReturns) {
        shortCov += (ret.asset1 - shortMean1) * (ret.asset2 - shortMean2);
        shortVar2 += Math.pow(ret.asset2 - shortMean2, 2);
      }
      const shortBeta = (shortCov / shortReturns.length) / (shortVar2 / shortReturns.length);
      gamma = Math.abs(shortBeta - beta);
    }
  }

  // Half-life calculation (partner's exact formula)
  // Steps:
  // 1. spread = ln(P1) - beta * ln(P2) ✓ (already calculated above)
  // 2. delta = spread[t] - spread[t-1] ✓ (spreadDiffs)
  // 3. p = autocorr(delta) ✓ (autocorrCoeff)
  // 4. half_life = -0.693 / ln(1 + p) where -0.693 = -ln(2)
  let halfLife = null;
  if (spreadDiffs.length >= 10) {
    // p = autocorrelation coefficient of spread changes (delta)
    const p = autocorrCoeff;
    // Half-life formula: -ln(2) / ln(1 + p) = -0.693 / ln(1 + p)
    // Only valid if p < 0 and p > -1 (mean-reverting)
    if (p < 0 && p > -1) {
      const calculatedHalfLife = -Math.log(2) / Math.log(1 + p);
      // Sanity check: half-life should be positive and reasonable
      if (calculatedHalfLife > 0 && isFinite(calculatedHalfLife) && calculatedHalfLife < 1000) {
        halfLife = calculatedHalfLife;
      }
    }
  }

  // Theta (mean reversion speed) - use half-life if available
  let theta = 0;
  if (halfLife !== null && halfLife > 0) {
    // Theta = expected z-score change per day
    const currentZAbs = Math.abs(zScore);
    if (currentZAbs > 0.1) {
      theta = currentZAbs / halfLife;
    }
  } else if (days === 7 && spreads.length >= 5) {
    const spreadStart = spreads[0];
    const spreadEnd = spreads[spreads.length - 1];
    const devStart = spreadStart - meanSpread;
    const devEnd = spreadEnd - meanSpread;
    if (Math.abs(devStart) > Math.abs(devEnd) && Math.abs(devStart) > 0.001) {
      const zStart = (spreadStart - meanSpread) / stdDevSpread;
      const zEnd = (spreadEnd - meanSpread) / stdDevSpread;
      const zChange = Math.abs(zStart) - Math.abs(zEnd);
      theta = zChange / days;
    } else if (meanReversionRate > 0.4) {
      const currentZAbs = Math.abs(zScore);
      if (currentZAbs > 0.1) {
        theta = meanReversionRate * currentZAbs / days;
      }
    }
  } else if (meanReversionRate > 0.4) {
    const currentZAbs = Math.abs(zScore);
    if (currentZAbs > 0.1) {
      theta = meanReversionRate * currentZAbs / Math.min(days, 30);
    }
  }
  if (theta === 0 && isCointegrated && Math.abs(zScore) > 0.5) {
    theta = Math.abs(zScore) / (days * 2);
  }

  // OBV
  let obv1Change = null, obv2Change = null;
  if (fullOBV1 && fullOBV2 && fullOBV1.length >= days && fullOBV2.length >= days && obvTimeframes.includes(days)) {
    const obv1Slice = fullOBV1.slice(-days);
    const obv2Slice = fullOBV2.slice(-days);
    obv1Change = obv1Slice[obv1Slice.length - 1] - obv1Slice[0];
    obv2Change = obv2Slice[obv2Slice.length - 1] - obv2Slice[0];
  }

  return {
    correlation,
    beta,
    zScore,
    isCointegrated,
    meanReversionRate,
    halfLife,
    hedgeRatio: beta,
    gamma,
    theta,
    price1Start: prices1[0],
    price1End: prices1[prices1.length - 1],
    price2Start: prices2[0],
    price2End: prices2[prices2.length - 1],
    obv1Change,
    obv2Change,
    meanSpread,
    stdDevSpread
  };
}

/**
 * Analyze historical divergences to determine optimal entry thresholds
 * Tracks Z-score crossings and reversion rates at different thresholds
 */
async function analyzeHistoricalDivergences(symbol1, symbol2, sharedSdk = null, stdDevSpread = null, currentZScore = null) {
  let sdk = sharedSdk;
  let shouldDisconnect = false;

  try {
    if (!sdk) {
      const originalLog = console.log;
      const originalError = console.error;
      const noop = () => { };
      console.log = noop;
      console.error = noop;

      sdk = new Hyperliquid();
      await sdk.connect();
      shouldDisconnect = true;

      console.log = originalLog;
      console.error = originalError;
    }

    // Fetch 60 days of hourly data to capture full 30-day analysis period
    // We need 30 days for the rolling window + 30 days to analyze = 60 days total
    const endTime = Date.now();
    const startTime = endTime - ((60 + 5) * 24 * 60 * 60 * 1000); // 60 days + buffer

    const [hl1Data, hl2Data] = await Promise.all([
      sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1h', startTime, endTime),
      sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1h', startTime, endTime)
    ]);

    if (!hl1Data?.length || !hl2Data?.length) {
      throw new Error('Insufficient data for divergence analysis');
    }

    // Map hourly data
    const hourlyMap1 = new Map();
    const hourlyMap2 = new Map();

    hl1Data.forEach(c => {
      const timestamp = typeof c.t === 'number' ? c.t : new Date(c.t).getTime();
      hourlyMap1.set(timestamp, parseFloat(c.c));
    });

    hl2Data.forEach(c => {
      const timestamp = typeof c.t === 'number' ? c.t : new Date(c.t).getTime();
      hourlyMap2.set(timestamp, parseFloat(c.c));
    });

    const commonTimestamps = [...hourlyMap1.keys()]
      .filter(t => hourlyMap2.has(t))
      .sort((a, b) => a - b);

    if (commonTimestamps.length < 30 * 24) {
      throw new Error(`Insufficient data: ${commonTimestamps.length} hours (need ${30 * 24})`);
    }

    // Calculate rolling 30-day z-scores (every hour)
    // Start from beginning to capture all events, not just after 30-day window
    const zScores = [];
    const windowHours = 30 * 24; // 30 days

    // Start from windowHours to have enough data for rolling calculation
    // But we'll track all z-scores from that point forward
    for (let i = windowHours; i < commonTimestamps.length; i++) {
      const windowStart = commonTimestamps[i - windowHours];
      const windowEnd = commonTimestamps[i];
      const windowData = commonTimestamps.filter(t => t >= windowStart && t <= windowEnd);

      if (windowData.length < 24) continue; // Need at least 1 day

      const prices1_window = windowData.map(t => hourlyMap1.get(t));
      const prices2_window = windowData.map(t => hourlyMap2.get(t));
      const currentPrice1 = hourlyMap1.get(commonTimestamps[i]);
      const currentPrice2 = hourlyMap2.get(commonTimestamps[i]);

      // Calculate returns for beta
      const returns = [];
      for (let j = 1; j < prices1_window.length; j++) {
        returns.push({
          asset1: (prices1_window[j] - prices1_window[j - 1]) / prices1_window[j - 1],
          asset2: (prices2_window[j] - prices2_window[j - 1]) / prices2_window[j - 1]
        });
      }

      if (returns.length < 24) continue;

      // Calculate 30-day beta (use last 30 days of returns, matching historical export)
      const returns30d = returns.slice(-(30 * 24)); // Last 30 days of returns
      if (returns30d.length < 24) continue; // Need at least 1 day

      const mean1_30d = returns30d.reduce((sum, r) => sum + r.asset1, 0) / returns30d.length;
      const mean2_30d = returns30d.reduce((sum, r) => sum + r.asset2, 0) / returns30d.length;
      let covariance30d = 0, variance2_30d = 0;
      for (const ret of returns30d) {
        covariance30d += (ret.asset1 - mean1_30d) * (ret.asset2 - mean2_30d);
        variance2_30d += Math.pow(ret.asset2 - mean2_30d, 2);
      }
      covariance30d /= returns30d.length;
      variance2_30d /= returns30d.length;
      const beta30d = variance2_30d > 0 ? covariance30d / variance2_30d : null;

      if (beta30d === null) continue;

      // Calculate spreads and z-score using 30-day beta (matching historical export)
      const spreads = prices1_window.map((p1, j) => Math.log(p1) - beta30d * Math.log(prices2_window[j]));
      const recentSpreads = spreads.slice(-(30 * 24)); // Last 30 days
      const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
      const stdDevSpread = Math.sqrt(
        recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length
      );
      const currentSpread = Math.log(currentPrice1) - beta30d * Math.log(currentPrice2);
      const zScore = stdDevSpread > 0 ? (currentSpread - meanSpread) / stdDevSpread : null;

      if (zScore !== null) {
        zScores.push({
          timestamp: commonTimestamps[i],
          zScore: zScore
        });
      }
    }

    // Debug: Check max z-score to see if thresholds are being reached
    if (zScores.length > 0) {
      const maxZ = Math.max(...zScores.map(z => Math.abs(z.zScore)));
      const minZ = Math.min(...zScores.map(z => Math.abs(z.zScore)));
      // console.log(`[DIVERGENCE DEBUG] ${symbol1}/${symbol2} Z-score range: ${minZ.toFixed(2)} to ${maxZ.toFixed(2)}, total points: ${zScores.length}`);
    }

    // Analyze divergences at different thresholds
    const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
    const profile = {};
    const profilePercent = {}; // Percentage-based reversion (50% of threshold)
    const fixedReversionThreshold = 0.5; // Fixed reversion to |Z| < 0.5

    for (const threshold of thresholds) {
      // Fixed reversion (0.5 for all)
      let events = 0;
      let reverted = 0;
      const reversionTimes = [];
      const activeDivergences = [];

      // Percentage-based reversion (50% of threshold)
      let eventsPercent = 0;
      let revertedPercent = 0;
      const reversionTimesPercent = [];
      const activeDivergencesPercent = [];
      const percentReversionThreshold = threshold * 0.5; // 50% of threshold

      for (let i = 0; i < zScores.length; i++) {
        const absZ = Math.abs(zScores[i].zScore);
        const prevAbsZ = i > 0 ? Math.abs(zScores[i - 1].zScore) : 0;
        const currentTime = zScores[i].timestamp;

        // Enter divergence: crossing above THIS threshold (was below, now above)
        if (prevAbsZ < threshold && absZ >= threshold) {
          // Fixed reversion tracking
          events++;
          activeDivergences.push({
            startIndex: i,
            startTime: currentTime
          });

          // Percentage-based reversion tracking
          eventsPercent++;
          activeDivergencesPercent.push({
            startIndex: i,
            startTime: currentTime
          });
        }

        // Also check if we start already above threshold (first data point)
        if (i === 0 && absZ >= threshold) {
          events++;
          activeDivergences.push({
            startIndex: i,
            startTime: currentTime
          });
          eventsPercent++;
          activeDivergencesPercent.push({
            startIndex: i,
            startTime: currentTime
          });
        }

        // Exit divergence: Fixed reversion (to < 0.5)
        for (let j = activeDivergences.length - 1; j >= 0; j--) {
          const div = activeDivergences[j];
          if (absZ < fixedReversionThreshold) {
            reverted++;
            const timeToRevertHours = (currentTime - div.startTime) / (60 * 60 * 1000);
            reversionTimes.push(timeToRevertHours);
            activeDivergences.splice(j, 1);
          }
        }

        // Exit divergence: Percentage-based reversion (to < 50% of threshold)
        for (let j = activeDivergencesPercent.length - 1; j >= 0; j--) {
          const div = activeDivergencesPercent[j];
          if (absZ < percentReversionThreshold) {
            revertedPercent++;
            const timeToRevertHours = (currentTime - div.startTime) / (60 * 60 * 1000);
            reversionTimesPercent.push(timeToRevertHours);
            activeDivergencesPercent.splice(j, 1);
          }
        }
      }

      // Fixed reversion stats
      const completedEvents = events;
      const rate = completedEvents > 0 ? (reverted / completedEvents) * 100 : 0;
      let avgTimeToRevert = null;
      let medianTimeToRevert = null;
      if (reversionTimes.length > 0) {
        const sortedTimes = [...reversionTimes].sort((a, b) => a - b);
        const avgHours = reversionTimes.reduce((sum, t) => sum + t, 0) / reversionTimes.length;
        avgTimeToRevert = avgHours / 24;
        // Median is more robust to outliers
        const mid = Math.floor(sortedTimes.length / 2);
        medianTimeToRevert = sortedTimes.length % 2 === 0
          ? (sortedTimes[mid - 1] + sortedTimes[mid]) / 2 / 24
          : sortedTimes[mid] / 24;
      }

      // Percentage-based reversion stats
      const completedEventsPercent = eventsPercent;
      const ratePercent = completedEventsPercent > 0 ? (revertedPercent / completedEventsPercent) * 100 : 0;
      let avgTimeToRevertPercent = null;
      let medianTimeToRevertPercent = null;
      if (reversionTimesPercent.length > 0) {
        const sortedTimes = [...reversionTimesPercent].sort((a, b) => a - b);
        const avgHours = reversionTimesPercent.reduce((sum, t) => sum + t, 0) / reversionTimesPercent.length;
        avgTimeToRevertPercent = avgHours / 24;
        // Median is more robust to outliers
        const mid = Math.floor(sortedTimes.length / 2);
        medianTimeToRevertPercent = sortedTimes.length % 2 === 0
          ? (sortedTimes[mid - 1] + sortedTimes[mid]) / 2 / 24
          : sortedTimes[mid] / 24;
      }

      profile[threshold.toString()] = {
        events: completedEvents,
        reverted: reverted,
        rate: rate.toFixed(1) + '%',
        avgTimeToRevert: avgTimeToRevert !== null ? avgTimeToRevert.toFixed(1) : null,
        medianTimeToRevert: medianTimeToRevert !== null ? medianTimeToRevert.toFixed(1) : null
      };

      profilePercent[threshold.toString()] = {
        events: completedEventsPercent,
        reverted: revertedPercent,
        rate: ratePercent.toFixed(1) + '%',
        avgTimeToRevert: avgTimeToRevertPercent !== null ? avgTimeToRevertPercent.toFixed(1) : null,
        medianTimeToRevert: medianTimeToRevertPercent !== null ? medianTimeToRevertPercent.toFixed(1) : null,
        reversionThreshold: percentReversionThreshold.toFixed(2)
      };
    }

    // Find optimal entry threshold (highest with 100% reversion, min 1.5)
    let optimalEntry = 1.5; // Minimum
    for (let i = thresholds.length - 1; i >= 0; i--) {
      const threshold = thresholds[i];
      const stats = profile[threshold.toString()];
      if (stats.events >= 1 && parseFloat(stats.rate) === 100) {
        optimalEntry = threshold;
        break;
      }
    }

    // Calculate ROI and time to reversion for current z-score (if provided)
    // ROI based on current z-score to exit targets
    let currentZROI = null;
    if (currentZScore !== null && stdDevSpread !== null) {
      const currentZ = Math.abs(currentZScore);
      const fixedExitZ = 0.5;

      // Fixed reversion ROI
      if (currentZ > fixedExitZ) {
        const zChange = currentZ - fixedExitZ;
        const spreadChange = zChange * stdDevSpread;
        // Convert from log space to percentage: ROI = (exp(spreadChange) - 1) * 100
        const roiFixed = (Math.exp(spreadChange) - 1) * 100;

        // Percentage-based ROI (50% of current z)
        const percentExitZ = currentZ * 0.5;
        const zChangePercent = currentZ - percentExitZ;
        const spreadChangePercent = zChangePercent * stdDevSpread;
        // Convert from log space to percentage
        const roiPercent = (Math.exp(spreadChangePercent) - 1) * 100;

        // Calculate time to reversion for both exit levels (using half-life if available)
        // We'll need to pass half-life to this function or calculate it here
        // For now, we'll calculate it from the spread data if available
        // Time = half_life * ln(z_current / z_target) / ln(2)

        currentZROI = {
          currentZ: currentZ.toFixed(2),
          fixedExitZ: fixedExitZ.toFixed(2),
          percentExitZ: percentExitZ.toFixed(2),
          roiFixed: roiFixed.toFixed(2) + '%',
          roiPercent: roiPercent.toFixed(2) + '%',
          // Time calculations will be added in the calling function where we have half-life
          timeToFixed: null, // Will be set by caller
          timeToPercent: null, // Will be set by caller
          note: 'Assumes constant beta and spread reverts through proportional price movements. Actual ROI varies by reversion path due to beta-weighted position sizing.'
        };
      }
    }

    return {
      profile: profile, // Fixed reversion to < 0.5
      profilePercent: profilePercent, // Percentage-based reversion (50% of threshold)
      optimalEntry: optimalEntry,
      currentZROI: currentZROI // ROI based on current z-score
      // zScores: zScores // COMMENTED OUT - Include z-score data for charting
    };

  } catch (error) {
    throw error;
  } finally {
    if (shouldDisconnect && sdk) {
      try {
        const originalLog = console.log;
        const originalError = console.error;
        const noop = () => { };
        console.log = noop;
        console.error = noop;
        await sdk.disconnect();
        console.log = originalLog;
        console.error = originalError;
      } catch (e) {
        // Ignore
      }
    }
  }
}

/**
 * Calculate Hurst Exponent using R/S (Rescaled Range) analysis
 * 
 * H < 0.5 = mean-reverting (what we want for pair trading)
 * H ≈ 0.5 = random walk (avoid)
 * H > 0.5 = trending (avoid)
 * 
 * @param {number[]} prices - Price series
 * @param {number} maxLag - Maximum lag for R/S calculation (default: 20)
 * @returns {{ hurst: number, isValid: boolean, classification: string }}
 */
function calculateHurst(prices, maxLag = 20) {
  if (prices.length < maxLag * 2) {
    return { hurst: 0.5, isValid: false, classification: 'INSUFFICIENT_DATA' };
  }

  // Calculate log returns
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const lags = [];
  const rsValues = [];

  // Calculate R/S for different lag sizes
  for (let lag = 10; lag <= Math.min(maxLag, Math.floor(returns.length / 2)); lag++) {
    const numBlocks = Math.floor(returns.length / lag);
    if (numBlocks < 2) continue;

    let rsSum = 0;
    let validBlocks = 0;

    for (let block = 0; block < numBlocks; block++) {
      const start = block * lag;
      const end = start + lag;
      const blockReturns = returns.slice(start, end);

      // Mean of block
      const mean = blockReturns.reduce((a, b) => a + b, 0) / blockReturns.length;

      // Cumulative deviation from mean
      let cumDev = 0;
      let maxCumDev = -Infinity;
      let minCumDev = Infinity;

      for (const r of blockReturns) {
        cumDev += (r - mean);
        maxCumDev = Math.max(maxCumDev, cumDev);
        minCumDev = Math.min(minCumDev, cumDev);
      }

      // Range
      const range = maxCumDev - minCumDev;

      // Standard deviation
      const std = Math.sqrt(blockReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / blockReturns.length);

      if (std > 0) {
        rsSum += range / std;
        validBlocks++;
      }
    }

    if (validBlocks > 0) {
      lags.push(Math.log(lag));
      rsValues.push(Math.log(rsSum / validBlocks));
    }
  }

  if (lags.length < 3) {
    return { hurst: 0.5, isValid: false, classification: 'INSUFFICIENT_DATA' };
  }

  // Linear regression: log(R/S) = H * log(lag) + c
  const n = lags.length;
  const sumX = lags.reduce((a, b) => a + b, 0);
  const sumY = rsValues.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((sum, x, i) => sum + x * rsValues[i], 0);
  const sumX2 = lags.reduce((sum, x) => sum + x * x, 0);

  const hurst = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Clamp to reasonable range
  const clampedHurst = Math.max(0, Math.min(1, hurst));

  // Classification
  let classification;
  if (clampedHurst < 0.4) {
    classification = 'STRONG_MEAN_REVERSION';
  } else if (clampedHurst < 0.5) {
    classification = 'MEAN_REVERTING';
  } else if (clampedHurst < 0.55) {
    classification = 'RANDOM_WALK';
  } else if (clampedHurst < 0.65) {
    classification = 'WEAK_TREND';
  } else {
    classification = 'TRENDING';
  }

  return {
    hurst: parseFloat(clampedHurst.toFixed(3)),
    isValid: true,
    classification
  };
}

/**
 * Calculate Dual Beta - structural (long-term) and dynamic (short-term)
 * 
 * Structural beta: baseline relationship from longer history
 * Dynamic beta: adapts to current market conditions (window = ~2x half-life)
 * 
 * @param {number[]} prices1 - First asset prices (full history)
 * @param {number[]} prices2 - Second asset prices (full history)
 * @param {number} halfLife - Half-life in days (determines dynamic window)
 * @returns {{ structural: { beta, r2, stdErr }, dynamic: { beta, r2, stdErr }, drift: number, isValid: boolean }}
 */
function calculateDualBeta(prices1, prices2, halfLife = 7) {
  if (prices1.length !== prices2.length || prices1.length < 30) {
    return {
      structural: { beta: 0, r2: 0, stdErr: 0 },
      dynamic: { beta: 0, r2: 0, stdErr: 0 },
      drift: 0,
      isValid: false
    };
  }

  // Helper: OLS regression with diagnostics
  function olsRegression(p1, p2) {
    const n = p1.length;
    if (n < 5) return { beta: 0, r2: 0, stdErr: Infinity };

    // Log returns
    const returns1 = [];
    const returns2 = [];
    for (let i = 1; i < n; i++) {
      returns1.push((p1[i] - p1[i - 1]) / p1[i - 1]);
      returns2.push((p2[i] - p2[i - 1]) / p2[i - 1]);
    }

    const mean1 = returns1.reduce((a, b) => a + b, 0) / returns1.length;
    const mean2 = returns2.reduce((a, b) => a + b, 0) / returns2.length;

    let covariance = 0, variance2 = 0, variance1 = 0;
    for (let i = 0; i < returns1.length; i++) {
      const dev1 = returns1[i] - mean1;
      const dev2 = returns2[i] - mean2;
      covariance += dev1 * dev2;
      variance1 += dev1 * dev1;
      variance2 += dev2 * dev2;
    }

    const beta = variance2 > 0 ? covariance / variance2 : 0;

    // R² calculation
    const ssRes = returns1.reduce((sum, r1, i) => {
      const predicted = beta * returns2[i];
      return sum + Math.pow(r1 - predicted, 2);
    }, 0);
    const ssTot = variance1;
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    // Standard error of beta
    const residualVariance = ssRes / (returns1.length - 2);
    const stdErr = variance2 > 0 ? Math.sqrt(residualVariance / variance2) : Infinity;

    return {
      beta: parseFloat(beta.toFixed(4)),
      r2: parseFloat(r2.toFixed(4)),
      stdErr: parseFloat(stdErr.toFixed(4))
    };
  }

  // Structural beta: use all data (or last 90 days if longer)
  const structuralWindow = Math.min(prices1.length, 90);
  const structural = olsRegression(
    prices1.slice(-structuralWindow),
    prices2.slice(-structuralWindow)
  );

  // Dynamic beta: window = 2x half-life (min 7, max 30)
  const dynamicWindow = Math.max(7, Math.min(30, Math.round(halfLife * 2)));
  const dynamic = olsRegression(
    prices1.slice(-dynamicWindow),
    prices2.slice(-dynamicWindow)
  );

  // Calculate drift (% difference between structural and dynamic)
  const drift = structural.beta !== 0
    ? Math.abs(dynamic.beta - structural.beta) / Math.abs(structural.beta)
    : 0;

  return {
    structural,
    dynamic,
    drift: parseFloat(drift.toFixed(4)),
    isValid: structural.r2 > 0.3 && dynamic.stdErr < 1.0
  };
}

/**
 * Detect market regime for a pair
 * 
 * Classifies current state based on z-score magnitude, volatility, and trend
 * 
 * @param {number} zScore - Current z-score
 * @param {number} entryThreshold - Entry threshold (e.g., 1.5 or 2.0)
 * @param {number[]} recentZScores - Recent z-scores for volatility calc (last 10-20 values)
 * @param {number} hurst - Hurst exponent (optional)
 * @returns {{ regime: string, confidence: number, action: string, riskLevel: string }}
 */
function detectRegime(zScore, entryThreshold, recentZScores = [], hurst = 0.5) {
  const absZ = Math.abs(zScore);

  // Calculate z-score volatility (how much z has been moving)
  let zVolatility = 0;
  if (recentZScores.length >= 5) {
    const zMean = recentZScores.reduce((a, b) => a + b, 0) / recentZScores.length;
    zVolatility = Math.sqrt(
      recentZScores.reduce((sum, z) => sum + Math.pow(z - zMean, 2), 0) / recentZScores.length
    );
  }

  // Check if z is moving toward or away from mean
  let zTrend = 'stable';
  if (recentZScores.length >= 3) {
    const recent3 = recentZScores.slice(-3);
    const avgRecent = recent3.reduce((a, b) => a + b, 0) / 3;
    const older = recentZScores.slice(0, -3);
    if (older.length > 0) {
      const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
      if (Math.abs(avgRecent) < Math.abs(avgOlder) - 0.2) {
        zTrend = 'reverting';
      } else if (Math.abs(avgRecent) > Math.abs(avgOlder) + 0.2) {
        zTrend = 'diverging';
      }
    }
  }

  // Regime classification
  let regime, confidence, action, riskLevel;

  if (absZ >= entryThreshold * 2) {
    // Extreme divergence
    if (zVolatility > 1.0 || zTrend === 'diverging') {
      regime = 'PEAK_DIVERGENCE';
      confidence = 0.6;
      action = 'WAIT_OR_REDUCE';
      riskLevel = 'HIGH';
    } else {
      regime = 'EXTREME_REVERSION';
      confidence = 0.8;
      action = 'STRONG_ENTRY';
      riskLevel = 'MEDIUM';
    }
  } else if (absZ >= entryThreshold) {
    // At or beyond entry threshold
    if (hurst < 0.45 && zTrend !== 'diverging') {
      regime = 'STRONG_REVERSION';
      confidence = 0.85;
      action = 'ENTER';
      riskLevel = 'LOW';
    } else if (zVolatility > 0.8) {
      regime = 'VOLATILE_SIGNAL';
      confidence = 0.5;
      action = 'SMALL_POSITION';
      riskLevel = 'MEDIUM';
    } else {
      regime = 'STANDARD_SIGNAL';
      confidence = 0.7;
      action = 'ENTER';
      riskLevel = 'MEDIUM';
    }
  } else if (absZ >= entryThreshold * 0.7) {
    // Approaching threshold
    regime = 'APPROACHING';
    confidence = 0.5;
    action = 'MONITOR';
    riskLevel = 'LOW';
  } else {
    // Near mean
    regime = 'IDLE';
    confidence = 0.9;
    action = 'NO_ACTION';
    riskLevel = 'NONE';
  }

  return {
    regime,
    confidence: parseFloat(confidence.toFixed(2)),
    action,
    riskLevel,
    zVolatility: parseFloat(zVolatility.toFixed(3)),
    zTrend
  };
}

/**
 * Calculate enhanced conviction score
 * 
 * Combines multiple factors into a 0-100 score
 * 
 * @param {Object} params - Analysis parameters
 * @returns {{ score: number, breakdown: Object }}
 */
function calculateConvictionScore(params) {
  const {
    correlation = 0,
    r2 = 0,
    halfLife = 30,
    hurst = 0.5,
    isCointegrated = false,
    adfStat = 0,
    betaDrift = 0
  } = params;

  const breakdown = {};

  // Correlation factor (0-20 points)
  breakdown.correlation = Math.max(0, Math.min(20, (correlation - 0.7) * 66.67));

  // R² quality (0-15 points)
  breakdown.rSquared = Math.max(0, Math.min(15, r2 * 15));

  // Half-life factor (0-20 points) - prefer 1-10 days
  if (halfLife <= 0) {
    breakdown.halfLife = 0;
  } else if (halfLife <= 3) {
    breakdown.halfLife = 20;
  } else if (halfLife <= 7) {
    breakdown.halfLife = 18;
  } else if (halfLife <= 14) {
    breakdown.halfLife = 14;
  } else if (halfLife <= 30) {
    breakdown.halfLife = 8;
  } else {
    breakdown.halfLife = 0;
  }

  // Hurst factor (0-25 points) - strong preference for H < 0.5
  if (hurst < 0.35) {
    breakdown.hurst = 25;
  } else if (hurst < 0.45) {
    breakdown.hurst = 20;
  } else if (hurst < 0.5) {
    breakdown.hurst = 12;
  } else if (hurst < 0.55) {
    breakdown.hurst = 5;
  } else {
    breakdown.hurst = 0;
  }

  // Cointegration bonus (0-15 points)
  breakdown.cointegration = isCointegrated ? 15 : 0;
  // Extra points for strong ADF
  if (isCointegrated && adfStat < -3.5) {
    breakdown.cointegration = Math.min(20, breakdown.cointegration + Math.abs(adfStat + 3.5) * 2);
  }

  // Beta stability penalty (0 to -10 points)
  breakdown.betaStability = -Math.min(10, betaDrift * 20);

  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.min(100, total));

  return {
    score: parseFloat(score.toFixed(1)),
    breakdown
  };
}

module.exports = {
  analyzePair,
  analyzeTimeframe,
  analyzeHistoricalDivergences,
  calculateHurst,
  calculateDualBeta,
  detectRegime,
  calculateConvictionScore
};

