/**
 * Backtest Historical ROI Predictions
 * 
 * Queries Supabase for executed trades and calculates what ROI would have been
 * predicted at entry time, then compares to actual ROI.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { analyzePair } = require('../lib/pairAnalysis');
const { Hyperliquid } = require('hyperliquid');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Get price at a specific time (or closest candle) using shared SDK connection
 */
async function getPriceAtTime(symbol, timestamp, sdk) {
  try {
    // Fetch hourly candles around the timestamp (1 hour before to 1 hour after)
    const startTime = timestamp - (60 * 60 * 1000);
    const endTime = timestamp + (60 * 60 * 1000);
    
    const candles = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1h', startTime, endTime);
    
    if (!candles || candles.length === 0) {
      return null;
    }
    
    // Find closest candle to timestamp
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
    
    return parseFloat(closest.c); // Return close price
  } catch (error) {
    return null;
  }
}

/**
 * Calculate predicted ROI at entry time using historical data
 */
async function calculatePredictedROI(symbol1, symbol2, entryTime, direction, entryZScore) {
  try {
    // Analyze pair using data up to entry time (historical backtest)
    const config = {
      symbol1,
      symbol2,
      direction: direction || 'long',
      timeframes: [30], // Use 30-day for ROI calculation
      cutoffTime: entryTime.getTime() // Only use data up to entry time
    };
    
    const result = await analyzePair(config);
    
    // Get stdDevSpread and half-life for ROI calculation
    const tf30d = result.timeframes?.[30];
    const stdDevSpread = tf30d?.stdDevSpread;
    const halfLife = result.standardized?.halfLife30d;
    
    if (!stdDevSpread || entryZScore === null || entryZScore === undefined) {
      return {
        predictedROI: null,
        predictedTime: null,
        zScore: null,
        error: 'Missing data for ROI calculation'
      };
    }
    
    // Calculate ROI from entry z-score (not current z-score)
    const entryZ = Math.abs(entryZScore);
    const fixedExitZ = 0.5;
    
    if (entryZ <= fixedExitZ) {
      return {
        predictedROI: 0,
        predictedTime: 0,
        zScore: entryZScore,
        error: 'Entry z-score too low for mean reversion trade'
      };
    }
    
    // Calculate spread change from entry z to exit z (assuming mean reversion to 0.5)
    const zChange = entryZ - fixedExitZ;
    const spreadChange = zChange * stdDevSpread;
    
    // Convert from log space to percentage: ROI = (exp(spreadChange) - 1) * 100
    // NOTE: This assumes successful mean reversion to 0.5 z-score
    // If the trade diverges further (z increases), actual ROI will be negative
    let predictedROI = (Math.exp(spreadChange) - 1) * 100;
    
    // Calculate time to reversion
    let predictedTime = null;
    if (halfLife && halfLife > 0) {
      const timeToFixed = halfLife * Math.log(entryZ / fixedExitZ) / Math.log(2);
      if (timeToFixed > 0 && isFinite(timeToFixed) && timeToFixed < 1000) {
        predictedTime = timeToFixed;
      }
    }
    
    // Percentage-based exit (50% of entry z)
    const percentExitZ = entryZ * 0.5;
    const zChangePercent = entryZ - percentExitZ;
    const spreadChangePercent = zChangePercent * stdDevSpread;
    const predictedROIPercent = (Math.exp(spreadChangePercent) - 1) * 100;
    
    return {
      predictedROI,
      predictedROIPercent,
      predictedTime,
      zScore: entryZScore, // Return actual entry z-score
      exitZ: fixedExitZ,
      stdDevSpread, // Return for use in actual exit calculations
      entryZ, // Return for use in actual exit calculations
      betaAtEntry: tf30d?.beta ?? null // Return beta at entry time
    };
  } catch (error) {
    return {
      predictedROI: null,
      error: error.message
    };
  }
}

/**
 * Query Supabase for trades and backtest ROI predictions
 */
