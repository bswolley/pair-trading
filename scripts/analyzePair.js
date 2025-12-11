#!/usr/bin/env node

/**
 * CLI tool to analyze a trading pair
 * Usage: node scripts/analyzePair.js BASE UNDERLYING [direction] [--output-dir reports]
 * 
 * Example:
 *   node scripts/analyzePair.js HYPE ZEC long
 *   node scripts/analyzePair.js TAO BTC short --output-dir reports
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { analyzePair } = require('../lib/pairAnalysis');
const { generateZScoreChart } = require('../lib/generateZScoreChart');

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/analyzePair.js BASE UNDERLYING [direction] [--output-dir DIR] [--timestamp TIMESTAMP]');
  console.error('\nExamples:');
  console.error('  node scripts/analyzePair.js HYPE ZEC long');
  console.error('  node scripts/analyzePair.js TAO BTC short');
  console.error('  node scripts/analyzePair.js LTC BTC long --output-dir reports');
  console.error('  node scripts/analyzePair.js MEME GALA --timestamp 2025-12-01T10:00:00Z');
  process.exit(1);
}

const baseSymbol = args[0].toUpperCase();
const underlyingSymbol = args[1].toUpperCase();

// Find direction (skip flags)
let direction = 'long';
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--output-dir' || args[i] === '--timestamp') {
    i++; // Skip flag value
    continue;
  }
  if (args[i] === 'long' || args[i] === 'short') {
    direction = args[i].toLowerCase();
    break;
  }
}

let outputDir = 'pair_reports';
const outputDirIndex = args.indexOf('--output-dir');
if (outputDirIndex !== -1 && args[outputDirIndex + 1]) {
  outputDir = args[outputDirIndex + 1];
}

let cutoffTime = null;
const timestampIndex = args.indexOf('--timestamp');
if (timestampIndex !== -1 && args[timestampIndex + 1]) {
  cutoffTime = new Date(args[timestampIndex + 1]).getTime();
  if (isNaN(cutoffTime)) {
    console.error('Invalid timestamp format. Use ISO format: 2025-12-01T10:00:00Z');
    process.exit(1);
  }
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function main() {
  console.log(`\nAnalyzing ${baseSymbol}/${underlyingSymbol}...`);
  console.log(`   Strategy: ${direction === 'long' ? `LONG ${baseSymbol} / SHORT ${underlyingSymbol}` : `SHORT ${baseSymbol} / LONG ${underlyingSymbol}`}`);
  if (cutoffTime) {
    console.log(`   Historical analysis as of: ${new Date(cutoffTime).toISOString()}\n`);
  } else {
    console.log();
  }
  
  try {
    const result = await analyzePair({
      symbol1: baseSymbol,
      symbol2: underlyingSymbol,
      direction,
      timeframes: [7, 14, 30, 90, 180],
      obvTimeframes: [7, 14],
      cutoffTime: cutoffTime
    });
    
    // Generate report
    const report = generateReport(result);
    
    // Save report
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${baseSymbol}_${underlyingSymbol}_${timestamp}.md`;
    const filepath = path.join(outputDir, filename);
    
    fs.writeFileSync(filepath, report);
    
    // Generate PDF (optional - skip if pandoc not available or file too large)
    try {
      const stats = fs.statSync(filepath);
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
          return;
        }
        
        const pdfDir = 'pair_reports_pdf';
        if (!fs.existsSync(pdfDir)) {
          fs.mkdirSync(pdfDir, { recursive: true });
        }
        
        const pdfFilename = `${baseSymbol}_${underlyingSymbol}_${timestamp}.pdf`;
        const pdfPath = path.join(pdfDir, pdfFilename);
        
        // Convert markdown to PDF using pandoc with timeout
        await Promise.race([
          execAsync(`pandoc "${filepath}" -o "${pdfPath}" --pdf-engine=pdflatex -V geometry:margin=1in --standalone`),
          new Promise((_, reject) => setTimeout(() => reject(new Error('PDF generation timeout (15s)')), 15000))
        ]);
        console.log(`PDF saved: ${pdfPath}`);
      }
    } catch (pdfError) {
      if (pdfError.message.includes('timeout')) {
        console.log(`PDF generation timed out - skipping`);
      } else if (pdfError.message.includes('not found') || pdfError.message.includes('which pandoc')) {
        console.log(`PDF generation skipped - pandoc not available`);
      } else {
        // Silent fail - PDF is optional
      }
    }
    
    console.log(`\nAnalysis complete!`);
    console.log(`Report saved: ${filepath}\n`);
    
    // Print summary
    console.log('Summary:');
    Object.values(result.timeframes).forEach(tf => {
      if (tf.error) {
        console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
      } else {
        const signal = result.direction === 'short' 
          ? (tf.leftSideOvervalued ? 'READY' : 'WAIT')
          : (tf.leftSideUndervalued ? 'READY' : 'WAIT');
        console.log(`  ${tf.days}d: Z=${tf.zScore?.toFixed(2) || 'N/A'}, Corr=${tf.correlation?.toFixed(3) || 'N/A'}, Beta=${tf.beta?.toFixed(3) || 'N/A'} ${signal}`);
      }
    });
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

function generateReport(pair) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  const directionText = pair.direction === 'long' 
    ? `**LONG ${pair.leftSide} / SHORT ${pair.symbol2}**` 
    : `**SHORT ${pair.leftSide} / LONG ${pair.symbol2}**`;
  
  const allTimeframes = Object.values(pair.timeframes)
    .filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days))
    .sort((a, b) => a.days - b.days);
  
  const bestSignal = allTimeframes.find(tf => 
    pair.direction === 'long' ? tf.zScore < -1 : tf.zScore > 1
  );
  
  const signalStatus = bestSignal 
    ? `**TRADE READY** (${bestSignal.days}d Z-score: ${bestSignal.zScore.toFixed(2)})`
    : `**WAIT** (No strong signal across timeframes)`;
  
  return `# Pair Trading Analysis: ${pair.pair}

**Generated:** ${dateStr}

${directionText}

**Current Prices & Market Caps:**
- **${pair.symbol1}:** $${pair.currentPrice1?.toFixed(2) || 'N/A'} ($${(pair.currentMcap1 / 1e9).toFixed(2)}B)
- **${pair.symbol2}:** $${pair.currentPrice2?.toFixed(2) || 'N/A'} ($${(pair.currentMcap2 / 1e9).toFixed(2)}B)

**Signal Status:** ${signalStatus}

${pair.standardized ? `## Standardized Metrics

*Calculated using fixed periods: Beta (30d), Correlation/Z-Score (30d), Cointegration (90d)*

| Metric | Value | Period |
|--------|-------|--------|
| **Beta (Hedge Ratio)** | ${pair.standardized.beta30d !== null ? pair.standardized.beta30d.toFixed(3) : 'N/A'} | 30 days |
| **Correlation** | ${pair.standardized.correlation30d !== null ? pair.standardized.correlation30d.toFixed(3) : 'N/A'} | 30 days |
| **Z-Score** | ${pair.standardized.zScore30d !== null ? pair.standardized.zScore30d.toFixed(2) : 'N/A'} | 30 days |
| **Cointegrated** | ${pair.standardized.isCointegrated90d ? 'Yes' : 'No'} | 90 days |
| **Half-Life** | ${pair.standardized.halfLife30d !== null ? pair.standardized.halfLife30d.toFixed(1) + ' days' : 'N/A'} | 30 days |
| **Time to Mean Reversion** | ${pair.standardized.timeToMeanReversion !== null ? pair.standardized.timeToMeanReversion.toFixed(1) + ' days' : 'N/A'} | To 0.5 z-score |
${pair.standardized.hurst30d !== null ? `| **Hurst Exponent** | ${pair.standardized.hurst30d.toFixed(3)} | 30 days |` : ''}
${pair.standardized.regime30d ? `| **Market Regime** | ${pair.standardized.regime30d.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} | 30 days |` : ''}
${pair.standardized.dualBeta30d ? `| **DualBeta (Up/Down)** | ${pair.standardized.dualBeta30d.upMarket !== null ? pair.standardized.dualBeta30d.upMarket.toFixed(3) : 'N/A'} / ${pair.standardized.dualBeta30d.downMarket !== null ? pair.standardized.dualBeta30d.downMarket.toFixed(3) : 'N/A'} | 30 days |` : ''}

` : ''}${pair.standardized.pathDependencyRisks && Object.keys(pair.standardized.pathDependencyRisks).length > 0 ? `## Path Dependency Risk

*Volatility asymmetry across short-term periods - higher ratio indicates higher path dependency risk*

| Period | Volatility Ratio | Risk Level |
|--------|------------------|------------|
${Object.entries(pair.standardized.pathDependencyRisks).map(([period, risk]) => {
  return `| **${period}** | ${risk.volatilityRatio.toFixed(2)}x | ${risk.pathDependencyRiskLevel} |`;
}).join('\n')}

` : ''}## Statistical Metrics

| Timeframe | Correlation | Beta | Z-Score | CoInt? | Hedge Ratio | Gamma | Theta |
|-----------|-------------|------|---------|--------------|-------------|-----------|-------|-------|
${allTimeframes.map(tf => {
  const corr = tf.correlation?.toFixed(3) || 'N/A';
  const beta = tf.beta?.toFixed(3) || 'N/A';
  const zScore = tf.zScore?.toFixed(2) || 'N/A';
  const hedgeRatio = tf.hedgeRatio?.toFixed(3) || 'N/A';
  const gamma = tf.gamma?.toFixed(3) || 'N/A';
  const theta = tf.theta?.toFixed(3) || 'N/A';
  const coint = tf.isCointegrated ? 'Yes' : 'No';
  
  return `| **${tf.days}d** | ${corr} | ${beta} | ${zScore} | ${coint} | ${hedgeRatio} | ${gamma} | ${theta} |`;
}).join('\n')}

${pair.positionSizing ? `**Position Sizing (from 30-day beta):**
- **${pair.symbol1}:** ${(pair.positionSizing.weight1 * 100).toFixed(1)}%
- **${pair.symbol2}:** ${(pair.positionSizing.weight2 * 100).toFixed(1)}%

` : ''}${pair.standardized?.divergenceProfile ? `## Dynamic Entry Thresholds

**Optimal Entry Threshold:** |Z| >= ${pair.standardized.optimalEntryThreshold?.toFixed(1) || 'N/A'}
**Current Z-Score:** ${pair.standardized.zScore30d !== null ? pair.standardized.zScore30d.toFixed(2) : 'N/A'}

*Based on 30-day historical divergence analysis*

${pair.standardized.currentZROI ? `### Expected ROI from Current Position

*Based on current z-score of ${pair.standardized.currentZROI.currentZ}*

| Exit Strategy | Exit Z-Score | Expected ROI | Time to Reversion |
|---------------|--------------|--------------|-------------------|
| **Fixed Reversion** | ${pair.standardized.currentZROI.fixedExitZ} | ${pair.standardized.currentZROI.roiFixed} | ${pair.standardized.currentZROI.timeToFixed || 'N/A'} days |
| **Percentage-Based (50%)** | ${pair.standardized.currentZROI.percentExitZ} | ${pair.standardized.currentZROI.roiPercent} | ${pair.standardized.currentZROI.timeToPercent || 'N/A'} days |


` : ''}### Fixed Reversion (to |Z| < 0.5)

| Threshold | Events | Reverted | Reversion Rate | Avg Time to Revert |
|-----------|--------|----------|----------------|-------------------|
${Object.entries(pair.standardized.divergenceProfile)
  .filter(([threshold]) => threshold !== 'currentZROI') // Filter out ROI data
  .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
  .map(([threshold, stats]) => {
    const avgTime = stats.avgTimeToRevert !== null ? `${stats.avgTimeToRevert} days` : 'N/A';
    return `| **${threshold}** | ${stats.events} | ${stats.reverted} | ${stats.rate} | ${avgTime} |`;
  }).join('\n')}

${pair.standardized?.divergenceProfilePercent ? `### Percentage-Based Reversion (to |Z| < 50% of threshold)

*Example: Threshold 2.0 reverts to < 1.0, Threshold 3.0 reverts to < 1.5*

| Threshold | Reversion To | Events | Reverted | Reversion Rate | Avg Time to Revert |
|-----------|--------------|--------|----------|----------------|-------------------|
${Object.entries(pair.standardized.divergenceProfilePercent)
  .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
  .map(([threshold, stats]) => {
    const avgTime = stats.avgTimeToRevert !== null ? `${stats.avgTimeToRevert} days` : 'N/A';
    return `| **${threshold}** | < ${stats.reversionThreshold} | ${stats.events} | ${stats.reverted} | ${stats.rate} | ${avgTime} |`;
  }).join('\n')}
` : ''}

` : ''}## Price Movement

| Timeframe | ${pair.symbol1} | ${pair.symbol2} |
|-----------|----------------|-----------------|
${allTimeframes.map(tf => {
  const price1Start = tf.price1Start?.toFixed(2) || 'N/A';
  const price1End = tf.price1End?.toFixed(2) || 'N/A';
  const price2Start = tf.price2Start?.toFixed(2) || 'N/A';
  const price2End = tf.price2End?.toFixed(2) || 'N/A';
  const change1 = tf.price1Start && tf.price1End ? (((tf.price1End - tf.price1Start) / tf.price1Start) * 100).toFixed(1) : 'N/A';
  const change2 = tf.price2Start && tf.price2End ? (((tf.price2End - tf.price2Start) / tf.price2Start) * 100).toFixed(1) : 'N/A';
  return `| **${tf.days}d** | $${price1Start} → $${price1End} (${change1}%) | $${price2Start} → $${price2End} (${change2}%) |`;
}).join('\n')}

## On-Balance Volume (OBV)

| Timeframe | ${pair.symbol1} OBV | ${pair.symbol2} OBV |
|-----------|-------------------|-------------------|
${Object.values(pair.timeframes)
  .filter(tf => !tf.error && tf.obv1Change !== null && [7, 14].includes(tf.days))
  .sort((a, b) => a.days - b.days)
  .map(tf => {
    // Format absolute value, then add sign prefix (avoid double negative)
    const obv1Abs = tf.obv1Change !== null && tf.obv1Change !== undefined 
      ? Math.abs(tf.obv1Change).toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const obv2Abs = tf.obv2Change !== null && tf.obv2Change !== undefined 
      ? Math.abs(tf.obv2Change).toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const trend1 = tf.obv1Change > 0 ? '+' : tf.obv1Change < 0 ? '-' : '';
    const trend2 = tf.obv2Change > 0 ? '+' : tf.obv2Change < 0 ? '-' : '';
    return `| **${tf.days}d** | ${trend1}${obv1Abs} | ${trend2}${obv2Abs} |`;
  }).join('\n') || '| N/A | No OBV data available |'}

${Object.values(pair.timeframes).some(tf => tf.obvDivergence1 !== null || tf.obvDivergence2 !== null) ? `## OBV Divergence Score

*Divergence Score = OBV Change % - Price Change %*

| Timeframe | ${pair.symbol1} Divergence | Signal | ${pair.symbol2} Divergence | Signal |
|-----------|-------------------------|--------|-------------------------|--------|
${Object.values(pair.timeframes)
  .filter(tf => !tf.error && (tf.obvDivergence1 !== null || tf.obvDivergence2 !== null) && [7, 14].includes(tf.days))
  .sort((a, b) => a.days - b.days)
  .map(tf => {
    const div1 = tf.obvDivergence1 !== null ? tf.obvDivergence1.toFixed(1) + '%' : 'N/A';
    const div2 = tf.obvDivergence2 !== null ? tf.obvDivergence2.toFixed(1) + '%' : 'N/A';
    const signal1 = tf.obvSignal1 || 'N/A';
    const signal2 = tf.obvSignal2 || 'N/A';
    return `| **${tf.days}d** | ${div1} | ${signal1} | ${div2} | ${signal2} |`;
  }).join('\n')}

**Interpretation:**
- **+30% or more**: STRONG BUY - Strong accumulation, price likely to rise
- **+10% to +30%**: BUY - Moderate accumulation
- **-10% to +10%**: NEUTRAL - No divergence, normal trading
- **-10% to -30%**: SELL - Moderate distribution
- **-30% or less**: STRONG SELL - Strong distribution, price likely to fall

` : ''}
---

## Notes

- **Z-Score:** Negative = ${pair.symbol1} undervalued (good for LONG), Positive = ${pair.symbol1} overvalued (good for SHORT)
- **Half-Life:** Time for spread to revert halfway to mean (lower = faster reversion, better)
- **Gamma:** Lower = more stable hedge ratio (better)
- **Theta:** Higher = faster mean reversion (better)
- **OBV:** Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
- **Cointegration:** Yes = pair moves together (better for pair trading)
- **Position Sizing:** Beta-adjusted weights for delta-neutral hedging

*Data sources: Hyperliquid (prices), CryptoCompare (OBV/volume)*
`;
}

main();

