#!/usr/bin/env node

/**
 * Dry Run Scanner with Advanced Metrics
 * 
 * Tests the scanner with Hurst, Dual Beta, Regime Detection, and Conviction Score
 * without saving to database or files.
 * 
 * Usage: node scripts/scanDryRun.js [--cross-sector]
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');
const { 
  checkPairFitness, 
  analyzeHistoricalDivergences,
  calculateHurst,
  calculateDualBeta,
  detectRegime,
  calculateConvictionScore 
} = require('../lib/pairAnalysis');

const CONFIG_DIR = path.join(__dirname, '../config');

const DEFAULT_MIN_VOLUME = 500_000;
const DEFAULT_MIN_OI = 100_000;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7;
const DEFAULT_LOOKBACK_DAYS = 30;

// Parse args
const args = process.argv.slice(2);
const includeCrossSector = args.includes('--cross-sector') || args.includes('-c');

function loadSectorMap() {
  const configPath = path.join(CONFIG_DIR, 'sectors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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

function loadBlacklist() {
  const blacklistPath = path.join(CONFIG_DIR, 'blacklist.json');
  try {
    if (fs.existsSync(blacklistPath)) {
      const config = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
      return new Set(config.assets || []);
    }
  } catch (err) { }
  return new Set();
}

function suppressConsole() {
  const orig = { log: console.log, error: console.error };
  console.log = () => { };
  console.error = () => { };
  return orig;
}

function restoreConsole(orig) {
  console.log = orig.log;
  console.error = orig.error;
}

async function fetchUniverse() {
  const sdk = new Hyperliquid();
  const saved = suppressConsole();

  try {
    await sdk.connect();
    restoreConsole(saved);

    const meta = await sdk.info.perpetuals.getMeta();
    const assetMap = {};
    meta.universe.forEach((asset, idx) => {
      assetMap[idx] = { name: asset.name.replace('-PERP', ''), szDecimals: asset.szDecimals };
    });

    const marketData = await sdk.info.perpetuals.getMetaAndAssetCtxs();
    const assets = [];

    if (marketData && marketData[1]) {
      for (let i = 0; i < marketData[1].length; i++) {
        const ctx = marketData[1][i];
        const assetInfo = assetMap[i];
        if (!assetInfo) continue;

        const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
        const openInterest = parseFloat(ctx.openInterest) * parseFloat(ctx.oraclePx) || 0;
        const fundingAnnualized = (parseFloat(ctx.funding) * 24 * 365 * 100) || 0;

        assets.push({
          symbol: assetInfo.name,
          volume24h,
          openInterest,
          fundingAnnualized
        });
      }
    }

    return { assets, sdk };
  } catch (error) {
    restoreConsole(saved);
    throw error;
  }
}

async function fetchHistoricalPrices(sdk, symbols, lookbackDays) {
  const priceMap = new Map();
  const endTime = Date.now();
  const startTime = endTime - (lookbackDays * 24 * 60 * 60 * 1000);

  for (const symbol of symbols) {
    try {
      const candles = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTime, endTime);
      if (candles && candles.length > 0) {
        const prices = candles.map(c => parseFloat(c.c));
        priceMap.set(symbol, prices);
      }
    } catch (err) { }
    await new Promise(r => setTimeout(r, 50));
  }

  return priceMap;
}

function filterByLiquidity(assets, minVol, minOI) {
  return assets.filter(a => a.volume24h >= minVol && a.openInterest >= minOI);
}

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

function generateCandidatePairs(sectorGroups, crossSector = false) {
  const pairs = [];

  // Same-sector pairs
  for (const [sector, assets] of Object.entries(sectorGroups)) {
    if (assets.length < 2) continue;
    assets.sort((a, b) => b.volume24h - a.volume24h);

    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        pairs.push({ sector, asset1: assets[i], asset2: assets[j], isCrossSector: false });
      }
    }
  }

  // Cross-sector pairs
  if (crossSector) {
    const sectors = Object.keys(sectorGroups);
    const TOP_PER_SECTOR_CROSS = 5;

    for (let s1 = 0; s1 < sectors.length; s1++) {
      for (let s2 = s1 + 1; s2 < sectors.length; s2++) {
        const sector1 = sectors[s1];
        const sector2 = sectors[s2];
        const assets1 = sectorGroups[sector1]?.slice(0, TOP_PER_SECTOR_CROSS) || [];
        const assets2 = sectorGroups[sector2]?.slice(0, TOP_PER_SECTOR_CROSS) || [];

        for (const a1 of assets1) {
          for (const a2 of assets2) {
            pairs.push({
              sector: `${sector1}x${sector2}`,
              asset1: a1,
              asset2: a2,
              isCrossSector: true
            });
          }
        }
      }
    }
  }

  return pairs;
}

async function main() {
  console.log('\n========================================');
  console.log('  DRY RUN SCANNER - Advanced Metrics');
  console.log('========================================\n');
  console.log(`Cross-sector: ${includeCrossSector ? 'ENABLED' : 'disabled'}\n`);

  const { symbolToSector } = loadSectorMap();
  const blacklist = loadBlacklist();

  console.log('Fetching universe...');
  const { assets: universe, sdk } = await fetchUniverse();

  const liquidityFiltered = filterByLiquidity(universe, DEFAULT_MIN_VOLUME, DEFAULT_MIN_OI);
  const filtered = liquidityFiltered.filter(a => !blacklist.has(a.symbol));

  console.log(`Found ${filtered.length} liquid assets (from ${universe.length} total)\n`);

  const { groups } = groupBySector(filtered, symbolToSector);
  const candidatePairs = generateCandidatePairs(groups, includeCrossSector);

  console.log(`Generated ${candidatePairs.length} candidate pairs\n`);

  // Fetch prices
  const symbolsNeeded = new Set();
  for (const pair of candidatePairs) {
    symbolsNeeded.add(pair.asset1.symbol);
    symbolsNeeded.add(pair.asset2.symbol);
  }

  console.log('Fetching historical prices...');
  const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded], DEFAULT_LOOKBACK_DAYS);
  console.log(`Fetched prices for ${priceMap.size} assets\n`);

  // Evaluate pairs with advanced metrics
  console.log('Evaluating pairs with advanced metrics...\n');
  const results = [];
  let processed = 0;

  for (const pair of candidatePairs) {
    const prices1 = priceMap.get(pair.asset1.symbol);
    const prices2 = priceMap.get(pair.asset2.symbol);

    if (!prices1 || !prices2) continue;

    const minLen = Math.min(prices1.length, prices2.length);
    const aligned1 = prices1.slice(-minLen);
    const aligned2 = prices2.slice(-minLen);

    if (minLen < 15) continue;

    const requiredCorr = pair.isCrossSector ? DEFAULT_CROSS_SECTOR_MIN_CORR : DEFAULT_MIN_CORR;

    try {
      const fitness = checkPairFitness(aligned1, aligned2);

      if (fitness.correlation >= requiredCorr && fitness.isCointegrated && fitness.halfLife <= 45) {
        // Calculate advanced metrics
        const hurst = calculateHurst(aligned1);
        const dualBeta = calculateDualBeta(aligned1, aligned2, fitness.halfLife);
        const regime = detectRegime(fitness.zScore, 1.5, [], hurst.hurst);
        const conviction = calculateConvictionScore({
          correlation: fitness.correlation,
          r2: dualBeta.structural.r2,
          halfLife: fitness.halfLife,
          hurst: hurst.hurst,
          isCointegrated: fitness.isCointegrated,
          betaDrift: dualBeta.drift
        });

        const divergenceProfile = analyzeHistoricalDivergences(aligned1, aligned2, fitness.beta);

        results.push({
          pair: `${pair.asset1.symbol}/${pair.asset2.symbol}`,
          sector: pair.sector,
          isCrossSector: pair.isCrossSector,
          
          // Basic metrics
          correlation: fitness.correlation,
          beta: fitness.beta,
          zScore: fitness.zScore,
          halfLife: fitness.halfLife,
          isCointegrated: fitness.isCointegrated,
          
          // Advanced metrics
          hurst: hurst.hurst,
          hurstClassification: hurst.classification,
          isMeanReverting: hurst.hurst < 0.5,
          
          dualBeta: {
            structural: dualBeta.structural.beta,
            dynamic: dualBeta.dynamic.beta,
            drift: dualBeta.drift,
            r2: dualBeta.structural.r2
          },
          
          regime: regime.regime,
          regimeAction: regime.action,
          
          conviction: conviction.score,
          convictionBreakdown: conviction.breakdown,
          
          optimalEntry: divergenceProfile.optimalEntry
        });
      }
    } catch (error) { }

    processed++;
    if (processed % 50 === 0) {
      process.stdout.write(`\rProcessed ${processed}/${candidatePairs.length} pairs...`);
    }
  }

  console.log(`\rProcessed ${candidatePairs.length}/${candidatePairs.length} pairs    \n`);

  // Disconnect SDK
  const saved = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved);

  // Analyze results
  const meanReverting = results.filter(r => r.isMeanReverting);
  const trending = results.filter(r => !r.isMeanReverting);

  console.log('========================================');
  console.log('              RESULTS');
  console.log('========================================\n');

  console.log(`TOTAL COINTEGRATED PAIRS: ${results.length}`);
  console.log(`  Mean-reverting (H < 0.5): ${meanReverting.length}`);
  console.log(`  Trending/Random (H >= 0.5): ${trending.length}\n`);

  // Top by conviction (mean-reverting only)
  const topByConviction = [...meanReverting].sort((a, b) => b.conviction - a.conviction).slice(0, 10);

  if (topByConviction.length > 0) {
    console.log('TOP 10 MEAN-REVERTING BY CONVICTION:\n');
    console.log('Rank | Pair              | Conv | Hurst | Regime          | Z-Score | Half-Life');
    console.log('-----|-------------------|------|-------|-----------------|---------|----------');
    topByConviction.forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(4)} | ${p.pair.padEnd(17)} | ${p.conviction.toFixed(0).padStart(4)} | ${p.hurst.toFixed(2).padStart(5)} | ${p.regime.padEnd(15)} | ${p.zScore.toFixed(2).padStart(7)} | ${p.halfLife.toFixed(1).padStart(9)}`
      );
    });
  }

  // Trending pairs that would be filtered
  if (trending.length > 0) {
    console.log('\n\nWOULD BE FILTERED OUT (H >= 0.5):\n');
    const topTrending = [...trending].sort((a, b) => b.correlation - a.correlation).slice(0, 10);
    console.log('Pair              | Hurst | Classification      | Corr  | Z-Score');
    console.log('------------------|-------|---------------------|-------|--------');
    topTrending.forEach(p => {
      console.log(
        `${p.pair.padEnd(17)} | ${p.hurst.toFixed(2).padStart(5)} | ${p.hurstClassification.padEnd(19)} | ${p.correlation.toFixed(2).padStart(5)} | ${p.zScore.toFixed(2).padStart(7)}`
      );
    });
  }

  // Sector breakdown
  console.log('\n\nSECTOR BREAKDOWN (Mean-Reverting Only):\n');
  const sectorCounts = {};
  for (const p of meanReverting) {
    sectorCounts[p.sector] = (sectorCounts[p.sector] || 0) + 1;
  }
  Object.entries(sectorCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([sector, count]) => {
      console.log(`  ${sector}: ${count} pairs`);
    });

  // Summary stats
  console.log('\n\nSUMMARY STATISTICS:\n');
  if (meanReverting.length > 0) {
    const avgHurst = meanReverting.reduce((s, p) => s + p.hurst, 0) / meanReverting.length;
    const avgConviction = meanReverting.reduce((s, p) => s + p.conviction, 0) / meanReverting.length;
    const avgHalfLife = meanReverting.reduce((s, p) => s + p.halfLife, 0) / meanReverting.length;
    
    console.log(`  Mean-reverting pairs:`);
    console.log(`    Avg Hurst: ${avgHurst.toFixed(3)}`);
    console.log(`    Avg Conviction: ${avgConviction.toFixed(1)}`);
    console.log(`    Avg Half-Life: ${avgHalfLife.toFixed(1)} days`);
  }

  console.log('\n========================================');
  console.log('  DRY RUN COMPLETE - No changes saved');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});

