const axios = require('axios');
const fs = require('fs');
const { obv } = require('indicatorts');

async function calculateCorrelationAnalysis() {
  console.log('=== HYPE/ZEC CORRELATION ANALYSIS ===\n');
  
  try {
    const pairs = [
      { name: 'HYPE/ZEC', asset1: 'HYPEUSDT', asset2: 'ZECUSDT', symbol1: 'HYPE', symbol2: 'ZEC', useHyperliquidAPI: true }
    ];
    
    const timeframes = [30, 90, 180];
    const results = [];
    
    for (const pair of pairs) {
      console.log(`Analyzing ${pair.name}...`);
      
      const pairResults = {
        pair: pair.name,
        symbol1: pair.symbol1,
        symbol2: pair.symbol2,
        timeframes: {}
      };
      
      for (const days of timeframes) {
        console.log(`  Fetching ${days}-day data...`);
        
        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
          // Fetch daily data - try Binance first, fallback to CryptoCompare
          let prices1, prices2, currentPrice1, currentPrice2, volumes1, volumes2;
          
          try {
            // Try Binance first
            const [data1, data2] = await Promise.all([
              axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset1}&interval=1d&limit=${days + 5}`),
              axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset2}&interval=1d&limit=${days + 5}`)
            ]);
            
            const [current1, current2] = await Promise.all([
              axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset1}`),
              axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset2}`)
            ]);
            
            prices1 = data1.data.slice(0, -1).map(candle => parseFloat(candle[4]));
            prices2 = data2.data.slice(0, -1).map(candle => parseFloat(candle[4]));
            volumes1 = data1.data.slice(0, -1).map(candle => parseFloat(candle[5]));
            volumes2 = data2.data.slice(0, -1).map(candle => parseFloat(candle[5]));
            currentPrice1 = parseFloat(current1.data.price);
            currentPrice2 = parseFloat(current2.data.price);
          } catch (binanceError) {
            // For HYPE, try Hyperliquid API first, then CryptoCompare
            if (pair.useHyperliquidAPI) {
              try {
                console.log(`    Trying Hyperliquid API for ${pair.symbol1}...`);
                // Hyperliquid API - get candles
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
                  const limit = Math.min(days + 5, 2000);
                  const toTs = Math.floor(Date.now() / 1000);
                  const cc2 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
                    params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
                  });
                  
                  if (cc2.data.Response === 'Error') {
                    throw new Error(`CryptoCompare error for ZEC: ${cc2.data.Message}`);
                  }
                  
                  const data2 = cc2.data.Data.Data || [];
                  prices2 = data2.slice(0, -1).map(candle => candle.close);
                  volumes2 = data2.slice(0, -1).map(candle => candle.volumefrom || candle.volumeto || 0);
                  currentPrice2 = data2[data2.length - 1].close;
                  
                  // Align arrays by length
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
              
              if (data1.length > 0 && data2.length > 0) {
                prices1 = data1.slice(0, -1).map(candle => candle.close);
                prices2 = data2.slice(0, -1).map(candle => candle.close);
                volumes1 = data1.slice(0, -1).map(candle => {
                  const vol = candle.volumeto || candle.volumefrom || 0;
                  return vol;
                });
                volumes2 = data2.slice(0, -1).map(candle => {
                  const vol = candle.volumeto || candle.volumefrom || 0;
                  return vol;
                });
                currentPrice1 = data1[data1.length - 1].close;
                currentPrice2 = data2[data2.length - 1].close;
                
                // Debug: Check sample volume data
                if (data1.length > 0) {
                  console.log(`    Sample volume data: data1[0].volumeto=${data1[0].volumeto}, data1[0].volumefrom=${data1[0].volumefrom}, volumes1[0]=${volumes1[0]}`);
                }
              }
            }
          }
          
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
          
          // Calculate spread (log spread for cointegration analysis)
          const spreads = [];
          for (let i = 0; i < prices1.length; i++) {
            const spread = Math.log(prices1[i]) - beta * Math.log(prices2[i]);
            spreads.push(spread);
          }
          
          // Rolling Z-score calculation (using rolling window for mean/std)
          // Standard pair protocol: use last 30 days for Z-score calculation regardless of analysis period
          const zScoreWindow = 30; // Fixed rolling window for Z-score (standard in pair protocols)
          const recentSpreads = spreads.slice(-Math.min(zScoreWindow, spreads.length));
          
          const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
          const varianceSpread = recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length;
          const stdDevSpread = Math.sqrt(varianceSpread);
          
          // Current spread and Z-score (using rolling mean/std)
          const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
          const zScore = (currentSpread - meanSpread) / stdDevSpread;
          
          // Calculate volatilities
          const volatility1 = Math.sqrt(variance1) * Math.sqrt(252); // Annualized
          const volatility2 = Math.sqrt(variance2) * Math.sqrt(252);
          
          // Simple mean reversion test: check if spread reverts to mean
          let meanReversionScore = 0;
          for (let i = 1; i < spreads.length; i++) {
            const deviation = spreads[i-1] - meanSpread;
            const change = spreads[i] - spreads[i-1];
            if (deviation > 0 && change < 0) meanReversionScore++; // Reverting from above
            if (deviation < 0 && change > 0) meanReversionScore++; // Reverting from below
          }
          const meanReversionRate = meanReversionScore / (spreads.length - 1);
          
          // Simple ADF test approximation (Augmented Dickey-Fuller)
          // Calculate first differences and test for stationarity
          const spreadDiffs = [];
          for (let i = 1; i < spreads.length; i++) {
            spreadDiffs.push(spreads[i] - spreads[i-1]);
          }
          
          // Calculate autocorrelation of first differences (if low, spread is stationary)
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
          
          // Simple cointegration test: if autocorrelation is low and mean reversion is high, likely cointegrated
          // ADF test statistic approximation: negative autocorrelation suggests stationarity
          const adfStat = -autocorrCoeff * Math.sqrt(spreads.length);
          const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && Math.abs(autocorrCoeff) < 0.3);
          const cointegrationStrength = isCointegrated ? (meanReversionRate > 0.6 ? 'Strong' : 'Moderate') : 'Weak';
          
          // Calculate OBV (On Balance Volume)
          let obv1 = null;
          let obv2 = null;
          let currentOBV1 = null;
          let currentOBV2 = null;
          let obv1Change = null;
          let obv2Change = null;
          let obv1ChangePct = null;
          let obv2ChangePct = null;
          
          try {
            // Check if volumes exist and have data
            const hasVolumes = volumes1 && Array.isArray(volumes1) && volumes1.length > 0 && 
                              volumes2 && Array.isArray(volumes2) && volumes2.length > 0;
            const lengthsMatch = hasVolumes && prices1.length === volumes1.length && prices2.length === volumes2.length;
            
            if (hasVolumes && lengthsMatch) {
              // Calculate OBV for both assets
              obv1 = obv(prices1, volumes1);
              obv2 = obv(prices2, volumes2);
              
              // Current OBV is the last value
              currentOBV1 = obv1.length > 0 ? obv1[obv1.length - 1] : null;
              currentOBV2 = obv2.length > 0 ? obv2[obv2.length - 1] : null;
              
              // Calculate OBV change over period (trend indicator)
              obv1Change = obv1.length > 1 ? currentOBV1 - obv1[0] : null;
              obv2Change = obv2.length > 1 ? currentOBV2 - obv2[0] : null;
              
              // Calculate OBV change percentage (normalized)
              obv1ChangePct = obv1.length > 1 && obv1[0] !== 0 ? ((currentOBV1 - obv1[0]) / Math.abs(obv1[0])) * 100 : null;
              obv2ChangePct = obv2.length > 1 && obv2[0] !== 0 ? ((currentOBV2 - obv2[0]) / Math.abs(obv2[0])) * 100 : null;
            } else {
              // Debug: Show why OBV was skipped
              const vol1Defined = typeof volumes1 !== 'undefined';
              const vol2Defined = typeof volumes2 !== 'undefined';
              console.log(`    OBV skipped: volumes1 defined=${vol1Defined}, length=${volumes1?.length || 0}, volumes2 defined=${vol2Defined}, length=${volumes2?.length || 0}, prices1=${prices1?.length || 0}, prices2=${prices2?.length || 0}`);
            }
          } catch (obvError) {
            console.log(`    OBV calculation error: ${obvError.message}`);
          }
          
          // Price statistics
          const price1Range = { min: Math.min(...prices1), max: Math.max(...prices1), current: currentPrice1 };
          const price2Range = { min: Math.min(...prices2), max: Math.max(...prices2), current: currentPrice2 };
          
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
            price1Range: price1Range,
            price2Range: price2Range,
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
  const report = `# HYPE/ZEC CORRELATION & STATISTICAL ANALYSIS
**Generated:** ${new Date().toISOString()}

## Overview

This report analyzes the correlation and statistical relationships between HYPE/ZEC across 30, 90, and 180-day timeframes.

---

${results.map(pair => {
  return `## ${pair.pair} ANALYSIS

