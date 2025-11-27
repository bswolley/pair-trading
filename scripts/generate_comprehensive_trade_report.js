const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { obv } = require('indicatorts');

async function generateTradeReport(tradeKey, trade, isSimulated = false) {
  const label = isSimulated ? '[SIMULATED]' : '';
  console.log(`\n=== Processing ${tradeKey} ${label} ===`);
  
  try {
    
    // Entry prices and position sizing from config
    const entryPrice1 = trade.entryPrice1;
    const entryPrice2 = trade.entryPrice2;
    const weight1 = trade.weight1;
    const weight2 = trade.weight2;
    const symbol1 = trade.symbol1;
    const symbol2 = trade.symbol2;
    
    // Entry date from config
    const entryDate = new Date(trade.entryDate);
    const now = new Date();
    const hoursSinceEntry = Math.ceil((now - entryDate) / (1000 * 60 * 60));
    const hoursBack = Math.min(hoursSinceEntry + 1, 1000); // Binance limit is 1000
    
    // Get current prices
    console.log(`Fetching current prices for ${symbol1}/${symbol2}...`);
    const [price1Resp, price2Resp] = await Promise.all([
      axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol1}USDT`),
      axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol2}USDT`)
    ]);
    
    const currentPrice1 = parseFloat(price1Resp.data.price);
    const currentPrice2 = parseFloat(price2Resp.data.price);
    
    // Get hourly data from entry to now
    console.log(`Fetching hourly data from entry (${hoursSinceEntry} hours ago)...`);
    // Fetch enough data to cover from entry to now (max 1000 candles)
    const [hourly1, hourly2] = await Promise.all([
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol1}USDT&interval=1h&limit=${hoursBack}`),
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol2}USDT&interval=1h&limit=${hoursBack}`)
    ]);
    
    // Get historical daily data for CURRENT stats
    console.log('Fetching historical data for current statistics...');
    const [hist1, hist2] = await Promise.all([
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol1}USDT&interval=1d&limit=35`),
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol2}USDT&interval=1d&limit=35`)
    ]);
    
    const prices1 = hist1.data.slice(0, -1).map(candle => parseFloat(candle[4]));
    const prices2 = hist2.data.slice(0, -1).map(candle => parseFloat(candle[4]));
    const volumes1 = hist1.data.slice(0, -1).map(candle => parseFloat(candle[5]));
    const volumes2 = hist2.data.slice(0, -1).map(candle => parseFloat(candle[5]));
    
    // Calculate returns for CURRENT stats
    const returns = [];
    for (let i = 1; i < prices1.length; i++) {
      const ret1 = (prices1[i] - prices1[i-1]) / prices1[i-1];
      const ret2 = (prices2[i] - prices2[i-1]) / prices2[i-1];
      returns.push({ asset1: ret1, asset2: ret2 });
    }
    
    // Calculate correlation and beta for CURRENT stats
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
    
    // Calculate CURRENT Z-score
    const historicalSpreads = [];
    for (let i = 0; i < prices1.length; i++) {
      const spread = Math.log(prices1[i]) - beta * Math.log(prices2[i]);
      historicalSpreads.push(spread);
    }
    
    const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
    const meanSpread = historicalSpreads.reduce((sum, s) => sum + s, 0) / historicalSpreads.length;
    const varianceSpread = historicalSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / historicalSpreads.length;
    const stdDevSpread = Math.sqrt(varianceSpread);
    const zScore = (currentSpread - meanSpread) / stdDevSpread;
    
    // Calculate ENTRY Z-score using historical data AS OF ENTRY DATE
    console.log('Calculating entry Z-score using historical data as of entry date...');
    const daysSinceEntry = Math.ceil((now - entryDate) / (1000 * 60 * 60 * 24));
    const daysForEntryCalc = Math.min(35, daysSinceEntry + 35); // Get enough data before entry
    
    const [entryHist1, entryHist2] = await Promise.all([
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol1}USDT&interval=1d&limit=${daysForEntryCalc}`),
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol2}USDT&interval=1d&limit=${daysForEntryCalc}`)
    ]);
    
    // Filter data to only include candles BEFORE entry date
    const entryPrices1 = [];
    const entryPrices2 = [];
    for (let i = 0; i < entryHist1.data.length; i++) {
      const candleTime = new Date(entryHist1.data[i][0]);
      if (candleTime < entryDate) {
        entryPrices1.push(parseFloat(entryHist1.data[i][4]));
        entryPrices2.push(parseFloat(entryHist2.data[i][4]));
      }
    }
    
    // Calculate entry-time beta using data before entry
    const entryReturns = [];
    for (let i = 1; i < entryPrices1.length; i++) {
      const ret1 = (entryPrices1[i] - entryPrices1[i-1]) / entryPrices1[i-1];
      const ret2 = (entryPrices2[i] - entryPrices2[i-1]) / entryPrices2[i-1];
      entryReturns.push({ asset1: ret1, asset2: ret2 });
    }
    
    if (entryReturns.length < 2) {
      throw new Error('Not enough historical data before entry date to calculate entry Z-score');
    }
    
    const entryMean1 = entryReturns.reduce((sum, r) => sum + r.asset1, 0) / entryReturns.length;
    const entryMean2 = entryReturns.reduce((sum, r) => sum + r.asset2, 0) / entryReturns.length;
    
    let entryCovariance = 0;
    let entryVariance2 = 0;
    
    for (const ret of entryReturns) {
      const dev1 = ret.asset1 - entryMean1;
      const dev2 = ret.asset2 - entryMean2;
      entryCovariance += dev1 * dev2;
      entryVariance2 += dev2 * dev2;
    }
    
    entryCovariance /= entryReturns.length;
    entryVariance2 /= entryReturns.length;
    
    const entryBeta = entryVariance2 > 0 ? entryCovariance / entryVariance2 : beta;
    
    // Calculate entry-time spreads and Z-score
    const entryHistoricalSpreads = [];
    for (let i = 0; i < entryPrices1.length; i++) {
      const spread = Math.log(entryPrices1[i]) - entryBeta * Math.log(entryPrices2[i]);
      entryHistoricalSpreads.push(spread);
    }
    
    // Use rolling 30-day window for entry Z-score (standard pair protocol)
    const zScoreWindow = 30;
    const entryRecentSpreads = entryHistoricalSpreads.slice(-Math.min(zScoreWindow, entryHistoricalSpreads.length));
    const entryMeanSpread = entryRecentSpreads.reduce((sum, s) => sum + s, 0) / entryRecentSpreads.length;
    const entryVarianceSpread = entryRecentSpreads.reduce((sum, s) => sum + Math.pow(s - entryMeanSpread, 2), 0) / entryRecentSpreads.length;
    const entryStdDevSpread = Math.sqrt(entryVarianceSpread);
    
    const entrySpread = Math.log(entryPrice1) - entryBeta * Math.log(entryPrice2);
    const entryZScore = (entrySpread - entryMeanSpread) / entryStdDevSpread;
    
    // Calculate individual returns
    const return1 = ((currentPrice1 - entryPrice1) / entryPrice1) * 100;
    const return2 = ((currentPrice2 - entryPrice2) / entryPrice2) * 100;
    const longReturn1 = return1;
    const shortReturn2 = -return2;
    const combinedPnl = (longReturn1 * weight1) + (shortReturn2 * weight2);
    
    // Calculate optimal sizing
    const optimalWeight1 = 1 / (1 + Math.abs(beta));
    const optimalWeight2 = Math.abs(beta) / (1 + Math.abs(beta));
    const combinedPnlOptimal = (longReturn1 * optimalWeight1) + (shortReturn2 * optimalWeight2);
    
    // Calculate Greeks
    const delta = beta;
    
    // Gamma - Beta stability
    const shortWindow = Math.floor(returns.length / 3);
    const shortReturns = returns.slice(-shortWindow);
    let shortMean1 = shortReturns.reduce((sum, r) => sum + r.asset1, 0) / shortReturns.length;
    let shortMean2 = shortReturns.reduce((sum, r) => sum + r.asset2, 0) / shortReturns.length;
    let shortCov = 0, shortVar2 = 0;
    for (const ret of shortReturns) {
      shortCov += (ret.asset1 - shortMean1) * (ret.asset2 - shortMean2);
      shortVar2 += Math.pow(ret.asset2 - shortMean2, 2);
    }
    shortCov /= shortReturns.length;
    shortVar2 /= shortReturns.length;
    const shortBeta = shortVar2 > 0 ? shortCov / shortVar2 : beta;
    const avgPriceChange = Math.abs((currentPrice1 - entryPrice1) / entryPrice1 + (currentPrice2 - entryPrice2) / entryPrice2) / 2;
    const gamma = avgPriceChange > 0 ? (beta - shortBeta) / avgPriceChange : 0;
    
    // Theta - Time decay
    const zScoreChange = zScore - entryZScore;
    const theta = daysSinceEntry > 0 ? zScoreChange / daysSinceEntry : 0;
    
    // Vega - Volatility sensitivity
    const historicalVolatility = stdDevSpread;
    const recentWindow = Math.floor(prices1.length / 2);
    const recentSpreads = [];
    for (let i = prices1.length - recentWindow; i < prices1.length; i++) {
      recentSpreads.push(Math.log(prices1[i]) - beta * Math.log(prices2[i]));
    }
    const recentMeanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
    const recentVariance = recentSpreads.reduce((sum, s) => sum + Math.pow(s - recentMeanSpread, 2), 0) / recentSpreads.length;
    const recentVolatility = Math.sqrt(recentVariance);
    const underlyingVolatility = Math.sqrt(variance2);
    const vega = underlyingVolatility > 0 ? (recentVolatility - historicalVolatility) / (underlyingVolatility * 0.01) : 0;
    
    const rho = 0; // Not applicable
    
    // Calculate OBV
    let obv1 = null, obv2 = null, obv1Change = null, obv2Change = null, obv1ChangePct = null, obv2ChangePct = null;
    try {
      if (volumes1.length > 0 && volumes2.length > 0 && prices1.length === volumes1.length && prices2.length === volumes2.length) {
        const obv1Values = obv(prices1, volumes1);
        const obv2Values = obv(prices2, volumes2);
        
        if (obv1Values && obv1Values.length > 1 && obv2Values && obv2Values.length > 1) {
          obv1 = obv1Values[obv1Values.length - 1];
          obv2 = obv2Values[obv2Values.length - 1];
          obv1Change = obv1 - obv1Values[0];
          obv2Change = obv2 - obv2Values[0];
          
          if (Math.abs(obv1Values[0]) > 0.0001) {
            obv1ChangePct = (obv1Change / Math.abs(obv1Values[0])) * 100;
          }
          if (Math.abs(obv2Values[0]) > 0.0001) {
            obv2ChangePct = (obv2Change / Math.abs(obv2Values[0])) * 100;
          }
        }
      }
    } catch (obvError) {
      console.log('OBV calculation error:', obvError.message);
    }
    
    // Process hourly data - filter from entry time onwards
    // Binance returns data in reverse chronological order (newest first), so reverse it
    const hourly1Reversed = [...hourly1.data].reverse();
    const hourly2Reversed = [...hourly2.data].reverse();
    
    // First pass: collect all hourly prices for rolling beta calculation
    const hourlyPrices = [];
    for (let i = 0; i < hourly1Reversed.length; i++) {
      const timestamp = hourly1Reversed[i][0];
      const candleTime = new Date(timestamp);
      if (candleTime < entryDate) continue;
      
      hourlyPrices.push({
        timestamp: timestamp,
        price1: parseFloat(hourly1Reversed[i][4]),
        price2: parseFloat(hourly2Reversed[i][4])
      });
    }
    
    const hourlyData = [];
    let previousZScore = entryZScore; // Track previous Z-score for theta calculation
    let previousTimestamp = entryDate.getTime();
    
    for (let i = 0; i < hourlyPrices.length; i++) {
      const { timestamp, price1, price2 } = hourlyPrices[i];
      const candleTime = new Date(timestamp);
      
      const ret1 = ((price1 - entryPrice1) / entryPrice1) * 100;
      const ret2 = ((price2 - entryPrice2) / entryPrice2) * 100;
      const longRet1 = ret1;
      const shortRet2 = -ret2;
      const combinedPnlHourly = (longRet1 * weight1) + (shortRet2 * weight2);
      
      // Calculate rolling beta for this point (use last 24 hours of hourly data, or all available if less)
      const rollingWindow = Math.min(24, i + 1);
      const rollingReturns = [];
      for (let j = Math.max(0, i - rollingWindow + 1); j <= i; j++) {
        if (j === 0) continue; // Need at least 2 points for returns
        const prev1 = hourlyPrices[j - 1].price1;
        const prev2 = hourlyPrices[j - 1].price2;
        const curr1 = hourlyPrices[j].price1;
        const curr2 = hourlyPrices[j].price2;
        const ret1Roll = (curr1 - prev1) / prev1;
        const ret2Roll = (curr2 - prev2) / prev2;
        rollingReturns.push({ asset1: ret1Roll, asset2: ret2Roll });
      }
      
      // Calculate rolling beta
      let rollingBeta = beta; // Default to overall beta
      if (rollingReturns.length >= 2) {
        const mean1Roll = rollingReturns.reduce((sum, r) => sum + r.asset1, 0) / rollingReturns.length;
        const mean2Roll = rollingReturns.reduce((sum, r) => sum + r.asset2, 0) / rollingReturns.length;
        let covRoll = 0;
        let var2Roll = 0;
        for (const ret of rollingReturns) {
          covRoll += (ret.asset1 - mean1Roll) * (ret.asset2 - mean2Roll);
          var2Roll += Math.pow(ret.asset2 - mean2Roll, 2);
        }
        covRoll /= rollingReturns.length;
        var2Roll /= rollingReturns.length;
        if (var2Roll > 0) {
          rollingBeta = covRoll / var2Roll;
        }
      }
      
      // Calculate optimal sizing based on rolling beta
      const optimalWeight1Roll = 1 / (1 + Math.abs(rollingBeta));
      const optimalWeight2Roll = Math.abs(rollingBeta) / (1 + Math.abs(rollingBeta));
      const combinedPnlOptimalHourly = (longRet1 * optimalWeight1Roll) + (shortRet2 * optimalWeight2Roll);
      
      const spreadHourly = Math.log(price1) - beta * Math.log(price2);
      const zScoreHourly = (spreadHourly - meanSpread) / stdDevSpread;
      
      // Calculate theta (Z-score change per hour)
      const hoursSincePrevious = (timestamp - previousTimestamp) / (1000 * 60 * 60);
      const thetaHourly = hoursSincePrevious > 0 ? (zScoreHourly - previousZScore) / hoursSincePrevious : 0;
      
      // Delta ratio (hedge ratio based on rolling beta)
      const deltaRatio = rollingBeta.toFixed(3);
      const hedgeRatio = `1:${deltaRatio}`;
      
      hourlyData.push({
        timestamp: candleTime.toISOString(),
        date: candleTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        time: candleTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        datetime: candleTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        price1: price1,
        price2: price2,
        return1: ret1,
        shortReturn2: shortRet2,
        combinedPnl: combinedPnlHourly,
        combinedPnlOptimal: combinedPnlOptimalHourly,
        zScore: zScoreHourly,
        spread: spreadHourly,
        theta: thetaHourly,
        deltaRatio: deltaRatio,
        hedgeRatio: hedgeRatio,
        rollingBeta: rollingBeta,
        optimalWeight1: optimalWeight1Roll,
        optimalWeight2: optimalWeight2Roll
      });
      
      previousZScore = zScoreHourly;
      previousTimestamp = timestamp;
    }
    
    // TP/SL - Multiple thresholds
    const tpThreshold1 = 2.0;   // 2% take profit
    const slThreshold1 = -1.0;  // 1% stop loss
    const tpThreshold2 = 10.0;  // 10% take profit (original)
    const slThreshold2 = -5.0;  // 5% stop loss (original)
    const hitTP1 = combinedPnl >= tpThreshold1;
    const hitSL1 = combinedPnl <= slThreshold1;
    const hitTP2 = combinedPnl >= tpThreshold2;
    const hitSL2 = combinedPnl <= slThreshold2;
    const zScoreExitThreshold = 0.5;
    const shouldExitByZScore = Math.abs(zScore) < zScoreExitThreshold;
    
    // Signal
    let signal = 'Neutral';
    let strength = 'None';
    if (zScore < -2) {
      signal = `Long ${symbol1}, Short ${symbol2}`;
      strength = 'Strong';
    } else if (zScore < -1) {
      signal = `Long ${symbol1}, Short ${symbol2}`;
      strength = 'Weak';
    } else if (zScore > 2) {
      signal = `Short ${symbol1}, Long ${symbol2}`;
      strength = 'Strong';
    } else if (zScore > 1) {
      signal = `Short ${symbol1}, Long ${symbol2}`;
      strength = 'Weak';
    }
    
    // Generate comprehensive report
    const simulatedNote = isSimulated ? '\n**NOTE: This is a SIMULATED/HYPOTHETICAL trade for analysis purposes**\n' : '';
    const report = `# ${symbol1}/${symbol2} PAIR TRADE - COMPREHENSIVE PERFORMANCE REPORT${isSimulated ? ' (SIMULATED)' : ''}
**Generated:** ${new Date().toISOString()}${simulatedNote}

---

## EXECUTIVE SUMMARY

### Current Status
- **Combined P&L:** ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%
- **Z-Score:** ${zScore.toFixed(2)} (${strength} ${signal})
- **Entry Z-Score:** ${entryZScore.toFixed(2)}
- **Z-Score Change:** ${(zScore - entryZScore).toFixed(2)} ${Math.abs(zScore) < Math.abs(entryZScore) ? '(moved toward mean - GOOD for mean reversion)' : '(moved away from mean - mean reversion not working)'}

### Exit Signals
- **Take Profit (2%):** ${hitTP1 ? 'HIT' : 'Not hit'} ${!hitTP1 ? `(${(tpThreshold1 - combinedPnl).toFixed(2)}% away)` : ''}
- **Stop Loss (-1%):** ${hitSL1 ? 'HIT' : 'Not hit'} ${!hitSL1 ? `(${(combinedPnl - slThreshold1).toFixed(2)}% away)` : ''}
- **Take Profit (10%):** ${hitTP2 ? 'HIT' : 'Not hit'} ${!hitTP2 ? `(${(tpThreshold2 - combinedPnl).toFixed(2)}% away)` : ''}
- **Stop Loss (-5%):** ${hitSL2 ? 'HIT' : 'Not hit'} ${!hitSL2 ? `(${(combinedPnl - slThreshold2).toFixed(2)}% away)` : ''}
- **Z-Score Exit (|Z| < 0.5):** ${shouldExitByZScore ? 'EXIT - Mean reversion complete' : 'HOLD'} ${!shouldExitByZScore ? `(${(Math.abs(zScore) - zScoreExitThreshold).toFixed(2)} away)` : ''}

---

## TRADE PERFORMANCE

### Entry Details
- **${symbol1} Entry:** $${entryPrice1.toFixed(2)} (${(weight1 * 100).toFixed(0)}% position)
- **${symbol2} Entry:** $${entryPrice2.toFixed(2)} (${(weight2 * 100).toFixed(0)}% position)
- **Entry Date:** ${entryDate.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}

### Current Prices
- **${symbol1}:** $${currentPrice1.toFixed(2)} (${return1 >= 0 ? '+' : ''}${return1.toFixed(2)}%)
- **${symbol2}:** $${currentPrice2.toFixed(2)} (${return2 >= 0 ? '+' : ''}${return2.toFixed(2)}%)

### Individual Leg Returns
- **${symbol1} (LONG):** ${longReturn1 >= 0 ? '+' : ''}${longReturn1.toFixed(2)}%
- **${symbol2} (SHORT):** ${shortReturn2 >= 0 ? '+' : ''}${shortReturn2.toFixed(2)}%

### Combined P&L
- **Current P&L:** ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%
- **Position Sizing:** ${(weight1 * 100).toFixed(0)}% ${symbol1} / ${(weight2 * 100).toFixed(0)}% ${symbol2}

---

## HOURLY PERFORMANCE (From Entry to Now)

**Note:** Showing every 3 hours to reduce table size. Full data available in source.

| Time | ${symbol1} Return | ${symbol2} Short | Actual P&L | Z-Score |
|------|------------|-----------|------------|---------|
${hourlyData.filter((d, i) => i % 3 === 0 || i === hourlyData.length - 1).reverse().map(d => `| ${d.datetime} | ${d.return1 >= 0 ? '+' : ''}${d.return1.toFixed(2)}% | ${d.shortReturn2 >= 0 ? '+' : ''}${d.shortReturn2.toFixed(2)}% | ${d.combinedPnl >= 0 ? '+' : ''}${d.combinedPnl.toFixed(2)}% | ${d.zScore.toFixed(2)} |`).join('\n')}

### Key Statistics
- **P&L Range:** ${Math.min(...hourlyData.map(d => d.combinedPnl)).toFixed(2)}% to ${Math.max(...hourlyData.map(d => d.combinedPnl)).toFixed(2)}% (Current: ${hourlyData[hourlyData.length - 1].combinedPnl.toFixed(2)}%)
- **Z-Score Range:** ${Math.min(...hourlyData.map(d => d.zScore)).toFixed(2)} to ${Math.max(...hourlyData.map(d => d.zScore)).toFixed(2)} (Current: ${hourlyData[hourlyData.length - 1].zScore.toFixed(2)})

---

## BETA-ADJUSTED OPTIMAL SIZING ANALYSIS

This table shows how the optimal position sizing changes over time based on rolling beta calculations (24-hour window). The optimal sizing is calculated for delta-neutrality.

**Interpretation:**
- **Stable sizing** = Beta is consistent, no rebalancing needed
- **Changing sizing** = Beta is drifting, may need to rebalance
- **Actual vs Optimal** = Shows if your current sizing (${(weight1 * 100).toFixed(0)}% ${symbol1} / ${(weight2 * 100).toFixed(0)}% ${symbol2}) matches the optimal

### Beta-Adjusted Optimal Sizing Over Time

| Time | Rolling Beta | Optimal ${symbol1} % | Deviation | Optimal P&L |
|------|--------------|---------------|-----------|-------------|
${hourlyData.filter((d, i) => i % 6 === 0 || i === hourlyData.length - 1).reverse().map(d => {
  const deviation = Math.abs((d.optimalWeight1 * 100) - (weight1 * 100));
  return `| ${d.datetime} | ${d.rollingBeta.toFixed(3)} | ${(d.optimalWeight1 * 100).toFixed(1)}% | ${deviation.toFixed(1)}% | ${d.combinedPnlOptimal >= 0 ? '+' : ''}${d.combinedPnlOptimal.toFixed(2)}% |`;
}).join('\n')}

### Beta Stability Summary
- **Beta Range:** ${Math.min(...hourlyData.map(d => d.rollingBeta)).toFixed(3)} to ${Math.max(...hourlyData.map(d => d.rollingBeta)).toFixed(3)} (Current: ${hourlyData[hourlyData.length - 1].rollingBeta.toFixed(3)})
- **Optimal ${symbol1} Range:** ${Math.min(...hourlyData.map(d => d.optimalWeight1 * 100)).toFixed(1)}% - ${Math.max(...hourlyData.map(d => d.optimalWeight1 * 100)).toFixed(1)}% (Current: ${(hourlyData[hourlyData.length - 1].optimalWeight1 * 100).toFixed(1)}%)
- **Your Actual:** ${(weight1 * 100).toFixed(0)}% ${symbol1} / ${(weight2 * 100).toFixed(0)}% ${symbol2}
- **Current Deviation:** ${Math.abs((hourlyData[hourlyData.length - 1].optimalWeight1 * 100) - (weight1 * 100)).toFixed(1)}% ${Math.abs((hourlyData[hourlyData.length - 1].optimalWeight1 * 100) - (weight1 * 100)) < 5 ? '(Close to optimal)' : '(Consider rebalancing)'}

---

## GREEKS ANALYSIS

### Greeks Summary
- **Delta (Beta):** ${delta.toFixed(3)} - Hedge ratio: ${(optimalWeight1 * 100).toFixed(1)}% ${symbol1} / ${(optimalWeight2 * 100).toFixed(1)}% ${symbol2}
- **Gamma:** ${gamma.toFixed(4)} - ${Math.abs(gamma) < 0.01 ? 'Beta stable' : 'Beta changing'}
- **Theta:** ${theta >= 0 ? '+' : ''}${theta.toFixed(4)} Z/day - ${theta > 0 ? 'Mean reversion working' : 'Mean reversion failing'} (${theta > 0 && Math.abs(zScore) > 0.5 ? `~${((Math.abs(zScore) - 0.5) / theta).toFixed(1)} days to exit` : 'Exit time unclear'})
- **Vega:** ${vega.toFixed(4)} - ${Math.abs(vega) < 0.1 ? 'Low volatility risk' : 'High volatility risk'} (${((recentVolatility - historicalVolatility) / historicalVolatility * 100).toFixed(1)}% volatility change)

### On Balance Volume (OBV) Analysis
${obv1 !== null && obv2 !== null ? `- **${symbol1} OBV:** ${obv1.toLocaleString('en-US', {maximumFractionDigits: 0})} ${obv1ChangePct !== null ? `(${obv1ChangePct > 0 ? '+' : ''}${obv1ChangePct.toFixed(1)}% change)` : ''} ${obv1Change > 0 ? '[Accumulating]' : '[Distributing]'}
- **${symbol2} OBV:** ${obv2.toLocaleString('en-US', {maximumFractionDigits: 0})} ${obv2ChangePct !== null ? `(${obv2ChangePct > 0 ? '+' : ''}${obv2ChangePct.toFixed(1)}% change)` : ''} ${obv2Change > 0 ? '[Accumulating]' : '[Distributing]'}
${obv1Change !== null && obv2Change !== null ? `- **OBV Signal:** ${obv1Change > 0 && obv2Change < 0 ? `BULLISH for LONG ${symbol1}/SHORT ${symbol2} (${symbol1} accumulating, ${symbol2} distributing)` : obv1Change < 0 && obv2Change > 0 ? `BEARISH for LONG ${symbol1}/SHORT ${symbol2} (${symbol1} distributing, ${symbol2} accumulating)` : 'NEUTRAL (both moving same direction)'}` : ''}` : '- **OBV:** Data unavailable'}

---

## PAIR STATISTICS

### Key Metrics
- **Z-Score:** ${zScore.toFixed(2)}
- **Signal:** ${signal}
- **Strength:** ${strength}
- **Beta (${symbol1} vs ${symbol2}):** ${beta.toFixed(3)}
- **Correlation:** ${correlation.toFixed(3)}

### Spread Analysis
- **Current Spread:** ${currentSpread.toFixed(4)} (Mean: ${meanSpread.toFixed(4)}, Std Dev: ${stdDevSpread.toFixed(4)})
- **Entry Spread:** ${entrySpread.toFixed(4)} (Z-Score: ${entryZScore.toFixed(2)})

### Position Sizing
- **Recommended:** ${(optimalWeight1 * 100).toFixed(1)}% ${symbol1} / ${(optimalWeight2 * 100).toFixed(1)}% ${symbol2}
- **Actual:** ${(weight1 * 100).toFixed(0)}% ${symbol1} / ${(weight2 * 100).toFixed(0)}% ${symbol2} (${Math.abs((weight1 - optimalWeight1) * 100).toFixed(1)}% deviation)

---

## ANALYSIS

### Performance Summary
- **Status:** ${combinedPnl > 0 ? 'SLIGHTLY PROFITABLE' : combinedPnl < 0 ? 'LOSS' : 'FLAT'} (+${combinedPnl.toFixed(2)}%)
- **Mean Reversion:** ${Math.abs(zScore) < Math.abs(entryZScore) ? 'WORKING' : 'FAILING'} (Z: ${entryZScore.toFixed(2)} → ${zScore.toFixed(2)})
- **Issue:** Both assets moved up ~${Math.abs(return1).toFixed(1)}% (bad for pair trades - need divergence)

### Rebalancing Status
${Math.abs((hourlyData[hourlyData.length - 1].optimalWeight1 * 100) - (weight1 * 100)) < 5 && Math.abs(gamma) < 0.1 ? 'No rebalancing needed - sizing close to optimal and beta stable' : 'Consider monitoring - sizing deviation or beta instability'}

### Exit Signals
- **TP (2%):** ${hitTP1 ? 'HIT' : `Not hit (${(tpThreshold1 - combinedPnl).toFixed(2)}% away)`}
- **SL (-1%):** ${hitSL1 ? 'HIT' : `Not hit (${(combinedPnl - slThreshold1).toFixed(2)}% away)`}
- **TP (10%):** ${hitTP2 ? 'HIT' : `Not hit (${(tpThreshold2 - combinedPnl).toFixed(2)}% away)`}
- **SL (-5%):** ${hitSL2 ? 'HIT' : `Not hit (${(combinedPnl - slThreshold2).toFixed(2)}% away)`}
- **Z-Score (|Z| < 0.5):** ${shouldExitByZScore ? 'HIT' : `Not hit (${(Math.abs(zScore) - zScoreExitThreshold).toFixed(2)} away)`}

---

## NOTES

- Analysis based on 30-day historical data (excluding today's incomplete candle)
- Current prices fetched from Binance API
- Entry beta approximated using current beta - exact calculation would require entry date
- Greeks adapted from options trading metrics for pair trading context
- Optimal sizing calculated for delta-neutrality based on current beta

---

*Report generated: ${new Date().toISOString()}*
`;

    const reportPath = `reports/${tradeKey}_trade_report.md`;
    fs.writeFileSync(reportPath, report);
    
    console.log(`\nCOMPREHENSIVE REPORT GENERATED`);
    console.log(`Saved to: ${reportPath}`);
    
    // Generate PDF (optional - skip if pandoc not available or file too large)
    try {
      const stats = fs.statSync(reportPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      if (fileSizeMB > 5) {
        console.log(`Skipping PDF generation - file too large (${fileSizeMB.toFixed(1)}MB)`);
      } else {
        // Check if pandoc exists
        try {
          await execAsync('which pandoc');
        } catch {
          console.log(`Skipping PDF generation - pandoc not installed`);
          console.log(`   (Install with: brew install pandoc basictex)`);
        }
        
        const pdfDir = 'pair_reports_pdf';
        if (!fs.existsSync(pdfDir)) {
          fs.mkdirSync(pdfDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const pdfFilename = `${tradeKey}_trade_performance_${timestamp}.pdf`;
        const pdfPath = path.join(pdfDir, pdfFilename);
        
        // Convert markdown to PDF using pandoc with timeout
        try {
          await Promise.race([
            execAsync(`pandoc "${reportPath}" -o "${pdfPath}" --pdf-engine=pdflatex -V geometry:margin=1in --standalone`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('PDF generation timeout (15s)')), 15000))
          ]);
          console.log(`PDF saved: ${pdfPath}`);
        } catch (pdfError) {
          if (pdfError.message.includes('timeout')) {
            console.log(`PDF generation timed out - skipping`);
          } else if (pdfError.message.includes('not found') || pdfError.message.includes('which pandoc')) {
            console.log(`PDF generation skipped - pandoc not available`);
          }
        }
      }
    } catch (pdfError) {
      // Silent fail - PDF is optional
    }
    
    console.log(`\nSUMMARY:`);
    console.log(`   P&L: ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%`);
    console.log(`   Z-Score: ${zScore.toFixed(2)} (Entry: ${entryZScore.toFixed(2)})`);
    console.log(`   Delta: ${delta.toFixed(3)}, Gamma: ${gamma.toFixed(4)}, Theta: ${theta >= 0 ? '+' : ''}${theta.toFixed(4)}, Vega: ${vega.toFixed(4)}`);
    console.log(`   Exit Signals: TP1 (2%) ${hitTP1 ? 'HIT' : 'Not hit'} | SL1 (-1%) ${hitSL1 ? 'HIT' : 'Not hit'} | TP2 (10%) ${hitTP2 ? 'HIT' : 'Not hit'} | SL2 (-5%) ${hitSL2 ? 'HIT' : 'Not hit'} | Z-Score ${shouldExitByZScore ? 'HIT' : 'Not hit'}`);
    
  } catch (error) {
    console.error(`Error processing ${tradeKey}:`, error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
    throw error;
  }
}

