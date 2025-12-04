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

  // Half-life calculation: -ln(2) / ln(1 + autocorrCoeff)
  // autocorrCoeff should be negative for mean reversion
  let halfLife = Infinity;
  if (autocorrCoeff < 0 && autocorrCoeff > -1) {
    halfLife = -Math.log(2) / Math.log(1 + autocorrCoeff);
    if (halfLife < 0 || !isFinite(halfLife) || halfLife > 365) {
      halfLife = Infinity;
    }
  }

  const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && halfLife <= 45);

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

  // Theta (mean reversion speed)
  let theta = 0;
  if (days === 7 && spreads.length >= 5) {
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
  } else if (spreads.length >= 10) {
    const spreadLevels = spreads;
    const meanSpreadLevel = spreadLevels.reduce((sum, s) => sum + s, 0) / spreadLevels.length;
    let num = 0, den = 0;
    for (let i = 1; i < spreadLevels.length; i++) {
      num += (spreadLevels[i] - meanSpreadLevel) * (spreadLevels[i - 1] - meanSpreadLevel);
      den += Math.pow(spreadLevels[i - 1] - meanSpreadLevel, 2);
    }
    const autocorrLevel = den > 0 ? num / den : 0;
    if (autocorrLevel < 0 && Math.abs(autocorrLevel) < 1) {
      const halfLife = -Math.log(2) / Math.log(1 + autocorrLevel);
      if (halfLife > 0 && isFinite(halfLife) && halfLife < 1000) {
        const currentZAbs = Math.abs(zScore);
        if (currentZAbs > 0.1) {
          theta = currentZAbs / halfLife;
        } else {
          theta = meanReversionRate * 0.1;
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

/**
 * =============================================================================
 * REUSABLE STATISTICS FUNCTIONS
 * =============================================================================
 */

/**
 * Calculate correlation between two price series
 * @param {number[]} prices1 - First price series
 * @param {number[]} prices2 - Second price series
 * @returns {{ correlation: number, beta: number }} Correlation coefficient and beta
 */
function calculateCorrelation(prices1, prices2) {
  if (prices1.length !== prices2.length || prices1.length < 2) {
    throw new Error('Price arrays must be equal length and have at least 2 points');
  }

  // Calculate returns
  const returns = [];
  for (let i = 1; i < prices1.length; i++) {
    returns.push({
      asset1: (prices1[i] - prices1[i - 1]) / prices1[i - 1],
      asset2: (prices2[i] - prices2[i - 1]) / prices2[i - 1]
    });
  }

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
  const beta = variance2 > 0 ? covariance / variance2 : 0;

  return { correlation, beta };
}

/**
 * Test cointegration between two price series
 * @param {number[]} prices1 - First price series
 * @param {number[]} prices2 - Second price series
 * @param {number} beta - Hedge ratio (from calculateCorrelation)
 * @returns {{ isCointegrated: boolean, adfStat: number, halfLife: number, meanReversionRate: number, zScore: number }}
 */
function testCointegration(prices1, prices2, beta) {
  if (prices1.length !== prices2.length || prices1.length < 10) {
    throw new Error('Price arrays must be equal length and have at least 10 points');
  }

  // Calculate spread using log prices
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));

  // Spread statistics
  const meanSpread = spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
  const stdDevSpread = Math.sqrt(
    spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length
  );

  // Current z-score
  const currentSpread = spreads[spreads.length - 1];
  const zScore = stdDevSpread > 0 ? (currentSpread - meanSpread) / stdDevSpread : 0;

  // ADF regression: Δspread_t = α + β × spread_{t-1} + ε
  // We regress spread changes on lagged spread levels (demeaned)
  const laggedSpreads = spreads.slice(0, -1).map(s => s - meanSpread);
  const spreadChanges = [];
  for (let i = 1; i < spreads.length; i++) {
    spreadChanges.push(spreads[i] - spreads[i - 1]);
  }

  // OLS regression to get β coefficient
  // β = Σ(x_i * y_i) / Σ(x_i^2) where x = lagged spread, y = spread change
  let sumXY = 0, sumX2 = 0;
  for (let i = 0; i < laggedSpreads.length; i++) {
    sumXY += laggedSpreads[i] * spreadChanges[i];
    sumX2 += laggedSpreads[i] * laggedSpreads[i];
  }
  const adfBeta = sumX2 > 0 ? sumXY / sumX2 : 0;

  // Half-life calculation: half_life = -ln(2) / ln(1 + β)
  // β should be negative for mean reversion (spread reverts when it's above/below mean)
  let halfLife = Infinity;
  if (adfBeta < 0 && adfBeta > -1) {
    halfLife = -Math.log(2) / Math.log(1 + adfBeta);
  } else if (adfBeta <= -1) {
    // Extremely fast reversion (or noise)
    halfLife = 0.5;
  }
  // Cap at reasonable values
  if (halfLife < 0 || !isFinite(halfLife)) {
    halfLife = Infinity;
  } else if (halfLife > 365) {
    halfLife = Infinity; // Too slow to be useful
  }

  // ADF statistic (for cointegration test)
  const adfStat = adfBeta / Math.sqrt(sumX2 > 0 ? (1 / laggedSpreads.length) : 1) * Math.sqrt(laggedSpreads.length);

  // Mean reversion rate (empirical)
  const meanReversionRate = spreadChanges.filter((d, i) => {
    const prevDev = spreads[i] - meanSpread;
    const currDev = spreads[i + 1] - meanSpread;
    return (prevDev > 0 && currDev < prevDev) || (prevDev < 0 && currDev > prevDev);
  }).length / spreadChanges.length;

  // Cointegration decision: ADF stat significant OR good mean reversion + finite half-life
  const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && halfLife <= 45);

  return {
    isCointegrated,
    adfStat,
    halfLife,
    meanReversionRate,
    zScore
  };
}

/**
 * Quick pair fitness check - returns correlation, cointegration, z-score, half-life, gamma, theta
 * @param {number[]} prices1 - First price series (e.g., 30 days)
 * @param {number[]} prices2 - Second price series
 * @returns {{ correlation: number, beta: number, isCointegrated: boolean, zScore: number, halfLife: number, meanReversionRate: number, gamma: number, theta: number }}
 */
function checkPairFitness(prices1, prices2) {
  const { correlation, beta } = calculateCorrelation(prices1, prices2);
  const { isCointegrated, zScore, halfLife, meanReversionRate } = testCointegration(prices1, prices2, beta);

  // Calculate returns for gamma calculation
  const returns = [];
  for (let i = 1; i < prices1.length; i++) {
    returns.push({
      asset1: (prices1[i] - prices1[i - 1]) / prices1[i - 1],
      asset2: (prices2[i] - prices2[i - 1]) / prices2[i - 1]
    });
  }

  // Calculate spreads for theta
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;

  // Gamma (beta stability) - measure how much beta varies over time
  let gamma = 0;
  if (returns.length >= 15) {
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
      const shortBeta = shortVar2 > 0 ? (shortCov / shortReturns.length) / (shortVar2 / shortReturns.length) : beta;
      gamma = Math.abs(shortBeta - beta);
    }
  }

  // Theta (mean reversion speed) - how fast Z moves toward mean
  let theta = 0;
  if (spreads.length >= 10 && halfLife > 0 && isFinite(halfLife) && halfLife < 1000) {
    const currentZAbs = Math.abs(zScore);
    if (currentZAbs > 0.1) {
      theta = currentZAbs / halfLife;
    } else {
      theta = meanReversionRate * 0.1;
    }
  } else if (meanReversionRate > 0.4 && Math.abs(zScore) > 0.1) {
    theta = meanReversionRate * Math.abs(zScore) / Math.min(prices1.length, 30);
  }

  return {
    correlation,
    beta,
    isCointegrated,
    zScore,
    halfLife,
    meanReversionRate,
    gamma,
    theta
  };
}