async function backtestTrades(options = {}) {
  const {
    symbol1 = null,
    symbol2 = null,
    limit = 100,
    startDate = null,
    endDate = null
  } = options;
  
  console.log('Querying Supabase for closed trades from trade_history...');
  
  // Build query - using trade_history table for closed trades
  let query = supabase
    .from('trade_history')
    .select('*')
    .order('entry_time', { ascending: false })
    .limit(limit);
  
  // Add filters if provided
  if (symbol1) {
    query = query.eq('asset1', symbol1.toUpperCase());
  }
  if (symbol2) {
    query = query.eq('asset2', symbol2.toUpperCase());
  }
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
    console.log('No closed trades found in trade_history');
    return [];
  }
  
  console.log(`Found ${trades.length} closed trades. Backtesting ROI predictions...\n`);
  
  const tradesToAnalyze = trades;
  
  const results = [];
  
  for (const trade of tradesToAnalyze) {
    // Using trade_history schema
    const entryTime = new Date(trade.entry_time);
    const exitTime = trade.exit_time ? new Date(trade.exit_time) : null;
    const symbol1 = trade.asset1;
    const symbol2 = trade.asset2;
    const direction = trade.direction || 'long';
    // total_pnl is already in percentage form (e.g., 3.0044 = 3.0044%)
    const actualROI = trade.total_pnl !== null && trade.total_pnl !== undefined 
      ? trade.total_pnl 
      : null;
    const entryZScore = trade.entry_z_score;
    const exitZScore = trade.exit_z_score;
    const exitReason = trade.exit_reason;
    const daysInTrade = trade.days_in_trade;
    
    console.log(`\nTrade: ${symbol1}/${symbol2}`);
    console.log(`  Entry: ${entryTime.toISOString()} (Z: ${entryZScore?.toFixed(2) || 'N/A'})`);
    if (exitTime) {
      console.log(`  Exit: ${exitTime.toISOString()} (Z: ${exitZScore?.toFixed(2) || 'N/A'}, Reason: ${exitReason || 'N/A'})`);
    }
    console.log(`  Duration: ${daysInTrade?.toFixed(1) || 'N/A'} days`);
    console.log(`  Direction: ${direction}`);
    if (actualROI !== null) {
      console.log(`  Actual ROI: ${actualROI.toFixed(2)}%`);
    }
    
    // Calculate predicted ROI at entry time using actual entry z-score
    const prediction = await calculatePredictedROI(symbol1, symbol2, entryTime, direction, entryZScore);
    
    if (prediction.error) {
      console.log(`  ⚠️  Error: ${prediction.error}`);
      results.push({
        trade,
        prediction: null,
        error: prediction.error
      });
      continue;
    }
    
    console.log(`  Predicted ROI (to 0.5z): ${prediction.predictedROI?.toFixed(2)}%`);
    if (prediction.predictedROIPercent !== null && prediction.predictedROIPercent !== undefined) {
      console.log(`  Predicted ROI (to 50% of entry z): ${prediction.predictedROIPercent.toFixed(2)}%`);
    }
    console.log(`  Entry Z-Score: ${prediction.zScore}`);
    
    // Calculate predicted ROI at actual exit z-score (this is what we compare against)
    let predictedROIAtActualExit = null;
    if (exitZScore !== null && exitZScore !== undefined && prediction.stdDevSpread && prediction.entryZ) {
      const actualExitZ = Math.abs(exitZScore);
      const actualZChange = prediction.entryZ - actualExitZ;
      const actualSpreadChange = actualZChange * prediction.stdDevSpread;
      predictedROIAtActualExit = (Math.exp(actualSpreadChange) - 1) * 100;
      console.log(`  Predicted ROI (to actual exit z=${exitZScore.toFixed(2)}): ${predictedROIAtActualExit.toFixed(2)}%`);
    }
    
    // Use predicted ROI at actual exit for error calculation (more accurate than 0.5z assumption)
    const predictedROIForComparison = predictedROIAtActualExit !== null ? predictedROIAtActualExit : prediction.predictedROI;
    const diff = actualROI !== null ? actualROI - predictedROIForComparison : null;
    const diffPercent = actualROI !== null && predictedROIForComparison !== null
      ? ((actualROI - predictedROIForComparison) / Math.abs(predictedROIForComparison)) * 100
      : null;
    
    // Calculate beta at exit time to check for beta drift
    let betaAtExit = null;
    if (exitTime) {
      try {
        const exitConfig = {
          symbol1,
          symbol2,
          direction: direction || 'long',
          timeframes: [30],
          cutoffTime: exitTime.getTime() // Only use data up to exit time
        };
        const exitResult = await analyzePair(exitConfig);
        betaAtExit = exitResult.timeframes?.[30]?.beta ?? null;
      } catch (e) {
        // Ignore errors - beta at exit is optional
      }
    }
    
    // Display beta comparison
    if (prediction.betaAtEntry !== null && betaAtExit !== null) {
      const betaChange = betaAtExit - prediction.betaAtEntry;
      const betaChangePercent = prediction.betaAtEntry !== 0 
        ? (betaChange / Math.abs(prediction.betaAtEntry)) * 100 
        : null;
      console.log(`  Beta at Entry: ${prediction.betaAtEntry.toFixed(4)}`);
      console.log(`  Beta at Exit: ${betaAtExit.toFixed(4)}`);
      console.log(`  Beta Change: ${betaChange > 0 ? '+' : ''}${betaChange.toFixed(4)} ${betaChangePercent !== null ? `(${betaChangePercent > 0 ? '+' : ''}${betaChangePercent.toFixed(1)}%)` : ''}`);
      
      // If beta changed significantly, note it
      if (Math.abs(betaChangePercent) > 10) {
        console.log(`  ⚠️  Significant beta drift detected - this likely explains ROI discrepancy`);
      }
    } else if (prediction.betaAtEntry !== null) {
      console.log(`  Beta at Entry: ${prediction.betaAtEntry.toFixed(4)}`);
    }
    
    // Calculate actual price movements to check path dependency
    if (exitTime) {
      try {
        // Suppress WebSocket noise
        const originalLog = console.log;
        const originalError = console.error;
        const noop = () => {};
        console.log = noop;
        console.error = noop;
        
        const sdk = new Hyperliquid();
        await sdk.connect();
        
        // Restore console for our messages
        console.log = originalLog;
        console.error = originalError;
        
        console.log(`  Fetching price movements...`);
        const [entryPrice1, entryPrice2, exitPrice1, exitPrice2] = await Promise.all([
          getPriceAtTime(symbol1, entryTime.getTime(), sdk),
          getPriceAtTime(symbol2, entryTime.getTime(), sdk),
          getPriceAtTime(symbol1, exitTime.getTime(), sdk),
          getPriceAtTime(symbol2, exitTime.getTime(), sdk)
        ]);
        
        // Suppress again for disconnect
        console.log = noop;
        console.error = noop;
        await sdk.disconnect();
        console.log = originalLog;
        console.error = originalError;
        
        if (entryPrice1 && entryPrice2 && exitPrice1 && exitPrice2) {
          const priceChange1 = ((exitPrice1 - entryPrice1) / entryPrice1) * 100;
          const priceChange2 = ((exitPrice2 - entryPrice2) / entryPrice2) * 100;
          
          console.log(`  ${symbol1} Price: ${entryPrice1.toFixed(4)} → ${exitPrice1.toFixed(4)} (${priceChange1 > 0 ? '+' : ''}${priceChange1.toFixed(2)}%)`);
          console.log(`  ${symbol2} Price: ${entryPrice2.toFixed(4)} → ${exitPrice2.toFixed(4)} (${priceChange2 > 0 ? '+' : ''}${priceChange2.toFixed(2)}%)`);
          
          const movementDiff = Math.abs(priceChange1) - Math.abs(priceChange2);
          if (Math.abs(movementDiff) > 2) {
            const dominantToken = Math.abs(priceChange1) > Math.abs(priceChange2) ? symbol1 : symbol2;
            console.log(`  ⚠️  Path dependency: ${dominantToken} moved ${Math.abs(movementDiff).toFixed(2)}% more - explains ROI discrepancy`);
          }
        }
      } catch (e) {
        // Ignore errors - price movement analysis is optional
        console.log(`  (Price movement analysis failed: ${e.message})`);
      }
    }
    
    if (diff !== null) {
      console.log(`  Difference: ${diff.toFixed(2)}% (${diffPercent?.toFixed(1)}% error)`);
    }
    
    results.push({
      trade,
      prediction,
      actualROI,
      predictedROIAtActualExit,
      diff,
      diffPercent,
      betaAtEntry: prediction.betaAtEntry,
      betaAtExit: betaAtExit
    });
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}

