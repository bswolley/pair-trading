const axios = require('axios');
const fs = require('fs');

async function generateSnapshot() {
  console.log('=== PAIR TRADING SNAPSHOT ===\n');
  
  const pairs = [
    { name: 'HYPE/ZEC', asset1: 'HYPEUSDT', asset2: 'ZECUSDT', symbol1: 'HYPE', symbol2: 'ZEC', leftSide: 'HYPE', direction: 'long' },
    { name: 'LTC/BTC', asset1: 'LTCUSDT', asset2: 'BTCUSDT', symbol1: 'LTC', symbol2: 'BTC', leftSide: 'LTC', direction: 'long' },
    { name: 'TAO/BTC', asset1: 'TAOUSDT', asset2: 'BTCUSDT', symbol1: 'TAO', symbol2: 'BTC', leftSide: 'TAO', direction: 'short' }
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
      console.log(`  ${days}d...`);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
        try {
          let prices1, prices2, currentPrice1, currentPrice2;
          
          // Try Hyperliquid first for all pairs
          try {
            console.log(`    Trying Hyperliquid API for ${pair.symbol1}...`);
            const hyperliquidUrl = `https://api.hyperliquid.xyz/info`;
            const hyperliquidResponse = await axios.post(hyperliquidUrl, {
              type: 'candleSnapshot',
              req: {
                coin: pair.symbol1,
                interval: '1d',
                n: days + 5
              }
            });
            
            if (hyperliquidResponse.data && hyperliquidResponse.data.length > 0) {
              const hyperliquidData = hyperliquidResponse.data.map(c => ({
                time: c[0],
                close: parseFloat(c[4])
              }));
              
              prices1 = hyperliquidData.slice(0, -1).map(c => c.close);
              currentPrice1 = hyperliquidData[hyperliquidData.length - 1].close;
              
              // Get second asset from Binance or CryptoCompare
              try {
                const data2 = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset2}&interval=1d&limit=${days + 5}`);
                const current2 = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset2}`);
                
                prices2 = data2.data.slice(0, -1).map(candle => parseFloat(candle[4]));
                currentPrice2 = parseFloat(current2.data.price);
              } catch (binanceError2) {
                // Fallback to CryptoCompare for asset2
                const limit = Math.min(days + 5, 2000);
                const toTs = Math.floor(Date.now() / 1000);
                const cc2 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
                  params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
                });
                
                if (cc2.data.Response === 'Error') {
                  throw new Error(`CryptoCompare error for ${pair.symbol2}: ${cc2.data.Message}`);
                }
                
                const data2 = cc2.data.Data.Data || [];
                const data2Map = new Map();
                data2.forEach(d => {
                  const date = new Date(d.time * 1000).toISOString().split('T')[0];
                  data2Map.set(date, d);
                });
                
                // Align by date
                const hyperliquidDates = hyperliquidData.map(c => {
                  const date = new Date(c.time).toISOString().split('T')[0];
                  return { date, close: c.close };
                });
                
                const alignedData = hyperliquidDates.filter(h => data2Map.has(h.date));
                
                if (alignedData.length < days) {
                  throw new Error(`Insufficient aligned data: ${alignedData.length} days`);
                }
                
                prices1 = alignedData.slice(0, -1).map(d => d.close);
                prices2 = alignedData.slice(0, -1).map(d => data2Map.get(d.date).close);
                currentPrice1 = alignedData[alignedData.length - 1].close;
                currentPrice2 = data2Map.get(alignedData[alignedData.length - 1].date).close;
              }
            } else {
              throw new Error('No data from Hyperliquid');
            }
          } catch (hyperliquidError) {
            console.log(`    Hyperliquid failed: ${hyperliquidError.message}, trying Binance...`);
            
            // Fallback to Binance
            try {
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
              currentPrice1 = parseFloat(current1.data.price);
              currentPrice2 = parseFloat(current2.data.price);
            } catch (binanceError) {
              // Fallback to CryptoCompare
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
                throw new Error(`Insufficient data: ${commonDates.length} days`);
              }
              
              const selectedDates = commonDates.slice(-days);
              
              prices1 = selectedDates.map(date => data1Map.get(date).close);
              prices2 = selectedDates.map(date => data2Map.get(date).close);
              currentPrice1 = data1Map.get(selectedDates[selectedDates.length - 1]).close;
              currentPrice2 = data2Map.get(selectedDates[selectedDates.length - 1]).close;
            }
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
        
        // Correlation
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
        
        // Spread and Z-score
        const spreads = [];
        for (let i = 0; i < prices1.length; i++) {
          const spread = Math.log(prices1[i]) - beta * Math.log(prices2[i]);
          spreads.push(spread);
        }
        
        const zScoreWindow = 30;
        const recentSpreads = spreads.slice(-Math.min(zScoreWindow, spreads.length));
        
        const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
        const varianceSpread = recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length;
        const stdDevSpread = Math.sqrt(varianceSpread);
        
        const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
        const zScore = (currentSpread - meanSpread) / stdDevSpread;
        
        // Cointegration
        let meanReversionScore = 0;
        for (let i = 1; i < spreads.length; i++) {
          const deviation = spreads[i-1] - meanSpread;
          const change = spreads[i] - spreads[i-1];
          if (deviation > 0 && change < 0) meanReversionScore++;
          if (deviation < 0 && change > 0) meanReversionScore++;
        }
        const meanReversionRate = meanReversionScore / (spreads.length - 1);
        
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
        
        pairResults.timeframes[days] = {
          days: days,
          correlation: correlation,
          beta: beta,
          currentSpread: currentSpread,
          meanSpread: meanSpread,
          zScore: zScore,
          isCointegrated: isCointegrated,
          meanReversionRate: meanReversionRate
        };
      } catch (error) {
        console.log(`  Error: ${error.message}`);
        pairResults.timeframes[days] = {
          days: days,
          error: error.message
        };
      }
    }
    
    results.push(pairResults);
  }
  
  // Generate report
  const report = `# PAIR TRADING SNAPSHOT
**Generated:** ${new Date().toISOString()}

${results.map(pair => {
  return `## ${pair.pair} - ${pair.direction === 'short' ? 'SHORT' : 'LONG'} ${pair.leftSide}

