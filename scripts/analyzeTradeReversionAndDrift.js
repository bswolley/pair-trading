/**
 * Combined analysis: Historical reversion + Hourly beta drift during trades
 * 
 * For each trade:
 * 1. Calculate historical reversion rate at entry threshold (using hourly candles)
 * 2. Track hourly beta drift from entry to exit
 * 3. Analyze correlations
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Hyperliquid } = require('hyperliquid');
const { analyzeHistoricalDivergences } = require('../lib/pairAnalysis');
const fs = require('fs');
const path = require('path');

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message?.includes('rate limit') || 
                         error.message?.includes('429') ||
                         error.message?.includes('too many requests') ||
                         error.message?.includes('An unknown error occurred');
      
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`  ⏳ Rate limit hit, waiting ${delay/1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Calculate beta from price arrays
 */
function calculateBeta(prices1, prices2) {
  if (prices1.length < 2 || prices2.length < 2) return null;
  
  const returns1 = [];
  const returns2 = [];
  
  for (let i = 1; i < prices1.length; i++) {
    returns1.push((prices1[i] - prices1[i-1]) / prices1[i-1]);
    returns2.push((prices2[i] - prices2[i-1]) / prices2[i-1]);
  }
  
  if (returns1.length === 0) return null;
  
  const mean1 = returns1.reduce((sum, r) => sum + r, 0) / returns1.length;
  const mean2 = returns2.reduce((sum, r) => sum + r, 0) / returns2.length;
  
  let covariance = 0;
  let variance2 = 0;
  
  for (let i = 0; i < returns1.length; i++) {
    covariance += (returns1[i] - mean1) * (returns2[i] - mean2);
    variance2 += Math.pow(returns2[i] - mean2, 2);
  }
  
  covariance /= returns1.length;
  variance2 /= returns1.length;
  
  return variance2 > 0 ? covariance / variance2 : null;
}

/**
 * Calculate Z-score from prices and beta
 */
function calculateZScore(prices1, prices2, beta) {
  if (prices1.length === 0 || prices2.length === 0 || beta === null) return null;
  
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
  const meanSpread = spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
  const variance = spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return null;
  
  const currentSpread = spreads[spreads.length - 1];
  return (currentSpread - meanSpread) / stdDev;
}

/**
 * Calculate ROI at a given hour based on prices and beta
 */
function calculateHourlyROI(entryPrice1, entryPrice2, currentPrice1, currentPrice2, beta, direction) {
  // Position weights based on beta
  const weight1 = 1 / (1 + beta);
  const weight2 = beta / (1 + beta);
  
  // Returns
  const return1 = (currentPrice1 - entryPrice1) / entryPrice1;
  const return2 = (currentPrice2 - entryPrice2) / entryPrice2;
  
  // Combined PnL: long asset1, short asset2 (or vice versa)
  if (direction === 'long') {
    // Long spread: long asset1, short asset2
    return (weight1 * return1 - weight2 * return2) * 100; // Convert to percentage
  } else {
    // Short spread: short asset1, long asset2
    return (weight2 * return2 - weight1 * return1) * 100;
  }
}

/**
 * Analyze hourly beta drift for a single trade
 */
