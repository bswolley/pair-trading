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
const { analyzePair, calculateCorrelation, analyzeHistoricalDivergences } = require('../lib/pairAnalysis');
const { fetchCurrentFunding, calculateNetFunding } = require('../lib/funding');

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
    
    // Fetch funding rates
    console.log('Fetching funding rates...');
    const fundingMap = await fetchCurrentFunding();
    
    // Analyze historical divergences for 30d timeframe (if available)
    let divergenceProfile = null;
    const tf30 = result.timeframes[30];
    if (tf30 && !tf30.error && tf30.beta) {
      // We need prices to calculate divergence profile
      // The analyzePair function doesn't return raw prices, so we need to extract from the 30d timeframe
      // For now, use the beta from the 30d analysis and note that this is calculated during scan
      console.log('Analyzing historical divergences...');
      
      // Get prices from Hyperliquid for 30d
      const { Hyperliquid } = require('hyperliquid');
      const sdk = new Hyperliquid();
      const originalLog = console.log;
      console.log = () => {};
      await sdk.connect();
      console.log = originalLog;
      
      const endTime = Date.now();
      const startTime = endTime - (35 * 24 * 60 * 60 * 1000);
      
      const [d1, d2] = await Promise.all([
        sdk.info.getCandleSnapshot(`${baseSymbol}-PERP`, '1d', startTime, endTime),
        sdk.info.getCandleSnapshot(`${underlyingSymbol}-PERP`, '1d', startTime, endTime)
      ]);
      
      console.log = () => {};
      await sdk.disconnect();
      console.log = originalLog;
      
      if (d1?.length && d2?.length) {
        const m1 = new Map(), m2 = new Map();
        d1.forEach(c => m1.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
        d2.forEach(c => m2.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
        
        const dates = [...m1.keys()].filter(d => m2.has(d)).sort().slice(-30);
        const prices1 = dates.map(d => m1.get(d));
        const prices2 = dates.map(d => m2.get(d));
        
        if (prices1.length >= 15) {
          const { beta } = calculateCorrelation(prices1, prices2);
          divergenceProfile = analyzeHistoricalDivergences(prices1, prices2, beta);
        }
      }
    }
    
    // Generate report
    const report = generateReport(result, fundingMap, divergenceProfile);
    
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
        const hl = tf.halfLife !== undefined && tf.halfLife !== Infinity ? `${tf.halfLife.toFixed(1)}d` : '∞';
        console.log(`  ${tf.days}d: Z=${tf.zScore?.toFixed(2) || 'N/A'}, Corr=${tf.correlation?.toFixed(3) || 'N/A'}, HL=${hl} ${signal}`);
      }
    });
    
    // Print divergence analysis summary
    if (divergenceProfile) {
      console.log(`\nDivergence Analysis (30d):`);
      console.log(`  Optimal Entry: |Z| ≥ ${divergenceProfile.optimalEntry.toFixed(1)}`);
      console.log(`  Max Historical |Z|: ${divergenceProfile.maxHistoricalZ.toFixed(2)}`);
      console.log(`  Current Z: ${divergenceProfile.currentZ.toFixed(2)}`);
      const readyPct = (Math.abs(divergenceProfile.currentZ) / divergenceProfile.optimalEntry * 100).toFixed(0);
      console.log(`  Status: ${Math.abs(divergenceProfile.currentZ) >= divergenceProfile.optimalEntry ? '🟢 READY' : `⏳ ${readyPct}% to entry`}`);
    }
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

function generateReport(pair, fundingMap = new Map(), divergenceProfile = null) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  const directionText = pair.direction === 'long' 
    ? `**LONG ${pair.leftSide} / SHORT ${pair.symbol2}**` 
    : `**SHORT ${pair.leftSide} / LONG ${pair.symbol2}**`;
  
  // Determine long/short assets based on direction
  const longAsset = pair.direction === 'long' ? pair.symbol1 : pair.symbol2;
  const shortAsset = pair.direction === 'long' ? pair.symbol2 : pair.symbol1;
  
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

