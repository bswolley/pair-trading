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

/**
 * Simplified divergence analysis using daily prices (no extra API calls)
 * Used by scanner for quick pair filtering
 * Matches logic in lib/pairAnalysis.js analyzeHistoricalDivergences()
 */
function analyzeLocalDivergences(prices1, prices2, beta) {
  if (prices1.length < 15 || prices2.length < 15) {
    return { optimalEntry: 1.5, maxHistoricalZ: 2.0, thresholds: {} };
  }

  // Calculate spreads and z-scores from daily data
  const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const stdDevSpread = Math.sqrt(
    spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length
  );

  if (stdDevSpread === 0) {
    return { optimalEntry: 1.5, maxHistoricalZ: 2.0, thresholds: {} };
  }

  const zScores = spreads.map(s => (s - meanSpread) / stdDevSpread);

  // Find max historical z-score
  const maxHistoricalZ = Math.max(...zScores.map(z => Math.abs(z)));

  // Analyze threshold crossings
  const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
  const profile = {};

  for (const threshold of thresholds) {
    let events = 0;
    let reverted = 0;

    for (let i = 1; i < zScores.length; i++) {
      const absZ = Math.abs(zScores[i]);
      const prevAbsZ = Math.abs(zScores[i - 1]);

      // Crossed above threshold
      if (prevAbsZ < threshold && absZ >= threshold) {
        events++;
        // Check if it reverted in remaining data
        for (let j = i + 1; j < zScores.length; j++) {
          if (Math.abs(zScores[j]) < 0.5) {
            reverted++;
            break;
          }
        }
      }
    }

    profile[threshold] = {
      events,
      reverted,
      rate: events > 0 ? (reverted / events * 100).toFixed(1) + '%' : '0%'
    };
  }

  // Find optimal entry (highest threshold with 100% reversion rate, min 1.5)
  let optimalEntry = 1.5;
  for (let i = thresholds.length - 1; i >= 0; i--) {
    const t = thresholds[i];
    const stats = profile[t];
    if (stats.events >= 1 && parseFloat(stats.rate) === 100) {
      optimalEntry = t;
      break;
    }
  }

  return { optimalEntry, maxHistoricalZ, thresholds: profile };
}

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
const CROSS_SECTOR = args.includes('--cross-sector');

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
 * Load blacklist from config
 */
