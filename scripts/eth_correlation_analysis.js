const axios = require('axios');
const fs = require('fs');

async function calculateCorrelationAnalysis() {
  console.log('=== ETH CORRELATION ANALYSIS ===\n');
  
  try {
    const pairs = [
      { name: 'ETH/BTC', asset1: 'ETHUSDT', asset2: 'BTCUSDT', symbol1: 'ETH', symbol2: 'BTC' },
      { name: 'ETH/SOL', asset1: 'ETHUSDT', asset2: 'SOLUSDT', symbol1: 'ETH', symbol2: 'SOL' }
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
        
        // Fetch daily data
        const [data1, data2] = await Promise.all([
          axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset1}&interval=1d&limit=${days + 5}`),
          axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair.asset2}&interval=1d&limit=${days + 5}`)
        ]);
        
        // Get current prices
        const [current1, current2] = await Promise.all([
          axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset1}`),
          axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair.asset2}`)
        ]);
        
        const prices1 = data1.data.slice(0, -1).map(candle => parseFloat(candle[4])); // Exclude today
        const prices2 = data2.data.slice(0, -1).map(candle => parseFloat(candle[4]));
        
        const currentPrice1 = parseFloat(current1.data.price);
        const currentPrice2 = parseFloat(current2.data.price);
        
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
        
        // Rolling Z-score calculation (using fixed rolling window for mean/std)
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
        
        // Simple ADF test approximation (check if spread is mean-reverting)
        // Calculate half-life of mean reversion
        const spreadChanges = [];
        for (let i = 1; i < spreads.length; i++) {
          spreadChanges.push(spreads[i] - spreads[i-1]);
        }
        
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
          price1Range: price1Range,
          price2Range: price2Range,
          dataPoints: prices1.length
        };
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
  const report = `# ETH CORRELATION & STATISTICAL ANALYSIS
**Generated:** ${new Date().toISOString()}

## Overview

This report analyzes the correlation and statistical relationships between ETH/BTC and ETH/SOL across 30, 90, and 180-day timeframes.

---

${results.map(pair => {
  return `## ${pair.pair} ANALYSIS

${Object.values(pair.timeframes).map(tf => {
  return `### ${tf.days}-Day Period

**Correlation & Beta:**
- **Correlation:** ${tf.correlation.toFixed(4)} (${tf.correlation > 0.7 ? 'Strong positive' : tf.correlation > 0.4 ? 'Moderate positive' : tf.correlation > 0 ? 'Weak positive' : 'Negative'})
- **Beta:** ${tf.beta.toFixed(4)} ${pair.pair === 'ETH/BTC' ? `(${pair.symbol2} underlying, ${pair.symbol1} relative - for every $1 move in ${pair.symbol2}, ${pair.symbol1} moves $${tf.beta.toFixed(4)})` : `(For every $1 move in ${pair.symbol2}, ${pair.symbol1} moves $${tf.beta.toFixed(4)})`}
- **Hedge Ratio:** ${(1 / (1 + Math.abs(tf.beta)) * 100).toFixed(1)}% ${pair.symbol1} / ${(Math.abs(tf.beta) / (1 + Math.abs(tf.beta)) * 100).toFixed(1)}% ${pair.symbol2} ${pair.pair === 'ETH/BTC' ? `(${pair.symbol2} underlying/reference)` : ''}

**Volatility (Annualized):**
- **${pair.symbol1} Volatility:** ${(tf.volatility1 * 100).toFixed(2)}%
- **${pair.symbol2} Volatility:** ${(tf.volatility2 * 100).toFixed(2)}%
- **Volatility Ratio:** ${(tf.volatility1 / tf.volatility2).toFixed(2)}x

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

### Summary Comparison

| Timeframe | Correlation | Beta | Z-Score | Spread (Current) | Cointegration | Mean Reversion |
|-----------|------------|------|---------|------------------|---------------|----------------|
${Object.values(pair.timeframes).map(tf => `| ${tf.days}d | ${tf.correlation.toFixed(3)} | ${tf.beta.toFixed(3)} | ${tf.zScore.toFixed(2)} | ${tf.currentSpread.toFixed(4)} | ${tf.isCointegrated ? 'Yes (' + tf.cointegrationStrength + ')' : 'No'} | ${(tf.meanReversionRate * 100).toFixed(1)}% |`).join('\n')}

`;
}).join('\n---\n\n')}

## Key Insights

### ETH/BTC
${(() => {
  const ethBtc = results.find(r => r.pair === 'ETH/BTC');
  if (!ethBtc) return 'Data not available';
  const tf30 = ethBtc.timeframes[30];
  const tf90 = ethBtc.timeframes[90];
  const tf180 = ethBtc.timeframes[180];
  return `- **30-day:** Correlation ${tf30.correlation.toFixed(3)}, Beta ${tf30.beta.toFixed(3)}, Z-score ${tf30.zScore.toFixed(2)}, Spread ${tf30.currentSpread.toFixed(4)}, Cointegrated: ${tf30.isCointegrated ? 'Yes (' + tf30.cointegrationStrength + ')' : 'No'}
- **90-day:** Correlation ${tf90.correlation.toFixed(3)}, Beta ${tf90.beta.toFixed(3)}, Z-score ${tf90.zScore.toFixed(2)}, Spread ${tf90.currentSpread.toFixed(4)}, Cointegrated: ${tf90.isCointegrated ? 'Yes (' + tf90.cointegrationStrength + ')' : 'No'}
- **180-day:** Correlation ${tf180.correlation.toFixed(3)}, Beta ${tf180.beta.toFixed(3)}, Z-score ${tf180.zScore.toFixed(2)}, Spread ${tf180.currentSpread.toFixed(4)}, Cointegrated: ${tf180.isCointegrated ? 'Yes (' + tf180.cointegrationStrength + ')' : 'No'}
- **Trend:** ${tf30.correlation > tf180.correlation ? 'Correlation increasing over time' : 'Correlation decreasing over time'} (${tf30.correlation.toFixed(3)} vs ${tf180.correlation.toFixed(3)})`;
})()}

### ETH/SOL
${(() => {
  const ethSol = results.find(r => r.pair === 'ETH/SOL');
  if (!ethSol) return 'Data not available';
  const tf30 = ethSol.timeframes[30];
  const tf90 = ethSol.timeframes[90];
  const tf180 = ethSol.timeframes[180];
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
`;

  fs.writeFileSync('eth_correlation_analysis.md', report);
  
  console.log('\n✅ ANALYSIS COMPLETE');
  console.log('📄 Report saved to: eth_correlation_analysis.md');
  
  // Console summary
  results.forEach(pair => {
    console.log(`\n${pair.pair}:`);
    Object.values(pair.timeframes).forEach(tf => {
      console.log(`  ${tf.days}d: Correlation ${tf.correlation.toFixed(3)}, Beta ${tf.beta.toFixed(3)}, Z-score ${tf.zScore.toFixed(2)}`);
    });
  });
}

calculateCorrelationAnalysis();

