/**
 * Scanner Service - Core scanning logic extracted from scanPairs.js
 * 
 * Discovers tradeable pairs from Hyperliquid perpetuals.
 * Returns structured result for API/Telegram.
 * Writes to both local JSON (backup) and Supabase (persistence).
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness, analyzeHistoricalDivergences } = require('../../lib/pairAnalysis');
const db = require('../db/queries');

const CONFIG_DIR = path.join(__dirname, '../../config');

const DEFAULT_MIN_VOLUME = 500_000;
const DEFAULT_MIN_OI = 100_000;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7; // Higher threshold for cross-sector
const DEFAULT_LOOKBACK_DAYS = 30;
const TOP_PER_SECTOR = 3;
const TOP_CROSS_SECTOR = 5; // Top 5 cross-sector pairs total
const EXIT_THRESHOLD = 0.5;

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
                    fundingAnnualized: funding * 24 * 365 * 100
                });
            }
        }

        return { assets, sdk };
    } catch (error) {
        restoreConsole(saved);
        throw error;
    }
}

async function fetchHistoricalPrices(sdk, symbols, days) {
    const priceMap = new Map();
    const endTime = Date.now();
    const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);

    const batchSize = 5;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);

        const promises = batch.map(async (symbol) => {
            try {
                const data = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTime, endTime);
                if (data && data.length > 0) {
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
            if (prices && prices.length >= days * 0.8) {
                priceMap.set(symbol, prices);
            }
        }

        if (i + batchSize < symbols.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
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

function generateCandidatePairs(sectorGroups, includeCrossSector = false) {
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

    // Cross-sector pairs (top 5 most liquid from each sector)
    if (includeCrossSector) {
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
                            sector: `${sector1}×${sector2}`,
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

function evaluatePairs(candidatePairs, priceMap, minCorrelation, crossSectorMinCorrelation) {
    const fittingPairs = [];

    for (const pair of candidatePairs) {
        const prices1 = priceMap.get(pair.asset1.symbol);
        const prices2 = priceMap.get(pair.asset2.symbol);

        if (!prices1 || !prices2) continue;

        const minLen = Math.min(prices1.length, prices2.length);
        const aligned1 = prices1.slice(-minLen);
        const aligned2 = prices2.slice(-minLen);

        if (minLen < 15) continue;

        // Use higher correlation threshold for cross-sector pairs
        const requiredCorr = pair.isCrossSector ? crossSectorMinCorrelation : minCorrelation;

        try {
            const fitness = checkPairFitness(aligned1, aligned2);

            if (fitness.correlation >= requiredCorr && fitness.isCointegrated && fitness.halfLife <= 45) {
                const divergenceProfile = analyzeHistoricalDivergences(aligned1, aligned2, fitness.beta);

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
                    optimalEntry: divergenceProfile.optimalEntry,
                    maxHistoricalZ: divergenceProfile.maxHistoricalZ,
                    divergenceProfile: divergenceProfile.thresholds,
                    isCrossSector: pair.isCrossSector
                });
            }
        } catch (error) { }
    }

    return fittingPairs;
}

/**
 * Main scan function - returns structured result
 * @param {Object} options - Scan options
 * @param {boolean} options.crossSector - Include cross-sector pairs (default: false)
 */