/**
 * Analyze historical divergence events and calculate optimal entry threshold
 * 
 * For each threshold level, counts how many times |Z| crossed above it and
 * whether each divergence reverted back to mean (|Z| < exitThreshold).
 * 
 * @param {number[]} prices1 - First price series (e.g., 30 days)
 * @param {number[]} prices2 - Second price series
 * @param {number} beta - Hedge ratio (from calculateCorrelation)
 * @param {Object} options - Configuration options
 * @param {number[]} options.thresholds - Z-score thresholds to test (default: [1.0, 1.5, 2.0, 2.5, 3.0])
 * @param {number} options.exitThreshold - Z-score level considered "reverted" (default: 0.5)
 * @returns {Object} Divergence analysis with optimal entry recommendation
 */
function analyzeHistoricalDivergences(prices1, prices2, beta, options = {}) {
  const {
    thresholds = [1.0, 1.5, 2.0, 2.5, 3.0],
    exitThreshold = 0.5
  } = options;

  if (prices1.length !== prices2.length || prices1.length < 10) {
    throw new Error('Price arrays must be equal length and have at least 10 points');
  }

  // Calculate spread series using log prices
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));

  // Calculate rolling Z-scores for each day
  // Use expanding window for first points, then fixed window
  const zScoreWindow = 30;
  const zScores = [];

  for (let i = 0; i < spreads.length; i++) {
    // Use all data up to this point (min 5 days)
    const windowStart = Math.max(0, i - zScoreWindow + 1);
    const windowSpreads = spreads.slice(windowStart, i + 1);

    if (windowSpreads.length < 5) {
      zScores.push(0); // Not enough data yet
      continue;
    }

    const mean = windowSpreads.reduce((a, b) => a + b, 0) / windowSpreads.length;
    const std = Math.sqrt(windowSpreads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / windowSpreads.length);
    const z = std > 0 ? (spreads[i] - mean) / std : 0;
    zScores.push(z);
  }

  // Track max |Z| seen in the window
  const maxAbsZ = Math.max(...zScores.map(z => Math.abs(z)));

  // For each threshold, analyze divergence events
  const thresholdResults = {};

  for (const threshold of thresholds) {
    const events = [];
    let inDivergence = false;
    let divergenceStartIdx = null;
    let divergenceDirection = null; // 'positive' or 'negative'
    let peakZ = 0;

    for (let i = 0; i < zScores.length; i++) {
      const z = zScores[i];
      const absZ = Math.abs(z);

      if (!inDivergence && absZ >= threshold) {
        // Start of new divergence event
        inDivergence = true;
        divergenceStartIdx = i;
        divergenceDirection = z > 0 ? 'positive' : 'negative';
        peakZ = z;
      } else if (inDivergence) {
        // Update peak if we're seeing larger divergence
        if (Math.abs(z) > Math.abs(peakZ)) {
          peakZ = z;
        }

        // Check for reversion (|Z| dropped below exit threshold)
        if (absZ <= exitThreshold) {
          events.push({
            startIdx: divergenceStartIdx,
            endIdx: i,
            duration: i - divergenceStartIdx,
            direction: divergenceDirection,
            peakZ: peakZ,
            reverted: true
          });
          inDivergence = false;
          divergenceStartIdx = null;
          peakZ = 0;
        }
        // Check for direction flip (crossed through mean to other side)
        else if ((divergenceDirection === 'positive' && z < -exitThreshold) ||
          (divergenceDirection === 'negative' && z > exitThreshold)) {
          // Count as reverted (passed through mean)
          events.push({
            startIdx: divergenceStartIdx,
            endIdx: i,
            duration: i - divergenceStartIdx,
            direction: divergenceDirection,
            peakZ: peakZ,
            reverted: true
          });
          // Start tracking new divergence in opposite direction
          inDivergence = true;
          divergenceStartIdx = i;
          divergenceDirection = z > 0 ? 'positive' : 'negative';
          peakZ = z;
        }
      }
    }

    // Handle ongoing divergence at end of window
    if (inDivergence) {
      events.push({
        startIdx: divergenceStartIdx,
        endIdx: zScores.length - 1,
        duration: zScores.length - 1 - divergenceStartIdx,
        direction: divergenceDirection,
        peakZ: peakZ,
        reverted: false,
        ongoing: true
      });
    }

    // Calculate statistics for this threshold
    const totalEvents = events.length;
    const revertedEvents = events.filter(e => e.reverted).length;
    const ongoingEvents = events.filter(e => e.ongoing).length;
    const completedEvents = totalEvents - ongoingEvents;

    // Reversion rate only counts completed events (not ongoing)
    const reversionRate = completedEvents > 0 ? revertedEvents / completedEvents : null;

    const avgDuration = events.length > 0
      ? events.reduce((sum, e) => sum + e.duration, 0) / events.length
      : null;

    const avgPeakZ = events.length > 0
      ? events.reduce((sum, e) => sum + Math.abs(e.peakZ), 0) / events.length
      : null;

    thresholdResults[threshold] = {
      threshold,
      totalEvents,
      revertedEvents,
      ongoingEvents,
      completedEvents,
      reversionRate,
      avgDuration,
      avgPeakZ
    };
  }

  // Determine optimal entry threshold
  // Criteria: highest threshold with 100% reversion rate and at least 1 completed event
  // If none have 100%, pick highest with best rate
  let optimalEntry = null;
  let optimalScore = -1;

  for (const threshold of [...thresholds].reverse()) { // Start from highest
    const result = thresholdResults[threshold];

    if (result.completedEvents === 0) continue;

    // Score = reversion rate × (prefer higher thresholds)
    // Bonus for having more events (more statistically significant)
    const eventBonus = Math.min(result.completedEvents / 3, 1); // Max bonus at 3+ events
    const score = (result.reversionRate || 0) * (1 + threshold / 10) * (0.5 + 0.5 * eventBonus);

    if (result.reversionRate === 1.0 && result.completedEvents >= 1) {
      // 100% reversion rate - use this threshold
      optimalEntry = threshold;
      break;
    }

    if (score > optimalScore) {
      optimalScore = score;
      optimalEntry = threshold;
    }
  }

  // Fallback to 2.0 if no data
  if (optimalEntry === null) {
    optimalEntry = 2.0;
  }

  // Enforce minimum entry threshold of 1.5
  // Prevents entering too early on pairs that could diverge further
  const MIN_ENTRY_THRESHOLD = 1.5;
  optimalEntry = Math.max(optimalEntry, MIN_ENTRY_THRESHOLD);

  return {
    thresholds: thresholdResults,
    optimalEntry,
    maxHistoricalZ: maxAbsZ,
    currentZ: zScores[zScores.length - 1],
    dataPoints: zScores.length,
    exitThreshold
  };
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
  calculateCorrelation,
  testCointegration,
  checkPairFitness,
  analyzeHistoricalDivergences,
  calculateHurst,
  calculateDualBeta,
  detectRegime,
  calculateConvictionScore
};

