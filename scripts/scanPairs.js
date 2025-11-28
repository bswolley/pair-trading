#!/usr/bin/env node

/**
 * Pairs Scanner - Discovers tradeable pairs from Hyperliquid perpetuals
 * 
 * Steps:
 * 1. Fetch universe (all perps with price, volume, funding, OI)
 * 2. Filter by liquidity (24h volume > $500k, OI > $100k)
 * 3. Group by sector
 * 4. Generate pair combinations within each sector
 * 5. Compute correlation & cointegration for each pair
 * 6. Keep only fitting pairs (correlation > 0.6, cointegrated)
 * 
 * Usage: node scripts/scanPairs.js [--min-volume 500000] [--min-oi 100000] [--min-corr 0.6]
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness } = require('../lib/pairAnalysis');

// Default thresholds
const DEFAULT_MIN_VOLUME = 500_000;   // $500k 24h volume
const DEFAULT_MIN_OI = 100_000;        // $100k open interest
const DEFAULT_MIN_CORR = 0.6;          // Minimum correlation
const DEFAULT_LOOKBACK_DAYS = 30;      // Days of history for correlation/cointegration

// Parse CLI args
const args = process.argv.slice(2);
let minVolume = DEFAULT_MIN_VOLUME;
let minOI = DEFAULT_MIN_OI;
let minCorr = DEFAULT_MIN_CORR;

const volIdx = args.indexOf('--min-volume');
if (volIdx !== -1 && args[volIdx + 1]) {
  minVolume = parseFloat(args[volIdx + 1]);
}
const oiIdx = args.indexOf('--min-oi');
if (oiIdx !== -1 && args[oiIdx + 1]) {
  minOI = parseFloat(args[oiIdx + 1]);
}
const corrIdx = args.indexOf('--min-corr');
if (corrIdx !== -1 && args[corrIdx + 1]) {
  minCorr = parseFloat(args[corrIdx + 1]);
}

/**
 * Load sector mapping from config
 */
function loadSectorMap() {
  const configPath = path.join(__dirname, '../config/sectors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Build reverse map: symbol -> sector
  const symbolToSector = {};
  const sectors = config._sectors || [];

  for (const sector of sectors) {
    if (config[sector]) {
      for (const symbol of config[sector]) {
        symbolToSector[symbol] = sector;
      }
    }
  }

  return { symbolToSector, sectors, config };
}

/**
 * Suppress console noise during SDK operations
 */
function suppressConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => { };
  console.error = () => { };
  return { originalLog, originalError };
}

function restoreConsole({ originalLog, originalError }) {
  console.log = originalLog;
  console.error = originalError;
}

/**
 * Fetch all perpetuals with market data from Hyperliquid
 * Returns { assets, sdk } - keeps SDK connected for historical data
 */
async function fetchUniverse() {
  const sdk = new Hyperliquid();

  const saved = suppressConsole();
  try {
    await sdk.connect();
    restoreConsole(saved);

    // Get metadata (asset info)
    const meta = await sdk.info.perpetuals.getMeta();
    const assetMap = {};
    meta.universe.forEach((asset, idx) => {
      assetMap[idx] = {
        name: asset.name.replace('-PERP', ''),
        szDecimals: asset.szDecimals
      };
    });

    // Get market data (prices, volumes, OI, funding)
    const marketData = await sdk.info.perpetuals.getMetaAndAssetCtxs();

    const assets = [];

    if (marketData && marketData[1]) {
      for (let i = 0; i < marketData[1].length; i++) {
        const ctx = marketData[1][i];
        const info = assetMap[i];

        if (!info) continue;

        const markPx = parseFloat(ctx.markPx || 0);
        const volume24h = parseFloat(ctx.dayNtlVlm || 0);
        const openInterest = parseFloat(ctx.openInterest || 0) * markPx;
        const funding = parseFloat(ctx.funding || 0);

        assets.push({
          symbol: info.name,
          price: markPx,
          volume24h,
          openInterest,
          fundingRate: funding,
          fundingAnnualized: funding * 24 * 365 * 100 // annualized %
        });
      }
    }

    return { assets, sdk };

  } catch (error) {
    restoreConsole(saved);
    throw error;
  }
}

/**
 * Fetch historical prices for multiple symbols
 * @param {Hyperliquid} sdk - Connected SDK instance
 * @param {string[]} symbols - Array of symbols to fetch
 * @param {number} days - Number of days of history
 * @returns {Map<string, number[]>} Map of symbol -> price array
 */
