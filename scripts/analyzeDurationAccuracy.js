/**
 * Analyze backtest results by trade duration
 * Compares prediction accuracy (using actual exit z-score) vs trade duration
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { analyzePair } = require('../lib/pairAnalysis');
const { Hyperliquid } = require('hyperliquid');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function getPriceAtTime(symbol, timestamp, sdk) {
  try {
    const startTime = timestamp - (60 * 60 * 1000);
    const endTime = timestamp + (60 * 60 * 1000);
    const candles = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1h', startTime, endTime);
    if (!candles || candles.length === 0) return null;
    
    let closest = candles[0];
    let minDiff = Math.abs((typeof closest.t === 'number' ? closest.t : new Date(closest.t).getTime()) - timestamp);
    for (const candle of candles) {
      const candleTime = typeof candle.t === 'number' ? candle.t : new Date(candle.t).getTime();
      const diff = Math.abs(candleTime - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = candle;
      }
    }
    return parseFloat(closest.c);
  } catch (error) {
    return null;
  }
}

async function calculatePredictedROIAtExit(symbol1, symbol2, entryTime, exitTime, entryZScore, exitZScore) {
  try {
    // Get beta and stdDev at entry time
    const entryConfig = {
      symbol1,
      symbol2,
      direction: 'long',
      timeframes: [30],
      cutoffTime: entryTime.getTime()
    };
    
    const entryResult = await analyzePair(entryConfig);
    const tf30d = entryResult.timeframes?.[30];
    const stdDevSpread = tf30d?.stdDevSpread;
    const betaAtEntry = tf30d?.beta ?? null;
    
    if (!stdDevSpread || entryZScore === null || exitZScore === null) {
      return null;
    }
    
    // Get beta at exit time
    let betaAtExit = null;
    if (exitTime) {
      try {
        const exitConfig = {
          symbol1,
          symbol2,
          direction: 'long',
          timeframes: [30],
          cutoffTime: exitTime.getTime()
        };
        const exitResult = await analyzePair(exitConfig);
        betaAtExit = exitResult.timeframes?.[30]?.beta ?? null;
      } catch (error) {
        // Ignore errors - beta at exit is optional
      }
    }
    
    const entryZ = Math.abs(entryZScore);
    const exitZ = Math.abs(exitZScore);
    
    // Prediction to actual exit z (perfect knowledge - what we currently use)
    const zChangeActual = entryZ - exitZ;
    const spreadChangeActual = zChangeActual * stdDevSpread;
    const predictedROIAtActualExit = (Math.exp(spreadChangeActual) - 1) * 100;
    
    // Prediction to 0.5z (what we show at entry time)
    const fixedExitZ = 0.5;
    let predictedROITo05z = null;
    if (entryZ > fixedExitZ) {
      const zChange05 = entryZ - fixedExitZ;
      const spreadChange05 = zChange05 * stdDevSpread;
      predictedROITo05z = (Math.exp(spreadChange05) - 1) * 100;
    }
    
    // Prediction to 50% of entry z (what we also show at entry time)
    const percentExitZ = entryZ * 0.5;
    const zChangePercent = entryZ - percentExitZ;
    const spreadChangePercent = zChangePercent * stdDevSpread;
    const predictedROITo50Percent = (Math.exp(spreadChangePercent) - 1) * 100;
    
    return { 
      predictedROIAtActualExit,
      predictedROITo05z,
      predictedROITo50Percent,
      stdDevSpread, 
      entryZ, 
      exitZ,
      betaAtEntry,
      betaAtExit
    };
  } catch (error) {
    return null;
  }
}

async function analyzeTradesByDuration(options = {}) {
  const { limit = 100 } = options;
  
  console.log('Querying Supabase for closed trades...');
  
  const { data: trades, error } = await supabase
    .from('trade_history')
    .select('*')
    .not('exit_time', 'is', null)
    .not('total_pnl', 'is', null)
    .order('entry_time', { ascending: false })
    .limit(limit);
  
  if (error) {
    console.error('Supabase query error:', error);
    throw error;
  }
  
  if (!trades || trades.length === 0) {
    console.log('No closed trades found');
    return [];
  }
  
  console.log(`Found ${trades.length} closed trades. Analyzing by duration...\n`);
  
  const results = [];
  const originalLog = console.log;
  const originalError = console.error;
  const noop = () => {};
  
  // Suppress WebSocket noise
  console.log = noop;
  console.error = noop;
  const sdk = new Hyperliquid();
  await sdk.connect();
  console.log = originalLog;
  console.error = originalError;
  
  let tradeIndex = 0;
  for (const trade of trades) {
    tradeIndex++;
    const entryTime = new Date(trade.entry_time);
    const exitTime = new Date(trade.exit_time);
    const duration = trade.days_in_trade || ((exitTime - entryTime) / (1000 * 60 * 60 * 24));
    const actualROI = trade.total_pnl;
    const entryZScore = trade.entry_z_score;
    const exitZScore = trade.exit_z_score;
    
    if (exitZScore === null || exitZScore === undefined) {
      continue;
    }
    
    console.log(`[${tradeIndex}/${trades.length}] Analyzing ${trade.asset1}/${trade.asset2} (${duration.toFixed(2)} days)...`);
    
    const prediction = await calculatePredictedROIAtExit(
      trade.asset1,
      trade.asset2,
      entryTime,
      exitTime,
      entryZScore,
      exitZScore
    );
    
    if (!prediction) {
      continue;
    }
    
    // Calculate errors for all three predictions
    // 1. Prediction to actual exit z (perfect knowledge)
    const errorAtActualExit = actualROI - prediction.predictedROIAtActualExit;
    const absErrorAtActualExit = Math.abs(errorAtActualExit);
    
    // 2. Prediction to 0.5z (entry-time prediction)
    let errorTo05z = null;
    let absErrorTo05z = null;
    if (prediction.predictedROITo05z !== null) {
      errorTo05z = actualROI - prediction.predictedROITo05z;
      absErrorTo05z = Math.abs(errorTo05z);
    }
    
    // 3. Prediction to 50% of entry z (entry-time prediction)
    const errorTo50Percent = actualROI - prediction.predictedROITo50Percent;
    const absErrorTo50Percent = Math.abs(errorTo50Percent);
    
    results.push({
      pair: `${trade.asset1}/${trade.asset2}`,
      duration,
      actualROI,
      predictedROIAtActualExit: prediction.predictedROIAtActualExit,
      predictedROITo05z: prediction.predictedROITo05z,
      predictedROITo50Percent: prediction.predictedROITo50Percent,
      errorAtActualExit,
      absErrorAtActualExit,
      errorTo05z,
      absErrorTo05z,
      errorTo50Percent,
      absErrorTo50Percent,
      entryZ: entryZScore,
      exitZ: exitZScore,
      direction: trade.direction,
      entryTime: entryTime.toISOString().split('T')[0],
      exitReason: trade.exit_reason || 'N/A',
      betaAtEntry: prediction.betaAtEntry,
      betaAtExit: prediction.betaAtExit
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log = noop;
  console.error = noop;
  await sdk.disconnect();
  console.log = originalLog;
  console.error = originalError;
  
  return results;
}

function generateDurationAnalysisReport(results) {
  if (results.length === 0) {
    return null;
  }
  
  // Sort by duration
  const sortedResults = [...results].sort((a, b) => a.duration - b.duration);
  
  let report = `# Duration vs Prediction Accuracy Analysis\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  report += `**Total Trades Analyzed:** ${results.length}\n\n`;
  report += `**Note:** This compares three prediction methods:\n`;
  report += `1. **To Actual Exit Z** - Perfect knowledge (if we knew exit z at entry)\n`;
  report += `2. **To 0.5z** - Entry-time prediction (assumes reversion to 0.5z)\n`;
  report += `3. **To 50% of Entry Z** - Entry-time prediction (assumes reversion to 50% of entry z)\n\n`;
  
  // Calculate statistics for each prediction method
  // 1. Actual Exit Z (perfect knowledge)
  const avgErrorAtActualExit = results.reduce((sum, r) => sum + r.errorAtActualExit, 0) / results.length;
  const avgAbsErrorAtActualExit = results.reduce((sum, r) => sum + r.absErrorAtActualExit, 0) / results.length;
  const absErrorsAtActualExit = results.map(r => r.absErrorAtActualExit).sort((a, b) => a - b);
  
  // 2. To 0.5z (entry-time prediction)
  const validTo05z = results.filter(r => r.absErrorTo05z !== null);
  const avgErrorTo05z = validTo05z.length > 0 
    ? validTo05z.reduce((sum, r) => sum + r.errorTo05z, 0) / validTo05z.length 
    : null;
  const avgAbsErrorTo05z = validTo05z.length > 0
    ? validTo05z.reduce((sum, r) => sum + r.absErrorTo05z, 0) / validTo05z.length
    : null;
  const absErrorsTo05z = validTo05z.map(r => r.absErrorTo05z).sort((a, b) => a - b);
  
  // 3. To 50% (entry-time prediction)
  const avgErrorTo50Percent = results.reduce((sum, r) => sum + r.errorTo50Percent, 0) / results.length;
  const avgAbsErrorTo50Percent = results.reduce((sum, r) => sum + r.absErrorTo50Percent, 0) / results.length;
  const absErrorsTo50Percent = results.map(r => r.absErrorTo50Percent).sort((a, b) => a - b);
  
  // For backward compatibility, use actual exit for main stats
  const avgError = avgErrorAtActualExit;
  const avgAbsError = avgAbsErrorAtActualExit;
  
  // Split into shorter vs longer trades
  const medianDuration = sortedResults[Math.floor(sortedResults.length / 2)].duration;
  const shortTrades = results.filter(r => r.duration <= medianDuration);
  const longTrades = results.filter(r => r.duration > medianDuration);
  
  const shortAvgAbsError = shortTrades.reduce((sum, r) => sum + r.absErrorAtActualExit, 0) / shortTrades.length;
  const longAvgAbsError = longTrades.reduce((sum, r) => sum + r.absErrorAtActualExit, 0) / longTrades.length;
  const shortWithin5 = shortTrades.filter(r => r.absErrorAtActualExit <= 5).length;
  const longWithin5 = longTrades.filter(r => r.absErrorAtActualExit <= 5).length;
  
  report += `## Comparison of Prediction Methods\n\n`;
  report += `| Method | Avg Error | Avg Abs Error | Median Abs Error | Within 5% |\n`;
  report += `|--------|-----------|---------------|------------------|----------|\n`;
  
  // Actual Exit Z
  const medianAtActualExit = absErrorsAtActualExit.length % 2 === 0
    ? (absErrorsAtActualExit[absErrorsAtActualExit.length / 2 - 1] + absErrorsAtActualExit[absErrorsAtActualExit.length / 2]) / 2
    : absErrorsAtActualExit[Math.floor(absErrorsAtActualExit.length / 2)];
  const within5AtActualExit = results.filter(r => r.absErrorAtActualExit <= 5).length;
  report += `| To Actual Exit Z | ${avgErrorAtActualExit.toFixed(2)}% | ${avgAbsErrorAtActualExit.toFixed(2)}% | ${medianAtActualExit.toFixed(2)}% | ${within5AtActualExit} (${(within5AtActualExit/results.length*100).toFixed(1)}%) |\n`;
  
  // To 0.5z
  if (avgAbsErrorTo05z !== null) {
    const medianTo05z = absErrorsTo05z.length % 2 === 0
      ? (absErrorsTo05z[absErrorsTo05z.length / 2 - 1] + absErrorsTo05z[absErrorsTo05z.length / 2]) / 2
      : absErrorsTo05z[Math.floor(absErrorsTo05z.length / 2)];
    const within5To05z = validTo05z.filter(r => r.absErrorTo05z <= 5).length;
    report += `| To 0.5z | ${avgErrorTo05z.toFixed(2)}% | ${avgAbsErrorTo05z.toFixed(2)}% | ${medianTo05z.toFixed(2)}% | ${within5To05z} (${(within5To05z/validTo05z.length*100).toFixed(1)}%) |\n`;
  } else {
    report += `| To 0.5z | N/A | N/A | N/A | N/A |\n`;
  }
  
  // To 50%
  const medianTo50Percent = absErrorsTo50Percent.length % 2 === 0
    ? (absErrorsTo50Percent[absErrorsTo50Percent.length / 2 - 1] + absErrorsTo50Percent[absErrorsTo50Percent.length / 2]) / 2
    : absErrorsTo50Percent[Math.floor(absErrorsTo50Percent.length / 2)];
  const within5To50Percent = results.filter(r => r.absErrorTo50Percent <= 5).length;
  report += `| To 50% of Entry Z | ${avgErrorTo50Percent.toFixed(2)}% | ${avgAbsErrorTo50Percent.toFixed(2)}% | ${medianTo50Percent.toFixed(2)}% | ${within5To50Percent} (${(within5To50Percent/results.length*100).toFixed(1)}%) |\n\n`;
  
  report += `**Key Insight:** The "To Actual Exit Z" method shows how accurate our ROI formula is when we know the exit z-score. The "To 0.5z" and "To 50%" methods show how accurate our entry-time predictions are in practice.\n\n`;
  
  report += `## Overall Statistics (To Actual Exit Z - Formula Accuracy)\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Average Error (signed) | ${avgErrorAtActualExit.toFixed(2)}% |\n`;
  report += `| Average Absolute Error | ${avgAbsErrorAtActualExit.toFixed(2)}% |\n`;
  const p25 = absErrorsAtActualExit[Math.floor(absErrorsAtActualExit.length * 0.25)];
  const p75 = absErrorsAtActualExit[Math.floor(absErrorsAtActualExit.length * 0.75)];
  const maxAbsError = Math.max(...absErrorsAtActualExit);
  const minAbsError = Math.min(...absErrorsAtActualExit);
  report += `| Median Absolute Error | ${medianAtActualExit.toFixed(2)}% |\n`;
  report += `| 25th Percentile | ${p25.toFixed(2)}% |\n`;
  report += `| 75th Percentile | ${p75.toFixed(2)}% |\n`;
  report += `| Min Absolute Error | ${minAbsError.toFixed(2)}% |\n`;
  report += `| Max Absolute Error | ${maxAbsError.toFixed(2)}% |\n`;
  report += `| Within 5% Accuracy | ${within5AtActualExit} (${(within5AtActualExit/results.length*100).toFixed(1)}%) |\n`;
  const within10AtActualExit = results.filter(r => r.absErrorAtActualExit <= 10).length;
  const within20AtActualExit = results.filter(r => r.absErrorAtActualExit <= 20).length;
  report += `| Within 10% Accuracy | ${within10AtActualExit} (${(within10AtActualExit/results.length*100).toFixed(1)}%) |\n`;
  report += `| Within 20% Accuracy | ${within20AtActualExit} (${(within20AtActualExit/results.length*100).toFixed(1)}%) |\n\n`;
  
  report += `## Shorter vs Longer Trades Comparison\n\n`;
  report += `**Median Duration:** ${medianDuration.toFixed(3)} days\n\n`;
  report += `| Metric | Shorter Trades (≤${medianDuration.toFixed(3)}d) | Longer Trades (>${medianDuration.toFixed(3)}d) |\n`;
  report += `|--------|-----------------------------------|----------------------------------|\n`;
  report += `| Count | ${shortTrades.length} | ${longTrades.length} |\n`;
  report += `| Avg Absolute Error | ${shortAvgAbsError.toFixed(2)}% | ${longAvgAbsError.toFixed(2)}% |\n`;
  report += `| Within 5% Accuracy | ${shortWithin5} (${(shortWithin5/shortTrades.length*100).toFixed(1)}%) | ${longWithin5} (${(longWithin5/longTrades.length*100).toFixed(1)}%) |\n\n`;
  
  if (shortAvgAbsError < longAvgAbsError) {
    report += `**Finding:** Shorter trades have ${((longAvgAbsError - shortAvgAbsError) / longAvgAbsError * 100).toFixed(1)}% better prediction accuracy on average.\n\n`;
  } else if (longAvgAbsError < shortAvgAbsError) {
    report += `**Finding:** Longer trades have ${((shortAvgAbsError - longAvgAbsError) / shortAvgAbsError * 100).toFixed(1)}% better prediction accuracy on average.\n\n`;
  } else {
    report += `**Finding:** No significant difference in prediction accuracy between shorter and longer trades.\n\n`;
  }
  
  // Duration ranges analysis
  const ranges = [
    { min: 0, max: 0.5, label: '0-0.5 days' },
    { min: 0.5, max: 1, label: '0.5-1 days' },
    { min: 1, max: 1.5, label: '1-1.5 days' },
    { min: 1.5, max: 2.5, label: '1.5-2.5 days' },
    { min: 2.5, max: Infinity, label: '2.5+ days' }
  ];
  
  report += `## Accuracy by Duration Range\n\n`;
  report += `| Duration Range | Count | Avg Abs Error | Median Abs Error | Within 5% |\n`;
  report += `|---------------|-------|---------------|------------------|----------|\n`;
  
  ranges.forEach(range => {
    const rangeTrades = results.filter(r => r.duration >= range.min && r.duration < range.max);
    if (rangeTrades.length === 0) {
      report += `| ${range.label} | 0 | - | - | - |\n`;
      return;
    }
    const rangeAvgAbsError = rangeTrades.reduce((sum, r) => sum + r.absErrorAtActualExit, 0) / rangeTrades.length;
    const rangeAbsErrors = rangeTrades.map(r => r.absErrorAtActualExit).sort((a, b) => a - b);
    const rangeMedian = rangeAbsErrors.length % 2 === 0
      ? (rangeAbsErrors[rangeAbsErrors.length / 2 - 1] + rangeAbsErrors[rangeAbsErrors.length / 2]) / 2
      : rangeAbsErrors[Math.floor(rangeAbsErrors.length / 2)];
    const rangeWithin5 = rangeTrades.filter(r => r.absErrorAtActualExit <= 5).length;
    report += `| ${range.label} | ${rangeTrades.length} | ${rangeAvgAbsError.toFixed(2)}% | ${rangeMedian.toFixed(2)}% | ${rangeWithin5} (${(rangeWithin5/rangeTrades.length*100).toFixed(1)}%) |\n`;
  });
  
  report += `\n## All Trades Sorted by Duration\n\n`;
  report += `| Pair | Duration | Entry Z | Exit Z | Exit Reason | Actual ROI | Pred To Exit Z | Pred To 0.5z | Pred To 50% | Error (Exit) | Beta Entry | Beta Exit | Beta Δ |\n`;
  report += `|------|----------|---------|--------|-------------|-----------|----------------|--------------|------------|--------------|-----------|----------|-------|\n`;
  
  sortedResults.forEach(r => {
    const pred05z = r.predictedROITo05z !== null ? r.predictedROITo05z.toFixed(2) : 'N/A';
    const error05z = r.errorTo05z !== null ? r.errorTo05z.toFixed(2) : 'N/A';
    const betaEntry = r.betaAtEntry !== null ? r.betaAtEntry.toFixed(4) : 'N/A';
    const betaExit = r.betaAtExit !== null ? r.betaAtExit.toFixed(4) : 'N/A';
    const betaChange = r.betaAtEntry !== null && r.betaAtExit !== null 
      ? (r.betaAtExit - r.betaAtEntry).toFixed(4) 
      : 'N/A';
    report += `| ${r.pair} | ${r.duration.toFixed(3)} | ${r.entryZ.toFixed(2)} | ${r.exitZ.toFixed(2)} | ${r.exitReason} | ${r.actualROI.toFixed(2)}% | ${r.predictedROIAtActualExit.toFixed(2)}% | ${pred05z}% | ${r.predictedROITo50Percent.toFixed(2)}% | ${r.errorAtActualExit.toFixed(2)}% | ${betaEntry} | ${betaExit} | ${betaChange} |\n`;
  });
  
  // Correlation analysis
  const durations = results.map(r => r.duration);
  const absErrorsForCorr = results.map(r => r.absErrorAtActualExit);
  const meanDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const meanAbsError = absErrorsForCorr.reduce((a, b) => a + b, 0) / absErrorsForCorr.length;
  
  let covariance = 0;
  let varianceDuration = 0;
  let varianceError = 0;
  
  for (let i = 0; i < results.length; i++) {
    const dDiff = durations[i] - meanDuration;
    const eDiff = absErrorsForCorr[i] - meanAbsError;
    covariance += dDiff * eDiff;
    varianceDuration += dDiff * dDiff;
    varianceError += eDiff * eDiff;
  }
  
  covariance /= results.length;
  varianceDuration /= results.length;
  varianceError /= results.length;
  
  const correlation = varianceDuration > 0 && varianceError > 0
    ? covariance / (Math.sqrt(varianceDuration) * Math.sqrt(varianceError))
    : 0;
  
  report += `\n## Duration vs Accuracy Correlation\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Correlation Coefficient | ${correlation.toFixed(3)} |\n`;
  report += `| Interpretation | ${correlation < -0.3 ? 'Strong negative correlation (shorter = more accurate)' : correlation < -0.1 ? 'Moderate negative correlation' : correlation < 0.1 ? 'Weak/no correlation' : correlation < 0.3 ? 'Moderate positive correlation' : 'Strong positive correlation (longer = more accurate)'} |\n`;
  
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args[0] ? parseInt(args[0]) : 50;
  
  try {
    const results = await analyzeTradesByDuration({ limit });
    const report = generateDurationAnalysisReport(results);
    
    if (report) {
      const outputDir = 'backtest_reports';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `duration_analysis_${timestamp}.md`;
      const filepath = path.join(outputDir, filename);
      
      fs.writeFileSync(filepath, report);
      console.log(`\nReport saved: ${filepath}`);
    }
  } catch (error) {
    console.error('Analysis failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { analyzeTradesByDuration, generateDurationAnalysisReport };