| Timeframe | Correlation | Beta | Z-Score | Spread (Current) | Spread (Mean) | Cointegrated |
|-----------|------------|------|---------|-----------------|---------------|--------------|
${Object.values(pair.timeframes).filter(tf => !tf.error).sort((a, b) => a.days - b.days).map(tf => {
  return `| ${tf.days}d | ${tf.correlation.toFixed(3)} | ${tf.beta.toFixed(3)} | ${tf.zScore.toFixed(2)} | ${tf.currentSpread.toFixed(4)} | ${tf.meanSpread.toFixed(4)} | ${tf.isCointegrated ? 'Yes' : 'No'} |`;
}).join('\n')}

**Hedge Ratio (for delta-neutral position):**
${Object.values(pair.timeframes).filter(tf => !tf.error).sort((a, b) => a.days - b.days).map(tf => {
  const hedgeRatio = tf.beta.toFixed(4);
  return `- **${tf.days}d:** For $1 of ${pair.symbol1} (base), use $${hedgeRatio} of ${pair.symbol2} (underlying)`;
}).join('\n')}

`;
}).join('\n')}

`;

  fs.writeFileSync('pair_snapshot.md', report);
  
  console.log('\n✅ SNAPSHOT COMPLETE');
  console.log('📄 Report saved to: pair_snapshot.md');
  
  results.forEach(pair => {
    console.log(`\n${pair.pair}:`);
    Object.values(pair.timeframes).forEach(tf => {
      if (tf.error) {
        console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
      } else {
        console.log(`  ${tf.days}d: Corr ${tf.correlation.toFixed(3)}, Beta ${tf.beta.toFixed(3)}, Z ${tf.zScore.toFixed(2)}, Cointegrated: ${tf.isCointegrated ? 'Yes' : 'No'}`);
      }
    });
  });
}

generateSnapshot();

