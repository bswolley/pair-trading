const axios = require('axios');
const fs = require('fs');
const { obv } = require('indicatorts');

async function analyzePairs() {
  console.log('=== PAIR TRADING ANALYSIS WITH OBV ===\n');
  
  try {
    const pairs = [
      { name: 'HYPE/ZEC', asset1: 'HYPEUSDT', asset2: 'ZECUSDT', symbol1: 'HYPE', symbol2: 'ZEC', useHyperliquidAPI: true, leftSide: 'HYPE', direction: 'long' },
      { name: 'LTC/BTC', asset1: 'LTCUSDT', asset2: 'BTCUSDT', symbol1: 'LTC', symbol2: 'BTC', useHyperliquidAPI: false, leftSide: 'LTC', direction: 'long' },
      { name: 'TAO/BTC', asset1: 'TAOUSDT', asset2: 'BTCUSDT', symbol1: 'TAO', symbol2: 'BTC', useHyperliquidAPI: false, leftSide: 'TAO', direction: 'short' }
    ];
    
    const timeframes = [30, 90, 180];
    const results = [];
    
    for (const pair of pairs) {
      console.log(`Analyzing ${pair.name}...`);
      
      const pairResults = {
        pair: pair.name,
        symbol1: pair.symbol1,
        symbol2: pair.symbol2,
        leftSide: pair.leftSide,
        direction: pair.direction,
        timeframes: {}
      };
      
      for (const days of timeframes) {
        console.log(`  Fetching ${days}-day data...`);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
          let prices1, prices2, currentPrice1, currentPrice2, volumes1, volumes2;
          
          try {
            // Try Binance first
            const binanceLimit = Math.min(days + 10, 1000); // Binance max is 1000
            const [data1, data2] = await Promise.all([
              axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset1}&interval=1d&limit=${binanceLimit}`),
              axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset2}&interval=1d&limit=${binanceLimit}`)
            ]);
            
            const [current1, current2] = await Promise.all([
              axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset1}`),
              axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset2}`)
            ]);
            
            const binanceData1 = data1.data.slice(0, -1);
            const binanceData2 = data2.data.slice(0, -1);
            prices1 = binanceData1.map(candle => parseFloat(candle[4]));
            prices2 = binanceData2.map(candle => parseFloat(candle[4]));
            volumes1 = binanceData1.map(candle => parseFloat(candle[5]));
            volumes2 = binanceData2.map(candle => parseFloat(candle[5]));
            currentPrice1 = parseFloat(current1.data.price);
            currentPrice2 = parseFloat(current2.data.price);
          } catch (binanceError) {
            // For HYPE, try Hyperliquid API first, then CryptoCompare
            if (pair.useHyperliquidAPI) {
              try {
                console.log(`    Trying Hyperliquid API for ${pair.symbol1}...`);
                const hyperliquidUrl = `https://api.hyperliquid.xyz/info`;
                const hyperliquidResponse = await axios.post(hyperliquidUrl, {
                  type: 'candleSnapshot',
                  req: {
                    coin: 'HYPE',
                    interval: '1d',
                    n: days + 5
                  }
                });
                
                if (hyperliquidResponse.data && hyperliquidResponse.data.length > 0) {
                  const hyperliquidData = hyperliquidResponse.data.map(c => ({
                    time: c[0],
                    open: parseFloat(c[1]),
                    high: parseFloat(c[2]),
                    low: parseFloat(c[3]),
                    close: parseFloat(c[4]),
                    volume: parseFloat(c[5])
                  }));
                  
                  prices1 = hyperliquidData.slice(0, -1).map(c => c.close);
                  volumes1 = hyperliquidData.slice(0, -1).map(c => c.volume || 0);
                  currentPrice1 = hyperliquidData[hyperliquidData.length - 1].close;
                  
                  // Get ZEC from CryptoCompare
                  const limit = Math.min(days + 10, 2000);
                  const toTs = Math.floor(Date.now() / 1000);
                  const cc2 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
                    params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
                  });
                  
                  if (cc2.data.Response === 'Error') {
                    throw new Error(`CryptoCompare error for ZEC: ${cc2.data.Message}`);
                  }
                  
                  const data2 = cc2.data.Data.Data || [];
                  prices2 = data2.slice(0, -1).map(candle => candle.close);
                  volumes2 = data2.slice(0, -1).map(candle => candle.volumeto || candle.volumefrom || 0);
                  currentPrice2 = data2[data2.length - 1].close;
                  
                  // Align arrays
                  const minLength = Math.min(prices1.length, prices2.length);
                  prices1 = prices1.slice(-minLength);
                  prices2 = prices2.slice(-minLength);
                  volumes1 = volumes1.slice(-minLength);
                  volumes2 = volumes2.slice(-minLength);
                } else {
                  throw new Error('No Hyperliquid data');
                }
              } catch (hyperliquidError) {
                // Fallback to CryptoCompare
                console.log(`    Hyperliquid failed, trying CryptoCompare...`);
                const limit = Math.min(days + 10, 2000);
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
                
                prices1 = data1.slice(0, -1).map(candle => candle.close);
                prices2 = data2.slice(0, -1).map(candle => candle.close);
                volumes1 = data1.slice(0, -1).map(candle => candle.volumeto || candle.volumefrom || 0);
                volumes2 = data2.slice(0, -1).map(candle => candle.volumeto || candle.volumefrom || 0);
                currentPrice1 = data1[data1.length - 1].close;
                currentPrice2 = data2[data2.length - 1].close;
              }
            } else {
              // Fallback to CryptoCompare
              console.log(`    Binance failed, trying CryptoCompare...`);
              const limit = Math.min(days + 10, 2000);
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
              
              prices1 = data1.slice(0, -1).map(candle => candle.close);
              prices2 = data2.slice(0, -1).map(candle => candle.close);
              volumes1 = data1.slice(0, -1).map(candle => candle.volumeto || candle.volumefrom || 0);
              volumes2 = data2.slice(0, -1).map(candle => candle.volumeto || candle.volumefrom || 0);
              currentPrice1 = data1[data1.length - 1].close;
              currentPrice2 = data2[data2.length - 1].close;
            }
          }
          
          if (!prices1 || prices1.length < days || !prices2 || prices2.length < days) {
            throw new Error(`Insufficient data: prices1=${prices1?.length || 0}, prices2=${prices2?.length || 0}`);
          }
          
          // Debug: Check volumes
          console.log(`    Data check: prices1=${prices1.length}, volumes1=${volumes1?.length || 0}, prices2=${prices2.length}, volumes2=${volumes2?.length || 0}`);
          
          // Calculate returns
          const returns = [];
          for (let i = 1; i < prices1.length; i++) {
            const ret1 = (prices1[i] - prices1[i-1]) / prices1[i-1];
            const ret2 = (prices2[i] - prices2[i-1]) / prices2[i-1];
            returns.push({ asset1: ret1, asset2: ret2 });
          }
          
          // Calculate correlation
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
          
          // Calculate beta (asset1 relative to asset2)
          const beta = covariance / variance2;
          
          // Calculate spread (log spread for cointegration)
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
          
          // Calculate volatilities
          const volatility1 = Math.sqrt(variance1) * Math.sqrt(252);
          const volatility2 = Math.sqrt(variance2) * Math.sqrt(252);
          
          // Mean reversion rate
          let meanReversionScore = 0;
          for (let i = 1; i < spreads.length; i++) {
            const deviation = spreads[i-1] - meanSpread;
            const change = spreads[i] - spreads[i-1];
            if (deviation > 0 && change < 0) meanReversionScore++;
            if (deviation < 0 && change > 0) meanReversionScore++;
          }
          const meanReversionRate = meanReversionScore / (spreads.length - 1);
          
          // Cointegration test
          const spreadDiffs = [];
          for (let i = 1; i < spreads.length; i++) {
            spreadDiffs.push(spreads[i] - spreads[i-1]);
          }
          
          const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
          let autocorr = 0;
          let varDiff = 0;
          for (let i = 0; i < spreadDiffs.length; i++) {
            const dev = spreadDiffs[i] - meanDiff;
            varDiff += dev * dev;
            if (i > 0) {
              autocorr += (spreadDiffs[i] - meanDiff) * (spreadDiffs[i-1] - meanDiff);
            }
          }
          varDiff /= spreadDiffs.length;
          autocorr /= (spreadDiffs.length - 1);
          const autocorrCoeff = varDiff > 0 ? autocorr / varDiff : 0;
          const adfStat = -autocorrCoeff * Math.sqrt(spreads.length);
          const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && Math.abs(autocorrCoeff) < 0.3);
          const cointegrationStrength = isCointegrated ? (meanReversionRate > 0.6 ? 'Strong' : 'Moderate') : 'Weak';
          
          // Calculate OBV
          let currentOBV1 = null;
          let currentOBV2 = null;
          let obv1Change = null;
          let obv2Change = null;
          let obv1ChangePct = null;
          let obv2ChangePct = null;
          let obv1Values = null;
          let obv2Values = null;
          
          try {
            // Check if volumes have actual data (not all zeros)
            const volumes1Sum = volumes1 ? volumes1.reduce((sum, v) => sum + Math.abs(v || 0), 0) : 0;
            const volumes2Sum = volumes2 ? volumes2.reduce((sum, v) => sum + Math.abs(v || 0), 0) : 0;
            
            if (volumes1 && Array.isArray(volumes1) && volumes1.length > 0 && 
                volumes2 && Array.isArray(volumes2) && volumes2.length > 0 &&
                prices1.length === volumes1.length && prices2.length === volumes2.length &&
                volumes1Sum > 0 && volumes2Sum > 0) {
              
              obv1Values = obv(prices1, volumes1);
              obv2Values = obv(prices2, volumes2);
              
              if (obv1Values && obv1Values.length > 0 && obv2Values && obv2Values.length > 0) {
                currentOBV1 = obv1Values[obv1Values.length - 1];
                currentOBV2 = obv2Values[obv2Values.length - 1];
                
                obv1Change = obv1Values.length > 1 ? currentOBV1 - obv1Values[0] : null;
                obv2Change = obv2Values.length > 1 ? currentOBV2 - obv2Values[0] : null;
                
                obv1ChangePct = obv1Values.length > 1 && obv1Values[0] !== 0 ? ((currentOBV1 - obv1Values[0]) / Math.abs(obv1Values[0])) * 100 : null;
                obv2ChangePct = obv2Values.length > 1 && obv2Values[0] !== 0 ? ((currentOBV2 - obv2Values[0]) / Math.abs(obv2Values[0])) * 100 : null;
              }
            } else {
              console.log(`    OBV skipped: volumes1=${volumes1?.length || 0} (sum=${volumes1Sum.toFixed(0)}), volumes2=${volumes2?.length || 0} (sum=${volumes2Sum.toFixed(0)})`);
            }
          } catch (obvError) {
            console.log(`    OBV calculation error: ${obvError.message}`);
            console.log(`    Stack: ${obvError.stack}`);
          }
          
          // Price statistics
          const price1Range = { min: Math.min(...prices1), max: Math.max(...prices1), current: currentPrice1 };
          const price2Range = { min: Math.min(...prices2), max: Math.max(...prices2), current: currentPrice2 };
          
          // Determine if left side is undervalued/overvalued based on Z-score
          // Negative Z-score means asset1 is undervalued relative to asset2
          // For SHORT (TAO/BTC): we want TAO overvalued (positive Z-score = good for short)
          // For LONG (HYPE/ZEC, LTC/BTC): we want left side undervalued (negative Z-score = good for long)
          const leftSideUndervalued = pair.direction === 'short' ? false : zScore < 0; // For short, we want overvalued (positive Z), so "undervalued" is always false
          const leftSideOvervalued = pair.direction === 'short' ? zScore > 0 : false; // For short, positive Z = overvalued = good
          const tradeReady = pair.direction === 'short' ? leftSideOvervalued : leftSideUndervalued;
          const tradeSignal = tradeReady ? (Math.abs(zScore) > 1.5 ? 'STRONG' : Math.abs(zScore) > 1 ? 'MODERATE' : 'WEAK') : 'WEAK';
          
          pairResults.timeframes[days] = {
            days: days,
            correlation: correlation,
            beta: beta,
            volatility1: volatility1,
            volatility2: volatility2,
            meanSpread: meanSpread,
            stdDevSpread: stdDevSpread,
            currentSpread: currentSpread,
            zScore: zScore,
            meanReversionRate: meanReversionRate,
            isCointegrated: isCointegrated,
            cointegrationStrength: cointegrationStrength,
            adfStat: adfStat,
            obv1: currentOBV1,
            obv2: currentOBV2,
            obv1Change: obv1Change,
            obv2Change: obv2Change,
            obv1ChangePct: obv1ChangePct,
            obv2ChangePct: obv2ChangePct,
            obv1Values: obv1Values,
            obv2Values: obv2Values,
            prices1: prices1,
            prices2: prices2,
            price1Range: price1Range,
            price2Range: price2Range,
            leftSideUndervalued: leftSideUndervalued,
            leftSideOvervalued: leftSideOvervalued,
            tradeReady: tradeReady,
            tradeSignal: tradeSignal,
            dataPoints: prices1.length
          };
        } catch (error) {
          console.log(`  Error for ${days}-day: ${error.message}`);
          pairResults.timeframes[days] = {
            days: days,
            error: error.message
          };
        }
      }
      
      results.push(pairResults);
    }
    
    // Generate report
    generateReport(results);
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
  }
}

