#!/usr/bin/env node

/**
 * Backtest Rolling Beta and Z-Score Windows
 * 
 * Tests different window sizes independently for beta and z-score calculation.
 * Measures: beta drift, win rate, Sharpe ratio, and finds optimal combinations per half-life bucket.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { analyzeTimeframe } = require('../lib/pairAnalysis');
const { Hyperliquid } = require('hyperliquid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Fixed window sizes to test (as partner asked: "3days or 7days etc")
const BETA_WINDOWS = [3, 7, 14, 30];
const ZSCORE_WINDOWS = [3, 7, 14, 30];

/**
 * Calculate beta at entry and exit times
 */
async function calculateBetaAtTime(symbol1, symbol2, time, betaWindow, sharedSdk, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tf = await analyzeTimeframe(
        symbol1,
        symbol2,
        betaWindow,
        [], // fullOBV1
        [], // fullOBV2
        [], // obvTimeframes
        sharedSdk,
        time.getTime(),
        betaWindow // Use same window for z-score (not used for beta calculation)
      );
      
      if (tf.error) {
        if (tf.error.includes('Hyperliquid') && attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          continue;
        }
        return { beta: null, error: tf.error };
      }
      
      return { beta: tf.beta, error: null };
    } catch (error) {
      if (error.message.includes('Hyperliquid') && attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      return { beta: null, error: error.message };
    }
  }
  return { beta: null, error: 'Max retries exceeded' };
}

/**
 * Calculate metrics with specific beta and z-score windows
 */
async function calculateMetricsWithWindows(symbol1, symbol2, entryTime, betaWindow, zScoreWindow, sharedSdk, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tf = await analyzeTimeframe(
        symbol1,
        symbol2,
        betaWindow,
        [], // fullOBV1
        [], // fullOBV2
        [], // obvTimeframes
        sharedSdk,
        entryTime.getTime(),
        zScoreWindow // custom z-score window
      );
      
      if (tf.error) {
        if (tf.error.includes('Hyperliquid') && attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          continue;
        }
        return {
          beta: null,
          zScore: null,
          stdDevSpread: null,
          halfLife: null,
          error: tf.error
        };
      }
      
      return {
        beta: tf.beta,
        zScore: tf.zScore,
        stdDevSpread: tf.stdDevSpread,
        halfLife: tf.halfLife || null,
        error: null
      };
    } catch (error) {
      if (error.message.includes('Hyperliquid') && attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      return {
        beta: null,
        zScore: null,
        stdDevSpread: null,
        halfLife: null,
        error: error.message
      };
    }
  }
  
  return {
    beta: null,
    zScore: null,
    stdDevSpread: null,
    halfLife: null,
    error: 'Max retries exceeded'
  };
}

/**
 * Check if trade hit target (win)
 */
function isWin(entryZScore, exitZScore) {
  if (entryZScore === null || exitZScore === null) return null;
  
  const entryZ = Math.abs(entryZScore);
  const exitZ = Math.abs(exitZScore);
  const targetZ = Math.max(0.5, entryZ * 0.5); // Target: 0.5 or 50% of entry, whichever is higher
  
  return exitZ <= targetZ;
}

/**
 * Calculate predicted ROI based on z-score change and stdDevSpread
 */
function calculatePredictedROI(entryZScore, exitZScore, stdDevSpread, direction) {
  if (!stdDevSpread || entryZScore === null || exitZScore === null) {
    return null;
  }
  
  const entryZ = Math.abs(entryZScore);
  const exitZ = Math.abs(exitZScore);
  
  if (entryZ <= exitZ) {
    return 0; // Already at or past target
  }
  
  const zChange = entryZ - exitZ;
  const spreadChange = zChange * stdDevSpread;
  const predictedROI = (Math.exp(spreadChange) - 1) * 100;
  
  return Math.abs(predictedROI);
}

/**
 * Calculate Sharpe ratio
 */