function loadBlacklist() {
  const blacklistPath = path.join(__dirname, '../config/blacklist.json');
  try {
    if (fs.existsSync(blacklistPath)) {
      const config = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
      return new Set(config.assets || []);
    }
  } catch (err) {
    console.warn('Warning: Could not load blacklist:', err.message);
  }
  return new Set();
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
function generateCandidatePairs(sectorGroups, includeCrossSector = false) {
  const pairs = [];

  // Same-sector pairs
  for (const [sector, assets] of Object.entries(sectorGroups)) {
    if (assets.length < 2) continue;

    // Sort by volume (most liquid first)
    assets.sort((a, b) => b.volume24h - a.volume24h);

    // Generate all combinations within sector
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

  // Cross-sector pairs (top assets from each sector)
  if (includeCrossSector) {
    const sectors = Object.keys(sectorGroups);
    const TOP_PER_SECTOR_CROSS = 5; // Top 5 most liquid from each sector
    
    for (let s1 = 0; s1 < sectors.length; s1++) {
      for (let s2 = s1 + 1; s2 < sectors.length; s2++) {
        const sector1 = sectors[s1];
        const sector2 = sectors[s2];
        const assets1 = sectorGroups[sector1]?.slice(0, TOP_PER_SECTOR_CROSS) || [];
        const assets2 = sectorGroups[sector2]?.slice(0, TOP_PER_SECTOR_CROSS) || [];
        
        for (const a1 of assets1) {
          for (const a2 of assets2) {
            pairs.push({
              sector: `${sector1}×${sector2}`,
              asset1: a1,
              asset2: a2
            });
          }
        }
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
        // Analyze historical divergences to find optimal entry threshold
        const divergenceProfile = analyzeLocalDivergences(aligned1, aligned2, fitness.beta);
        
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
          meanReversionRate: fitness.meanReversionRate,
          // Dynamic threshold data
          optimalEntry: divergenceProfile.optimalEntry,
          maxHistoricalZ: divergenceProfile.maxHistoricalZ,
          divergenceProfile: divergenceProfile.thresholds
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
  const liquidityFiltered = filterByLiquidity(universe, minVolume, minOI);
  console.log(`After liquidity filter: ${liquidityFiltered.length} assets`);

  // Step 2b: Apply blacklist
  const blacklist = loadBlacklist();
  const filtered = liquidityFiltered.filter(a => !blacklist.has(a.symbol));
  if (blacklist.size > 0) {
    const removed = liquidityFiltered.length - filtered.length;
    console.log(`After blacklist filter: ${filtered.length} assets (removed ${removed}: ${[...blacklist].join(', ')})`);
  }
  console.log('');

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
  const candidatePairs = generateCandidatePairs(groups, CROSS_SECTOR);
  const crossNote = CROSS_SECTOR ? ' (including cross-sector)' : ' (same-sector only)';
  console.log(`\nGenerated ${candidatePairs.length} candidate pairs${crossNote}\n`);

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

  // Calculate composite score for each pair
  // Score = correlation × (1 / halfLife) × meanReversionRate × 100
  // Higher = better (high corr, fast reversion, good mean reversion rate)
  for (const pair of fittingPairs) {
    const halfLifeFactor = 1 / Math.max(pair.halfLife, 0.5); // Avoid division by very small numbers
    pair.score = pair.correlation * halfLifeFactor * pair.meanReversionRate * 100;
  }

  // Sort by composite score (best pairs first)
  fittingPairs.sort((a, b) => b.score - a.score);

  // Show top 15 pairs by score
  console.log('\nTop 15 fitting pairs (by composite score):');
  console.log('  Pair                  | Sector | Score | Corr  | HL    | Z-Score | OptEntry | MaxZ');
  console.log('  ----------------------|--------|-------|-------|-------|---------|----------|------');
  for (const pair of fittingPairs.slice(0, 15)) {
    const pairName = `${pair.asset1}/${pair.asset2}`.padEnd(20);
    const sector = pair.sector.padEnd(6);
    const score = pair.score.toFixed(2).padStart(5);
    const corr = pair.correlation.toFixed(3);
    const hl = pair.halfLife < 100 ? pair.halfLife.toFixed(1).padStart(4) + 'd' : ' Inf';
    const z = pair.zScore.toFixed(2).padStart(7);
    const optEntry = pair.optimalEntry.toFixed(1).padStart(8);
    const maxZ = pair.maxHistoricalZ.toFixed(1).padStart(5);
    console.log(`  ${pairName} | ${sector} | ${score} | ${corr} | ${hl} | ${z} | ${optEntry} | ${maxZ}`);
  }

  // Select top 3 pairs from each sector for watchlist
  const TOP_PER_SECTOR = 3;
  const watchlistPairs = [];
  const sectorCounts = {};

  for (const pair of fittingPairs) {
    sectorCounts[pair.sector] = sectorCounts[pair.sector] || 0;
    if (sectorCounts[pair.sector] < TOP_PER_SECTOR) {
      watchlistPairs.push(pair);
      sectorCounts[pair.sector]++;
    }
  }

  // Exit threshold (fixed for all pairs)
  const EXIT_THRESHOLD = 0.5;   // Exit when |Z| < 0.5

  console.log(`\n📋 Watchlist: Top ${TOP_PER_SECTOR} pairs per sector (${watchlistPairs.length} total)`);
  console.log('  Pair                  | Sector      | Quality | HL    | Z-Score | Entry | Signal');
  console.log('  ----------------------|-------------|---------|-------|---------|-------|-------');

  // Group by sector for display
  const watchlistBySector = {};
  for (const pair of watchlistPairs) {
    if (!watchlistBySector[pair.sector]) watchlistBySector[pair.sector] = [];
    watchlistBySector[pair.sector].push(pair);
  }

  for (const [sector, pairs] of Object.entries(watchlistBySector).sort()) {
    for (const pair of pairs) {
      const pairName = `${pair.asset1}/${pair.asset2}`.padEnd(20);
      const sectorPad = sector.padEnd(11);
      const score = pair.score.toFixed(1).padStart(6);
      const hl = pair.halfLife.toFixed(1).padStart(4) + 'd';
      const z = pair.zScore.toFixed(2).padStart(7);
      const entryThreshold = pair.optimalEntry;
      const entryStr = entryThreshold.toFixed(1).padStart(5);
      const signal = Math.min(Math.abs(pair.zScore) / entryThreshold, 1.0);
      const signalPct = (signal * 100).toFixed(0).padStart(4) + '%';
      console.log(`  ${pairName} | ${sectorPad} | ${score} | ${hl} | ${z} | ${entryStr} | ${signalPct}`);
    }
  }

  // Disconnect SDK
  const saved = suppressConsole();
  await sdk.disconnect();
  restoreConsole(saved);

  // Save all discovered pairs
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
      score: parseFloat(p.score.toFixed(2)),
      correlation: parseFloat(p.correlation.toFixed(3)),
      beta: parseFloat(p.beta.toFixed(3)),
      halfLife: parseFloat(p.halfLife.toFixed(1)),
      zScore: parseFloat(p.zScore.toFixed(2)),
      meanReversionRate: parseFloat(p.meanReversionRate.toFixed(3)),
      fundingSpread: parseFloat(p.fundingSpread.toFixed(2)),
      // Dynamic threshold data
      optimalEntry: p.optimalEntry,
      maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2)),
      divergenceProfile: Object.fromEntries(
        Object.entries(p.divergenceProfile).map(([thresh, data]) => [
          thresh,
          {
            events: data.events,
            reverted: data.reverted,
            rate: data.rate // Already formatted as string like "93.3%"
          }
        ])
      )
    }))
  };

  const outputPath = path.join(__dirname, '../config/discovered_pairs.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ All pairs saved to ${outputPath}`);

  // Save watchlist (top 3 per sector)

  const watchlist = {
    timestamp: new Date().toISOString(),
    description: `Top ${TOP_PER_SECTOR} pairs per sector by composite score`,
    scoringFormula: 'qualityScore = correlation × (1/halfLife) × meanReversionRate × 100',
    signalFormula: 'signalStrength = |zScore| / entryThreshold (0-1, 1 = ready)',
    entryThresholdNote: 'Dynamic per-pair entry threshold based on historical divergence analysis',
    totalPairs: watchlistPairs.length,
    pairs: watchlistPairs.map(p => {
      // Use pair-specific optimal entry threshold
      const entryThreshold = p.optimalEntry;
      const signalStrength = Math.min(Math.abs(p.zScore) / entryThreshold, 1.0);
      const direction = p.zScore < 0 ? 'long' : 'short'; // Negative Z = asset1 undervalued = long asset1
      const isReady = Math.abs(p.zScore) >= entryThreshold;

      return {
        pair: `${p.asset1}/${p.asset2}`,
        asset1: p.asset1,
        asset2: p.asset2,
        sector: p.sector,
        // Quality metrics (stable)
        qualityScore: parseFloat(p.score.toFixed(2)),
        correlation: parseFloat(p.correlation.toFixed(3)),
        beta: parseFloat(p.beta.toFixed(3)),
        halfLife: parseFloat(p.halfLife.toFixed(1)),
        meanReversionRate: parseFloat(p.meanReversionRate.toFixed(3)),
        // Signal metrics (changes frequently)
        zScore: parseFloat(p.zScore.toFixed(2)),
        signalStrength: parseFloat(signalStrength.toFixed(2)),
        direction,  // 'long' = long asset1/short asset2, 'short' = short asset1/long asset2
        isReady,
        // Dynamic thresholds (per-pair)
        entryThreshold: entryThreshold,
        exitThreshold: EXIT_THRESHOLD,
        maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2)),
        // Divergence profile summary
        divergenceProfile: Object.fromEntries(
          Object.entries(p.divergenceProfile).map(([thresh, data]) => [
            thresh,
            {
              events: data.events,
              reverted: data.reverted,
              rate: data.rate // Already formatted as string like "93.3%"
            }
          ])
        )
      };
    })
  };

  // Show actionable pairs (signal strength > 0.8)
  const actionablePairs = watchlist.pairs.filter(p => p.signalStrength >= 0.8);
  if (actionablePairs.length > 0) {
    console.log(`\n🎯 Actionable now (signal ≥ 80%):`);
    for (const p of actionablePairs) {
      const status = p.isReady ? '🟢 READY' : '🟡 CLOSE';
      const dir = p.direction === 'long' ? `Long ${p.asset1}` : `Short ${p.asset1}`;
      console.log(`  ${status} ${p.pair} | Z=${p.zScore} (entry@${p.entryThreshold}) | ${dir}`);
    }
  } else {
    console.log(`\n⏳ No pairs at entry threshold yet`);
  }

  const watchlistPath = path.join(__dirname, '../config/watchlist.json');
  fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
  console.log(`✅ Watchlist saved to ${watchlistPath}`);

  return output;
}

// Run
main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = { fetchUniverse, filterByLiquidity, groupBySector, generateCandidatePairs, evaluatePairs };
