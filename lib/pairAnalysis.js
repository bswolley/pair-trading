/**
 * Core Pair Trading Analysis Module
 * 
 * Reusable functions for analyzing trading pairs
 * Calculates: correlation, beta, z-score, gamma, theta, OBV, cointegration
 */

const axios = require('axios');
const { obv } = require('indicatorts');
const { Hyperliquid } = require('hyperliquid');

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
    const noop = () => {};
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
  // - Beta/Hedge Ratio: 7 days
  // - Correlation & Z-Score: 30 days
  // - Cointegration: 90 days
  // - Half-life: 30 days of data with 7-day beta
  try {
    const tf7d = pairResults.timeframes[7];
    const tf30d = pairResults.timeframes[30];
    const tf90d = pairResults.timeframes[90];
    
    // Reuse values from timeframe analysis
    let halfLife30d = null;
    
    // Recalculate half-life using 7-day beta with 30 days of data (partner's spec)
    if (tf7d?.beta !== null && tf30d) {
      // We need to recalculate half-life with 7-day beta
      // Fetch 30 days of data to recalculate
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
            
            // Calculate spreads using 7-day beta
            const beta7d = tf7d.beta;
            const spreads30d = prices30d_1.map((p1, i) => Math.log(p1) - beta7d * Math.log(prices30d_2[i]));
            
            // Calculate delta (spread changes)
            const spreadDiffs30d = [];
            for (let i = 1; i < spreads30d.length; i++) {
              spreadDiffs30d.push(spreads30d[i] - spreads30d[i-1]);
            }
            
            // Calculate autocorrelation of delta
            if (spreadDiffs30d.length >= 10) {
              const meanDiff = spreadDiffs30d.reduce((sum, d) => sum + d, 0) / spreadDiffs30d.length;
              let autocorr = 0, varDiff = 0;
              for (let i = 0; i < spreadDiffs30d.length; i++) {
                const dev = spreadDiffs30d[i] - meanDiff;
                varDiff += dev * dev;
                if (i > 0) autocorr += (spreadDiffs30d[i] - meanDiff) * (spreadDiffs30d[i-1] - meanDiff);
              }
              varDiff /= spreadDiffs30d.length;
              autocorr /= (spreadDiffs30d.length - 1);
              const p = varDiff > 0 ? autocorr / varDiff : 0;
              
              // Half-life formula: -ln(2) / ln(1 + p) where p = autocorr(delta)
              // Partner's exact formula: half_life = -0.693 / ln(1 + p)
              if (p < 0 && p > -1) {
                const calculatedHalfLife = -Math.log(2) / Math.log(1 + p);
                // Sanity check: half-life should be positive, finite, and reasonable (< 1000 days)
                if (calculatedHalfLife > 0 && isFinite(calculatedHalfLife) && calculatedHalfLife < 1000) {
                  halfLife30d = calculatedHalfLife;
                }
              }
            }
          }
        }
      } catch (error) {
        // Fallback to 30-day timeframe's half-life if recalculation fails
        halfLife30d = tf30d?.halfLife ?? null;
      }
    } else {
      // Fallback to 30-day timeframe's half-life
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
    
    pairResults.standardized = {
      beta7d: tf7d?.beta ?? null,
      correlation30d: tf30d?.correlation ?? null,
      zScore30d: tf30d?.zScore ?? null,
      isCointegrated90d: tf90d?.isCointegrated ?? false,
      halfLife30d: halfLife30d, // Half-life from 30 days of data using 7-day beta
      timeToMeanReversion: timeToMeanReversion // Expected days to reach 0.5 z-score
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
  
  // Disconnect Hyperliquid if we connected (suppress WebSocket noise)
  if (sdk) {
    try {
      const originalLog = console.log;
      const originalError = console.error;
      const noop = () => {};
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
      const noop = () => {};
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
      const noop = () => {};
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
      asset1: (prices1[i] - prices1[i-1]) / prices1[i-1],
      asset2: (prices2[i] - prices2[i-1]) / prices2[i-1]
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
    spreadDiffs.push(spreads[i] - spreads[i-1]);
  }
  const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
  let autocorr = 0, varDiff = 0;
  for (let i = 0; i < spreadDiffs.length; i++) {
    const dev = spreadDiffs[i] - meanDiff;
    varDiff += dev * dev;
    if (i > 0) autocorr += (spreadDiffs[i] - meanDiff) * (spreadDiffs[i-1] - meanDiff);
  }
  varDiff /= spreadDiffs.length;
  autocorr /= (spreadDiffs.length - 1);
  const autocorrCoeff = varDiff > 0 ? autocorr / varDiff : 0;
  const adfStat = -autocorrCoeff * Math.sqrt(spreads.length);
  const meanReversionRate = spreadDiffs.filter((d, i) => {
    if (i === 0) return false;
    const prevDev = spreads[i-1] - meanSpread;
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
    obv2Change
  };
}

module.exports = { analyzePair };

