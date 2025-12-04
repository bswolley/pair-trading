/**
 * Half-Life Diagnostic Script
 * 
 * Compares the two half-life calculation methods:
 * 1. Autocorrelation method (current in testCointegration)
 * 2. AR(1) regression method (used in analyzePair API)
 * 
 * Usage: node scripts/halfLifeDiagnostic.js
 */

const { Hyperliquid } = require('hyperliquid');
const db = require('../server/db/queries');

// Suppress SDK noise
function suppressConsole() {
  const orig = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return orig;
}

function restoreConsole(orig) {
  console.log = orig.log;
  console.error = orig.error;
}

/**
 * Method 1: Current autocorrelation method (from testCointegration)
 */
function calcHalfLifeAutocorr(spreads) {
  if (spreads.length < 10) return null;
  
  const spreadDiffs = [];
  for (let i = 1; i < spreads.length; i++) {
    spreadDiffs.push(spreads[i] - spreads[i - 1]);
  }
  
  const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
  let autocorr = 0, varDiff = 0;
  
  for (let i = 0; i < spreadDiffs.length; i++) {
    const dev = spreadDiffs[i] - meanDiff;
    varDiff += dev * dev;
    if (i > 0) {
      autocorr += (spreadDiffs[i] - meanDiff) * (spreadDiffs[i - 1] - meanDiff);
    }
  }
  
  varDiff /= spreadDiffs.length;
  autocorr /= (spreadDiffs.length - 1);
  const autocorrCoeff = varDiff > 0 ? autocorr / varDiff : 0;
  
  if (autocorrCoeff < 0 && autocorrCoeff > -1) {
    const hl = -Math.log(2) / Math.log(1 + autocorrCoeff);
    if (hl > 0 && isFinite(hl) && hl < 1000) {
      return { halfLife: hl, coeff: autocorrCoeff, method: 'autocorr' };
    }
  }
  
  return null;
}

/**
 * Method 2: AR(1) regression on spread levels (from analyzePair API)
 */
function calcHalfLifeAR1(spreads) {
  if (spreads.length < 10) return null;
  
  const spreadLevels = spreads.slice(0, -1); // X: spread[t-1]
  const spreadNext = spreads.slice(1);       // Y: spread[t]
  
  const meanX = spreadLevels.reduce((sum, s) => sum + s, 0) / spreadLevels.length;
  const meanY = spreadNext.reduce((sum, s) => sum + s, 0) / spreadNext.length;
  
  let numerator = 0, denominator = 0;
  for (let i = 0; i < spreadLevels.length; i++) {
    numerator += (spreadLevels[i] - meanX) * (spreadNext[i] - meanY);
    denominator += Math.pow(spreadLevels[i] - meanX, 2);
  }
  
  const phi = denominator > 0 ? numerator / denominator : null;
  
  if (phi !== null && phi > 0 && phi < 1) {
    const hl = -Math.log(2) / Math.log(phi);
    if (hl > 0 && isFinite(hl) && hl < 1000) {
      return { halfLife: hl, coeff: phi, method: 'ar1' };
    }
  }
  
  return null;
}

/**
 * Calculate beta from returns
 */
function calculateBeta(prices1, prices2) {
  const returns = [];
  for (let i = 1; i < prices1.length; i++) {
    returns.push({
      r1: (prices1[i] - prices1[i - 1]) / prices1[i - 1],
      r2: (prices2[i] - prices2[i - 1]) / prices2[i - 1]
    });
  }
  
  const mean1 = returns.reduce((sum, r) => sum + r.r1, 0) / returns.length;
  const mean2 = returns.reduce((sum, r) => sum + r.r2, 0) / returns.length;
  
  let covariance = 0, variance2 = 0;
  for (const ret of returns) {
    covariance += (ret.r1 - mean1) * (ret.r2 - mean2);
    variance2 += Math.pow(ret.r2 - mean2, 2);
  }
  
  return variance2 > 0 ? covariance / variance2 : 1;
}