async function main(options = {}) {
    const { crossSector = false } = options;
    
    const { symbolToSector, sectors } = loadSectorMap();
    const blacklist = loadBlacklist();

    // Fetch universe
    const { assets: universe, sdk } = await fetchUniverse();

    // Filter by liquidity
    const liquidityFiltered = filterByLiquidity(universe, DEFAULT_MIN_VOLUME, DEFAULT_MIN_OI);

    // Apply blacklist
    const filtered = liquidityFiltered.filter(a => !blacklist.has(a.symbol));

    // Group by sector
    const { groups, unmapped } = groupBySector(filtered, symbolToSector);

    // Generate candidate pairs (with optional cross-sector)
    const candidatePairs = generateCandidatePairs(groups, crossSector);

    // Fetch historical prices
    const symbolsNeeded = new Set();
    for (const pair of candidatePairs) {
        symbolsNeeded.add(pair.asset1.symbol);
        symbolsNeeded.add(pair.asset2.symbol);
    }

    const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded], DEFAULT_LOOKBACK_DAYS);

    // Evaluate pairs
    const fittingPairs = evaluatePairs(candidatePairs, priceMap, DEFAULT_MIN_CORR, DEFAULT_CROSS_SECTOR_MIN_CORR);

    // Calculate composite score
    for (const pair of fittingPairs) {
        const halfLifeFactor = 1 / Math.max(pair.halfLife, 0.5);
        pair.score = pair.correlation * halfLifeFactor * pair.meanReversionRate * 100;
    }

    fittingPairs.sort((a, b) => b.score - a.score);

    // Select top pairs per sector
    const watchlistPairs = [];
    const sectorCounts = {};
    const crossSectorPairs = [];

    for (const pair of fittingPairs) {
        if (pair.isCrossSector) {
            // Collect cross-sector pairs separately
            if (crossSectorPairs.length < TOP_CROSS_SECTOR) {
                crossSectorPairs.push(pair);
            }
        } else {
            // Top 3 per same-sector
            sectorCounts[pair.sector] = sectorCounts[pair.sector] || 0;
            if (sectorCounts[pair.sector] < TOP_PER_SECTOR) {
                watchlistPairs.push(pair);
                sectorCounts[pair.sector]++;
            }
        }
    }

    // Add top cross-sector pairs to watchlist
    watchlistPairs.push(...crossSectorPairs);

    // Disconnect SDK
    const saved = suppressConsole();
    await sdk.disconnect();
    restoreConsole(saved);

    // Save discovered pairs
    const output = {
        timestamp: new Date().toISOString(),
        thresholds: { 
            minVolume: DEFAULT_MIN_VOLUME, 
            minOI: DEFAULT_MIN_OI, 
            minCorrelation: DEFAULT_MIN_CORR, 
            crossSectorMinCorrelation: DEFAULT_CROSS_SECTOR_MIN_CORR,
            maxHalfLife: 45 
        },
        lookbackDays: DEFAULT_LOOKBACK_DAYS,
        crossSectorEnabled: crossSector,
        totalAssets: universe.length,
        filteredAssets: filtered.length,
        candidatePairs: candidatePairs.length,
        fittingPairs: fittingPairs.length,
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
            optimalEntry: p.optimalEntry,
            maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2))
        }))
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'discovered_pairs.json'), JSON.stringify(output, null, 2));

    // Build watchlist pairs
    const watchlistData = watchlistPairs.map(p => {
        const entryThreshold = p.optimalEntry;
        const signalStrength = Math.min(Math.abs(p.zScore) / entryThreshold, 1.0);
        const direction = p.zScore < 0 ? 'long' : 'short';
        const isReady = Math.abs(p.zScore) >= entryThreshold;

        return {
            pair: `${p.asset1}/${p.asset2}`,
            asset1: p.asset1,
            asset2: p.asset2,
            sector: p.sector,
            qualityScore: parseFloat(p.score.toFixed(2)),
            correlation: parseFloat(p.correlation.toFixed(3)),
            beta: parseFloat(p.beta.toFixed(3)),
            halfLife: parseFloat(p.halfLife.toFixed(1)),
            meanReversionRate: parseFloat(p.meanReversionRate.toFixed(3)),
            zScore: parseFloat(p.zScore.toFixed(2)),
            signalStrength: parseFloat(signalStrength.toFixed(2)),
            direction,
            isReady,
            entryThreshold,
            exitThreshold: EXIT_THRESHOLD,
            maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2)),
            fundingSpread: parseFloat(p.fundingSpread.toFixed(2)),
            lastScan: new Date().toISOString()
        };
    });

    // Save watchlist to local JSON (backup)
    const watchlist = {
        timestamp: new Date().toISOString(),
        description: `Top ${TOP_PER_SECTOR} pairs per sector${crossSector ? ` + top ${TOP_CROSS_SECTOR} cross-sector` : ''} by composite score`,
        crossSectorEnabled: crossSector,
        totalPairs: watchlistData.length,
        pairs: watchlistData
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 2));

    // Save watchlist to Supabase (persistence)
    try {
        await db.upsertWatchlist(watchlistData);
        console.log(`[SCANNER] Saved ${watchlistData.length} pairs to Supabase`);
    } catch (err) {
        console.error('[SCANNER] Failed to save to Supabase:', err.message);
    }

    return {
        totalAssets: universe.length,
        filteredAssets: filtered.length,
        candidatePairs: candidatePairs.length,
        fittingPairs: fittingPairs.length,
        watchlistPairs: watchlistPairs.length,
        crossSectorPairs: crossSectorPairs.length,
        crossSectorEnabled: crossSector,
        unmappedSymbols: unmapped
    };
}

module.exports = { main };