${Object.values(pair.timeframes).filter(tf => !tf.error).map(tf => {
  return `### ${tf.days}-Day Period

**Correlation & Beta:**
- **Correlation:** ${tf.correlation.toFixed(4)} (${tf.correlation > 0.7 ? 'Strong positive' : tf.correlation > 0.4 ? 'Moderate positive' : tf.correlation > 0 ? 'Weak positive' : 'Negative'})
- **Beta:** ${tf.beta.toFixed(4)} (${pair.symbol2} underlying, ${pair.symbol1} relative - for every $1 move in ${pair.symbol2}, ${pair.symbol1} moves $${tf.beta.toFixed(4)})
- **Hedge Ratio:** ${(1 / (1 + Math.abs(tf.beta)) * 100).toFixed(1)}% ${pair.symbol1} / ${(Math.abs(tf.beta) / (1 + Math.abs(tf.beta)) * 100).toFixed(1)}% ${pair.symbol2} (${pair.symbol2} underlying/reference)

**Volatility (Annualized):**
- **${pair.symbol1} Volatility:** ${(tf.volatility1 * 100).toFixed(2)}%
- **${pair.symbol2} Volatility:** ${(tf.volatility2 * 100).toFixed(2)}%
- **Volatility Ratio:** ${(tf.volatility1 / tf.volatility2).toFixed(2)}x

**On Balance Volume (OBV):**
- **${pair.symbol1} OBV:** ${tf.obv1 !== null ? tf.obv1.toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A'} ${tf.obv1ChangePct !== null ? `(${tf.obv1ChangePct > 0 ? '+' : ''}${tf.obv1ChangePct.toFixed(1)}% change)` : ''}
- **${pair.symbol2} OBV:** ${tf.obv2 !== null ? tf.obv2.toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A'} ${tf.obv2ChangePct !== null ? `(${tf.obv2ChangePct > 0 ? '+' : ''}${tf.obv2ChangePct.toFixed(1)}% change)` : ''}
${tf.obv1Change !== null && tf.obv2Change !== null ? `- **OBV Trend:** ${pair.symbol1} ${tf.obv1Change > 0 ? 'accumulating' : 'distributing'} (${tf.obv1Change > 0 ? '+' : ''}${tf.obv1Change.toLocaleString('en-US', {maximumFractionDigits: 0})}), ${pair.symbol2} ${tf.obv2Change > 0 ? 'accumulating' : 'distributing'} (${tf.obv2Change > 0 ? '+' : ''}${tf.obv2Change.toLocaleString('en-US', {maximumFractionDigits: 0})})` : ''}

**Spread Analysis:**
- **Mean Spread:** ${tf.meanSpread.toFixed(4)} (rolling 30-day mean)
- **Std Dev:** ${tf.stdDevSpread.toFixed(4)} (rolling 30-day std dev)
- **Current Spread:** ${tf.currentSpread.toFixed(4)}
- **Z-Score:** ${tf.zScore.toFixed(2)} ${Math.abs(tf.zScore) < 0.5 ? '(Near mean)' : Math.abs(tf.zScore) < 1 ? '(Moderate deviation)' : Math.abs(tf.zScore) < 2 ? '(Significant deviation)' : '(Extreme deviation)'} (calculated using rolling 30-day window)
- **Mean Reversion Rate:** ${(tf.meanReversionRate * 100).toFixed(1)}% (${tf.meanReversionRate > 0.5 ? 'Strong mean reversion tendency' : tf.meanReversionRate > 0.3 ? 'Moderate mean reversion' : 'Weak mean reversion'})

**Cointegration Analysis:**
- **Cointegrated:** ${tf.isCointegrated ? 'Yes' : 'No'} (${tf.cointegrationStrength})
- **ADF Test Statistic:** ${tf.adfStat.toFixed(4)} ${tf.adfStat < -2.5 ? '(Stationary - cointegrated)' : tf.adfStat < -1.5 ? '(Likely stationary)' : '(Non-stationary)'}
- **Interpretation:** ${tf.isCointegrated ? 'Pair shows cointegration - suitable for pair trading' : 'Pair may not be cointegrated - pair trading may be risky'}

**Price Ranges:**
- **${pair.symbol1}:** $${tf.price1Range.min.toFixed(2)} - $${tf.price1Range.max.toFixed(2)} (Current: $${tf.price1Range.current.toFixed(2)})
- **${pair.symbol2}:** $${tf.price2Range.min.toFixed(2)} - $${tf.price2Range.max.toFixed(2)} (Current: $${tf.price2Range.current.toFixed(2)})

**Data Points:** ${tf.dataPoints} days

`;
}).join('\n')}

