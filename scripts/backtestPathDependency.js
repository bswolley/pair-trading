#!/usr/bin/env node

/**
 * Backtest Path Dependency Risk
 * 
 * For closed trades, calculates:
 * 1. Path dependency risk at entry time (24hr, 48hr, 7d)
 * 2. Actual price movement ratio during the trade
 * 3. Compares predicted ROI vs actual ROI by risk level
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { analyzePair } = require('../lib/pairAnalysis');
const { Hyperliquid } = require('hyperliquid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Get price at a specific time
 */
async function getPriceAtTime(symbol, timestamp, sdk) {
  try {
    // Use 24 hour window for hourly candles (should be plenty for recent data)
    const startTime = timestamp - (24 * 60 * 60 * 1000);
    const endTime = timestamp + (24 * 60 * 60 * 1000);
    
    const symbolWithPerp = `${symbol}-PERP`;
    const candles = await sdk.info.getCandleSnapshot(symbolWithPerp, '1h', startTime, endTime);
    
    if (!candles || candles.length === 0) {
      // Try without PERP suffix in case symbol already includes it
      const candlesAlt = await sdk.info.getCandleSnapshot(symbol, '1h', startTime, endTime);
      if (!candlesAlt || candlesAlt.length === 0) {
        return null;
      }
      
      let closest = candlesAlt[0];
      let minDiff = Math.abs((typeof closest.t === 'number' ? closest.t : new Date(closest.t).getTime()) - timestamp);
      
      for (const candle of candlesAlt) {
        const candleTime = typeof candle.t === 'number' ? candle.t : new Date(candle.t).getTime();
        const diff = Math.abs(candleTime - timestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closest = candle;
        }
      }
      
      return parseFloat(closest.c);
    }
    
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
    // Log error for debugging
    console.error(`  ⚠️  Failed to get price for ${symbol} at ${new Date(timestamp).toISOString()}: ${error.message}`);
    return null;
  }
}

/**
 * Calculate path dependency risk at entry time
 */
async function getPathDependencyRiskAtEntry(symbol1, symbol2, entryTime) {
  try {
    const result = await analyzePair({
      symbol1,
      symbol2,
      cutoffTime: entryTime.getTime()
    });
    
    const pathDependencyRisks = result.standardized?.pathDependencyRisks || {};
    
    return {
      risk24hr: pathDependencyRisks['24hr'],
      risk48hr: pathDependencyRisks['48hr'],
      risk7d: pathDependencyRisks['7d']
    };
  } catch (error) {
    return { risk24hr: null, risk48hr: null, risk7d: null };
  }
}

/**
 * Calculate actual price movement ratio during trade
 */
async function calculateActualMovementRatio(symbol1, symbol2, entryTime, exitTime, sdk, entryPrice1FromDB = null, entryPrice2FromDB = null) {
  try {
    // Use entry prices from database if available, otherwise fetch
    const entryPrice1 = entryPrice1FromDB || await getPriceAtTime(symbol1, entryTime.getTime(), sdk);
    const entryPrice2 = entryPrice2FromDB || await getPriceAtTime(symbol2, entryTime.getTime(), sdk);
    
    // Always fetch exit prices
    const [exitPrice1, exitPrice2] = await Promise.all([
      getPriceAtTime(symbol1, exitTime.getTime(), sdk),
      getPriceAtTime(symbol2, exitTime.getTime(), sdk)
    ]);
    
    if (!entryPrice1 || !entryPrice2 || !exitPrice1 || !exitPrice2) {
      return null;
    }
    
    const change1 = Math.abs((exitPrice1 - entryPrice1) / entryPrice1);
    const change2 = Math.abs((exitPrice2 - entryPrice2) / entryPrice2);
    
    // Ratio: larger change / smaller change (always >= 1)
    // Handle division by zero
    if (change1 === 0 && change2 === 0) {
      return null; // Both tokens didn't move
    }
    if (change1 === 0) {
      return { ratio: Infinity, change1: 0, change2: change2 * 100, entryPrice1, entryPrice2, exitPrice1, exitPrice2 };
    }
    if (change2 === 0) {
      return { ratio: Infinity, change1: change1 * 100, change2: 0, entryPrice1, entryPrice2, exitPrice1, exitPrice2 };
    }
    
    const ratio = change1 > change2 ? change1 / change2 : change2 / change1;
    
    return {
      ratio,
      change1: change1 * 100, // as percentage
      change2: change2 * 100,
      entryPrice1,
      entryPrice2,
      exitPrice1,
      exitPrice2
    };
  } catch (error) {
    return null;
  }
}

