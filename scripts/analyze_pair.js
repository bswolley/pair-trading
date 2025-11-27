#!/usr/bin/env node

/**
 * CLI tool to analyze a trading pair
 * Usage: node analyze_pair.js BASE UNDERLYING [direction]
 * Example: node analyze_pair.js HYPE ZEC long
 *          node analyze_pair.js TAO BTC short
 */

const axios = require('axios');
const fs = require('fs');
const { obv } = require('indicatorts');
const { Hyperliquid } = require('hyperliquid');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node analyze_pair.js BASE UNDERLYING [direction]');
  console.error('Example: node analyze_pair.js HYPE ZEC long');
  console.error('        node analyze_pair.js TAO BTC short');
  process.exit(1);
}

const baseSymbol = args[0].toUpperCase();
const underlyingSymbol = args[1].toUpperCase();
const direction = (args[2] || 'long').toLowerCase();

if (!['long', 'short'].includes(direction)) {
  console.error('Direction must be "long" or "short"');
  process.exit(1);
}

async function analyzePair() {
  console.log(`\n=== ANALYZING ${baseSymbol}/${underlyingSymbol} ===\n`);
  console.log(`Direction: ${direction === 'long' ? `LONG ${baseSymbol} / SHORT ${underlyingSymbol}` : `SHORT ${baseSymbol} / LONG ${underlyingSymbol}`}\n`);
  
  const pair = {
    name: `${baseSymbol}/${underlyingSymbol}`,
    asset1: `${baseSymbol}USDT`,
    asset2: `${underlyingSymbol}USDT`,
    symbol1: baseSymbol,
    symbol2: underlyingSymbol,
    useHyperliquidAPI: true,
    leftSide: baseSymbol,
    direction: direction
  };
  
  const timeframes = [7, 30, 90, 180];
  const obvTimeframes = [7, 30];
  
  const pairResults = {
    pair: pair.name,
    symbol1: pair.symbol1,
    symbol2: pair.symbol2,
    leftSide: pair.leftSide,
    direction: pair.direction,
    timeframes: {}
  };
  
  try {
    // Fetch current market cap data
    console.log('Fetching current market cap data...');
    let currentMcap1 = null, currentMcap2 = null;
    try {
      const [mcap1, mcap2] = await Promise.all([
        axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${pair.symbol1}&tsyms=USD`),
        axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${pair.symbol2}&tsyms=USD`)
      ]);
      if (mcap1.data.RAW && mcap1.data.RAW[pair.symbol1] && mcap1.data.RAW[pair.symbol1].USD) {
        currentMcap1 = mcap1.data.RAW[pair.symbol1].USD.MKTCAP;
      }
      if (mcap2.data.RAW && mcap2.data.RAW[pair.symbol2] && mcap2.data.RAW[pair.symbol2].USD) {
        currentMcap2 = mcap2.data.RAW[pair.symbol2].USD.MKTCAP;
      }
    } catch (mcapError) {
      console.log(`Market cap fetch failed: ${mcapError.message}`);
    }
    
    // Fetch full 180 days of data for cumulative OBV
    console.log('Fetching full historical data for OBV calculation...');
    let fullPrices1, fullPrices2, fullVolumes1, fullVolumes2, fullOBV1, fullOBV2;
    
    try {
      const limit = 2000;
      const toTs = Math.floor(Date.now() / 1000);
      
      const [cc1, cc2] = await Promise.all([
        axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
          params: { fsym: pair.symbol1, tsym: 'USD', limit: limit, toTs: toTs }
        }),
        axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
          params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
        })
      ]);
      
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
      fullVolumes1 = selectedDates.map(date => data1Map.get(date).volumeto || data1Map.get(date).volumefrom || 0);
      fullVolumes2 = selectedDates.map(date => data2Map.get(date).volumeto || data2Map.get(date).volumefrom || 0);
      
      if (fullPrices1 && fullPrices1.length >= 180 && fullVolumes1 && fullVolumes1.length >= 180) {
        fullOBV1 = obv(fullPrices1, fullVolumes1);
        fullOBV2 = obv(fullPrices2, fullVolumes2);
        
        pairResults.currentPrice1 = fullPrices1[fullPrices1.length - 1];
        pairResults.currentPrice2 = fullPrices2[fullPrices2.length - 1];
      }
      
      pairResults.currentMcap1 = currentMcap1;
      pairResults.currentMcap2 = currentMcap2;
    } catch (error) {
      console.log(`Error fetching full data: ${error.message}`);
    }
    
    // Analyze main timeframes
    for (const days of timeframes) {
      console.log(`Analyzing ${days}-day period...`);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      try {
        let prices1, prices2, currentPrice1, currentPrice2, volumes1, volumes2;
        
        // Use Hyperliquid for price data
        try {
          const sdk = new Hyperliquid();
          await sdk.connect();
          
          const endTime = Date.now();
          const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
          
          const [hl1Data, hl2Data] = await Promise.all([
            sdk.info.getCandleSnapshot(`${pair.symbol1}-PERP`, '1d', startTime, endTime),
            sdk.info.getCandleSnapshot(`${pair.symbol2}-PERP`, '1d', startTime, endTime)
          ]);
          
          sdk.disconnect();
          
          if (hl1Data && hl1Data.length > 0 && hl2Data && hl2Data.length > 0) {
            const hl1Parsed = hl1Data.map(c => ({
              time: c.t,
              open: parseFloat(c.o),
              high: parseFloat(c.h),
              low: parseFloat(c.l),
              close: parseFloat(c.c),
              volume: parseFloat(c.v)
            }));
            
            const hl2Parsed = hl2Data.map(c => ({
              time: c.t,
              open: parseFloat(c.o),
              high: parseFloat(c.h),
              low: parseFloat(c.l),
              close: parseFloat(c.c),
              volume: parseFloat(c.v)
            }));
            
            const hl1Map = new Map();
            const hl2Map = new Map();
            
            hl1Parsed.forEach(d => {
              const date = new Date(d.time).toISOString().split('T')[0];
              hl1Map.set(date, d);
            });
            
            hl2Parsed.forEach(d => {
              const date = new Date(d.time).toISOString().split('T')[0];
              hl2Map.set(date, d);
            });
            
            const commonDates = [...hl1Map.keys()].filter(d => hl2Map.has(d)).sort();
            
            if (commonDates.length >= days) {
              const selectedDates = commonDates.slice(-days);
              prices1 = selectedDates.map(date => hl1Map.get(date).close);
              prices2 = selectedDates.map(date => hl2Map.get(date).close);
              volumes1 = selectedDates.map(date => hl1Map.get(date).volume || 0);
              volumes2 = selectedDates.map(date => hl2Map.get(date).volume || 0);
              
              currentPrice1 = hl1Map.get(selectedDates[selectedDates.length - 1]).close;
              currentPrice2 = hl2Map.get(selectedDates[selectedDates.length - 1]).close;
            } else {
              throw new Error(`Insufficient overlapping Hyperliquid data: ${commonDates.length} days (need ${days})`);
            }
          } else {
            throw new Error('No data from Hyperliquid');
          }
        } catch (hyperliquidError) {
          console.log(`  Hyperliquid failed: ${hyperliquidError.message}, trying CryptoCompare...`);
          const limit = Math.min(days + 5, 2000);
          const toTs = Math.floor(Date.now() / 1000);
          
          const [cc1, cc2] = await Promise.all([
            axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
              params: { fsym: pair.symbol1, tsym: 'USD', limit: limit, toTs: toTs }
            }),
            axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
              params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
            })
          ]);
          
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
          
          if (commonDates.length < days) {
            throw new Error(`Insufficient overlapping data: ${commonDates.length} days (need ${days})`);
          }
          
          const selectedDates = commonDates.slice(-days);
          
          prices1 = selectedDates.map(date => data1Map.get(date).close);
          prices2 = selectedDates.map(date => data2Map.get(date).close);
          volumes1 = selectedDates.map(date => data1Map.get(date).volumeto || data1Map.get(date).volumefrom || 0);
          volumes2 = selectedDates.map(date => data2Map.get(date).volumeto || data2Map.get(date).volumefrom || 0);
          
          currentPrice1 = data1Map.get(selectedDates[selectedDates.length - 1]).close;
          currentPrice2 = data2Map.get(selectedDates[selectedDates.length - 1]).close;
        }
        
        if (!prices1 || prices1.length < days || !prices2 || prices2.length < days) {
          throw new Error(`Insufficient data: prices1=${prices1?.length || 0}, prices2=${prices2?.length || 0}`);
        }
        
        // Calculate returns
        const returns = [];
        for (let i = 1; i < prices1.length; i++) {
          const ret1 = (prices1[i] - prices1[i-1]) / prices1[i-1];
          const ret2 = (prices2[i] - prices2[i-1]) / prices2[i-1];
          returns.push({ asset1: ret1, asset2: ret2 });
        }
        
        // Calculate correlation and beta
        const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
        const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;
        
        let covariance = 0;
        let variance1 = 0;
        let variance2 = 0;
        
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
        
        // Calculate spread
        const spreads = [];
        for (let i = 0; i < prices1.length; i++) {
          const spread = Math.log(prices1[i]) - beta * Math.log(prices2[i]);
          spreads.push(spread);
        }
        
        // Rolling Z-score (30-day window)
        const zScoreWindow = 30;
        const recentSpreads = spreads.slice(-Math.min(zScoreWindow, spreads.length));
        
        const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
        const varianceSpread = recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length;
        const stdDevSpread = Math.sqrt(varianceSpread);
        
        const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
        const zScore = (currentSpread - meanSpread) / stdDevSpread;
        
        // Cointegration test (simplified ADF)
        const spreadDiffs = [];
        for (let i = 1; i < spreads.length; i++) {
          spreadDiffs.push(spreads[i] - spreads[i-1]);
        }
        
        const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
        const varianceDiff = spreadDiffs.reduce((sum, d) => sum + Math.pow(d - meanDiff, 2), 0) / spreadDiffs.length;
        const adfStat = meanDiff / Math.sqrt(varianceDiff / spreadDiffs.length);
        
        const isCointegrated = Math.abs(adfStat) > 0.5;
        
        // Mean reversion rate
        const meanReversionRate = Math.abs(adfStat) > 0.5 ? (1 - Math.abs(adfStat)) * 100 : 0;
        
        // Gamma (beta stability)
        let gamma = 0;
        if (returns.length >= 6) {
          const midPoint = Math.floor(returns.length / 2);
          const firstHalf = returns.slice(0, midPoint);
          const secondHalf = returns.slice(midPoint);
          
          const calcBeta = (retArray) => {
            const m1 = retArray.reduce((sum, r) => sum + r.asset1, 0) / retArray.length;
            const m2 = retArray.reduce((sum, r) => sum + r.asset2, 0) / retArray.length;
            let cov = 0, var2 = 0;
            for (const ret of retArray) {
              const dev1 = ret.asset1 - m1;
              const dev2 = ret.asset2 - m2;
              cov += dev1 * dev2;
              var2 += dev2 * dev2;
            }
            return (cov / retArray.length) / (var2 / retArray.length);
          };
          
          const beta1 = calcBeta(firstHalf);
          const beta2 = calcBeta(secondHalf);
          gamma = Math.abs(beta2 - beta1);
        }
        
        // Theta (mean reversion speed)
        let theta = 0;
        if (spreads.length >= 10) {
          const recentSpreadsForTheta = spreads.slice(-Math.min(30, spreads.length));
          const meanS = recentSpreadsForTheta.reduce((sum, s) => sum + s, 0) / recentSpreadsForTheta.length;
          
          let movingTowardMean = 0;
          for (let i = 1; i < recentSpreadsForTheta.length; i++) {
            const prevDist = Math.abs(recentSpreadsForTheta[i-1] - meanS);
            const currDist = Math.abs(recentSpreadsForTheta[i] - meanS);
            if (currDist < prevDist) movingTowardMean++;
          }
          
          const reversionRatio = movingTowardMean / (recentSpreadsForTheta.length - 1);
          
          if (reversionRatio > 0.5) {
            const autocorr = (arr) => {
              if (arr.length < 2) return 0;
              const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length;
              let num = 0, den1 = 0, den2 = 0;
              for (let i = 1; i < arr.length; i++) {
                num += (arr[i-1] - mean) * (arr[i] - mean);
                den1 += Math.pow(arr[i-1] - mean, 2);
                den2 += Math.pow(arr[i] - mean, 2);
              }
              return num / Math.sqrt(den1 * den2);
            };
            
            const spreadReturns = [];
            for (let i = 1; i < recentSpreadsForTheta.length; i++) {
              spreadReturns.push(recentSpreadsForTheta[i] - recentSpreadsForTheta[i-1]);
            }
            
            const ac = autocorr(spreadReturns);
            if (ac < 0) {
              theta = Math.abs(ac) * reversionRatio;
            }
          }
        }
        
        const hedgeRatio = beta;
        
        const price1Start = prices1[0];
        const price1End = prices1[prices1.length - 1];
        const price2Start = prices2[0];
        const price2End = prices2[prices2.length - 1];
        
        const leftSideUndervalued = pair.direction === 'long' ? zScore < -1 : false;
        const leftSideOvervalued = pair.direction === 'short' ? zScore > 1 : false;
        const tradeReady = pair.direction === 'short' ? leftSideOvervalued : leftSideUndervalued;
        
        pairResults.timeframes[days] = {
          days: days,
          correlation: correlation,
          beta: beta,
          zScore: zScore,
          isCointegrated: isCointegrated,
          meanReversionRate: meanReversionRate,
          hedgeRatio: hedgeRatio,
          gamma: gamma,
          theta: theta,
          price1Start: price1Start,
          price1End: price1End,
          price2Start: price2Start,
          price2End: price2End,
          leftSideUndervalued: leftSideUndervalued,
          leftSideOvervalued: leftSideOvervalued,
          tradeReady: tradeReady
        };
        
        // Calculate OBV for this timeframe
        if (fullOBV1 && fullOBV2 && fullOBV1.length >= days && fullOBV2.length >= days) {
          try {
            const obv1Slice = fullOBV1.slice(-days);
            const obv2Slice = fullOBV2.slice(-days);
            
            const obv1Start = obv1Slice[0];
            const obv1End = obv1Slice[obv1Slice.length - 1];
            const obv2Start = obv2Slice[0];
            const obv2End = obv2Slice[obv2Slice.length - 1];
            
            const obv1Change = obv1End - obv1Start;
            const obv2Change = obv2End - obv2Start;
            
            if (obvTimeframes.includes(days)) {
              pairResults.timeframes[days].obv1Change = obv1Change;
              pairResults.timeframes[days].obv2Change = obv2Change;
            }
          } catch (obvError) {
            console.log(`  OBV error: ${obvError.message}`);
          }
        }
        
      } catch (error) {
        console.log(`  Error: ${error.message}`);
        pairResults.timeframes[days] = { days: days, error: error.message };
      }
    }
    
    // Generate report
    generateReport(pairResults);
    
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