async function fetchHistoricalPrices(sdk, symbols, days) {
  const priceMap = new Map();
  const endTime = Date.now();
  const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);

  // Batch fetch with rate limiting
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);

    const promises = batch.map(async (symbol) => {
      try {
        const data = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTime, endTime);
        if (data && data.length > 0) {
          // Sort by time and extract closing prices
          const sorted = data.sort((a, b) => a.t - b.t);
          const prices = sorted.slice(-days).map(c => parseFloat(c.c));
          return { symbol, prices };
        }
        return { symbol, prices: null };
      } catch (error) {
        return { symbol, prices: null };
      }
    });

    const results = await Promise.all(promises);
    for (const { symbol, prices } of results) {
      if (prices && prices.length >= days * 0.8) { // Allow 20% missing data
        priceMap.set(symbol, prices);
      }
    }

    // Rate limit between batches
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return priceMap;
}

/**
 * Filter assets by liquidity thresholds
 */
function filterByLiquidity(assets, minVol, minOI) {
  return assets.filter(a => a.volume24h >= minVol && a.openInterest >= minOI);
}

/**
 * Group assets by sector
 */
function groupBySector(assets, symbolToSector) {
  const groups = {};
  const unmapped = [];

  for (const asset of assets) {
    const sector = symbolToSector[asset.symbol];
    if (sector) {
      if (!groups[sector]) groups[sector] = [];
      groups[sector].push(asset);
    } else {
      unmapped.push(asset.symbol);
    }
  }

  return { groups, unmapped };
}

/**
 * Generate candidate pairs within each sector
 */
function generateCandidatePairs(sectorGroups) {
  const pairs = [];

  for (const [sector, assets] of Object.entries(sectorGroups)) {
    if (assets.length < 2) continue;

    // Sort by volume (most liquid first)
    assets.sort((a, b) => b.volume24h - a.volume24h);

    // Generate all combinations
    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        pairs.push({
          sector,
          asset1: assets[i],
          asset2: assets[j]
        });
      }
    }
  }

  return pairs;
}

/**
 * Evaluate pairs using correlation and cointegration
 */
function evaluatePairs(candidatePairs, priceMap, minCorrelation) {
  const fittingPairs = [];
  const rejectedPairs = [];

  for (const pair of candidatePairs) {
    const prices1 = priceMap.get(pair.asset1.symbol);
    const prices2 = priceMap.get(pair.asset2.symbol);

    if (!prices1 || !prices2) {
      rejectedPairs.push({ ...pair, reason: 'missing_data' });
      continue;
    }

    // Align arrays to same length
    const minLen = Math.min(prices1.length, prices2.length);
    const aligned1 = prices1.slice(-minLen);
    const aligned2 = prices2.slice(-minLen);

    if (minLen < 15) {
      rejectedPairs.push({ ...pair, reason: 'insufficient_data' });
      continue;
    }

    try {
      const fitness = checkPairFitness(aligned1, aligned2);

      // Check thresholds: correlation > min, cointegrated, half-life <= 45 days
      const passesCorrelation = fitness.correlation >= minCorrelation;
      const passesCointegration = fitness.isCointegrated;
      const passesHalfLife = fitness.halfLife <= 45;
      
      if (passesCorrelation && passesCointegration && passesHalfLife) {
        fittingPairs.push({
          sector: pair.sector,
          asset1: pair.asset1.symbol,
          asset2: pair.asset2.symbol,
          volume1: pair.asset1.volume24h,
          volume2: pair.asset2.volume24h,
          funding1: pair.asset1.fundingAnnualized,
          funding2: pair.asset2.fundingAnnualized,
          fundingSpread: pair.asset1.fundingAnnualized - pair.asset2.fundingAnnualized,
          correlation: fitness.correlation,
          beta: fitness.beta,
          isCointegrated: fitness.isCointegrated,
          halfLife: fitness.halfLife,
          zScore: fitness.zScore,
          meanReversionRate: fitness.meanReversionRate
        });
      } else {
        let reason = 'low_correlation';
        if (!passesCointegration) reason = 'not_cointegrated';
        else if (!passesHalfLife) reason = 'slow_halflife';
        
        rejectedPairs.push({
          ...pair,
          reason,
          correlation: fitness.correlation,
          halfLife: fitness.halfLife,
          isCointegrated: fitness.isCointegrated
        });
      }
    } catch (error) {
      rejectedPairs.push({ ...pair, reason: 'calc_error', error: error.message });
    }
  }

  return { fittingPairs, rejectedPairs };
}

/**
 * Main entry point
 */