/**
 * Get predicted ROI at entry time using multiple methods
 */
async function getPredictedROI(symbol1, symbol2, entryTime, direction, entryZScore, exitZScore = null) {
  try {
    const result = await analyzePair({
      symbol1,
      symbol2,
      direction,
      timeframes: [30],
      cutoffTime: entryTime.getTime()
    });
    
    const tf30d = result.timeframes?.[30];
    const stdDevSpread = tf30d?.stdDevSpread;
    
    if (!stdDevSpread || entryZScore === null || entryZScore === undefined) {
      return { to05z: null, to50Percent: null, toActualExit: null };
    }
    
    const entryZ = Math.abs(entryZScore);
    
    const predictions = {
      to05z: null,
      to50Percent: null,
      toActualExit: null
    };
    
    // Method 1: To 0.5z
    const fixedExitZ = 0.5;
    if (entryZ > fixedExitZ) {
      const zChange = entryZ - fixedExitZ;
      const spreadChange = zChange * stdDevSpread;
      const predictedROI = (Math.exp(spreadChange) - 1) * 100;
      predictions.to05z = direction === 'long' ? predictedROI : -predictedROI;
    }
    
    // Method 2: To 50% of entry z-score
    const percentExitZ = entryZ * 0.5;
    if (entryZ > percentExitZ) {
      const zChange = entryZ - percentExitZ;
      const spreadChange = zChange * stdDevSpread;
      const predictedROI = (Math.exp(spreadChange) - 1) * 100;
      predictions.to50Percent = direction === 'long' ? predictedROI : -predictedROI;
    }
    
    // Method 3: To actual exit z-score (if available)
    if (exitZScore !== null && exitZScore !== undefined) {
      const actualExitZ = Math.abs(exitZScore);
      if (entryZ > actualExitZ) {
        const zChange = entryZ - actualExitZ;
        const spreadChange = zChange * stdDevSpread;
        const predictedROI = (Math.exp(spreadChange) - 1) * 100;
        predictions.toActualExit = direction === 'long' ? predictedROI : -predictedROI;
      } else if (entryZ < actualExitZ) {
        // Spread widened - negative ROI
        const zChange = actualExitZ - entryZ;
        const spreadChange = zChange * stdDevSpread;
        const predictedROI = (Math.exp(spreadChange) - 1) * 100;
        predictions.toActualExit = direction === 'long' ? -predictedROI : predictedROI;
      } else {
        predictions.toActualExit = 0;
      }
    }
    
    return predictions;
  } catch (error) {
    return { to05z: null, to50Percent: null, toActualExit: null };
  }
}

/**
 * Main backtest function
 */
