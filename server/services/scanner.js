/**
 * Scanner Service - Core scanning logic extracted from scanPairs.js
 * 
 * Discovers tradeable pairs from Hyperliquid perpetuals.
 * Returns structured result for API/Telegram.
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness, analyzeHistoricalDivergences } = require('../../lib/pairAnalysis');

const CONFIG_DIR = path.join(__dirname, '../../config');

const DEFAULT_MIN_VOLUME = 500_000;
const DEFAULT_MIN_OI = 100_000;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_LOOKBACK_DAYS = 30;
const TOP_PER_SECTOR = 3;
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

function generateCandidatePairs(sectorGroups) {
    const pairs = [];

    for (const [sector, assets] of Object.entries(sectorGroups)) {
        if (assets.length < 2) continue;
        assets.sort((a, b) => b.volume24h - a.volume24h);

        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                pairs.push({ sector, asset1: assets[i], asset2: assets[j] });
            }
        }
    }

    return pairs;
}

function evaluatePairs(candidatePairs, priceMap, minCorrelation) {
    const fittingPairs = [];

    for (const pair of candidatePairs) {
        const prices1 = priceMap.get(pair.asset1.symbol);
        const prices2 = priceMap.get(pair.asset2.symbol);

        if (!prices1 || !prices2) continue;

        const minLen = Math.min(prices1.length, prices2.length);
        const aligned1 = prices1.slice(-minLen);
        const aligned2 = prices2.slice(-minLen);

        if (minLen < 15) continue;

        try {
            const fitness = checkPairFitness(aligned1, aligned2);

            if (fitness.correlation >= minCorrelation && fitness.isCointegrated && fitness.halfLife <= 45) {
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
                    divergenceProfile: divergenceProfile.thresholds
                });
            }
        } catch (error) { }
    }

    return fittingPairs;
}

/**
 * Main scan function - returns structured result
 */
async function main() {
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

    // Generate candidate pairs
    const candidatePairs = generateCandidatePairs(groups);

    // Fetch historical prices
    const symbolsNeeded = new Set();
    for (const pair of candidatePairs) {
        symbolsNeeded.add(pair.asset1.symbol);
        symbolsNeeded.add(pair.asset2.symbol);
    }

    const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded], DEFAULT_LOOKBACK_DAYS);

    // Evaluate pairs
    const fittingPairs = evaluatePairs(candidatePairs, priceMap, DEFAULT_MIN_CORR);

    // Calculate composite score
    for (const pair of fittingPairs) {
        const halfLifeFactor = 1 / Math.max(pair.halfLife, 0.5);
        pair.score = pair.correlation * halfLifeFactor * pair.meanReversionRate * 100;
    }

    fittingPairs.sort((a, b) => b.score - a.score);

    // Select top 3 per sector
    const watchlistPairs = [];
    const sectorCounts = {};

    for (const pair of fittingPairs) {
        sectorCounts[pair.sector] = sectorCounts[pair.sector] || 0;
        if (sectorCounts[pair.sector] < TOP_PER_SECTOR) {
            watchlistPairs.push(pair);
            sectorCounts[pair.sector]++;
        }
    }

    // Disconnect SDK
    const saved = suppressConsole();
    await sdk.disconnect();
    restoreConsole(saved);

    // Save discovered pairs
    const output = {
        timestamp: new Date().toISOString(),
        thresholds: { minVolume: DEFAULT_MIN_VOLUME, minOI: DEFAULT_MIN_OI, minCorrelation: DEFAULT_MIN_CORR, maxHalfLife: 45 },
        lookbackDays: DEFAULT_LOOKBACK_DAYS,
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

    // Save watchlist
    const watchlist = {
        timestamp: new Date().toISOString(),
        description: `Top ${TOP_PER_SECTOR} pairs per sector by composite score`,
        totalPairs: watchlistPairs.length,
        pairs: watchlistPairs.map(p => {
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
                maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2))
            };
        })
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 2));

    return {
        totalAssets: universe.length,
        filteredAssets: filtered.length,
        candidatePairs: candidatePairs.length,
        fittingPairs: fittingPairs.length,
        watchlistPairs: watchlistPairs.length,
        unmappedSymbols: unmapped
    };
}

module.exports = { main };