function generateReport(pair) {
  const obvTimeframes = [7, 30];
  const directionText = pair.direction === 'long' 
    ? `LONG ${pair.leftSide} / SHORT ${pair.symbol2}` 
    : `SHORT ${pair.leftSide} / LONG ${pair.symbol2}`;
  
  const report = `# PAIR TRADING ANALYSIS
**Generated:** ${new Date().toISOString()}

## ${pair.pair} - ${directionText}

**Current:** ${pair.symbol1} $${pair.currentPrice1?.toFixed(2) || 'N/A'} ($${(pair.currentMcap1 / 1e9).toFixed(2)}B) | ${pair.symbol2} $${pair.currentPrice2?.toFixed(2) || 'N/A'} ($${(pair.currentMcap2 / 1e9).toFixed(2)}B)

**Stats (7d, 30d, 90d, 180d):**

| TF | Corr | Beta | Z | Coint | Hedge | Gamma | Theta |
|----|------|------|---|-------|-------|-------|-------|
${Object.values(pair.timeframes).filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days)).sort((a, b) => a.days - b.days).map(tf => {
  const corr = tf.correlation !== null && tf.correlation !== undefined ? tf.correlation.toFixed(3) : 'N/A';
  const beta = tf.beta !== null && tf.beta !== undefined ? tf.beta.toFixed(3) : 'N/A';
  const zScore = tf.zScore !== null && tf.zScore !== undefined ? tf.zScore.toFixed(2) : 'N/A';
  const hedgeRatio = tf.hedgeRatio !== null && tf.hedgeRatio !== undefined ? tf.hedgeRatio.toFixed(3) : 'N/A';
  const gamma = tf.gamma !== null && tf.gamma !== undefined ? tf.gamma.toFixed(3) : 'N/A';
  const theta = tf.theta !== null && tf.theta !== undefined ? tf.theta.toFixed(3) : 'N/A';
  return `| ${tf.days}d | ${corr} | ${beta} | ${zScore} | ${tf.isCointegrated ? 'Yes' : 'No'} | ${hedgeRatio} | ${gamma} | ${theta} |`;
}).join('\n')}

**Prices (7d, 30d, 90d, 180d):**

| TF | ${pair.symbol1} Price | ${pair.symbol2} Price |
|----|---------------------|---------------------|
${Object.values(pair.timeframes).filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days)).sort((a, b) => a.days - b.days).map(tf => {
  const price1Start = tf.price1Start ? tf.price1Start.toFixed(2) : 'N/A';
  const price1End = tf.price1End ? tf.price1End.toFixed(2) : 'N/A';
  const price2Start = tf.price2Start ? tf.price2Start.toFixed(2) : 'N/A';
  const price2End = tf.price2End ? tf.price2End.toFixed(2) : 'N/A';
  return `| ${tf.days}d | $${price1Start}→$${price1End} | $${price2Start}→$${price2End} |`;
}).join('\n')}
`;

  const obvRows = Object.values(pair.timeframes).filter(tf => !tf.error && tf.obv1Change !== null && obvTimeframes.includes(tf.days)).sort((a, b) => a.days - b.days);
  const obvDetails = obvRows.length > 0 ? `**OBV (7d, 30d):**

| TF | ${pair.symbol1} OBV | ${pair.symbol2} OBV |
|----|---------------------|---------------------|
${obvRows.map(tf => {
    const obv1 = tf.obv1Change !== null && tf.obv1Change !== undefined ? (tf.obv1Change > 0 ? '+' : '') + tf.obv1Change.toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';
    const obv2 = tf.obv2Change !== null && tf.obv2Change !== undefined ? (tf.obv2Change > 0 ? '+' : '') + tf.obv2Change.toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';
    return `| ${tf.days}d | ${obv1} | ${obv2} |`;
  }).join('\n')}` : '';

  const fullReport = report + (obvDetails ? `\n\n${obvDetails}` : '');
  
  const filename = `pair_${baseSymbol}_${underlyingSymbol}_${Date.now()}.md`;
  fs.writeFileSync(filename, fullReport);
  
  console.log('\n✅ ANALYSIS COMPLETE');
  console.log(`📄 Report saved to: ${filename}`);
  
  Object.values(pair.timeframes).forEach(tf => {
    if (tf.error) {
      console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
    } else {
      const status = pair.direction === 'short' 
        ? (tf.leftSideOvervalued ? 'OVERVALUED ✅' : 'NOT OVERVALUED ❌')
        : (tf.leftSideUndervalued ? 'UNDERVALUED ✅' : 'NOT UNDERVALUED ❌');
      const corr = tf.correlation !== null && tf.correlation !== undefined ? tf.correlation.toFixed(3) : 'N/A';
      const beta = tf.beta !== null && tf.beta !== undefined ? tf.beta.toFixed(3) : 'N/A';
      const z = tf.zScore !== null && tf.zScore !== undefined ? tf.zScore.toFixed(2) : 'N/A';
      console.log(`  ${tf.days}d: Corr ${corr}, Beta ${beta}, Z ${z}, ${pair.leftSide} ${status}`);
    }
  });
}

analyzePair();