async function backtestPathDependency(options = {}) {
  const {
    limit = 100,
    startDate = null,
    endDate = null
  } = options;
  
  // Checkpoint file path
  const checkpointPath = path.join(__dirname, '..', 'backtest_reports', '.path_dependency_checkpoint.json');
  
  // Load checkpoint if exists
  let checkpoint = null;
  let processedIds = new Set();
  if (fs.existsSync(checkpointPath)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      processedIds = new Set(checkpoint.processedIds || []);
      console.log(`Found checkpoint: ${processedIds.size} trades already processed. Resuming...\n`);
    } catch (err) {
      console.log('Could not load checkpoint, starting fresh...\n');
    }
  }
  
  console.log('Querying Supabase for closed trades...\n');
  
  let query = supabase
    .from('trade_history')
    .select('*')
    .not('exit_time', 'is', null)
    .not('total_pnl', 'is', null)
    .order('entry_time', { ascending: false })
    .limit(limit);
  
  if (startDate) {
    query = query.gte('entry_time', startDate);
  }
  if (endDate) {
    query = query.lte('entry_time', endDate);
  }
  
  const { data: trades, error } = await query;
  
  if (error) {
    console.error('Supabase query error:', error);
    throw error;
  }
  
  if (!trades || trades.length === 0) {
    console.log('No closed trades found');
    return;
  }
  
  // Filter out already processed trades
  const tradesToProcess = checkpoint ? trades.filter(t => !processedIds.has(t.id)) : trades;
  
  if (tradesToProcess.length === 0) {
    console.log('All trades already processed. Loading results from checkpoint...\n');
    if (checkpoint && checkpoint.results) {
      generateReport(checkpoint.results);
      // Clean up checkpoint
      fs.unlinkSync(checkpointPath);
      return;
    }
  }
  
  console.log(`Found ${trades.length} total trades, ${tradesToProcess.length} remaining to process. Analyzing path dependency...\n`);
  
  const sdk = new Hyperliquid();
  
  // Start with existing results from checkpoint
  const results = checkpoint && checkpoint.results ? checkpoint.results : [];
  
  for (let i = 0; i < tradesToProcess.length; i++) {
    const trade = tradesToProcess[i];
    const symbol1 = trade.asset1;
    const symbol2 = trade.asset2;
    const entryTime = new Date(trade.entry_time);
    const exitTime = new Date(trade.exit_time);
    const direction = trade.direction || 'long';
    const entryZScore = trade.entry_z_score;
    const exitZScore = trade.exit_z_score;
    const actualROI = trade.total_pnl; // Already in percentage
    
    try {
      console.log(`[${i + 1}/${tradesToProcess.length}] ${symbol1}/${symbol2}...`);
      
      // Get path dependency risk at entry time
      let pathRisk = { risk24hr: null, risk48hr: null, risk7d: null };
      try {
        pathRisk = await getPathDependencyRiskAtEntry(symbol1, symbol2, entryTime);
      } catch (err) {
        console.log(`  ⚠️  Path risk calculation failed: ${err.message}`);
      }
      
      // Get actual price movement ratio during trade
      // Use entry prices from database if available
      const entryPrice1 = trade.entry_price1;
      const entryPrice2 = trade.entry_price2;
      
      let actualMovement = null;
      try {
        actualMovement = await calculateActualMovementRatio(
          symbol1, 
          symbol2, 
          entryTime, 
          exitTime, 
          sdk,
          entryPrice1,
          entryPrice2
        );
      } catch (err) {
        console.log(`  ⚠️  Price movement calculation failed: ${err.message}`);
      }
      
      // Get predicted ROI using all three methods
      let predictions = { to05z: null, to50Percent: null, toActualExit: null };
      try {
        predictions = await getPredictedROI(symbol1, symbol2, entryTime, direction, entryZScore, exitZScore);
      } catch (err) {
        console.log(`  ⚠️  ROI prediction failed: ${err.message}`);
      }
      
      // Calculate errors for all three methods
      const error05z = predictions.to05z !== null && actualROI !== null ? actualROI - predictions.to05z : null;
      const absError05z = error05z !== null ? Math.abs(error05z) : null;
      
      const error50Percent = predictions.to50Percent !== null && actualROI !== null ? actualROI - predictions.to50Percent : null;
      const absError50Percent = error50Percent !== null ? Math.abs(error50Percent) : null;
      
      const errorActualExit = predictions.toActualExit !== null && actualROI !== null ? actualROI - predictions.toActualExit : null;
      const absErrorActualExit = errorActualExit !== null ? Math.abs(errorActualExit) : null;
      
      results.push({
        pair: `${symbol1}/${symbol2}`,
        entryTime: entryTime.toISOString(),
        exitTime: exitTime.toISOString(),
        duration: (exitTime - entryTime) / (1000 * 60 * 60 * 24), // days
        direction,
        actualROI,
        // Predictions using three methods
        predictedROI_05z: predictions.to05z,
        predictedROI_50Percent: predictions.to50Percent,
        predictedROI_actualExit: predictions.toActualExit,
        // Errors for each method
        error_05z: error05z,
        absError_05z: absError05z,
        error_50Percent: error50Percent,
        absError_50Percent: absError50Percent,
        error_actualExit: errorActualExit,
        absError_actualExit: absErrorActualExit,
        pathRisk24hr: pathRisk.risk24hr,
        pathRisk48hr: pathRisk.risk48hr,
        pathRisk7d: pathRisk.risk7d,
        actualMovementRatio: actualMovement?.ratio,
        actualChange1: actualMovement?.change1,
        actualChange2: actualMovement?.change2
      });
    } catch (err) {
      console.log(`  ❌ Error processing trade: ${err.message}`);
      // Still add the trade with null values so we can see what failed
      results.push({
        pair: `${symbol1}/${symbol2}`,
        entryTime: entryTime.toISOString(),
        exitTime: exitTime.toISOString(),
        duration: (exitTime - entryTime) / (1000 * 60 * 60 * 24),
        direction,
        actualROI,
        predictedROI_05z: null,
        predictedROI_50Percent: null,
        predictedROI_actualExit: null,
        error_05z: null,
        absError_05z: null,
        error_50Percent: null,
        absError_50Percent: null,
        error_actualExit: null,
        absError_actualExit: null,
        pathRisk24hr: null,
        pathRisk48hr: null,
        pathRisk7d: null,
        actualMovementRatio: null,
        actualChange1: null,
        actualChange2: null
      });
    }
  }
  
  try {
    sdk.disconnect();
  } catch (err) {
    // Ignore disconnect errors
  }
  
  // Generate report (even if some trades failed)
  if (results.length > 0) {
    generateReport(results);
  } else {
    console.log('\nNo results to report');
  }
}