/**
 * Generate summary statistics and markdown report
 */
function generateSummary(results, options = {}) {
  const validResults = results.filter(r => r.prediction && r.actualROI !== null && !r.error);
  
  if (validResults.length === 0) {
    console.log('\nNo valid results for summary');
    return null;
  }
  
  const diffs = validResults.map(r => r.diff);
  const absDiffs = diffs.map(d => Math.abs(d));
  
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const avgAbsDiff = absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length;
  const maxOverestimate = Math.max(...diffs);
  const maxUnderestimate = Math.min(...diffs);
  
  // Accuracy buckets
  const within5 = validResults.filter(r => Math.abs(r.diff) <= 5).length;
  const within10 = validResults.filter(r => Math.abs(r.diff) <= 10).length;
  const within20 = validResults.filter(r => Math.abs(r.diff) <= 20).length;
  
  // Console output
  console.log('\n' + '='.repeat(60));
  console.log('BACKTEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total trades analyzed: ${validResults.length}`);
  console.log(`Average prediction error: ${avgDiff.toFixed(2)}%`);
  console.log(`Average absolute error: ${avgAbsDiff.toFixed(2)}%`);
  console.log(`Max overestimate: ${maxOverestimate.toFixed(2)}%`);
  console.log(`Max underestimate: ${maxUnderestimate.toFixed(2)}%`);
  console.log(`\nAccuracy:`);
  console.log(`  Within 5%: ${within5} (${(within5/validResults.length*100).toFixed(1)}%)`);
  console.log(`  Within 10%: ${within10} (${(within10/validResults.length*100).toFixed(1)}%)`);
  console.log(`  Within 20%: ${within20} (${(within20/validResults.length*100).toFixed(1)}%)`);
  
  // Generate markdown report
  let report = `# ROI Backtest Report\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  if (options.symbol1 && options.symbol2) {
    report += `**Filter:** ${options.symbol1}/${options.symbol2}\n`;
  } else {
    report += `**Filter:** All pairs\n`;
  }
  report += `**Total Trades Analyzed:** ${validResults.length}\n\n`;
  
  report += `## Summary Statistics\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Average Prediction Error | ${avgDiff.toFixed(2)}% |\n`;
  report += `| Average Absolute Error | ${avgAbsDiff.toFixed(2)}% |\n`;
  report += `| Max Overestimate | ${maxOverestimate.toFixed(2)}% |\n`;
  report += `| Max Underestimate | ${maxUnderestimate.toFixed(2)}% |\n\n`;
  
  report += `## Accuracy\n\n`;
  report += `| Threshold | Count | Percentage |\n`;
  report += `|-----------|-------|------------|\n`;
  report += `| Within 5% | ${within5} | ${(within5/validResults.length*100).toFixed(1)}% |\n`;
  report += `| Within 10% | ${within10} | ${(within10/validResults.length*100).toFixed(1)}% |\n`;
  report += `| Within 20% | ${within20} | ${(within20/validResults.length*100).toFixed(1)}% |\n\n`;
  
  report += `## Individual Trade Results\n\n`;
  report += `| Pair | Entry Time | Entry Z | Exit Z | Direction | Actual ROI | Predicted ROI | Difference | Error % | Beta Entry | Beta Exit | Beta Δ |\n`;
  report += `|------|------------|---------|--------|-----------|------------|---------------|------------|--------|-----------|----------|-------|\n`;
  
  validResults.forEach(r => {
    const trade = r.trade;
    const entryTime = new Date(trade.entry_time).toISOString().split('T')[0];
    const betaEntry = r.betaAtEntry !== null ? r.betaAtEntry.toFixed(4) : 'N/A';
    const betaExit = r.betaAtExit !== null ? r.betaAtExit.toFixed(4) : 'N/A';
    const betaChange = r.betaAtEntry !== null && r.betaAtExit !== null 
      ? (r.betaAtExit - r.betaAtEntry).toFixed(4) 
      : 'N/A';
    report += `| ${trade.asset1}/${trade.asset2} | ${entryTime} | ${trade.entry_z_score?.toFixed(2) || 'N/A'} | ${trade.exit_z_score?.toFixed(2) || 'N/A'} | ${trade.direction || 'N/A'} | ${r.actualROI?.toFixed(2)}% | ${r.prediction?.predictedROI?.toFixed(2)}% | ${r.diff?.toFixed(2)}% | ${r.diffPercent?.toFixed(1)}% | ${betaEntry} | ${betaExit} | ${betaChange} |\n`;
  });
  
  // Add errors section if any
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    report += `\n## Errors\n\n`;
    errors.forEach(r => {
      report += `- **${r.trade.asset1}/${r.trade.asset2}** (${new Date(r.trade.entry_time).toISOString().split('T')[0]}): ${r.error}\n`;
    });
  }
  
  return report;
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  // Usage: npm run backtest-roi [SYMBOL1] [SYMBOL2] [LIMIT]
  // Examples:
  //   npm run backtest-roi                    # All trades, limit 50
  //   npm run backtest-roi 100                 # All trades, limit 100
  //   npm run backtest-roi kBONK PNUT          # kBONK/PNUT trades only, limit 50
  //   npm run backtest-roi kBONK PNUT 20       # kBONK/PNUT trades, limit 20
  
  let symbol1 = null;
  let symbol2 = null;
  let limit = 50;
  
  if (args.length === 1) {
    // Just limit provided
    limit = parseInt(args[0]) || 50;
  } else if (args.length === 2) {
    // Two symbols provided
    symbol1 = args[0];
    symbol2 = args[1];
  } else if (args.length >= 3) {
    // All three provided
    symbol1 = args[0];
    symbol2 = args[1];
    limit = parseInt(args[2]) || 50;
  }
  
  const options = {
    symbol1,
    symbol2,
    limit
  };
  
  console.log('Backtest Options:');
  if (symbol1 && symbol2) {
    console.log(`  Filter: ${symbol1}/${symbol2}`);
  } else {
    console.log(`  Filter: All pairs`);
  }
  console.log(`  Limit: ${limit} trades\n`);
  
  try {
    const results = await backtestTrades(options);
    const report = generateSummary(results, options);
    
    // Save report to file
    if (report) {
      const outputDir = 'backtest_reports';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const pairFilter = options.symbol1 && options.symbol2 
        ? `${options.symbol1}_${options.symbol2}` 
        : 'ALL';
      const filename = `backtest_${pairFilter}_${timestamp}.md`;
      const filepath = path.join(outputDir, filename);
      
      fs.writeFileSync(filepath, report);
      console.log(`\nReport saved: ${filepath}`);
    }
  } catch (error) {
    console.error('Backtest failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { backtestTrades, calculatePredictedROI, generateSummary };