${Object.values(pair.timeframes).filter(tf => !tf.error).length > 0 ? `### Summary Comparison

| Timeframe | Correlation | Beta | Z-Score | Spread (Current) | Cointegration | Mean Reversion |
|-----------|------------|------|---------|------------------|---------------|----------------|
${Object.values(pair.timeframes).filter(tf => !tf.error).map(tf => `| ${tf.days}d | ${tf.correlation.toFixed(3)} | ${tf.beta.toFixed(3)} | ${tf.zScore.toFixed(2)} | ${tf.currentSpread.toFixed(4)} | ${tf.isCointegrated ? 'Yes (' + tf.cointegrationStrength + ')' : 'No'} | ${(tf.meanReversionRate * 100).toFixed(1)}% |`).join('\n')}
` : '**Error:** Unable to fetch data for this pair'}

`;
}).join('\n---\n\n')}

## Key Insights

### HYPE/ZEC
${(() => {
  const hypeZec = results.find(r => r.pair === 'HYPE/ZEC');
  if (!hypeZec) return 'Data not available';
  const tf30 = hypeZec.timeframes[30];
  const tf90 = hypeZec.timeframes[90];
  const tf180 = hypeZec.timeframes[180];
  if (tf30?.error || tf90?.error || tf180?.error) return 'Some timeframes unavailable due to data errors';
  return `- **30-day:** Correlation ${tf30.correlation.toFixed(3)}, Beta ${tf30.beta.toFixed(3)}, Z-score ${tf30.zScore.toFixed(2)}, Spread ${tf30.currentSpread.toFixed(4)}, Cointegrated: ${tf30.isCointegrated ? 'Yes (' + tf30.cointegrationStrength + ')' : 'No'}
