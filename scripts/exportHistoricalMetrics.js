/**
 * Export Historical Metrics for Pair Trading Analysis
 * 
 * Exports time series data for modeling APR/ROI predictions
 * - Z-score (30-day rolling)
 * - Beta (calculated every 4 hours)
 * - Correlation (30-day rolling)
 * - Rate of change metrics
 * - Spread and price data
 */

const { Hyperliquid } = require('hyperliquid');
const fs = require('fs');
const path = require('path');

async function exportHistoricalMetrics(symbol1, symbol2, days = 30, intervalHours = 4) {
  console.log(`\nExporting historical metrics for ${symbol1}/${symbol2}...`);
  console.log(`Period: ${days} days, Interval: ${intervalHours} hours\n`);
  
  let sdk;
  try {
    // Suppress WebSocket noise
    const originalLog = console.log;
    const originalError = console.error;
    const noop = () => {};
    console.log = noop;
    console.error = noop;
    
    sdk = new Hyperliquid();
    await sdk.connect();
    
    console.log = originalLog;
    console.error = originalError;
  } catch (error) {
    throw new Error(`Hyperliquid connection failed: ${error.message}`);
  }
  
  try {
    // Fetch enough data for 30-day rolling windows + historical period
    const endTime = Date.now();
    const startTime = endTime - ((days + 35) * 24 * 60 * 60 * 1000); // Extra buffer for rolling windows
    
    // Fetch hourly data for flexibility
    const [hl1Data, hl2Data] = await Promise.all([
      sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1h', startTime, endTime),
      sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1h', startTime, endTime)
    ]);
    
    if (!hl1Data?.length || !hl2Data?.length) {
      throw new Error('Insufficient Hyperliquid data');
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
    
    // Get common timestamps and sort
    const commonTimestamps = [...hourlyMap1.keys()]
      .filter(t => hourlyMap2.has(t))
      .sort((a, b) => a - b);
    
    if (commonTimestamps.length < 30 * 24) {
      throw new Error(`Insufficient data: ${commonTimestamps.length} hours (need at least ${30 * 24})`);
    }
    
    // Sample at interval (every 4 hours by default)
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const cutoffTime = endTime - (days * 24 * 60 * 60 * 1000);
    
    // Sample timestamps at the specified interval, starting from the most recent
    const sampledTimestamps = [];
    let lastSampledTime = null;
    
    // Go backwards from most recent, sampling every intervalHours
    for (let i = commonTimestamps.length - 1; i >= 0; i--) {
      const ts = commonTimestamps[i];
      
      // Only include timestamps within the date range
      if (ts < cutoffTime) continue;
      
      // If this is the first one, or enough time has passed since last sample
      if (lastSampledTime === null || (lastSampledTime - ts) >= intervalMs) {
        sampledTimestamps.unshift(ts);
        lastSampledTime = ts;
      }
    }
    
    const filteredTimestamps = sampledTimestamps;
    
    console.log(`Processing ${filteredTimestamps.length} data points...`);
    
    const results = [];
    const windowHours = 30 * 24; // 30-day window in hours
    
    for (let i = 0; i < filteredTimestamps.length; i++) {
      const currentTs = filteredTimestamps[i];
      const windowStart = currentTs - (windowHours * 60 * 60 * 1000);
      
      // Get all data points in the 30-day window
      const windowData = commonTimestamps.filter(ts => ts >= windowStart && ts <= currentTs);
      
      if (windowData.length < 24) { // Need at least 1 day of data
        continue;
      }
      
      const prices1_window = windowData.map(ts => hourlyMap1.get(ts));
      const prices2_window = windowData.map(ts => hourlyMap2.get(ts));
      const currentPrice1 = hourlyMap1.get(currentTs);
      const currentPrice2 = hourlyMap2.get(currentTs);
      
      // Calculate returns
      const returns = [];
      for (let j = 1; j < prices1_window.length; j++) {
        returns.push({
          asset1: (prices1_window[j] - prices1_window[j-1]) / prices1_window[j-1],
          asset2: (prices2_window[j] - prices2_window[j-1]) / prices2_window[j-1]
        });
      }
      
      if (returns.length < 7) continue; // Need at least 7 days for beta
      
      // Calculate 7-day beta (for position sizing / hedge ratio tracking)
      const returns7d = returns.slice(-168); // Last 7 days (7*24 hours)
      let beta7d = null;
      if (returns7d.length >= 24) { // Need at least 1 day
        const mean1_7d = returns7d.reduce((sum, r) => sum + r.asset1, 0) / returns7d.length;
        const mean2_7d = returns7d.reduce((sum, r) => sum + r.asset2, 0) / returns7d.length;
        
        let covariance = 0, variance2 = 0;
        for (const ret of returns7d) {
          covariance += (ret.asset1 - mean1_7d) * (ret.asset2 - mean2_7d);
          variance2 += Math.pow(ret.asset2 - mean2_7d, 2);
        }
        covariance /= returns7d.length;
        variance2 /= returns7d.length;
        beta7d = variance2 > 0 ? covariance / variance2 : null;
      }
      
      // Calculate 30-day beta (for z-score calculation - consistent period)
      const returns30d = returns.slice(-(30 * 24)); // Last 30 days
      let beta30d = null;
      if (returns30d.length >= 24) {
        const mean1_30d = returns30d.reduce((sum, r) => sum + r.asset1, 0) / returns30d.length;
        const mean2_30d = returns30d.reduce((sum, r) => sum + r.asset2, 0) / returns30d.length;
        
        let covariance30d = 0, variance2_30d = 0;
        for (const ret of returns30d) {
          covariance30d += (ret.asset1 - mean1_30d) * (ret.asset2 - mean2_30d);
          variance2_30d += Math.pow(ret.asset2 - mean2_30d, 2);
        }
        covariance30d /= returns30d.length;
        variance2_30d /= returns30d.length;
        beta30d = variance2_30d > 0 ? covariance30d / variance2_30d : null;
      }
      
      // Calculate correlation (30-day window)
      const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
      const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;
      
      let cov = 0, var1 = 0, var2 = 0;
      for (const ret of returns) {
        const dev1 = ret.asset1 - mean1;
        const dev2 = ret.asset2 - mean2;
        cov += dev1 * dev2;
        var1 += dev1 * dev1;
        var2 += dev2 * dev2;
      }
      cov /= returns.length;
      var1 /= returns.length;
      var2 /= returns.length;
      const correlation = (Math.sqrt(var1) * Math.sqrt(var2)) > 0 
        ? cov / (Math.sqrt(var1) * Math.sqrt(var2))
        : null;
      
      // Calculate z-score (30-day rolling window using 30-day beta for consistency)
      // Use 30-day beta for spread calculation to match the 30-day z-score window
      const betaForZScore = beta30d || beta7d; // Fallback to 7d if 30d not available
      if (betaForZScore === null) continue;
      
      const spreads = prices1_window.map((p1, j) => Math.log(p1) - betaForZScore * Math.log(prices2_window[j]));
      const recentSpreads = spreads.slice(-(30 * 24)); // Last 30 days
      const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
      const stdDevSpread = Math.sqrt(
        recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length
      );
      const currentSpread = Math.log(currentPrice1) - betaForZScore * Math.log(currentPrice2);
      const zScore = stdDevSpread > 0 ? (currentSpread - meanSpread) / stdDevSpread : null;
      
      // Calculate spread value
      const spread = currentSpread;
      
      // Calculate rate of change metrics (if we have previous data point)
      let zScoreROC = null;
      let betaROC = null;
      let correlationROC = null;
      
      if (i > 0 && results.length > 0) {
        const prev = results[results.length - 1];
        const timeDiff = (currentTs - prev.timestamp) / (24 * 60 * 60 * 1000); // days
        
        if (prev.zScore !== null && zScore !== null && timeDiff > 0) {
          zScoreROC = (zScore - prev.zScore) / timeDiff; // z-score change per day
        }
        
        if (prev.beta7d !== null && beta7d !== null && timeDiff > 0) {
          betaROC = (beta7d - prev.beta7d) / timeDiff; // 7d beta change per day
        }
        
        if (prev.correlation !== null && correlation !== null && timeDiff > 0) {
          correlationROC = (correlation - prev.correlation) / timeDiff; // correlation change per day
        }
      }
      
      // Round values for readability
      const round = (val, decimals) => val !== null ? Number(val.toFixed(decimals)) : null;
      
      results.push({
        timestamp: currentTs,
        date: new Date(currentTs).toISOString(),
        price1: round(currentPrice1, 2),
        price2: round(currentPrice2, 2),
        spread: round(currentSpread, 4),
        zScore: round(zScore, 2),
        beta7d: round(beta7d, 4), // 7-day beta (for position sizing)
        beta30d: round(beta30d, 4), // 30-day beta (for z-score calculation)
        correlation: round(correlation, 4),
        zScoreROC: round(zScoreROC, 4), // Rate of change (per day)
        betaROC: round(betaROC, 5), // Rate of change (per day) - tracks 7d beta
        correlationROC: round(correlationROC, 5), // Rate of change (per day)
        spreadMean: round(meanSpread, 4),
        spreadStdDev: round(stdDevSpread, 4)
      });
      
      if ((i + 1) % 50 === 0) {
        process.stdout.write(`\rProcessed ${i + 1}/${filteredTimestamps.length}...`);
      }
    }
    
    console.log(`\n\nExported ${results.length} data points`);
    
    // Export to CSV - format all values consistently to prevent Numbers parsing issues
    const formatCSVValue = (val, decimals = null) => {
      if (val === null || val === undefined) return '';
      if (typeof val === 'number') {
        if (decimals !== null) {
          return val.toFixed(decimals);
        }
        // For integers (timestamps), return as-is
        if (Number.isInteger(val)) {
          return val.toString();
        }
        // For decimals, ensure proper formatting
        return val.toString();
      }
      // For strings (dates), wrap in quotes if they contain commas
      if (typeof val === 'string' && val.includes(',')) {
        return `"${val}"`;
      }
      return val;
    };
    
    const csvHeader = 'timestamp,date,price1,price2,spread,zScore,beta7d,beta30d,correlation,zScoreROC,betaROC,correlationROC,spreadMean,spreadStdDev\n';
    const csvRows = results.map(r => 
      `${r.timestamp},${r.date},${formatCSVValue(r.price1, 2)},${formatCSVValue(r.price2, 2)},${formatCSVValue(r.spread, 4)},${formatCSVValue(r.zScore, 2)},${formatCSVValue(r.beta7d, 4)},${formatCSVValue(r.beta30d, 4)},${formatCSVValue(r.correlation, 4)},${formatCSVValue(r.zScoreROC, 4)},${formatCSVValue(r.betaROC, 5)},${formatCSVValue(r.correlationROC, 5)},${formatCSVValue(r.spreadMean, 4)},${formatCSVValue(r.spreadStdDev, 4)}`
    ).join('\n');
    
    const csvContent = csvHeader + csvRows;
    
    // Export to JSON
    const jsonContent = JSON.stringify(results, null, 2);
    
    // Save files
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const csvPath = path.join(__dirname, '..', 'historical_data', `${symbol1}_${symbol2}_${days}d_${intervalHours}h_${timestamp}.csv`);
    const jsonPath = path.join(__dirname, '..', 'historical_data', `${symbol1}_${symbol2}_${days}d_${intervalHours}h_${timestamp}.json`);
    
    // Create directory if it doesn't exist
    const dir = path.dirname(csvPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(csvPath, csvContent);
    fs.writeFileSync(jsonPath, jsonContent);
    
    console.log(`\nFiles saved:`);
    console.log(`  CSV: ${csvPath}`);
    console.log(`  JSON: ${jsonPath}`);
    
    // Print summary stats
    const validZ = results.filter(r => r.zScore !== null).map(r => r.zScore);
    const validBeta7d = results.filter(r => r.beta7d !== null).map(r => r.beta7d);
    const validBeta30d = results.filter(r => r.beta30d !== null).map(r => r.beta30d);
    const validCorr = results.filter(r => r.correlation !== null).map(r => r.correlation);
    
    console.log(`\nSummary Statistics:`);
    console.log(`  Z-Score: min=${Math.min(...validZ).toFixed(2)}, max=${Math.max(...validZ).toFixed(2)}, mean=${(validZ.reduce((a,b) => a+b, 0) / validZ.length).toFixed(2)}`);
    console.log(`  Beta (7d): min=${Math.min(...validBeta7d).toFixed(3)}, max=${Math.max(...validBeta7d).toFixed(3)}, mean=${(validBeta7d.reduce((a,b) => a+b, 0) / validBeta7d.length).toFixed(3)}`);
    console.log(`  Beta (30d): min=${Math.min(...validBeta30d).toFixed(3)}, max=${Math.max(...validBeta30d).toFixed(3)}, mean=${(validBeta30d.reduce((a,b) => a+b, 0) / validBeta30d.length).toFixed(3)}`);
    console.log(`  Correlation: min=${Math.min(...validCorr).toFixed(3)}, max=${Math.max(...validCorr).toFixed(3)}, mean=${(validCorr.reduce((a,b) => a+b, 0) / validCorr.length).toFixed(3)}`);
    
    return { csvPath, jsonPath, results };
    
  } catch (error) {
    throw error;
  } finally {
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
      } catch (e) {
        // Ignore
      }
    }
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const symbol1 = args[0] || 'ETH';
  const symbol2 = args[1] || 'SOL';
  const days = parseInt(args[2]) || 30;
  const intervalHours = parseInt(args[3]) || 4;
  
  exportHistoricalMetrics(symbol1, symbol2, days, intervalHours)
    .then(() => {
      console.log('\n✅ Export complete!');
      process.exit(0);
    })
    .catch(error => {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { exportHistoricalMetrics };

