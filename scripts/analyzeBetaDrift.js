/**
 * Analyze Beta Drift Patterns
 * 
 * Analyzes ROI backtest data to see if beta drift correlates with:
 * - Prediction errors
 * - Actual losses
 * - Diverging trades
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

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

// Parse markdown table
function parseReport(reportPath) {
  const content = fs.readFileSync(reportPath, 'utf8');
  const lines = content.split('\n');
  
  // Find the table header
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('| Pair | Entry Time |')) {
      headerIndex = i;
      break;
    }
  }
  
  if (headerIndex === -1) {
    throw new Error('Could not find table header');
  }
  
  const trades = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|') || line === '|------|') continue;
    if (line.includes('##')) break; // End of table
    
    const cols = line.split('|').map(c => c.trim()).filter(c => c);
    if (cols.length < 12) continue;
    
    const trade = {
      pair: cols[0],
      entryTime: cols[1],
      entryZ: parseFloat(cols[2]) || null,
      exitZ: cols[3] === 'N/A' ? null : parseFloat(cols[3]) || null,
      direction: cols[4],
      actualROI: parseFloat(cols[5]) || null,
      predictedROI: parseFloat(cols[6]) || null,
      difference: parseFloat(cols[7]) || null,
      errorPercent: parseFloat(cols[8]) || null,
      betaEntry: parseFloat(cols[9]) || null,
      betaExit: parseFloat(cols[10]) || null,
      betaDelta: parseFloat(cols[11]) || null
    };
    
    // Calculate absolute beta drift
    if (trade.betaDelta !== null) {
      trade.absBetaDrift = Math.abs(trade.betaDelta);
    } else if (trade.betaEntry !== null && trade.betaExit !== null) {
      trade.absBetaDrift = Math.abs(trade.betaExit - trade.betaEntry);
    } else {
      trade.absBetaDrift = null;
    }
    
    // Calculate percent beta drift
    if (trade.betaEntry !== null && trade.betaEntry !== 0 && trade.absBetaDrift !== null) {
      trade.percentBetaDrift = (trade.absBetaDrift / Math.abs(trade.betaEntry)) * 100;
    } else {
      trade.percentBetaDrift = null;
    }
    
    // Check if diverged (exit Z further from mean than entry Z)
    if (trade.entryZ !== null && trade.exitZ !== null) {
      const absEntryZ = Math.abs(trade.entryZ);
      const absExitZ = Math.abs(trade.exitZ);
      trade.diverged = absExitZ > absEntryZ;
    } else {
      trade.diverged = null;
    }
    
    // Check if won
    trade.won = trade.actualROI !== null && trade.actualROI > 0;
    
    trades.push(trade);
  }
  
  return trades;
}

function analyzeBetaDrift(trades) {
  // Filter out trades without beta drift data
  const validTrades = trades.filter(t => t.absBetaDrift !== null);
  
  console.log(`\nAnalyzing ${validTrades.length} trades with beta drift data\n`);
  
  // Group by beta drift ranges
  const ranges = [
    { label: '0.00-0.01', min: 0, max: 0.01 },
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
    
    const winners = tradesInRange.filter(t => t.won);
    const losers = tradesInRange.filter(t => !t.won);
    const diverged = tradesInRange.filter(t => t.diverged === true);
    
    const avgROI = tradesInRange.reduce((sum, t) => sum + (t.actualROI || 0), 0) / tradesInRange.length;
    const avgError = tradesInRange.reduce((sum, t) => sum + Math.abs(t.errorPercent || 0), 0) / tradesInRange.length;
    const avgAbsError = tradesInRange.reduce((sum, t) => sum + Math.abs(t.difference || 0), 0) / tradesInRange.length;
    
    results[range.label] = {
      count: tradesInRange.length,
      winRate: (winners.length / tradesInRange.length) * 100,
      avgROI,
      avgError,
      avgAbsError,
      divergedCount: diverged.length,
      divergedPercent: (diverged.length / tradesInRange.length) * 100
    };
  }
  
  // Also analyze by percent beta drift
  const percentRanges = [
    { label: '0-5%', min: 0, max: 5 },
    { label: '5-10%', min: 5, max: 10 },
    { label: '10-20%', min: 10, max: 20 },
    { label: '20-50%', min: 20, max: 50 },
    { label: '50%+', min: 50, max: Infinity }
  ];
  
  const percentResults = {};
  
  for (const range of percentRanges) {
    const tradesInRange = validTrades.filter(t => 
      t.percentBetaDrift !== null &&
      t.percentBetaDrift >= range.min && t.percentBetaDrift < range.max
    );
    
    if (tradesInRange.length === 0) continue;
    
    const winners = tradesInRange.filter(t => t.won);
    const diverged = tradesInRange.filter(t => t.diverged === true);
    
    const avgROI = tradesInRange.reduce((sum, t) => sum + (t.actualROI || 0), 0) / tradesInRange.length;
    const avgError = tradesInRange.reduce((sum, t) => sum + Math.abs(t.errorPercent || 0), 0) / tradesInRange.length;
    
    percentResults[range.label] = {
      count: tradesInRange.length,
      winRate: (winners.length / tradesInRange.length) * 100,
      avgROI,
      avgError,
      divergedCount: diverged.length,
      divergedPercent: (diverged.length / tradesInRange.length) * 100
    };
  }
  
  // Find worst trades by beta drift
  const sortedByDrift = [...validTrades].sort((a, b) => (b.absBetaDrift || 0) - (a.absBetaDrift || 0));
  const worst10 = sortedByDrift.slice(0, 10);
  
  return {
    absolute: results,
    percent: percentResults,
    worstTrades: worst10
  };
}

function generateReport(analysis) {
  let report = `# Beta Drift Analysis\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  report += `## Analysis by Absolute Beta Drift\n\n`;
  report += `| Beta Drift Range | Trades | Win Rate | Avg ROI | Avg Error % | Avg Abs Error | Diverged | Diverged % |\n`;
  report += `|------------------|--------|----------|---------|-------------|---------------|----------|------------|\n`;
  
  for (const [range, stats] of Object.entries(analysis.absolute)) {
    report += `| ${range} | ${stats.count} | ${stats.winRate.toFixed(1)}% | ${stats.avgROI.toFixed(2)}% | ${stats.avgError.toFixed(1)}% | ${stats.avgAbsError.toFixed(2)}% | ${stats.divergedCount} | ${stats.divergedPercent.toFixed(1)}% |\n`;
  }
  
  report += `\n## Analysis by Percent Beta Drift\n\n`;
  report += `| Beta Drift % | Trades | Win Rate | Avg ROI | Avg Error % | Diverged | Diverged % |\n`;
  report += `|--------------|--------|----------|---------|-------------|----------|------------|\n`;
  
  for (const [range, stats] of Object.entries(analysis.percent)) {
    report += `| ${range} | ${stats.count} | ${stats.winRate.toFixed(1)}% | ${stats.avgROI.toFixed(2)}% | ${stats.avgError.toFixed(1)}% | ${stats.divergedCount} | ${stats.divergedPercent.toFixed(1)}% |\n`;
  }
  
  report += `\n## Top 10 Trades by Beta Drift\n\n`;
  report += `| Pair | Beta Entry | Beta Exit | Beta Δ | % Drift | Actual ROI | Won | Diverged |\n`;
  report += `|------|-----------|-----------|--------|---------|------------|-----|----------|\n`;
  
  for (const trade of analysis.worstTrades) {
    const percent = trade.percentBetaDrift !== null ? trade.percentBetaDrift.toFixed(1) + '%' : 'N/A';
    report += `| ${trade.pair} | ${trade.betaEntry?.toFixed(4) || 'N/A'} | ${trade.betaExit?.toFixed(4) || 'N/A'} | ${trade.absBetaDrift?.toFixed(4) || 'N/A'} | ${percent} | ${trade.actualROI?.toFixed(2) || 'N/A'}% | ${trade.won ? 'Yes' : 'No'} | ${trade.diverged ? 'Yes' : 'No'} |\n`;
  }
  
  // Key findings
  report += `\n## Key Findings\n\n`;
  
  const absoluteEntries = Object.entries(analysis.absolute);
  if (absoluteEntries.length > 0) {
    const lowDrift = absoluteEntries.find(([r]) => r.includes('0.00-0.01'));
    const highDrift = absoluteEntries.find(([r]) => r.includes('0.20+'));
    
    if (lowDrift && highDrift) {
      const low = lowDrift[1];
      const high = highDrift[1];
      
      report += `- **Low drift (0.00-0.01):** ${low.winRate.toFixed(1)}% win rate, ${low.avgROI.toFixed(2)}% avg ROI\n`;
      report += `- **High drift (0.20+):** ${high.winRate.toFixed(1)}% win rate, ${high.avgROI.toFixed(2)}% avg ROI\n`;
      
      if (high.winRate < low.winRate || high.avgROI < low.avgROI) {
        report += `- **Conclusion:** High beta drift correlates with worse performance\n`;
      }
    }
  }
  
  return report;
}

async function main() {
  try {
    const reportPath = findLatestROIReport();
    console.log(`Reading: ${reportPath}`);
    
    const trades = parseReport(reportPath);
    console.log(`Parsed ${trades.length} trades`);
    
    const analysis = analyzeBetaDrift(trades);
    const report = generateReport(analysis);
    
    // Save report
    const outputDir = 'backtest_reports';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `beta_drift_analysis_${timestamp}.md`;
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

module.exports = { analyzeBetaDrift, parseReport };

