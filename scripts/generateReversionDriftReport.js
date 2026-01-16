/**
 * Generate comprehensive report from trade reversion and drift analysis
 */

const fs = require('fs');
const path = require('path');

function generateReport(resultsFile) {
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  
  let report = `# Trade Reversion & Beta Drift Analysis\n\n`;
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `Total Trades: ${results.length}\n\n`;
  
  // Overall stats
  const winners = results.filter(r => r.won);
  const losers = results.filter(r => !r.won);
  const avgROI = results.reduce((sum, r) => sum + r.actualROI, 0) / results.length;
  
  report += `## Overall Performance\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Total Trades | ${results.length} |\n`;
  report += `| Win Rate | ${(winners.length / results.length * 100).toFixed(1)}% |\n`;
  report += `| Avg ROI | ${avgROI.toFixed(2)}% |\n`;
  report += `| Winners Avg ROI | ${(winners.reduce((sum, r) => sum + r.actualROI, 0) / winners.length).toFixed(2)}% |\n`;
  report += `| Losers Avg ROI | ${(losers.reduce((sum, r) => sum + r.actualROI, 0) / losers.length).toFixed(2)}% |\n\n`;
  
  // Historical reversion analysis
  const withHist = results.filter(r => r.historicalReversion?.fixedReversionRate !== null);
  if (withHist.length > 0) {
    report += `## Historical Reversion vs Performance\n\n`;
    report += `| Hist Rev Range | Trades | Win Rate | Avg ROI |\n`;
    report += `|----------------|--------|----------|---------|\n`;
    
    const ranges = [
      { label: '0-40%', min: 0, max: 40 },
      { label: '40-60%', min: 40, max: 60 },
      { label: '60-80%', min: 60, max: 80 },
      { label: '80-100%', min: 80, max: 101 }
    ];
    
    for (const range of ranges) {
      const filtered = withHist.filter(r => {
        const rate = r.historicalReversion.fixedReversionRate;
        return rate >= range.min && rate < range.max;
      });
      if (filtered.length === 0) continue;
      
      const wins = filtered.filter(r => r.won).length;
      const avgROI = filtered.reduce((sum, r) => sum + r.actualROI, 0) / filtered.length;
      
      report += `| ${range.label} | ${filtered.length} | ${(wins / filtered.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% |\n`;
    }
    
    // Percent reversion
    report += `\n### Percent Reversion (50% of threshold)\n\n`;
    report += `| Hist Rev Range | Trades | Win Rate | Avg ROI |\n`;
    report += `|----------------|--------|----------|---------|\n`;
    
    for (const range of ranges) {
      const filtered = withHist.filter(r => {
        const rate = r.historicalReversion.percentReversionRate;
        return rate !== null && rate >= range.min && rate < range.max;
      });
      if (filtered.length === 0) continue;
      
      const wins = filtered.filter(r => r.won).length;
      const avgROI = filtered.reduce((sum, r) => sum + r.actualROI, 0) / filtered.length;
      
      report += `| ${range.label} | ${filtered.length} | ${(wins / filtered.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% |\n`;
    }
  }
  
  // Beta drift analysis
  const withDrift = results.filter(r => r.hourlyBetaDrift?.maxBetaDrift !== null && r.hourlyBetaDrift?.maxBetaDrift !== undefined);
  if (withDrift.length > 0) {
    report += `\n## Beta Drift vs Performance\n\n`;
    report += `| Max Drift Range | Trades | Win Rate | Avg ROI | Avg Hist Rev |\n`;
    report += `|-----------------|--------|----------|---------|--------------|\n`;
    
    const driftRanges = [
      { label: '<0.01', min: 0, max: 0.01 },
      { label: '0.01-0.05', min: 0.01, max: 0.05 },
      { label: '0.05-0.10', min: 0.05, max: 0.10 },
      { label: '0.10-0.20', min: 0.10, max: 0.20 },
      { label: '0.20+', min: 0.20, max: Infinity }
    ];
    
    for (const range of driftRanges) {
      const filtered = withDrift.filter(r => {
        const drift = r.hourlyBetaDrift.maxBetaDrift;
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
    
    // Early drift (24h)
    const with24h = withDrift.filter(r => r.hourlyBetaDrift.driftAt24h !== null);
    if (with24h.length > 0) {
      report += `\n### Early Beta Drift (24h)\n\n`;
      report += `| 24h Drift Range | Trades | Win Rate | Avg ROI |\n`;
      report += `|-----------------|--------|----------|---------|\n`;
      
      for (const range of driftRanges) {
        const filtered = with24h.filter(r => {
          const drift = r.hourlyBetaDrift.driftAt24h;
          return drift !== null && drift >= range.min && drift < range.max;
        });
        if (filtered.length === 0) continue;
        
        const wins = filtered.filter(r => r.won).length;
        const avgROI = filtered.reduce((sum, r) => sum + r.actualROI, 0) / filtered.length;
        
        report += `| ${range.label} | ${filtered.length} | ${(wins / filtered.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% |\n`;
      }
    }
  }
  
  // ROI trajectory analysis
  const withROI = results.filter(r => r.hourlyBetaDrift?.maxROI !== null && r.hourlyBetaDrift?.maxROI !== undefined);
  if (withROI.length > 0) {
    report += `\n## ROI Trajectory Analysis\n\n`;
    
    // ROI at 24h/48h
    const with24hROI = withROI.filter(r => r.hourlyBetaDrift.roiAt24h !== null);
    const with48hROI = withROI.filter(r => r.hourlyBetaDrift.roiAt48h !== null);
    
    if (with24hROI.length > 0) {
      const winners24h = with24hROI.filter(r => r.hourlyBetaDrift.roiAt24h > 0);
      const losers24h = with24hROI.filter(r => r.hourlyBetaDrift.roiAt24h <= 0);
      const finalWinners24h = winners24h.filter(r => r.won).length;
      const finalWinnersLosers24h = losers24h.filter(r => r.won).length;
      
      const winners24hFinalROI = winners24h.filter(r => r.won).length > 0
        ? winners24h.filter(r => r.won).reduce((sum, r) => sum + r.actualROI, 0) / winners24h.filter(r => r.won).length
        : 0;
      const losers24hFinalROI = losers24h.filter(r => r.won).length > 0
        ? losers24h.filter(r => r.won).reduce((sum, r) => sum + r.actualROI, 0) / losers24h.filter(r => r.won).length
        : 0;
      
      report += `### ROI at 24h vs Final Outcome\n\n`;
      report += `| 24h ROI | Trades | Final Win Rate | Final Avg ROI (Winners) |\n`;
      report += `|---------|--------|----------------|------------------------|\n`;
      report += `| Positive | ${winners24h.length} | ${(finalWinners24h / winners24h.length * 100).toFixed(1)}% | ${winners24hFinalROI.toFixed(2)}% |\n`;
      report += `| Negative/Zero | ${losers24h.length} | ${(finalWinnersLosers24h / losers24h.length * 100).toFixed(1)}% | ${losers24hFinalROI.toFixed(2)}% |\n`;
    }
    
    // Max/min ROI
    report += `\n### Max/Min ROI During Trade\n\n`;
    report += `| Metric | All | Winners | Losers |\n`;
    report += `|--------|-----|---------|--------|\n`;
    
    const avgMaxROI = withROI.reduce((sum, r) => sum + (r.hourlyBetaDrift.maxROI || 0), 0) / withROI.length;
    const avgMinROI = withROI.reduce((sum, r) => sum + (r.hourlyBetaDrift.minROI || 0), 0) / withROI.length;
    const winnersMaxROI = winners.filter(r => r.hourlyBetaDrift?.maxROI).reduce((sum, r) => sum + (r.hourlyBetaDrift.maxROI || 0), 0) / Math.max(1, winners.filter(r => r.hourlyBetaDrift?.maxROI).length);
    const winnersMinROI = winners.filter(r => r.hourlyBetaDrift?.minROI).reduce((sum, r) => sum + (r.hourlyBetaDrift.minROI || 0), 0) / Math.max(1, winners.filter(r => r.hourlyBetaDrift?.minROI).length);
    const losersMaxROI = losers.filter(r => r.hourlyBetaDrift?.maxROI).reduce((sum, r) => sum + (r.hourlyBetaDrift.maxROI || 0), 0) / Math.max(1, losers.filter(r => r.hourlyBetaDrift?.maxROI).length);
    const losersMinROI = losers.filter(r => r.hourlyBetaDrift?.minROI).reduce((sum, r) => sum + (r.hourlyBetaDrift.minROI || 0), 0) / Math.max(1, losers.filter(r => r.hourlyBetaDrift?.minROI).length);
    
    report += `| Avg Max ROI | ${avgMaxROI.toFixed(2)}% | ${winnersMaxROI.toFixed(2)}% | ${losersMaxROI.toFixed(2)}% |\n`;
    report += `| Avg Min ROI | ${avgMinROI.toFixed(2)}% | ${winnersMinROI.toFixed(2)}% | ${losersMinROI.toFixed(2)}% |\n`;
  }
  
  // Z-score reversion
  const reverted = results.filter(r => r.hourlyBetaDrift?.revertedAtExit === true);
  if (reverted.length > 0) {
    report += `\n## Z-Score Reversion\n\n`;
    report += `| Status | Trades | Win Rate | Avg ROI |\n`;
    report += `|--------|--------|----------|---------|\n`;
    
    const revertedWins = reverted.filter(r => r.won).length;
    const revertedROI = reverted.reduce((sum, r) => sum + r.actualROI, 0) / reverted.length;
    
    const notReverted = results.filter(r => r.hourlyBetaDrift?.revertedAtExit === false);
    const notRevertedWins = notReverted.filter(r => r.won).length;
    const notRevertedROI = notReverted.reduce((sum, r) => sum + r.actualROI, 0) / notReverted.length;
    
    report += `| Reverted at Exit | ${reverted.length} | ${(revertedWins / reverted.length * 100).toFixed(1)}% | ${revertedROI.toFixed(2)}% |\n`;
    report += `| Not Reverted | ${notReverted.length} | ${(notRevertedWins / notReverted.length * 100).toFixed(1)}% | ${notRevertedROI.toFixed(2)}% |\n`;
  }
  
  // Combined analysis: High hist rev + Low drift
  report += `\n## Combined Filters\n\n`;
  
  const highHistLowDrift = results.filter(r => 
    r.historicalReversion?.fixedReversionRate >= 80 &&
    r.hourlyBetaDrift?.maxBetaDrift < 0.05
  );
  
  if (highHistLowDrift.length > 0) {
    const wins = highHistLowDrift.filter(r => r.won).length;
    const avgROI = highHistLowDrift.reduce((sum, r) => sum + r.actualROI, 0) / highHistLowDrift.length;
    
    report += `| Filter | Trades | Win Rate | Avg ROI |\n`;
    report += `|--------|--------|----------|---------|\n`;
    report += `| Hist Rev ≥80% AND Max Drift <0.05 | ${highHistLowDrift.length} | ${(wins / highHistLowDrift.length * 100).toFixed(1)}% | ${avgROI.toFixed(2)}% |\n`;
  }
  
  return report;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const resultsFile = args[0] || 'backtest_reports/trade_reversion_drift_2026-01-12T11-08-49_results.json';
  
  if (!fs.existsSync(resultsFile)) {
    console.error(`Error: Results file not found: ${resultsFile}`);
    process.exit(1);
  }
  
  const report = generateReport(resultsFile);
  
  // Generate new timestamp for report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outputFile = resultsFile.replace('_results.json', `_ANALYSIS_${timestamp}.md`);
  fs.writeFileSync(outputFile, report);
  console.log(`Report saved: ${outputFile}`);
}

module.exports = { generateReport };