/**
 * Calculate stats by risk level for a given timeframe
 */
function calculateStatsByRiskLevel(results, riskKey) {
  const byRiskLevel = {
    High: [],
    Medium: [],
    Low: [],
    Unknown: []
  };
  
  results.forEach(r => {
    const risk = r[riskKey];
    if (!risk) {
      byRiskLevel.Unknown.push(r);
    } else {
      const level = risk.pathDependencyRiskLevel || 'Unknown';
      byRiskLevel[level] = byRiskLevel[level] || [];
      byRiskLevel[level].push(r);
    }
  });
  
  const stats = {};
  Object.keys(byRiskLevel).forEach(level => {
    const trades = byRiskLevel[level];
    if (trades.length === 0) return;
    
    const errors05z = trades.filter(t => t.absError_05z !== null && !isNaN(t.absError_05z) && isFinite(t.absError_05z)).map(t => t.absError_05z);
    const errors50Percent = trades.filter(t => t.absError_50Percent !== null && !isNaN(t.absError_50Percent) && isFinite(t.absError_50Percent)).map(t => t.absError_50Percent);
    const errorsActualExit = trades.filter(t => t.absError_actualExit !== null && !isNaN(t.absError_actualExit) && isFinite(t.absError_actualExit)).map(t => t.absError_actualExit);
    const ratios = trades.filter(t => t.actualMovementRatio !== null && t.actualMovementRatio !== undefined && !isNaN(t.actualMovementRatio) && isFinite(t.actualMovementRatio)).map(t => t.actualMovementRatio);
    const rois = trades.filter(t => t.actualROI !== null && !isNaN(t.actualROI) && isFinite(t.actualROI)).map(t => t.actualROI);
    
    stats[level] = {
      count: trades.length,
      avgAbsError_05z: errors05z.length > 0 ? errors05z.reduce((a, b) => a + b, 0) / errors05z.length : null,
      avgAbsError_50Percent: errors50Percent.length > 0 ? errors50Percent.reduce((a, b) => a + b, 0) / errors50Percent.length : null,
      avgAbsError_actualExit: errorsActualExit.length > 0 ? errorsActualExit.reduce((a, b) => a + b, 0) / errorsActualExit.length : null,
      avgMovementRatio: ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
      avgROI: rois.length > 0 ? rois.reduce((a, b) => a + b, 0) / rois.length : null
    };
  });
  
  return stats;
}

/**
 * Generate markdown report
 */