async function analyzeTradeHourly(symbol1, symbol2, entryTime, exitTime, entryZScore, direction, sdk) {
  const endTime = exitTime.getTime();
  const startTime = entryTime.getTime() - (30 * 24 * 60 * 60 * 1000);
  
  try {
    // Fetch with retry logic
    const [hl1Data, hl2Data] = await retryWithBackoff(async () => {
      return await Promise.all([
        sdk.info.getCandleSnapshot(`${symbol1}-PERP`, '1h', startTime, endTime),
        sdk.info.getCandleSnapshot(`${symbol2}-PERP`, '1h', startTime, endTime)
      ]);
    }, 3, 2000);
    
    if (!hl1Data?.length || !hl2Data?.length) {
      return { error: 'Insufficient data' };
    }
    
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
    
    const entryTimestamp = entryTime.getTime();
    const exitTimestamp = exitTime.getTime();
    
    const allTimestamps = [...hourlyMap1.keys()]
      .filter(t => hourlyMap2.has(t))
      .filter(t => t >= startTime && t <= endTime)
      .sort((a, b) => a - b);
    
    if (allTimestamps.length < 30 * 24) {
      return { error: 'Insufficient historical data' };
    }
    
    // Find closest entry/exit
    let entryIdx = -1;
    let minEntryDiff = Infinity;
    let exitIdx = -1;
    let minExitDiff = Infinity;
    
    for (let i = 0; i < allTimestamps.length; i++) {
      const diff = Math.abs(allTimestamps[i] - entryTimestamp);
      if (diff < minEntryDiff) {
        minEntryDiff = diff;
        entryIdx = i;
      }
      
      const exitDiff = Math.abs(allTimestamps[i] - exitTimestamp);
      if (exitDiff < minExitDiff) {
        minExitDiff = exitDiff;
        exitIdx = i;
      }
    }
    
    if (entryIdx === -1 || exitIdx === -1 || exitIdx < entryIdx) {
      return { error: 'Could not find entry/exit' };
    }
    
    // Calculate hourly beta and z-score
    const hourlyData = [];
    const windowHours = 30 * 24;
    
    for (let i = entryIdx; i <= exitIdx; i++) {
      const currentTime = allTimestamps[i];
      const windowStart = Math.max(0, i - windowHours);
      const windowEnd = i + 1;
      
      const windowTimestamps = allTimestamps.slice(windowStart, windowEnd);
      const prices1_window = windowTimestamps.map(t => hourlyMap1.get(t));
      const prices2_window = windowTimestamps.map(t => hourlyMap2.get(t));
      
      if (prices1_window.length < 24) continue;
      
      const beta = calculateBeta(prices1_window, prices2_window);
      if (beta === null) continue;
      
      const zScore = calculateZScore(prices1_window, prices2_window, beta);
      const hoursSinceEntry = (currentTime - entryTimestamp) / (1000 * 60 * 60);
      
      hourlyData.push({
        timestamp: currentTime,
        hoursSinceEntry: hoursSinceEntry,
        beta: beta,
        zScore: zScore
      });
    }
    
    if (hourlyData.length === 0) {
      return { error: 'No hourly data calculated' };
    }
    
    // Get entry prices
    const entryPrice1 = hourlyMap1.get(allTimestamps[entryIdx]);
    const entryPrice2 = hourlyMap2.get(allTimestamps[entryIdx]);
    
    if (!entryPrice1 || !entryPrice2) {
      return { error: 'Could not find entry prices' };
    }
    
    const entryBeta = hourlyData[0].beta;
    const betaDrifts = [];
    const hourlyROI = [];
    
    for (const d of hourlyData) {
      const currentPrice1 = hourlyMap1.get(d.timestamp);
      const currentPrice2 = hourlyMap2.get(d.timestamp);
      
      if (!currentPrice1 || !currentPrice2) continue;
      
      // Calculate ROI at this hour
      const roi = calculateHourlyROI(
        entryPrice1,
        entryPrice2,
        currentPrice1,
        currentPrice2,
        d.beta, // Use current beta for position sizing
        direction
      );
      
      betaDrifts.push({
        hoursSinceEntry: d.hoursSinceEntry,
        beta: d.beta,
        betaDrift: d.beta - entryBeta,
        absBetaDrift: Math.abs(d.beta - entryBeta),
        zScore: d.zScore,
        price1: currentPrice1,
        price2: currentPrice2
      });
      
      hourlyROI.push({
        hoursSinceEntry: d.hoursSinceEntry,
        roi: roi,
        price1: currentPrice1,
        price2: currentPrice2
      });
    }
    
    const maxDrift = Math.max(...betaDrifts.map(d => d.absBetaDrift));
    const avgDrift = betaDrifts.reduce((sum, d) => sum + d.absBetaDrift, 0) / betaDrifts.length;
    const driftAt24h = betaDrifts.find(d => d.hoursSinceEntry >= 24 && d.hoursSinceEntry < 25);
    
    // Track Z-score reversion during trade
    const zScoreReversion = [];
    const entryAbsZ = Math.abs(entryZScore);
    const targetZ = 0.5; // Fixed reversion target
    
    for (const d of betaDrifts) {
      if (d.zScore === null) continue;
      const absZ = Math.abs(d.zScore);
      const reverted = absZ < targetZ;
      const percentReverted = entryAbsZ > 0 ? (1 - (absZ / entryAbsZ)) * 100 : 0;
      
      zScoreReversion.push({
        hoursSinceEntry: d.hoursSinceEntry,
        zScore: d.zScore,
        absZScore: absZ,
        reverted: reverted,
        percentReverted: percentReverted
      });
    }
    
    const revertedAtExit = zScoreReversion.length > 0 ? zScoreReversion[zScoreReversion.length - 1].reverted : false;
    const maxReversion = Math.max(...zScoreReversion.map(r => r.percentReverted));
    
    // Calculate ROI metrics
    const maxROI = hourlyROI.length > 0 ? Math.max(...hourlyROI.map(r => r.roi)) : null;
    const minROI = hourlyROI.length > 0 ? Math.min(...hourlyROI.map(r => r.roi)) : null;
    const roiAt24h = hourlyROI.find(r => r.hoursSinceEntry >= 24 && r.hoursSinceEntry < 25);
    const roiAt48h = hourlyROI.find(r => r.hoursSinceEntry >= 48 && r.hoursSinceEntry < 49);
    const finalROI = hourlyROI.length > 0 ? hourlyROI[hourlyROI.length - 1].roi : null;
    
    return {
      entryBeta,
      exitBeta: betaDrifts[betaDrifts.length - 1].beta,
      totalBetaDrift: betaDrifts[betaDrifts.length - 1].betaDrift,
      maxBetaDrift: maxDrift,
      avgBetaDrift: avgDrift,
      driftAt24h: driftAt24h?.absBetaDrift || null,
      revertedAtExit,
      maxReversion,
      maxROI,
      minROI,
      roiAt24h: roiAt24h?.roi || null,
      roiAt48h: roiAt48h?.roi || null,
      finalROI,
      hourlyBetaDrift: betaDrifts,
      hourlyZScoreReversion: zScoreReversion,
      hourlyROI: hourlyROI
    };
    
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Main analysis
 */
async function analyzeTrades(options = {}) {
  const { limit = null, startDate = null, endDate = null, saveIncrementally = true } = options;
  
  console.log('Fetching trades from Supabase...\n');
  
  let query = supabase
    .from('trade_history')
    .select('*')
    .not('exit_time', 'is', null)
    .order('entry_time', { ascending: false });
  
  if (startDate) query = query.gte('entry_time', startDate);
  if (endDate) query = query.lte('entry_time', endDate);
  // Don't limit by default - get all trades
  
  const { data: trades, error } = await query;
  
  if (error) throw new Error(`Supabase error: ${error.message}`);
  if (!trades || trades.length === 0) {
    console.log('No trades found');
    return;
  }
  
  // Apply limit only if explicitly provided
  const tradesToAnalyze = limit ? trades.slice(0, limit) : trades;
  
  console.log(`Found ${trades.length} total trades, analyzing ${tradesToAnalyze.length}\n`);
  
  // Setup output file for incremental saving
  const outputDir = 'backtest_reports';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Find most recent results file to resume from
  let resultsFile = null;
  let results = [];
  
  if (saveIncrementally) {
    const existingFiles = fs.readdirSync(outputDir)
      .filter(f => f.startsWith('trade_reversion_drift_') && f.endsWith('_results.json'))
      .map(f => ({
        name: f,
        path: path.join(outputDir, f),
        mtime: fs.statSync(path.join(outputDir, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    if (existingFiles.length > 0) {
      resultsFile = existingFiles[0].path;
      try {
        results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        console.log(`Resuming: Found ${results.length} existing results in ${existingFiles[0].name}\n`);
      } catch (e) {
        console.log('Could not load existing results, starting fresh\n');
        resultsFile = null;
      }
    }
  }
  
  // Create new file if no existing file found
  if (!resultsFile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    resultsFile = path.join(outputDir, `trade_reversion_drift_${timestamp}_results.json`);
  }
  
  const reportFile = resultsFile.replace('_results.json', '.md');
  
  // Find which trades we've already processed
  const processedPairs = new Set();
  results.forEach(r => {
    const key = `${r.pair}_${r.entryTime}`;
    processedPairs.add(key);
  });
  
  const sdk = new Hyperliquid();
  await sdk.connect();
  console.log('Connected to Hyperliquid\n');
  
  let processed = 0;
  let skipped = 0;
  
  for (let i = 0; i < tradesToAnalyze.length; i++) {
    const trade = trades[i];
    const symbol1 = trade.asset1;
    const symbol2 = trade.asset2;
    const entryTime = new Date(trade.entry_time);
    const exitTime = new Date(trade.exit_time);
    const entryZScore = trade.entry_z_score;
    const exitZScore = trade.exit_z_score;
    const direction = trade.direction || 'long';
    const actualROI = trade.total_pnl;
    
    // Check if already processed
    const tradeKey = `${symbol1}/${symbol2}_${entryTime.toISOString()}`;
    if (processedPairs.has(tradeKey)) {
      skipped++;
      continue;
    }
    
    console.log(`[${i + 1}/${tradesToAnalyze.length}] Analyzing ${symbol1}/${symbol2}...`);
    console.log(`  Entry: ${entryTime.toISOString()}, Exit: ${exitTime.toISOString()}`);
    
    // 1. Get historical reversion at entry threshold (using HOURLY candles BEFORE entry)
    console.log(`  📊 Calculating historical reversion (hourly candles, 60 days before entry)...`);
    let historicalReversion = null;
    try {
      const divergence = await retryWithBackoff(async () => {
        return await analyzeHistoricalDivergences(
          symbol1,
          symbol2,
          sdk,
          null,
          entryZScore,
          entryTime.getTime() // cutoffTime = entry time (only use data BEFORE trade)
        );
      }, 3, 3000); // 3 retries, 3s base delay
      
      if (divergence && divergence.profile) {
        // Find threshold bucket
        const absEntryZ = Math.abs(entryZScore);
        let threshold = 1.0;
        if (absEntryZ >= 3.0) threshold = 3.0;
        else if (absEntryZ >= 2.5) threshold = 2.5;
        else if (absEntryZ >= 2.0) threshold = 2.0;
        else if (absEntryZ >= 1.5) threshold = 1.5;
        else threshold = 1.0;
        
        const fixedReversion = divergence.profile[threshold.toString()];
        const percentReversion = divergence.profilePercent[threshold.toString()];
        
        historicalReversion = {
          threshold,
          fixedReversionRate: fixedReversion ? parseFloat(fixedReversion.rate) : null,
          percentReversionRate: percentReversion ? parseFloat(percentReversion.rate) : null
        };
      }
    } catch (error) {
      const isRateLimit = error.message?.includes('rate limit') || 
                         error.message?.includes('429') ||
                         error.message?.includes('too many requests') ||
                         error.message?.includes('An unknown error occurred');
      if (isRateLimit) {
        console.log(`  ⚠️  Historical reversion rate limited, skipping...`);
      } else {
        console.log(`  ⚠️  Historical reversion error: ${error.message}`);
      }
    }
    
    // 2. Get hourly beta drift (during trade, at each hour)
    console.log(`  📈 Calculating hourly beta drift during trade (hourly candles from entry to exit)...`);
    let hourlyAnalysis;
    try {
      hourlyAnalysis = await retryWithBackoff(async () => {
        return await analyzeTradeHourly(
          symbol1,
          symbol2,
          entryTime,
          exitTime,
          entryZScore,
          direction, // Pass direction for ROI calculation
          sdk
        );
      }, 3, 3000);
      
      if (hourlyAnalysis.error) {
        console.log(`  ⚠️  Hourly analysis error: ${hourlyAnalysis.error}`);
        continue;
      }
    } catch (error) {
      const isRateLimit = error.message?.includes('rate limit') || 
                         error.message?.includes('429') ||
                         error.message?.includes('too many requests') ||
                         error.message?.includes('An unknown error occurred');
      if (isRateLimit) {
        console.log(`  ⚠️  Hourly analysis rate limited, skipping trade...`);
        await sleep(5000); // Wait longer before next trade
      } else {
        console.log(`  ⚠️  Hourly analysis error: ${error.message}`);
      }
      continue;
    }
    
    const result = {
      pair: `${symbol1}/${symbol2}`,
      entryTime: entryTime.toISOString(),
      exitTime: exitTime.toISOString(),
      durationHours: (exitTime.getTime() - entryTime.getTime()) / (1000 * 60 * 60),
      entryZScore,
      exitZScore,
      direction,
      actualROI,
      won: actualROI > 0,
      historicalReversion,
      hourlyBetaDrift: hourlyAnalysis
    };
    
    results.push(result);
    processed++;
    
    const histRev = (historicalReversion && historicalReversion.fixedReversionRate !== null)
      ? `${historicalReversion.fixedReversionRate.toFixed(1)}%` 
      : 'N/A';
    const hourlyPoints = hourlyAnalysis.hourlyBetaDrift?.length || 0;
    console.log(`  ✓ ROI: ${actualROI.toFixed(2)}%, Hist Rev: ${histRev}, Max drift: ${hourlyAnalysis.maxBetaDrift.toFixed(4)}, Reverted: ${hourlyAnalysis.revertedAtExit ? 'Yes' : 'No'}, Hourly points: ${hourlyPoints}`);
    
    // Save incrementally every 5 trades
    if (saveIncrementally && processed % 5 === 0) {
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      console.log(`  💾 Saved progress: ${processed} trades processed`);
    }
    
    // Rate limiting: wait between trades to avoid hitting limits
    await sleep(1000); // 1 second between trades
  }
  
  await sdk.disconnect();
  
  // Final save
  if (saveIncrementally) {
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Final save: ${results.length} trades saved to ${resultsFile}`);
  }
  
  // Generate report
  const report = generateReport(results);
  fs.writeFileSync(reportFile, report);
  console.log(`📊 Report saved: ${reportFile}`);
  
  if (skipped > 0) {
    console.log(`\n⏭️  Skipped ${skipped} already processed trades`);
  }
  
  return results;
}

/**
 * Generate report
 */
function generateReport(results) {
  if (results.length === 0) {
    return '# Trade Reversion & Beta Drift Analysis\n\nNo results.';
  }
  
  let report = `# Trade Reversion & Beta Drift Analysis\n\n`;
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `Total Trades: ${results.length}\n\n`;
  
  // Summary
  const winners = results.filter(r => r.won);
  const losers = results.filter(r => !r.won);
  
  report += `## Summary\n\n`;
  report += `| Metric | All | Winners | Losers |\n`;
  report += `|--------|-----|---------|--------|\n`;
  report += `| Count | ${results.length} | ${winners.length} | ${losers.length} |\n`;
  report += `| Avg ROI | ${(results.reduce((sum, r) => sum + r.actualROI, 0) / results.length).toFixed(2)}% | ${(winners.reduce((sum, r) => sum + r.actualROI, 0) / winners.length).toFixed(2)}% | ${(losers.reduce((sum, r) => sum + r.actualROI, 0) / losers.length).toFixed(2)}% |\n`;
  
  const avgMaxDrift = results.reduce((sum, r) => sum + (r.hourlyBetaDrift?.maxBetaDrift || 0), 0) / results.length;
  const winnersAvgDrift = winners.reduce((sum, r) => sum + (r.hourlyBetaDrift?.maxBetaDrift || 0), 0) / winners.length;
  const losersAvgDrift = losers.reduce((sum, r) => sum + (r.hourlyBetaDrift?.maxBetaDrift || 0), 0) / losers.length;
  
  report += `| Avg Max Beta Drift | ${avgMaxDrift.toFixed(4)} | ${winnersAvgDrift.toFixed(4)} | ${losersAvgDrift.toFixed(4)} |\n`;
  
  const revertedCount = results.filter(r => r.hourlyBetaDrift?.revertedAtExit).length;
  report += `| Reverted at Exit | ${revertedCount} (${(revertedCount / results.length * 100).toFixed(1)}%) | | |\n\n`;
  
  // Historical reversion vs actual
  const withHistorical = results.filter(r => r.historicalReversion?.fixedReversionRate !== null);
  if (withHistorical.length > 0) {
    report += `## Historical Reversion vs Actual Performance\n\n`;
    report += `| Historical Reversion | Trades | Win Rate | Avg ROI | Avg Max Drift |\n`;
    report += `|---------------------|--------|----------|---------|---------------|\n`;
    
    const ranges = [
      { label: '0-40%', min: 0, max: 40 },
      { label: '40-60%', min: 40, max: 60 },
      { label: '60-80%', min: 60, max: 80 },
      { label: '80-100%', min: 80, max: 101 }
    ];
    
    for (const range of ranges) {
      const filtered = withHistorical.filter(r => {
        const rate = r.historicalReversion.fixedReversionRate;
        return rate >= range.min && rate < range.max;
      });
      if (filtered.length === 0) continue;
      
      const wins = filtered.filter(r => r.won).length;
      const avgROI = filtered.reduce((sum, r) => sum + r.actualROI, 0) / filtered.length;
      const avgDrift = filtered.reduce((sum, r) => sum + (r.hourlyBetaDrift?.maxBetaDrift || 0), 0) / filtered.length;
      
      report += `| ${range.label} | ${filtered.length} | ${(wins / filtered.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% | ${avgDrift.toFixed(4)} |\n`;
    }
  }
  
  // Beta drift vs performance
  report += `\n## Beta Drift vs Performance\n\n`;
  report += `| Max Drift | Trades | Win Rate | Avg ROI | Avg Historical Reversion |\n`;
  report += `|-----------|--------|----------|---------|------------------------|\n`;
  
  const driftRanges = [
    { label: '<0.01', min: 0, max: 0.01 },
    { label: '0.01-0.05', min: 0.01, max: 0.05 },
    { label: '0.05-0.10', min: 0.05, max: 0.10 },
    { label: '0.10+', min: 0.10, max: Infinity }
  ];
  
  for (const range of driftRanges) {
    const filtered = results.filter(r => {
      const drift = r.hourlyBetaDrift?.maxBetaDrift || 0;
      return drift >= range.min && drift < range.max;
    });
    if (filtered.length === 0) continue;
    
    const wins = filtered.filter(r => r.won).length;
    const avgROI = filtered.reduce((sum, r) => sum + r.actualROI, 0) / filtered.length;
    const withHist = filtered.filter(r => r.historicalReversion?.fixedReversionRate !== null);
    const avgHist = withHist.length > 0
      ? withHist.reduce((sum, r) => sum + r.historicalReversion.fixedReversionRate, 0) / withHist.length
      : null;
    
    report += `| ${range.label} | ${filtered.length} | ${(wins / filtered.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% | ${avgHist !== null ? avgHist.toFixed(1) + '%' : 'N/A'} |\n`;
  }
  
  // Individual trades
  report += `\n## Individual Trades\n\n`;
  report += `| Pair | Entry Z | Exit Z | ROI | Won | Hist Rev | Max Drift | Reverted |\n`;
  report += `|------|---------|--------|-----|-----|---------|-----------|----------|\n`;
  
  for (const r of results.slice(0, 20)) {
    const histRev = r.historicalReversion?.fixedReversionRate !== null
      ? r.historicalReversion.fixedReversionRate.toFixed(1) + '%'
      : 'N/A';
    const maxDrift = r.hourlyBetaDrift?.maxBetaDrift.toFixed(4) || 'N/A';
    const reverted = r.hourlyBetaDrift?.revertedAtExit ? 'Yes' : 'No';
    
    report += `| ${r.pair} | ${r.entryZScore?.toFixed(2) || 'N/A'} | ${r.exitZScore?.toFixed(2) || 'N/A'} | ${r.actualROI.toFixed(2)}% | ${r.won ? 'Yes' : 'No'} | ${histRev} | ${maxDrift} | ${reverted} |\n`;
  }
  
  return report;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const limit = args[0] ? parseInt(args[0]) : null;
  const startDate = args[1] || null;
  const endDate = args[2] || null;
  
  analyzeTrades({ limit, startDate, endDate })
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { analyzeTrades };

