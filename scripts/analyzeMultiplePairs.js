#!/usr/bin/env node

/**
 * Analyze multiple trading pairs in one report
 * Usage: node scripts/analyzeMultiplePairs.js PAIR1_DIRECTION PAIR2_DIRECTION ... [--output-dir pair_reports]
 * 
 * Examples:
 *   node scripts/analyzeMultiplePairs.js HYPE ZEC long SOL ETH long
 *   node scripts/analyzeMultiplePairs.js LTC BTC long TAO BTC short ETH SOL long
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { analyzePair } = require('../lib/pairAnalysis');

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 3 || args.length % 3 !== 0) {
  console.error('Usage: node scripts/analyzeMultiplePairs.js BASE1 UNDERLYING1 DIRECTION1 [BASE2 UNDERLYING2 DIRECTION2 ...] [--output-dir DIR]');
  console.error('\nExamples:');
  console.error('  node scripts/analyzeMultiplePairs.js HYPE ZEC long SOL ETH long');
  console.error('  node scripts/analyzeMultiplePairs.js LTC BTC long TAO BTC short');
  console.error('  node scripts/analyzeMultiplePairs.js HYPE ZEC long SOL ETH long --output-dir pair_reports');
  process.exit(1);
}

// Find output dir argument
let outputDir = 'pair_reports';
const outputDirIndex = args.indexOf('--output-dir');
if (outputDirIndex !== -1 && args[outputDirIndex + 1]) {
  outputDir = args[outputDirIndex + 1];
  args.splice(outputDirIndex, 2); // Remove --output-dir and its value
}

// Parse pairs
const pairs = [];
for (let i = 0; i < args.length; i += 3) {
  if (i + 2 >= args.length) break;
  
  const baseSymbol = args[i].toUpperCase();
  const underlyingSymbol = args[i + 1].toUpperCase();
  const direction = (args[i + 2] || 'long').toLowerCase();
  
  if (!['long', 'short'].includes(direction)) {
    console.error(`Invalid direction "${direction}" for ${baseSymbol}/${underlyingSymbol}. Must be "long" or "short"`);
    process.exit(1);
  }
  
  pairs.push({ symbol1: baseSymbol, symbol2: underlyingSymbol, direction });
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function main() {
  console.log(`\nAnalyzing ${pairs.length} pair(s)...\n`);
  
  const results = [];
  
  for (const pair of pairs) {
    console.log(`Analyzing ${pair.symbol1}/${pair.symbol2}...`);
    console.log(`   Strategy: ${pair.direction === 'long' ? `LONG ${pair.symbol1} / SHORT ${pair.symbol2}` : `SHORT ${pair.symbol1} / LONG ${pair.symbol2}`}`);
    
    try {
      const result = await analyzePair({
        symbol1: pair.symbol1,
        symbol2: pair.symbol2,
        direction: pair.direction,
        timeframes: [7, 30, 90, 180],
        obvTimeframes: [7, 30]
      });
      
      results.push(result);
      console.log(`   ✓ Complete\n`);
    } catch (error) {
      console.error(`   ✗ Error: ${error.message}\n`);
      results.push({
        pair: `${pair.symbol1}/${pair.symbol2}`,
        symbol1: pair.symbol1,
        symbol2: pair.symbol2,
        direction: pair.direction,
        error: error.message,
        timeframes: {}
      });
    }
  }
  
  // Generate combined report
  const report = generateCombinedReport(results);
  
  // Save report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const pairNames = results.map(r => `${r.symbol1}_${r.symbol2}`).join('_');
  const filename = `MULTI_${pairNames}_${timestamp}.md`;
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
        return;
      }
      
      const pdfDir = 'pair_reports_pdf';
      if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
      }
      
      const pdfFilename = `MULTI_${pairNames}_${timestamp}.pdf`;
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
      // Silent fail - PDF is optional
    } else {
      // Silent fail - PDF is optional
    }
  }
  
  console.log(`\nAnalysis complete!`);
  console.log(`Report saved: ${filepath}\n`);
  
  // Print summary
  console.log('Summary:');
  results.forEach(result => {
    if (result.error) {
      console.log(`  ${result.pair}: ERROR - ${result.error}`);
    } else {
      const allTimeframes = Object.values(result.timeframes)
        .filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days))
        .sort((a, b) => a.days - b.days);
      
      const bestSignal = allTimeframes.find(tf => 
        result.direction === 'long' ? tf.zScore < -1 : tf.zScore > 1
      );
      
      const signal = bestSignal ? 'READY' : 'WAIT';
      const bestZ = bestSignal ? bestSignal.zScore.toFixed(2) : allTimeframes[0]?.zScore?.toFixed(2) || 'N/A';
      
      console.log(`  ${result.pair}: Z=${bestZ} ${signal}`);
    }
  });
}

function generateCombinedReport(results) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  // Executive summary
  const summaryRows = results.map(result => {
    if (result.error) {
      return `| **${result.pair}** | ERROR | ${result.error} |`;
    }
    
    const allTimeframes = Object.values(result.timeframes)
      .filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days))
      .sort((a, b) => a.days - b.days);
    
    const bestSignal = allTimeframes.find(tf => 
      result.direction === 'long' ? tf.zScore < -1 : tf.zScore > 1
    );
    
    const signal = bestSignal 
      ? `**READY** (${bestSignal.days}d Z: ${bestSignal.zScore.toFixed(2)})`
      : '**WAIT**';
    
    const directionText = result.direction === 'long' 
      ? `LONG ${result.symbol1}` 
      : `SHORT ${result.symbol1}`;
    
    return `| **${result.pair}** | ${directionText} | ${signal} |`;
  }).join('\n');
  
  let report = `# Multi-Pair Trading Analysis

**Generated:** ${dateStr}

## Executive Summary

| Pair | Strategy | Signal |
|------|----------|--------|
${summaryRows}

---

`;

  // Individual pair details
  results.forEach((result, index) => {
    if (result.error) {
      report += `## ${result.pair}

**Error:** ${result.error}

---

`;
      return;
    }
    
    const directionText = result.direction === 'long' 
      ? `**LONG ${result.symbol1} / SHORT ${result.symbol2}**` 
      : `**SHORT ${result.symbol1} / LONG ${result.symbol2}**`;
    
    const allTimeframes = Object.values(result.timeframes)
      .filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days))
      .sort((a, b) => a.days - b.days);
    
    const bestSignal = allTimeframes.find(tf => 
      result.direction === 'long' ? tf.zScore < -1 : tf.zScore > 1
    );
    
    const signalStatus = bestSignal 
      ? `**TRADE READY** (${bestSignal.days}d Z-score: ${bestSignal.zScore.toFixed(2)})`
      : `**WAIT** (No strong signal across timeframes)`;
    
    report += `## ${result.pair}

${directionText}

**Current Prices & Market Caps:**
- **${result.symbol1}:** $${result.currentPrice1?.toFixed(2) || 'N/A'} ($${(result.currentMcap1 / 1e9).toFixed(2)}B)
- **${result.symbol2}:** $${result.currentPrice2?.toFixed(2) || 'N/A'} ($${(result.currentMcap2 / 1e9).toFixed(2)}B)

**Signal Status:** ${signalStatus}

### Statistical Metrics

| Timeframe | Correlation | Beta | Z-Score | Cointegrated | Hedge Ratio | Gamma | Theta |
|-----------|-------------|------|---------|--------------|-------------|-------|-------|
${allTimeframes.map(tf => {
  const corr = tf.correlation?.toFixed(3) || 'N/A';
  const beta = tf.beta?.toFixed(3) || 'N/A';
  const zScore = tf.zScore?.toFixed(2) || 'N/A';
  const hedgeRatio = tf.hedgeRatio?.toFixed(3) || 'N/A';
  const gamma = tf.gamma?.toFixed(3) || 'N/A';
  const theta = tf.theta?.toFixed(3) || 'N/A';
  const coint = tf.isCointegrated ? 'Yes' : 'No';
  
  let signal = '';
  if (result.direction === 'long' && tf.zScore < -1) signal = ' [READY]';
  else if (result.direction === 'short' && tf.zScore > 1) signal = ' [READY]';
  
  return `| **${tf.days}d** | ${corr} | ${beta} | ${zScore}${signal} | ${coint} | ${hedgeRatio} | ${gamma} | ${theta} |`;
}).join('\n')}

### Price Movement

| Timeframe | ${result.symbol1} | ${result.symbol2} |
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

### On-Balance Volume (OBV)

| Timeframe | ${result.symbol1} OBV | ${result.symbol2} OBV |
|-----------|-------------------|-------------------|
${Object.values(result.timeframes)
  .filter(tf => !tf.error && tf.obv1Change !== null && [7, 30].includes(tf.days))
  .sort((a, b) => a.days - b.days)
  .map(tf => {
    const obv1 = tf.obv1Change !== null && tf.obv1Change !== undefined 
      ? (tf.obv1Change > 0 ? '+' : '') + tf.obv1Change.toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const obv2 = tf.obv2Change !== null && tf.obv2Change !== undefined 
      ? (tf.obv2Change > 0 ? '+' : '') + tf.obv2Change.toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const trend1 = tf.obv1Change > 0 ? '+' : tf.obv1Change < 0 ? '-' : '';
    const trend2 = tf.obv2Change > 0 ? '+' : tf.obv2Change < 0 ? '-' : '';
    return `| **${tf.days}d** | ${trend1}${obv1} | ${trend2}${obv2} |`;
  }).join('\n') || '| N/A | No OBV data available |'}

`;

    if (index < results.length - 1) {
      report += '---\n\n';
    }
  });
  
  report += `---

## Notes

- **Z-Score:** Negative = left token undervalued (good for LONG), Positive = left token overvalued (good for SHORT)
- **Gamma:** Lower = more stable hedge ratio (better)
- **Theta:** Higher = faster mean reversion (better)
- **OBV:** Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
- **Cointegration:** Yes = pair moves together (better for pair trading)

*Data sources: Hyperliquid (prices), CryptoCompare (OBV/volume)*
`;
  
  return report;
}

main();