function calculateSharpeRatio(returns) {
  if (returns.length === 0) return null;
  
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return null;
  
  // Annualized Sharpe (assuming daily returns)
  const sharpe = (avgReturn / stdDev) * Math.sqrt(365);
  return sharpe;
}

/**
 * Analyze trades with different window combinations
 */
async function analyzeRollingWindows() {
  console.log('🔍 Fetching closed trades from Supabase...\n');
  
  try {
    const { data: trades, error } = await supabase
      .from('trade_history')
      .select('*')
      .not('exit_time', 'is', null)
      .not('total_pnl', 'is', null)
      .order('entry_time', { ascending: false });
    
    if (error) {
      throw new Error(`Supabase query error: ${error.message}`);
    }
    
    if (!trades || trades.length === 0) {
      console.log('No closed trades found.');
      return;
    }
    
    console.log(`Found ${trades.length} closed trades\n`);
    console.log(`Testing fixed windows: ${BETA_WINDOWS.join('d, ')}d`);
    console.log(`  Beta windows: ${BETA_WINDOWS.join('d, ')}d`);
    console.log(`  Z-score windows: ${ZSCORE_WINDOWS.join('d, ')}d`);
    console.log(`  Total combinations per trade: ${BETA_WINDOWS.length * ZSCORE_WINDOWS.length}\n`);
    
    const results = [];
    const sdk = new Hyperliquid();
    await sdk.connect();
    
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const symbol1 = trade.asset1;
      const symbol2 = trade.asset2;
      const entryTime = new Date(trade.entry_time);
      const exitTime = new Date(trade.exit_time);
      const actualROI = trade.total_pnl; // Already in percentage
      const entryZScore = trade.entry_z_score;
      const exitZScore = trade.exit_z_score;
      const direction = trade.direction || 'long';
      
      console.log(`[${i + 1}/${trades.length}] Analyzing ${symbol1}/${symbol2}...`);
      
      // Get half-life using 30d window (for grouping into buckets)
      let halfLife = null;
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const refMetrics = await calculateMetricsWithWindows(
          symbol1,
          symbol2,
          entryTime,
          30,
          30,
          sdk,
          3
        );
        halfLife = refMetrics.halfLife;
      } catch (error) {
        // Continue anyway - we'll just group by half-life if available
      }
      
      const tradeResult = {
        pair: `${symbol1}/${symbol2}`,
        symbol1,
        symbol2,
        entryTime: entryTime.toISOString(),
        exitTime: exitTime.toISOString(),
        duration: (exitTime - entryTime) / (1000 * 60 * 60 * 24), // days
        actualROI,
        entryZScore,
        exitZScore,
        direction,
        halfLife,
        combinations: {} // Store results for each (betaWindow, zScoreWindow) combination
      };
      
      // Test each fixed window combination
      for (const betaWindow of BETA_WINDOWS) {
        for (const zScoreWindow of ZSCORE_WINDOWS) {
          const comboKey = `${betaWindow}d_${zScoreWindow}d`;
          
          try {
            // Add delay between API calls to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Get metrics at entry time
            const entryMetrics = await calculateMetricsWithWindows(
              symbol1,
              symbol2,
              entryTime,
              betaWindow,
              zScoreWindow,
              sdk,
              3
            );
            
            if (entryMetrics.error) {
              // If rate limited, wait longer
              if (entryMetrics.error.includes('429') || entryMetrics.error.includes('rate limit')) {
                console.log(`    ⏳ Rate limited on ${comboKey}, waiting 10 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
              }
              tradeResult.combinations[comboKey] = {
                error: entryMetrics.error,
                betaWindow,
                zScoreWindow,
                betaAtEntry: null,
                betaAtExit: null,
                betaDrift: null,
                win: null,
                sharpe: null
              };
              continue;
            }
            
            // Add delay before exit beta calculation
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Get beta at exit time (using same beta window)
            const exitBetaResult = await calculateBetaAtTime(
              symbol1,
              symbol2,
              exitTime,
              betaWindow,
              sdk,
              3
            );
            
            // If exit beta failed due to rate limit, wait
            if (exitBetaResult.error && (exitBetaResult.error.includes('429') || exitBetaResult.error.includes('rate limit'))) {
              console.log(`    ⏳ Rate limited on exit beta for ${comboKey}, waiting 10 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            const betaAtEntry = entryMetrics.beta;
            const betaAtExit = exitBetaResult.beta;
            const betaDrift = (betaAtEntry !== null && betaAtExit !== null)
              ? Math.abs(betaAtExit - betaAtEntry)
              : null;
            
            // Calculate predicted ROI using this window's stdDevSpread
            const predictedROI = calculatePredictedROI(
              entryZScore,
              exitZScore,
              entryMetrics.stdDevSpread,
              direction
            );
            
            // Prediction error
            const predictionError = (predictedROI !== null && actualROI !== null)
              ? predictedROI - actualROI
              : null;
            const absError = predictionError !== null ? Math.abs(predictionError) : null;
            
            // Check if trade won
            const win = isWin(entryZScore, exitZScore);
            
            // Days to target (actual trade duration if it hit target)
            const daysToTarget = win ? tradeResult.duration : null;
            
            tradeResult.combinations[comboKey] = {
              betaWindow,
              zScoreWindow,
              betaAtEntry,
              betaAtExit,
              betaDrift,
              predictedROI,
              actualROI,
              predictionError,
              absError,
              win,
              daysToTarget,
              error: null
            };
            
          } catch (error) {
            // If rate limited, wait longer
            if (error.message.includes('429') || error.message.includes('rate limit')) {
              console.log(`    ⏳ Rate limited on ${comboKey}, waiting 10 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 10000));
            }
            tradeResult.combinations[comboKey] = {
              error: error.message,
              betaWindow,
              zScoreWindow,
              betaAtEntry: null,
              betaAtExit: null,
              betaDrift: null,
              win: null,
              sharpe: null
            };
          }
        }
      }
      
      results.push(tradeResult);
      
      // Longer delay between trades to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    await sdk.disconnect();
    
    // Generate report
    generateReport(results);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

/**
 * Generate markdown report
 */
function generateReport(results) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(__dirname, '..', 'backtest_reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const reportPath = path.join(reportDir, `rolling_windows_backtest_${timestamp}.md`);
  
  // Group trades by half-life buckets
  const halfLifeBuckets = {
    '0-3d': [],
    '3-7d': [],
    '7-14d': [],
    '14d+': []
  };
  
  // Assign trades to buckets based on their half-life
  for (const trade of results) {
    const halfLife = trade.halfLife;
    if (halfLife !== null && halfLife !== undefined && !isNaN(halfLife) && halfLife > 0) {
      if (halfLife <= 3) {
        halfLifeBuckets['0-3d'].push(trade);
      } else if (halfLife <= 7) {
        halfLifeBuckets['3-7d'].push(trade);
      } else if (halfLife <= 14) {
        halfLifeBuckets['7-14d'].push(trade);
      } else {
        halfLifeBuckets['14d+'].push(trade);
      }
    }
  }
  
  // Count skipped trades
  const skippedTrades = results.filter(t => t.skipped);
  const validTrades = results.filter(t => !t.skipped);
  
  let markdown = `# Rolling Beta/Z-Score Window Backtest\n\n`;
  markdown += `Generated: ${new Date().toISOString()}\n\n`;
  markdown += `## Summary\n\n`;
  markdown += `Total trades analyzed: ${results.length}\n`;
  markdown += `Trades with valid half-life: ${validTrades.length}\n`;
  markdown += `Trades skipped (no half-life): ${skippedTrades.length}\n\n`;
  
  if (skippedTrades.length > 0) {
    markdown += `### Skipped Trades (No Valid Half-Life)\n\n`;
    markdown += `| Pair | Reason |\n`;
    markdown += `|------|--------|\n`;
    for (const trade of skippedTrades) {
      markdown += `| ${trade.pair} | ${trade.skipReason || 'Spread not mean-reverting'} |\n`;
    }
    markdown += `\n`;
  }
  
  // Analyze each half-life bucket
  for (const [bucketName, bucketTrades] of Object.entries(halfLifeBuckets)) {
    if (bucketTrades.length === 0) continue;
    
    markdown += `## Half-Life Bucket: ${bucketName}\n\n`;
    markdown += `Trades in bucket: ${bucketTrades.length}\n\n`;
    
    // Calculate metrics for each combination
    const comboStats = {};
    
    for (const betaWindow of BETA_WINDOWS) {
      for (const zScoreWindow of ZSCORE_WINDOWS) {
        const comboKey = `${betaWindow}d_${zScoreWindow}d`;
        
        const validTrades = bucketTrades.filter(t => {
          const combo = t.combinations[comboKey];
          return combo && !combo.error && combo.betaDrift !== null;
        });
        
        if (validTrades.length === 0) continue;
        
        // Beta drift stats
        const betaDrifts = validTrades
          .map(t => t.combinations[comboKey].betaDrift)
          .filter(d => d !== null && !isNaN(d) && isFinite(d));
        
        // Prediction error stats
        const absErrors = validTrades
          .map(t => t.combinations[comboKey].absError)
          .filter(e => e !== null && !isNaN(e) && isFinite(e));
        
        const predictionErrors = validTrades
          .map(t => t.combinations[comboKey].predictionError)
          .filter(e => e !== null && !isNaN(e) && isFinite(e));
        
        // Predicted ROI stats (for Sharpe of predictions)
        const predictedROIs = validTrades
          .map(t => t.combinations[comboKey].predictedROI)
          .filter(r => r !== null && !isNaN(r) && isFinite(r));
        
        // Actual ROI stats (for Sharpe ratio)
        const actualROIs = validTrades
          .map(t => t.combinations[comboKey].actualROI)
          .filter(r => r !== null && !isNaN(r) && isFinite(r));
        
        // Days to target (only for winning trades)
        const daysToTargets = validTrades
          .map(t => t.combinations[comboKey].daysToTarget)
          .filter(d => d !== null && !isNaN(d) && isFinite(d) && d > 0);
        
        const avgBetaDrift = betaDrifts.length > 0
          ? betaDrifts.reduce((sum, d) => sum + d, 0) / betaDrifts.length
          : null;
        
        const avgAbsError = absErrors.length > 0
          ? absErrors.reduce((sum, e) => sum + e, 0) / absErrors.length
          : null;
        
        const avgPredictionError = predictionErrors.length > 0
          ? predictionErrors.reduce((sum, e) => sum + e, 0) / predictionErrors.length
          : null;
        
        const avgPredictedROI = predictedROIs.length > 0
          ? predictedROIs.reduce((sum, r) => sum + r, 0) / predictedROIs.length
          : null;
        
        const avgActualROI = actualROIs.length > 0
          ? actualROIs.reduce((sum, r) => sum + r, 0) / actualROIs.length
          : null;
        
        // Sharpe ratio on ACTUAL PnL (not predicted)
        const sharpeActual = calculateSharpeRatio(actualROIs);
        
        // Avg days to target (only for winning trades)
        const avgDaysToTarget = daysToTargets.length > 0
          ? daysToTargets.reduce((sum, d) => sum + d, 0) / daysToTargets.length
          : null;
        
        // Win rate (actual)
        const wins = validTrades.filter(t => t.combinations[comboKey].win === true).length;
        const winRate = validTrades.length > 0 ? (wins / validTrades.length) * 100 : 0;
        
        comboStats[comboKey] = {
          betaWindow,
          zScoreWindow,
          count: validTrades.length,
          avgBetaDrift,
          avgAbsError,
          avgPredictionError,
          avgPredictedROI,
          avgActualROI,
          winRate,
          avgDaysToTarget,
          sharpeActual
        };
      }
    }
    
    // Find best combinations
    const bestBetaDrift = Object.values(comboStats)
      .filter(s => s.avgBetaDrift !== null)
      .sort((a, b) => a.avgBetaDrift - b.avgBetaDrift)[0];
    
    const bestPredictionAccuracy = Object.values(comboStats)
      .filter(s => s.avgAbsError !== null)
      .sort((a, b) => a.avgAbsError - b.avgAbsError)[0];
    
    const bestSharpe = Object.values(comboStats)
      .filter(s => s.sharpeActual !== null)
      .sort((a, b) => b.sharpeActual - a.sharpeActual)[0];
    
    const bestDaysToTarget = Object.values(comboStats)
      .filter(s => s.avgDaysToTarget !== null)
      .sort((a, b) => a.avgDaysToTarget - b.avgDaysToTarget)[0];
    
    markdown += `### Best Combinations\n\n`;
    markdown += `| Metric | Beta Win | Z-Score Win | Value |\n`;
    markdown += `|--------|----------|-------------|-------|\n`;
    
    if (bestBetaDrift) {
      markdown += `| **Lowest Beta Drift** | ${bestBetaDrift.betaWindow}d | ${bestBetaDrift.zScoreWindow}d | ${bestBetaDrift.avgBetaDrift.toFixed(4)} |\n`;
    }
    if (bestPredictionAccuracy) {
      markdown += `| **Best Prediction Accuracy** | ${bestPredictionAccuracy.betaWindow}d | ${bestPredictionAccuracy.zScoreWindow}d | ${bestPredictionAccuracy.avgAbsError.toFixed(2)}% error |\n`;
    }
    if (bestDaysToTarget) {
      markdown += `| **Fastest to Target** | ${bestDaysToTarget.betaWindow}d | ${bestDaysToTarget.zScoreWindow}d | ${bestDaysToTarget.avgDaysToTarget.toFixed(1)} days |\n`;
    }
    if (bestSharpe) {
      markdown += `| **Best Sharpe Ratio** | ${bestSharpe.betaWindow}d | ${bestSharpe.zScoreWindow}d | ${bestSharpe.sharpeActual.toFixed(2)} |\n`;
    }
    
    markdown += `\n### All Combinations\n\n`;
    markdown += `| Beta Win | Z-Score Win | Trades | Beta Drift | Avg Abs Error | Avg Days to Target | Avg Actual ROI | Sharpe |\n`;
    markdown += `|----------|-------------|--------|------------|---------------|-------------------|----------------|--------|\n`;
    
    const sortedCombos = Object.values(comboStats).sort((a, b) => {
      // Sort by beta window first, then z-score window
      if (a.betaWindow !== b.betaWindow) return a.betaWindow - b.betaWindow;
      return a.zScoreWindow - b.zScoreWindow;
    });
    
    for (const stats of sortedCombos) {
      markdown += `| ${stats.betaWindow}d | ${stats.zScoreWindow}d | ${stats.count} | `;
      markdown += stats.avgBetaDrift !== null ? stats.avgBetaDrift.toFixed(4) : 'N/A';
      markdown += ` | `;
      markdown += stats.avgAbsError !== null ? `${stats.avgAbsError.toFixed(2)}%` : 'N/A';
      markdown += ` | `;
      markdown += stats.avgDaysToTarget !== null ? `${stats.avgDaysToTarget.toFixed(1)}d` : 'N/A';
      markdown += ` | `;
      markdown += stats.avgActualROI !== null ? `${stats.avgActualROI.toFixed(2)}%` : 'N/A';
      markdown += ` | `;
      markdown += stats.sharpeActual !== null ? stats.sharpeActual.toFixed(2) : 'N/A';
      markdown += ` |\n`;
    }
    
    markdown += `\n`;
  }
  
  fs.writeFileSync(reportPath, markdown);
  console.log(`\n✅ Report saved to: ${reportPath}\n`);
}

// Run the analysis
if (require.main === module) {
  analyzeRollingWindows().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { analyzeRollingWindows };