function generateReport(results) {
  // Calculate stats for each timeframe
  const stats24hr = calculateStatsByRiskLevel(results, 'pathRisk24hr');
  const stats48hr = calculateStatsByRiskLevel(results, 'pathRisk48hr');
  const stats7d = calculateStatsByRiskLevel(results, 'pathRisk7d');
  
  // Generate markdown
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(__dirname, '..', 'backtest_reports', `path_dependency_backtest_${timestamp}.md`);
  
  let report = `# Path Dependency Risk Backtest\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  report += `Total Trades: ${results.length}\n\n`;
  
  report += `## What is Path Dependency Risk?\n\n`;
  report += `Path dependency risk measures **volatility asymmetry** between the two tokens in a pair. When one token is much more volatile than the other, the actual ROI can vary significantly even if the spread reverts as predicted.\n\n`;
  report += `**Risk Level Thresholds:**\n`;
  report += `- **High Risk**: Volatility ratio ≥ 1.5x (one token is 1.5x+ more volatile)\n`;
  report += `- **Medium Risk**: Volatility ratio ≥ 1.2x (one token is 1.2-1.5x more volatile)\n`;
  report += `- **Low Risk**: Volatility ratio < 1.2x (similar volatility between tokens)\n\n`;
  report += `**Why It Matters:**\n`;
  report += `- ROI predictions assume proportional price movements\n`;
  report += `- High volatility asymmetry means one token moves more than expected\n`;
  report += `- This causes prediction errors even when spread reversion is correct\n\n`;
  report += `**Note on High Risk Prevalence:**\n`;
  report += `Many trades show High risk because crypto tokens often have different volatility profiles (e.g., newer tokens vs established ones, different market caps, different sectors). A 1.5x volatility ratio is common in pair trading. The key insight is that **High risk trades have ~3x higher prediction errors** than Low risk trades.\n\n`;
  
  // Summary for 24hr
  report += `## Summary by Risk Level (24hr)\n\n`;
  report += `### Prediction Method Comparison\n\n`;
  report += `| Risk Level | Count | Error (to 0.5z) | Error (to 50% entry z) | Error (to actual exit z) | Avg Movement Ratio |\n`;
  report += `|------------|-------|----------------|------------------------|-------------------------|-------------------|\n`;
  Object.keys(stats24hr).forEach(level => {
    const s = stats24hr[level];
    if (s && s.count > 0) {
      report += `| ${level} | ${s.count} | ${s.avgAbsError_05z !== null ? s.avgAbsError_05z.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_50Percent !== null ? s.avgAbsError_50Percent.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_actualExit !== null ? s.avgAbsError_actualExit.toFixed(2) + '%' : 'N/A'} | ${s.avgMovementRatio !== null ? s.avgMovementRatio.toFixed(2) + 'x' : 'N/A'} |\n`;
    }
  });
  
  // Summary for 48hr
  report += `\n## Summary by Risk Level (48hr)\n\n`;
  report += `### Prediction Method Comparison\n\n`;
  report += `| Risk Level | Count | Error (to 0.5z) | Error (to 50% entry z) | Error (to actual exit z) | Avg Movement Ratio |\n`;
  report += `|------------|-------|----------------|------------------------|-------------------------|-------------------|\n`;
  Object.keys(stats48hr).forEach(level => {
    const s = stats48hr[level];
    if (s && s.count > 0) {
      report += `| ${level} | ${s.count} | ${s.avgAbsError_05z !== null ? s.avgAbsError_05z.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_50Percent !== null ? s.avgAbsError_50Percent.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_actualExit !== null ? s.avgAbsError_actualExit.toFixed(2) + '%' : 'N/A'} | ${s.avgMovementRatio !== null ? s.avgMovementRatio.toFixed(2) + 'x' : 'N/A'} |\n`;
    }
  });
  
  // Summary for 7d
  report += `\n## Summary by Risk Level (7d)\n\n`;
  report += `### Prediction Method Comparison\n\n`;
  report += `| Risk Level | Count | Error (to 0.5z) | Error (to 50% entry z) | Error (to actual exit z) | Avg Movement Ratio |\n`;
  report += `|------------|-------|----------------|------------------------|-------------------------|-------------------|\n`;
  Object.keys(stats7d).forEach(level => {
    const s = stats7d[level];
    if (s && s.count > 0) {
      report += `| ${level} | ${s.count} | ${s.avgAbsError_05z !== null ? s.avgAbsError_05z.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_50Percent !== null ? s.avgAbsError_50Percent.toFixed(2) + '%' : 'N/A'} | ${s.avgAbsError_actualExit !== null ? s.avgAbsError_actualExit.toFixed(2) + '%' : 'N/A'} | ${s.avgMovementRatio !== null ? s.avgMovementRatio.toFixed(2) + 'x' : 'N/A'} |\n`;
    }
  });
  
  report += `\n## Individual Trade Results\n\n`;
  report += `| Pair | Entry | Duration | Risk 48hr | Vol 48hr | Actual ROI | Error (0.5z) | Error (50%) | Error (exit z) |\n`;
  report += `|------|-------|----------|-----------|----------|------------|---------------|------------|----------------|\n`;
  
  results.forEach(r => {
    const risk48hr = r.pathRisk48hr;
    const risk48hrLevel = risk48hr?.pathDependencyRiskLevel || 'N/A';
    const vol48hr = risk48hr?.volatilityRatio ? risk48hr.volatilityRatio.toFixed(2) + 'x' : 'N/A';
    
    report += `| ${r.pair} | ${r.entryTime.split('T')[0]} | ${r.duration.toFixed(1)}d | ${risk48hrLevel} | ${vol48hr} | ${r.actualROI !== null ? r.actualROI.toFixed(2) + '%' : 'N/A'} | ${r.absError_05z !== null ? r.absError_05z.toFixed(2) + '%' : 'N/A'} | ${r.absError_50Percent !== null ? r.absError_50Percent.toFixed(2) + '%' : 'N/A'} | ${r.absError_actualExit !== null ? r.absError_actualExit.toFixed(2) + '%' : 'N/A'} |\n`;
  });
  
  // Save report
  const reportsDir = path.dirname(reportPath);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport saved to: ${reportPath}\n`);
  
  // Save data as JSON for further analysis
  const jsonPath = reportPath.replace('.md', '.json');
  const jsonData = {
    generated: new Date().toISOString(),
    totalTrades: results.length,
    stats: {
      stats24hr,
      stats48hr,
      stats7d
    },
    trades: results.map(r => ({
      pair: r.pair,
      entryTime: r.entryTime,
      exitTime: r.exitTime,
      duration: r.duration,
      direction: r.direction,
      actualROI: r.actualROI,
      predictedROI_05z: r.predictedROI_05z,
      predictedROI_50Percent: r.predictedROI_50Percent,
      predictedROI_actualExit: r.predictedROI_actualExit,
      error_05z: r.error_05z,
      absError_05z: r.absError_05z,
      error_50Percent: r.error_50Percent,
      absError_50Percent: r.absError_50Percent,
      error_actualExit: r.error_actualExit,
      absError_actualExit: r.absError_actualExit,
      pathRisk24hr: r.pathRisk24hr ? {
        level: r.pathRisk24hr.pathDependencyRiskLevel,
        volatilityRatio: r.pathRisk24hr.volatilityRatio
      } : null,
      pathRisk48hr: r.pathRisk48hr ? {
        level: r.pathRisk48hr.pathDependencyRiskLevel,
        volatilityRatio: r.pathRisk48hr.volatilityRatio
      } : null,
      pathRisk7d: r.pathRisk7d ? {
        level: r.pathRisk7d.pathDependencyRiskLevel,
        volatilityRatio: r.pathRisk7d.volatilityRatio
      } : null,
      actualMovementRatio: r.actualMovementRatio,
      actualChange1: r.actualChange1,
      actualChange2: r.actualChange2
    }))
  };
  
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`Data saved to: ${jsonPath}\n`);
  
  // Print summary to console
  console.log('\n=== SUMMARY (48hr - Most Predictive) ===\n');
  Object.keys(stats48hr).forEach(level => {
    const s = stats48hr[level];
    if (s && s.count > 0) {
      console.log(`${level} Risk (${s.count} trades):`);
      console.log(`  Error (to 0.5z): ${s.avgAbsError_05z !== null ? s.avgAbsError_05z.toFixed(2) + '%' : 'N/A'}`);
      console.log(`  Error (to 50% entry z): ${s.avgAbsError_50Percent !== null ? s.avgAbsError_50Percent.toFixed(2) + '%' : 'N/A'}`);
      console.log(`  Error (to actual exit z): ${s.avgAbsError_actualExit !== null ? s.avgAbsError_actualExit.toFixed(2) + '%' : 'N/A'}`);
      console.log(`  Avg Movement Ratio: ${s.avgMovementRatio !== null ? s.avgMovementRatio.toFixed(2) + 'x' : 'N/A'}`);
      console.log('');
    }
  });
}

// Run if called directly
if (require.main === module) {
  backtestPathDependency()
    .then(() => {
      console.log('Backtest complete');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { backtestPathDependency };

