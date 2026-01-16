/**
 * Analyze Prediction Confidence by Beta Drift
 * 
 * Calculates:
 * - Average predicted ROI
 * - Confidence intervals (95%, 90%, 80%) for predictions by beta drift
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseReport } = require('./analyzeBetaDrift');

// Find most recent ROI backtest report
function findLatestROIReport() {
  const reportsDir = 'backtest_reports';
  if (!fs.existsSync(reportsDir)) {
    throw new Error('backtest_reports directory not found');
  }
  
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('backtest_ALL_') && f.endsWith('.md'))
    .sort()
    .reverse();
  
  if (files.length === 0) {
    throw new Error('No ROI backtest reports found');
  }
  
  return path.join(reportsDir, files[0]);
}

function calculateConfidenceIntervals(trades) {
  const validTrades = trades.filter(t => 
    t.predictedROI !== null && 
    t.actualROI !== null && 
    t.absBetaDrift !== null
  );
  
  // Calculate overall stats
  const avgPredictedROI = validTrades.reduce((sum, t) => sum + (t.predictedROI || 0), 0) / validTrades.length;
  const avgActualROI = validTrades.reduce((sum, t) => sum + (t.actualROI || 0), 0) / validTrades.length;
  
  // Group by beta drift ranges
  const ranges = [
    { label: '<0.01', min: 0, max: 0.01 },
    { label: '0.01-0.05', min: 0.01, max: 0.05 },
    { label: '0.05-0.10', min: 0.05, max: 0.10 },
    { label: '0.10-0.20', min: 0.10, max: 0.20 },
    { label: '0.20+', min: 0.20, max: Infinity }
  ];
  
  const results = {};
  
  for (const range of ranges) {
    const tradesInRange = validTrades.filter(t => 
      t.absBetaDrift >= range.min && t.absBetaDrift < range.max
    );
    
    if (tradesInRange.length === 0) continue;
    
    // Calculate errors (actual - predicted)
    const errors = tradesInRange.map(t => (t.actualROI || 0) - (t.predictedROI || 0));
    const absErrors = errors.map(e => Math.abs(e));
    
    // Sort for percentile calculation
    const sortedErrors = [...absErrors].sort((a, b) => a - b);
    
    // Calculate percentiles (confidence intervals)
    const percentile = (arr, p) => {
      const index = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, Math.min(index, arr.length - 1))];
    };
    
    const p80 = percentile(sortedErrors, 80);
    const p90 = percentile(sortedErrors, 90);
    const p95 = percentile(sortedErrors, 95);
    
    // Calculate mean and std dev of errors
    const meanError = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    const variance = errors.reduce((sum, e) => sum + Math.pow(e - meanError, 2), 0) / errors.length;
    const stdDev = Math.sqrt(variance);
    
    // Calculate avg predicted ROI for this range
    const avgPredROI = tradesInRange.reduce((sum, t) => sum + (t.predictedROI || 0), 0) / tradesInRange.length;
    const avgAbsError = absErrors.reduce((sum, e) => sum + e, 0) / absErrors.length;
    
    results[range.label] = {
      count: tradesInRange.length,
      avgPredictedROI: avgPredROI,
      avgActualROI: tradesInRange.reduce((sum, t) => sum + (t.actualROI || 0), 0) / tradesInRange.length,
      avgAbsError: avgAbsError,
      meanError: meanError,
      stdDev: stdDev,
      confidence80: p80,
      confidence90: p90,
      confidence95: p95,
      // Example: if predicted 5% ROI, 95% confidence interval would be 5% ± p95
      // So actual ROI likely falls between (5% - p95) and (5% + p95)
    };
  }
  
  return {
    overall: {
      avgPredictedROI,
      avgActualROI,
      totalTrades: validTrades.length
    },
    byDrift: results
  };
}

function generateReport(analysis) {
  let report = `# Prediction Confidence Analysis by Beta Drift\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  report += `## Overall Statistics\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Total Trades | ${analysis.overall.totalTrades} |\n`;
  report += `| Average Predicted ROI | ${analysis.overall.avgPredictedROI.toFixed(2)}% |\n`;
  report += `| Average Actual ROI | ${analysis.overall.avgActualROI.toFixed(2)}% |\n\n`;
  
  report += `## Confidence Intervals by Beta Drift\n\n`;
  report += `**Interpretation:** If predicted ROI is X%, there's an 80%/90%/95% chance actual ROI falls within X% ± the confidence interval.\n\n`;
  
  report += `| Beta Drift | Trades | Avg Pred ROI | Avg Abs Error | 80% CI | 90% CI | 95% CI |\n`;
  report += `|------------|--------|---------------|---------------|--------|--------|--------|\n`;
  
  for (const [range, stats] of Object.entries(analysis.byDrift)) {
    report += `| ${range} | ${stats.count} | ${stats.avgPredictedROI.toFixed(2)}% | ${stats.avgAbsError.toFixed(2)}% | ±${stats.confidence80.toFixed(2)}% | ±${stats.confidence90.toFixed(2)}% | ±${stats.confidence95.toFixed(2)}% |\n`;
  }
  
  report += `\n## Example Predictions\n\n`;
  
  // Example: if predicted 5% ROI with different beta drift levels
  const examplePredicted = 5.0;
  
  report += `**If predicted ROI = ${examplePredicted}%:**\n\n`;
  report += `| Beta Drift | 80% Confidence Range | 90% Confidence Range | 95% Confidence Range |\n`;
  report += `|------------|---------------------|---------------------|---------------------|\n`;
  
  for (const [range, stats] of Object.entries(analysis.byDrift)) {
    const ci80_low = (examplePredicted - stats.confidence80).toFixed(2);
    const ci80_high = (examplePredicted + stats.confidence80).toFixed(2);
    const ci90_low = (examplePredicted - stats.confidence90).toFixed(2);
    const ci90_high = (examplePredicted + stats.confidence90).toFixed(2);
    const ci95_low = (examplePredicted - stats.confidence95).toFixed(2);
    const ci95_high = (examplePredicted + stats.confidence95).toFixed(2);
    
    report += `| ${range} | ${ci80_low}% to ${ci80_high}% | ${ci90_low}% to ${ci90_high}% | ${ci95_low}% to ${ci95_high}% |\n`;
  }
  
  report += `\n## Key Findings\n\n`;
  
  const veryLow = analysis.byDrift['<0.01'];
  const medium = analysis.byDrift['0.05-0.10'];
  const high = analysis.byDrift['0.10-0.20'];
  
  if (veryLow && medium) {
    report += `- **Very low drift (<0.01):** Avg predicted ROI ${veryLow.avgPredictedROI.toFixed(2)}%, avg abs error ${veryLow.avgAbsError.toFixed(2)}%\n`;
    report += `  - 95% confidence: ±${veryLow.confidence95.toFixed(2)}% (if predicted 5%, actual likely between ${(5 - veryLow.confidence95).toFixed(2)}% and ${(5 + veryLow.confidence95).toFixed(2)}%)\n`;
    report += `- **Medium drift (0.05-0.10):** Avg predicted ROI ${medium.avgPredictedROI.toFixed(2)}%, avg abs error ${medium.avgAbsError.toFixed(2)}%\n`;
    report += `  - 95% confidence: ±${medium.confidence95.toFixed(2)}% (if predicted 5%, actual likely between ${(5 - medium.confidence95).toFixed(2)}% and ${(5 + medium.confidence95).toFixed(2)}%)\n`;
    
    if (high) {
      report += `- **High drift (0.10-0.20):** Avg predicted ROI ${high.avgPredictedROI.toFixed(2)}%, avg abs error ${high.avgAbsError.toFixed(2)}%\n`;
      report += `  - 95% confidence: ±${high.confidence95.toFixed(2)}% (if predicted 5%, actual likely between ${(5 - high.confidence95).toFixed(2)}% and ${(5 + high.confidence95).toFixed(2)}%)\n`;
    }
  }
  
  report += `\n**Conclusion:** 1.77% avg abs error is ${veryLow ? (veryLow.avgAbsError / analysis.overall.avgPredictedROI * 100).toFixed(1) : 'N/A'}% of average predicted ROI (${analysis.overall.avgPredictedROI.toFixed(2)}%). `;
  report += `For very low drift trades, 95% of predictions are within ±${veryLow ? veryLow.confidence95.toFixed(2) : 'N/A'}% of predicted value.\n`;
  
  return report;
}

async function main() {
  try {
    const reportPath = findLatestROIReport();
    console.log(`Reading: ${reportPath}`);
    
    const trades = parseReport(reportPath);
    console.log(`Parsed ${trades.length} trades`);
    
    const analysis = calculateConfidenceIntervals(trades);
    const report = generateReport(analysis);
    
    // Save report
    const outputDir = 'backtest_reports';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `prediction_confidence_${timestamp}.md`;
    const filepath = path.join(outputDir, filename);
    
    fs.writeFileSync(filepath, report);
    console.log(`\nReport saved: ${filepath}`);
    console.log(report);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { calculateConfidenceIntervals };

