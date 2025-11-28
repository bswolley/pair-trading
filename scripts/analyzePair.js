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

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/analyzePair.js BASE UNDERLYING [direction] [--output-dir DIR]');
  console.error('\nExamples:');
  console.error('  node scripts/analyzePair.js HYPE ZEC long');
  console.error('  node scripts/analyzePair.js TAO BTC short');
  console.error('  node scripts/analyzePair.js LTC BTC long --output-dir reports');
  process.exit(1);
}

// Preserve 'k' prefix for Hyperliquid's kilo tokens (kSHIB, kBONK, etc.)
const normalizeSymbol = (sym) => {
  const upper = sym.toUpperCase();
  // If it starts with K and the rest is a known kilo-token, use lowercase k
  if (upper.startsWith('K') && ['KSHIB', 'KBONK', 'KPEPE', 'KFLOKI', 'KNEIRO', 'KDOGS', 'KLUNC'].includes(upper)) {
    return 'k' + upper.slice(1);
  }
  return upper;
};
const baseSymbol = normalizeSymbol(args[0]);
const underlyingSymbol = normalizeSymbol(args[1]);
const direction = (args[2] || 'long').toLowerCase();

if (!['long', 'short'].includes(direction)) {
  console.error('Direction must be "long" or "short"');
  process.exit(1);
}

let outputDir = 'pair_reports';
const outputDirIndex = args.indexOf('--output-dir');
if (outputDirIndex !== -1 && args[outputDirIndex + 1]) {
  outputDir = args[outputDirIndex + 1];
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function main() {
  console.log(`\nAnalyzing ${baseSymbol}/${underlyingSymbol}...`);
  console.log(`   Strategy: ${direction === 'long' ? `LONG ${baseSymbol} / SHORT ${underlyingSymbol}` : `SHORT ${baseSymbol} / LONG ${underlyingSymbol}`}\n`);
  
  try {
    const result = await analyzePair({
      symbol1: baseSymbol,
      symbol2: underlyingSymbol,
      direction,
      timeframes: [7, 30, 90, 180],
      obvTimeframes: [7, 30]
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

## Statistical Metrics

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
  if (pair.direction === 'long' && tf.zScore < -1) signal = ' [READY]';
  else if (pair.direction === 'short' && tf.zScore > 1) signal = ' [READY]';
  
  return `| **${tf.days}d** | ${corr} | ${beta} | ${zScore}${signal} | ${coint} | ${hedgeRatio} | ${gamma} | ${theta} |`;
}).join('\n')}

## Price Movement

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

---

## Notes

- **Z-Score:** Negative = ${pair.symbol1} undervalued (good for LONG), Positive = ${pair.symbol1} overvalued (good for SHORT)
- **Gamma:** Lower = more stable hedge ratio (better)
- **Theta:** Higher = faster mean reversion (better)
- **OBV:** Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
- **Cointegration:** Yes = pair moves together (better for pair trading)

*Data sources: Hyperliquid (prices), CryptoCompare (OBV/volume)*
`;
}

main();