async function main() {
  console.log('🔍 Pairs Scanner (with statistical filtering)\n');
  console.log(`Thresholds:`);
  console.log(`  Liquidity: Volume > $${(minVolume / 1000).toFixed(0)}k, OI > $${(minOI / 1000).toFixed(0)}k`);
  console.log(`  Pair fitness: Correlation > ${minCorr}, Cointegrated = true, Half-life ≤ 45 days\n`);

  // Load sector mapping
  const { symbolToSector, sectors } = loadSectorMap();
  console.log(`Loaded ${Object.keys(symbolToSector).length} symbols across ${sectors.length} sectors\n`);

  // Step 1: Fetch universe (keep SDK connected)
  console.log('Fetching Hyperliquid perpetuals...');
  const { assets: universe, sdk } = await fetchUniverse();
  console.log(`  Found ${universe.length} perpetuals\n`);

  // Step 2: Filter by liquidity
  const filtered = filterByLiquidity(universe, minVolume, minOI);
  console.log(`After liquidity filter: ${filtered.length} assets\n`);

  // Step 3: Group by sector
  const { groups, unmapped } = groupBySector(filtered, symbolToSector);

  console.log('Assets by sector:');
  for (const sector of sectors) {
    const count = groups[sector]?.length || 0;
    if (count > 0) {
      const symbols = groups[sector].map(a => a.symbol).join(', ');
      console.log(`  ${sector}: ${count} (${symbols})`);
    }
  }

  if (unmapped.length > 0) {
    console.log(`\n⚠️  Unmapped symbols (add to config/sectors.json): ${unmapped.join(', ')}`);
  }

  // Step 4: Generate candidate pairs
  const candidatePairs = generateCandidatePairs(groups);
  console.log(`\nGenerated ${candidatePairs.length} candidate pairs\n`);

  // Step 5: Fetch historical prices for all symbols in candidates
  const symbolsNeeded = new Set();
  for (const pair of candidatePairs) {
    symbolsNeeded.add(pair.asset1.symbol);
    symbolsNeeded.add(pair.asset2.symbol);
  }

  console.log(`Fetching ${DEFAULT_LOOKBACK_DAYS}d historical prices for ${symbolsNeeded.size} assets...`);
  const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded], DEFAULT_LOOKBACK_DAYS);
  console.log(`  Got price data for ${priceMap.size} assets\n`);

  // Step 6: Evaluate pairs
  console.log('Evaluating pair fitness (correlation + cointegration)...');
  const { fittingPairs, rejectedPairs } = evaluatePairs(candidatePairs, priceMap, minCorr);

  console.log(`  ✅ Fitting pairs: ${fittingPairs.length}`);
  console.log(`  ❌ Rejected pairs: ${rejectedPairs.length}\n`);

  // Rejection breakdown
  const rejectionReasons = {};
  for (const r of rejectedPairs) {
    rejectionReasons[r.reason] = (rejectionReasons[r.reason] || 0) + 1;
  }
  console.log('Rejection breakdown:');
  for (const [reason, count] of Object.entries(rejectionReasons)) {
    console.log(`  ${reason}: ${count}`);
  }

  // Summary by sector
  const pairsBySector = {};
  for (const pair of fittingPairs) {
    pairsBySector[pair.sector] = (pairsBySector[pair.sector] || 0) + 1;
  }

  console.log('\nFitting pairs by sector:');
  for (const [sector, count] of Object.entries(pairsBySector).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sector}: ${count} pairs`);
  }

  // Sort by correlation (best pairs first)
  fittingPairs.sort((a, b) => b.correlation - a.correlation);

  // Show top 15 pairs
  console.log('\nTop 15 fitting pairs (by correlation):');
  console.log('  Pair                  | Sector | Corr  | HalfLife | Z-Score | MeanRev');
  console.log('  ----------------------|--------|-------|----------|---------|--------');
  for (const pair of fittingPairs.slice(0, 15)) {
    const pairName = `${pair.asset1}/${pair.asset2}`.padEnd(20);
    const sector = pair.sector.padEnd(6);
    const corr = pair.correlation.toFixed(3);
    const hl = pair.halfLife < 100 ? pair.halfLife.toFixed(1).padStart(6) + 'd' : '    Inf';
    const z = pair.zScore.toFixed(2).padStart(7);
    const mr = (pair.meanReversionRate * 100).toFixed(0).padStart(5) + '%';
    console.log(`  ${pairName} | ${sector} | ${corr} | ${hl}  | ${z} | ${mr}`);
  }

  // Disconnect SDK
  const saved = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved);

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    thresholds: { minVolume, minOI, minCorrelation: minCorr, maxHalfLife: 45 },
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    totalAssets: universe.length,
    filteredAssets: filtered.length,
    candidatePairs: candidatePairs.length,
    fittingPairs: fittingPairs.length,
    pairsBySector,
    pairs: fittingPairs.map(p => ({
      pair: `${p.asset1}/${p.asset2}`,
      sector: p.sector,
      correlation: parseFloat(p.correlation.toFixed(3)),
      beta: parseFloat(p.beta.toFixed(3)),
      halfLife: parseFloat(p.halfLife.toFixed(1)),
      zScore: parseFloat(p.zScore.toFixed(2)),
      meanReversionRate: parseFloat(p.meanReversionRate.toFixed(3)),
      fundingSpread: parseFloat(p.fundingSpread.toFixed(2))
    }))
  };

  const outputPath = path.join(__dirname, '../config/discovered_pairs.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Results saved to ${outputPath}`);

  return output;
}

// Run
main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = { fetchUniverse, filterByLiquidity, groupBySector, generateCandidatePairs, evaluatePairs };
