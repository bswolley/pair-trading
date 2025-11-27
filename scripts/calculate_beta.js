const fs = require('fs');

// Load OHLC data
const ohlcData = JSON.parse(fs.readFileSync('snapshots/2025-11-18/ohlc.json', 'utf8'));

// Get BTC as benchmark (or ETH if BTC not available)
function getBenchmarkData() {
  // Try BTC first, then ETH
  if (ohlcData['BTC']?.data) {
    return { symbol: 'BTC', data: ohlcData['BTC'].data };
  }
  if (ohlcData['ETH']?.data) {
    return { symbol: 'ETH', data: ohlcData['ETH'].data };
  }
  return null;
}

// Calculate returns from price data
function calculateReturns(priceData) {
  const returns = [];
  for (let i = 1; i < priceData.length; i++) {
    const prevPrice = priceData[i - 1].close;
    const currPrice = priceData[i].close;
    if (prevPrice > 0) {
      returns.push((currPrice - prevPrice) / prevPrice);
    }
  }
  return returns;
}

// Calculate beta: beta = Cov(X, Y) / Var(Y)
function calculateBeta(assetReturns, benchmarkReturns) {
  if (assetReturns.length !== benchmarkReturns.length || assetReturns.length === 0) {
    return null;
  }
  
  // Calculate means
  const assetMean = assetReturns.reduce((sum, r) => sum + r, 0) / assetReturns.length;
  const benchmarkMean = benchmarkReturns.reduce((sum, r) => sum + r, 0) / benchmarkReturns.length;
  
  // Calculate covariance
  let covariance = 0;
  for (let i = 0; i < assetReturns.length; i++) {
    covariance += (assetReturns[i] - assetMean) * (benchmarkReturns[i] - benchmarkMean);
  }
  covariance /= assetReturns.length;
  
  // Calculate variance of benchmark
  let variance = 0;
  for (let i = 0; i < benchmarkReturns.length; i++) {
    variance += Math.pow(benchmarkReturns[i] - benchmarkMean, 2);
  }
  variance /= benchmarkReturns.length;
  
  if (variance === 0) return null;
  
  return covariance / variance;
}

// Calculate relative beta between two tokens (for pair trades)
function calculateRelativeBeta(tokenAReturns, tokenBReturns) {
  return calculateBeta(tokenAReturns, tokenBReturns);
}

// Main calculation
const benchmark = getBenchmarkData();
if (!benchmark) {
  console.log('Error: No BTC or ETH data found for benchmark');
  process.exit(1);
}

console.log(`Using ${benchmark.symbol} as benchmark\n`);

const benchmarkReturns = calculateReturns(benchmark.data);
const results = [];

// Calculate beta for all tokens with data
for (const [symbol, tokenData] of Object.entries(ohlcData)) {
  if (!tokenData.data || tokenData.data.length < 2) continue;
  if (symbol === benchmark.symbol) continue; // Skip benchmark itself
  
  const tokenReturns = calculateReturns(tokenData.data);
  
  // Align lengths (take minimum)
  const minLength = Math.min(tokenReturns.length, benchmarkReturns.length);
  if (minLength < 10) continue; // Need at least 10 data points
  
  const alignedTokenReturns = tokenReturns.slice(-minLength);
  const alignedBenchmarkReturns = benchmarkReturns.slice(-minLength);
  
  const beta = calculateBeta(alignedTokenReturns, alignedBenchmarkReturns);
  
  if (beta !== null && isFinite(beta)) {
    results.push({
      symbol,
      beta_vs_benchmark: beta,
      data_points: minLength,
      source: tokenData.source
    });
  }
}

// Sort by absolute beta (most volatile first)
results.sort((a, b) => Math.abs(b.beta_vs_benchmark) - Math.abs(a.beta_vs_benchmark));

// Save results
fs.writeFileSync('beta_calculations.json', JSON.stringify({
  benchmark: benchmark.symbol,
  calculated_at: new Date().toISOString(),
  tokens: results
}, null, 2));

// Print top results
console.log(`Calculated beta for ${results.length} tokens\n`);
console.log('Top 20 by absolute beta:');
console.log('Symbol | Beta vs ' + benchmark.symbol + ' | Data Points | Source');
console.log('-------|------------------|-------------|----------');
results.slice(0, 20).forEach(r => {
  console.log(`${r.symbol.padEnd(6)} | ${r.beta_vs_benchmark.toFixed(3).padStart(16)} | ${r.data_points.toString().padStart(11)} | ${r.source}`);
});

console.log(`\nFull results saved to beta_calculations.json`);