| Timeframe | Correlation | Beta | Z-Score | Half-Life | Cointegrated | Gamma | Theta |
|-----------|-------------|------|---------|-----------|--------------|-------|-------|
${allTimeframes.map(tf => {
  const corr = tf.correlation?.toFixed(3) || 'N/A';
  const beta = tf.beta?.toFixed(3) || 'N/A';
  const zScore = tf.zScore?.toFixed(2) || 'N/A';
  const halfLife = tf.halfLife !== undefined && tf.halfLife !== Infinity ? tf.halfLife.toFixed(1) + 'd' : '∞';
  const gamma = tf.gamma?.toFixed(3) || 'N/A';
  const theta = tf.theta?.toFixed(3) || 'N/A';
  const coint = tf.isCointegrated ? 'Yes' : 'No';
  
  let signal = '';
  if (pair.direction === 'long' && tf.zScore < -1) signal = ' [READY]';
  else if (pair.direction === 'short' && tf.zScore > 1) signal = ' [READY]';
  
  return `| **${tf.days}d** | ${corr} | ${beta} | ${zScore}${signal} | ${halfLife} | ${coint} | ${gamma} | ${theta} |`;
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

## Funding Analysis

${(() => {
  const netFunding = calculateNetFunding(longAsset, shortAsset, fundingMap);
  
  if (netFunding.netFunding8h === null) {
    return '**Funding data not available**';
  }
  
  const longData = fundingMap.get(longAsset);
  const shortData = fundingMap.get(shortAsset);
  
  const netSign = netFunding.netFunding8h >= 0 ? '+' : '';
  const net8h = (netFunding.netFunding8h * 100).toFixed(4);
  const netDaily = (netFunding.netFundingDaily * 100).toFixed(4);
  const netMonthly = (netFunding.netFundingMonthly * 100).toFixed(2);
  
  const longFund = longData ? longData.funding : 0;
  const shortFund = shortData ? shortData.funding : 0;
  const longFundPct = (longFund * 100).toFixed(4);
  const shortFundPct = (shortFund * 100).toFixed(4);
  
  // Funding effect: positive funding = longs pay shorts, negative = shorts pay longs
  const longEffect = longFund >= 0 ? 'You pay' : 'You receive';
  const shortEffect = shortFund >= 0 ? 'You receive' : 'You pay';
  
  return `| Asset | Position | Funding Rate (8h) | Effect |
|-------|----------|-------------------|--------|
| **${longAsset}** | LONG | ${longFundPct}% | ${longEffect} |
| **${shortAsset}** | SHORT | ${shortFundPct}% | ${shortEffect} |

**Net Funding:** ${netSign}${net8h}%/8h = ${netSign}${netDaily}%/day = **${netSign}${netMonthly}%/month**

${netFunding.netFunding8h >= 0 
  ? '**Favorable carry** - You earn funding while holding this position'
  : '**Negative carry** - You pay funding while holding this position'}`;
})()}

## Historical Divergence Analysis

${(() => {
  if (!divergenceProfile) {
    return '**Divergence analysis not available**\n\nRun `npm run scan` to generate divergence profiles for all pairs.';
  }
  
  const thresholds = divergenceProfile.thresholds;
  const optEntry = divergenceProfile.optimalEntry;
  const maxZ = divergenceProfile.maxHistoricalZ;
  const currentZ = divergenceProfile.currentZ;
  
  let tableRows = '';
  for (const thresh of [1.0, 1.5, 2.0, 2.5, 3.0]) {
    const data = thresholds[thresh];
    if (!data) continue;
    
    const events = data.totalEvents || 0;
    const reverted = data.revertedEvents || 0;
    const rate = data.reversionRate !== null ? (data.reversionRate * 100).toFixed(0) + '%' : 'N/A';
    const avgDur = data.avgDuration !== null ? data.avgDuration.toFixed(1) + 'd' : 'N/A';
    const avgPeak = data.avgPeakZ !== null ? data.avgPeakZ.toFixed(2) : 'N/A';
    const isOptimal = thresh === optEntry ? ' ✓' : '';
    
    tableRows += `| ${thresh.toFixed(1)}${isOptimal} | ${events} | ${reverted} | ${rate} | ${avgDur} | ${avgPeak} |\n`;
  }
  
  return `This analysis shows how often the Z-score reached each threshold in the past 30 days and whether it reverted back to mean (|Z| < 0.5).

| Threshold | Events | Reverted | Success Rate | Avg Duration | Avg Peak |
|-----------|--------|----------|--------------|--------------|----------|
${tableRows}
**Optimal Entry Threshold:** ${optEntry.toFixed(1)} (highest threshold with 100% reversion rate)

**Maximum Historical |Z|:** ${maxZ.toFixed(2)} (furthest divergence seen in window)

**Current Z-Score:** ${currentZ.toFixed(2)} (${Math.abs(currentZ) >= optEntry ? '**READY**' : `${(Math.abs(currentZ) / optEntry * 100).toFixed(0)}% to entry`})

*Use the optimal entry threshold instead of a fixed 2.0 for better timing.*`;
})()}

---

## Notes

- **Z-Score:** Negative = ${pair.symbol1} undervalued (good for LONG), Positive = ${pair.symbol1} overvalued (good for SHORT)
- **Half-Life:** Days for spread to revert halfway to mean (lower = faster, better)
- **Gamma:** Lower = more stable hedge ratio (better)
- **Theta:** Higher = faster mean reversion (better)
- **OBV:** Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
- **Cointegration:** Yes = pair moves together (better for pair trading)
- **Time to Exit:** Approx. halfLife × log₂(|Z| / 0.5) days to reach exit threshold
- **Funding:** Paid/received every 8h. Positive net = you earn; Negative net = you pay

*Data sources: Hyperliquid (prices), CryptoCompare (OBV/volume)*
`;
}

main();