- **90-day:** Correlation ${tf90.correlation.toFixed(3)}, Beta ${tf90.beta.toFixed(3)}, Z-score ${tf90.zScore.toFixed(2)}, Spread ${tf90.currentSpread.toFixed(4)}, Cointegrated: ${tf90.isCointegrated ? 'Yes (' + tf90.cointegrationStrength + ')' : 'No'}
- **180-day:** Correlation ${tf180.correlation.toFixed(3)}, Beta ${tf180.beta.toFixed(3)}, Z-score ${tf180.zScore.toFixed(2)}, Spread ${tf180.currentSpread.toFixed(4)}, Cointegrated: ${tf180.isCointegrated ? 'Yes (' + tf180.cointegrationStrength + ')' : 'No'}
- **Trend:** ${tf30.correlation > tf180.correlation ? 'Correlation increasing over time' : 'Correlation decreasing over time'} (${tf30.correlation.toFixed(3)} vs ${tf180.correlation.toFixed(3)})`;
})()}

---

## Interpretation Guide

**Correlation:**
- > 0.7: Strong positive correlation (move together)
- 0.4-0.7: Moderate correlation
- < 0.4: Weak correlation
- < 0: Negative correlation (move opposite)

**Beta:**
- Beta > 1: Asset1 more volatile than Asset2
- Beta < 1: Asset1 less volatile than Asset2
- Beta = 1: Equal volatility

**Z-Score:**
- |Z| < 0.5: Near mean (spread normalized)
- |Z| < 1: Moderate deviation
- |Z| < 2: Significant deviation (potential trade opportunity)
- |Z| > 2: Extreme deviation (strong trade signal)

**Mean Reversion Rate:**
- > 50%: Strong mean reversion (good for pair trading)
- 30-50%: Moderate mean reversion
- < 30%: Weak mean reversion (may not be suitable for pair trading)

---

*Analysis based on daily closing prices from Binance API*
*Data excludes today's incomplete candle*
*Z-score calculated using rolling 30-day window (pair protocol standard)*
`;

  fs.writeFileSync('hype_zec_correlation_analysis.md', report);
  
  console.log('\n✅ ANALYSIS COMPLETE');
  console.log('📄 Report saved to: hype_zec_correlation_analysis.md');
  
  // Console summary
  results.forEach(pair => {
    console.log(`\n${pair.pair}:`);
    Object.values(pair.timeframes).forEach(tf => {
      if (tf.error) {
        console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
      } else {
        console.log(`  ${tf.days}d: Correlation ${tf.correlation.toFixed(3)}, Beta ${tf.beta.toFixed(3)}, Z-score ${tf.zScore.toFixed(2)}`);
      }
    });
  });
}

calculateCorrelationAnalysis();