function generateReport(results) {
  const report = `# PAIR TRADING ANALYSIS
**Generated:** ${new Date().toISOString()}

## Summary Tables

${results.map(pair => {
  return `### ${pair.pair} - ${pair.direction === 'short' ? 'SHORT' : 'LONG'} ${pair.leftSide}

| Timeframe | Correlation | Beta | Z-Score | Spread | Cointegrated | ${pair.symbol1} OBV | ${pair.symbol2} OBV | Status |
|-----------|------------|------|---------|--------|--------------|---------------------|---------------------|--------|
${Object.values(pair.timeframes).filter(tf => !tf.error).sort((a, b) => a.days - b.days).map(tf => {
  const status = pair.direction === 'short' 
    ? (tf.leftSideOvervalued ? 'Overvalued (GOOD)' : 'Not Overvalued')
    : (tf.leftSideUndervalued ? 'Undervalued (GOOD)' : 'Not Undervalued');
  const obv1Str = tf.obv1ChangePct !== null && tf.obv1ChangePct !== undefined ? (tf.obv1ChangePct > 0 ? '+' : '') + tf.obv1ChangePct.toFixed(1) + '%' : 'N/A';
  const obv2Str = tf.obv2ChangePct !== null && tf.obv2ChangePct !== undefined ? (tf.obv2ChangePct > 0 ? '+' : '') + tf.obv2ChangePct.toFixed(1) + '%' : 'N/A';
  return `| ${tf.days}d | ${tf.correlation.toFixed(3)} | ${tf.beta.toFixed(3)} | ${tf.zScore.toFixed(2)} | ${tf.currentSpread.toFixed(4)} | ${tf.isCointegrated ? 'Yes' : 'No'} | ${obv1Str} | ${obv2Str} | ${status} |`;
}).join('\n')}

`;
}).join('\n')}

## Key Metrics

${results.map(pair => {
  const tf30 = pair.timeframes[30];
  const tf90 = pair.timeframes[90];
  const tf180 = pair.timeframes[180];
  
  let insights = `### ${pair.pair}\n`;
  
  if (tf30 && !tf30.error) {
    insights += `**30d:** Corr ${tf30.correlation.toFixed(2)}, Beta ${tf30.beta.toFixed(2)}, Z ${tf30.zScore.toFixed(2)}, ${pair.leftSide} ${pair.direction === 'short' ? (tf30.leftSideOvervalued ? 'OVERVALUED' : 'NOT OVERVALUED') : (tf30.leftSideUndervalued ? 'UNDERVALUED' : 'NOT UNDERVALUED')}, OBV: ${tf30.obv1ChangePct !== null ? (tf30.obv1ChangePct > 0 ? '+' : '') + tf30.obv1ChangePct.toFixed(1) + '%' : 'N/A'}\n`;
  }
  
  if (tf90 && !tf90.error) {
    insights += `**90d:** Corr ${tf90.correlation.toFixed(2)}, Beta ${tf90.beta.toFixed(2)}, Z ${tf90.zScore.toFixed(2)}, ${pair.leftSide} ${pair.direction === 'short' ? (tf90.leftSideOvervalued ? 'OVERVALUED' : 'NOT OVERVALUED') : (tf90.leftSideUndervalued ? 'UNDERVALUED' : 'NOT UNDERVALUED')}, OBV: ${tf90.obv1ChangePct !== null ? (tf90.obv1ChangePct > 0 ? '+' : '') + tf90.obv1ChangePct.toFixed(1) + '%' : 'N/A'}\n`;
  }
  
  if (tf180 && !tf180.error) {
    insights += `**180d:** Corr ${tf180.correlation.toFixed(2)}, Beta ${tf180.beta.toFixed(2)}, Z ${tf180.zScore.toFixed(2)}, ${pair.leftSide} ${pair.direction === 'short' ? (tf180.leftSideOvervalued ? 'OVERVALUED' : 'NOT OVERVALUED') : (tf180.leftSideUndervalued ? 'UNDERVALUED' : 'NOT UNDERVALUED')}, OBV: ${tf180.obv1ChangePct !== null ? (tf180.obv1ChangePct > 0 ? '+' : '') + tf180.obv1ChangePct.toFixed(1) + '%' : 'N/A'}\n`;
  } else {
    insights += `**180d:** Data unavailable\n`;
  }
  
  return insights;
}).join('\n')}

---

*Z-score: rolling 30-day window | OBV: On Balance Volume change %*
`;

  fs.writeFileSync('pair_obv_analysis.md', report);
  
  console.log('\n✅ ANALYSIS COMPLETE');
  console.log('📄 Report saved to: pair_obv_analysis.md');
  
  // Console summary
  results.forEach(pair => {
    console.log(`\n${pair.pair}:`);
    Object.values(pair.timeframes).forEach(tf => {
      if (tf.error) {
        console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
      } else {
        const status = pair.direction === 'short' 
          ? (tf.leftSideOvervalued ? 'OVERVALUED ✅ (Good for SHORT)' : 'NOT OVERVALUED ❌')
          : (tf.leftSideUndervalued ? 'UNDERVALUED ✅ (Good for LONG)' : 'NOT UNDERVALUED ❌');
        console.log(`  ${tf.days}d: Correlation ${tf.correlation.toFixed(3)}, Beta ${tf.beta.toFixed(3)}, Z-score ${tf.zScore.toFixed(2)}, ${pair.leftSide} ${status}`);
      }
    });
  });
}

analyzePairs();