async function generateComprehensiveTradeReport() {
  console.log('=== COMPREHENSIVE TRADE REPORT GENERATOR ===\n');
  
  try {
    // Load trade configurations (both active and simulated)
    let activeTrades = {};
    let simulatedTrades = {};
    
    try {
      activeTrades = require('../config/active_trades.json');
    } catch (e) {
      console.log('No active_trades.json found, skipping...');
    }
    
    try {
      simulatedTrades = require('../config/simulated_trades.json');
    } catch (e) {
      console.log('No simulated_trades.json found, skipping...');
    }
    
    // Merge both (simulated trades will be marked)
    const allTrades = { ...activeTrades, ...simulatedTrades };
    
    const tradeKeys = Object.keys(allTrades);
    if (tradeKeys.length === 0) {
      throw new Error('No trades found in config/active_trades.json or config/simulated_trades.json');
    }
    
    const activeCount = Object.keys(activeTrades).length;
    const simulatedCount = Object.keys(simulatedTrades).length;
    console.log(`Found ${activeCount} active trade(s) and ${simulatedCount} simulated trade(s)\n`);
    
    // Process each trade
    for (const tradeKey of tradeKeys) {
      const trade = allTrades[tradeKey];
      const isSimulated = trade.simulated === true || simulatedTrades[tradeKey] !== undefined;
      
      if (isSimulated) {
        console.log(`[SIMULATED] Processing ${tradeKey}...`);
      }
      
      await generateTradeReport(tradeKey, trade, isSimulated);
    }
    
    console.log(`\n=== ALL REPORTS GENERATED ===`);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

generateComprehensiveTradeReport();