async function fetchPrices(sdk, sym1, sym2, days = 30) {
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
  
  const [d1, d2] = await Promise.all([
    sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
    sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
  ]);
  
  if (!d1?.length || !d2?.length) return null;
  
  const m1 = new Map(), m2 = new Map();
  d1.forEach(c => m1.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
  d2.forEach(c => m2.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
  
  const dates = [...m1.keys()].filter(d => m2.has(d)).sort().slice(-days);
  if (dates.length < 15) return null;
  
  return {
    prices1: dates.map(d => m1.get(d)),
    prices2: dates.map(d => m2.get(d))
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           HALF-LIFE METHOD DIAGNOSTIC                          ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║ Comparing: Autocorr (current) vs AR(1) (API method)            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  // Get watchlist
  const watchlist = await db.getWatchlist();
  if (!watchlist || watchlist.length === 0) {
    console.log('No watchlist pairs found');
    return;
  }
  
  console.log(`Found ${watchlist.length} pairs in watchlist\n`);
  
  // Connect to Hyperliquid
  const sdk = new Hyperliquid();
  const saved = suppressConsole();
  await sdk.connect();
  restoreConsole(saved);
  
  const results = [];
  
  for (const pair of watchlist) {
    try {
      const priceData = await fetchPrices(sdk, pair.asset1, pair.asset2, 30);
      if (!priceData) {
        console.log(`⚠️  ${pair.pair}: Insufficient data`);
        continue;
      }
      
      const { prices1, prices2 } = priceData;
      const beta = calculateBeta(prices1, prices2);
      
      // Calculate spreads
      const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
      
      // Calculate half-life with both methods
      const autocorrResult = calcHalfLifeAutocorr(spreads);
      const ar1Result = calcHalfLifeAR1(spreads);
      
      const hlAutocorr = autocorrResult?.halfLife ?? null;
      const hlAR1 = ar1Result?.halfLife ?? null;
      
      // Calculate difference
      let diff = null;
      let pctDiff = null;
      if (hlAutocorr && hlAR1) {
        diff = hlAR1 - hlAutocorr;
        pctDiff = ((hlAR1 - hlAutocorr) / hlAutocorr) * 100;
      }
      
      results.push({
        pair: pair.pair,
        sector: pair.sector,
        storedHL: pair.halfLife,
        autocorrHL: hlAutocorr,
        ar1HL: hlAR1,
        diff,
        pctDiff,
        autocorrCoeff: autocorrResult?.coeff,
        ar1Phi: ar1Result?.coeff
      });
      
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log(`❌ ${pair.pair}: ${e.message}`);
    }
  }
  
  // Disconnect
  const saved2 = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved2);
  
  // Sort by absolute difference
  results.sort((a, b) => Math.abs(b.pctDiff || 0) - Math.abs(a.pctDiff || 0));
  
  // Print results
  console.log('\n┌─────────────────┬──────────┬───────────┬──────────┬───────────┬───────────┐');
  console.log('│ Pair            │ Stored   │ Autocorr  │ AR(1)    │ Diff (d)  │ Diff (%)  │');
  console.log('├─────────────────┼──────────┼───────────┼──────────┼───────────┼───────────┤');
  
  let significantDiffs = 0;
  
  for (const r of results) {
    const stored = r.storedHL !== null ? r.storedHL.toFixed(1).padStart(6) : '  null';
    const autocorr = r.autocorrHL !== null ? r.autocorrHL.toFixed(1).padStart(7) : '   null';
    const ar1 = r.ar1HL !== null ? r.ar1HL.toFixed(1).padStart(6) : '  null';
    const diff = r.diff !== null ? (r.diff >= 0 ? '+' : '') + r.diff.toFixed(1).padStart(6) : '   N/A';
    const pct = r.pctDiff !== null ? (r.pctDiff >= 0 ? '+' : '') + r.pctDiff.toFixed(0).padStart(5) + '%' : '    N/A';
    
    // Highlight significant differences (>30%)
    const highlight = r.pctDiff !== null && Math.abs(r.pctDiff) > 30;
    if (highlight) significantDiffs++;
    
    const prefix = highlight ? '│ ⚠️' : '│  ';
    console.log(`${prefix} ${r.pair.padEnd(14)} │ ${stored}d  │ ${autocorr}d  │ ${ar1}d  │ ${diff}d  │ ${pct}  │`);
  }
  
  console.log('└─────────────────┴──────────┴───────────┴──────────┴───────────┴───────────┘');
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Total pairs analyzed: ${results.length}`);
  console.log(`Pairs with >30% difference: ${significantDiffs}`);
  
  const validResults = results.filter(r => r.pctDiff !== null);
  if (validResults.length > 0) {
    const avgPctDiff = validResults.reduce((sum, r) => sum + Math.abs(r.pctDiff), 0) / validResults.length;
    const maxPctDiff = Math.max(...validResults.map(r => Math.abs(r.pctDiff)));
    
    console.log(`Average absolute difference: ${avgPctDiff.toFixed(1)}%`);
    console.log(`Maximum absolute difference: ${maxPctDiff.toFixed(1)}%`);
    
    // Show which method tends to give higher values
    const ar1Higher = validResults.filter(r => r.pctDiff > 0).length;
    const autocorrHigher = validResults.filter(r => r.pctDiff < 0).length;
    console.log(`\nAR(1) gives higher half-life: ${ar1Higher} pairs`);
    console.log(`Autocorr gives higher half-life: ${autocorrHigher} pairs`);
  }
  
  // Also check stored vs current
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('STORED vs CURRENT (using autocorr method)');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  const driftResults = results.filter(r => r.storedHL && r.autocorrHL);
  driftResults.sort((a, b) => {
    const driftA = Math.abs(a.autocorrHL - a.storedHL) / a.storedHL;
    const driftB = Math.abs(b.autocorrHL - b.storedHL) / b.storedHL;
    return driftB - driftA;
  });
  
  console.log('\nTop drifters (stored HL vs current calculation):');
  for (const r of driftResults.slice(0, 10)) {
    const drift = ((r.autocorrHL - r.storedHL) / r.storedHL) * 100;
    const emoji = Math.abs(drift) > 100 ? '🔥' : Math.abs(drift) > 50 ? '⚠️' : '  ';
    console.log(`${emoji} ${r.pair}: ${r.storedHL.toFixed(1)}d → ${r.autocorrHL.toFixed(1)}d (${drift >= 0 ? '+' : ''}${drift.toFixed(0)}%)`);
  }
}

main().catch(console.error);

