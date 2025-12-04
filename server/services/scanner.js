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
const { 
    checkPairFitness,
    calculateCorrelation,
    testCointegration,
    calculateHurst,
    calculateDualBeta,
    calculateConvictionScore
} = require('../../lib/pairAnalysis');
const db = require('../db/queries');

const CONFIG_DIR = path.join(__dirname, '../../config');

/**
 * Simplified divergence analysis using daily prices (no extra API calls)
 * Used by scanner for quick pair filtering
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

    // Find optimal entry (highest threshold with good reversion rate)
    let optimalEntry = 1.5;
    for (let i = thresholds.length - 1; i >= 0; i--) {
        const t = thresholds[i];
        const stats = profile[t];
        if (stats.events >= 1 && parseFloat(stats.rate) >= 50) {
            optimalEntry = t;
            break;
        }
    }

    return { optimalEntry, maxHistoricalZ, thresholds: profile };
}

const DEFAULT_MIN_VOLUME = 500_000;
const DEFAULT_MIN_OI = 100_000;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7; // Higher threshold for cross-sector
const MAX_HURST_THRESHOLD = 0.5; // Only keep mean-reverting pairs (H < 0.5)

// Time windows for different metrics
const WINDOWS = {
    cointegration: 90,  // Structural test - longer window for confidence
    hurst: 60,          // Needs 40+ data points for R/S analysis
    reactive: 30        // Z-score, correlation, beta - responsive to recent market
};
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

async function fetchHistoricalPrices(sdk, symbols) {
    const priceMap = new Map();
    const endTime = Date.now();
    // Fetch enough data for the longest window (cointegration = 90 days) + buffer
    const startTime = endTime - ((WINDOWS.cointegration + 5) * 24 * 60 * 60 * 1000);

    const batchSize = 5;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);

        const promises = batch.map(async (symbol) => {
            try {
                const data = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTime, endTime);
                if (data && data.length > 0) {
                    const sorted = data.sort((a, b) => a.t - b.t);
                    const allPrices = sorted.map(c => parseFloat(c.c));
                    
                    // Return multi-window structure
                    return { 
                        symbol, 
                        prices: {
                            all: allPrices,
                            d90: allPrices.slice(-90),  // Cointegration
                            d60: allPrices.slice(-60),  // Hurst
                            d30: allPrices.slice(-30)   // Reactive metrics
                        }
                    };
                }
                return { symbol, prices: null };
            } catch (error) {
                return { symbol, prices: null };
            }
        });

        const results = await Promise.all(promises);
        for (const { symbol, prices } of results) {
            // Need at least 30 days of data for reactive metrics
            if (prices && prices.d30.length >= 25) {
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
        const priceData1 = priceMap.get(pair.asset1.symbol);
        const priceData2 = priceMap.get(pair.asset2.symbol);

        if (!priceData1 || !priceData2) continue;

        // Align each window separately
        const align = (arr1, arr2) => {
            const len = Math.min(arr1.length, arr2.length);
            return [arr1.slice(-len), arr2.slice(-len)];
        };

        const [prices1_30d, prices2_30d] = align(priceData1.d30, priceData2.d30);
        const [prices1_60d, prices2_60d] = align(priceData1.d60, priceData2.d60);
        const [prices1_90d, prices2_90d] = align(priceData1.d90, priceData2.d90);

        if (prices1_30d.length < 15) continue;

        // Use higher correlation threshold for cross-sector pairs
        const requiredCorr = pair.isCrossSector ? crossSectorMinCorrelation : minCorrelation;

        try {
            // REACTIVE METRICS (30-day window) - responsive to recent market
            const { correlation, beta } = calculateCorrelation(prices1_30d, prices2_30d);
            
            // STRUCTURAL TEST (90-day window) - internally consistent with 90d beta
            const cointLen = Math.min(prices1_90d.length, 90);
            const { beta: beta90d } = calculateCorrelation(
                prices1_90d.slice(-cointLen), 
                prices2_90d.slice(-cointLen)
            );
            const coint = testCointegration(
                prices1_90d.slice(-cointLen), 
                prices2_90d.slice(-cointLen), 
                beta90d  // Use 90d beta for 90d cointegration test
            );
            
            // Also get 30-day Z-score and half-life for trading
            const reactive = testCointegration(prices1_30d, prices2_30d, beta);

            // Must pass correlation AND 90-day cointegration test
            if (correlation >= requiredCorr && coint.isCointegrated && reactive.halfLife <= 45) {
                
                // HURST (60-day window) - needs 40+ data points
                const hurstLen = Math.min(prices1_60d.length, 60);
                const hurst = calculateHurst(prices1_60d.slice(-hurstLen));
                
                // Skip pairs that are not mean-reverting (H >= 0.5)
                if (hurst.isValid && hurst.hurst >= MAX_HURST_THRESHOLD) {
                    continue; // Skip trending/random walk pairs
                }
                
                // Calculate dual beta for regression quality metrics (uses all data)
                const dualBeta = calculateDualBeta(prices1_90d, prices2_90d, reactive.halfLife);
                
                // Calculate conviction score
                const conviction = calculateConvictionScore({
                    correlation: correlation,
                    r2: dualBeta.structural.r2,
                    halfLife: reactive.halfLife,  // Use 30-day half-life for trading relevance
                    hurst: hurst.hurst,
                    isCointegrated: coint.isCointegrated,
                    adfStat: coint.adfStat,  // Use 90-day ADF stat for confidence
                    betaDrift: dualBeta.drift
                });

                const divergenceProfile = analyzeLocalDivergences(prices1_30d, prices2_30d, beta);

                fittingPairs.push({
                    sector: pair.sector,
                    asset1: pair.asset1.symbol,
                    asset2: pair.asset2.symbol,
                    volume1: pair.asset1.volume24h,
                    volume2: pair.asset2.volume24h,
                    funding1: pair.asset1.fundingAnnualized,
                    funding2: pair.asset2.fundingAnnualized,
                    fundingSpread: pair.asset1.fundingAnnualized - pair.asset2.fundingAnnualized,
                    correlation: correlation,
                    beta: beta,
                    isCointegrated: coint.isCointegrated,  // 90-day structural test
                    halfLife: reactive.halfLife,           // 30-day for trading
                    zScore: reactive.zScore,               // 30-day current state
                    meanReversionRate: reactive.meanReversionRate,
                    optimalEntry: divergenceProfile.optimalEntry,
                    maxHistoricalZ: divergenceProfile.maxHistoricalZ,
                    divergenceProfile: divergenceProfile.thresholds,
                    isCrossSector: pair.isCrossSector,
                    // Advanced metrics
                    hurst: hurst.hurst,
                    hurstClassification: hurst.classification,
                    dualBeta: {
                        structural: dualBeta.structural.beta,
                        dynamic: dualBeta.dynamic.beta,
                        drift: dualBeta.drift,
                        r2: dualBeta.structural.r2
                    },
                    conviction: conviction.score,
                    // Window info for transparency
                    windows: {
                        cointegration: cointLen,
                        hurst: hurstLen,
                        reactive: prices1_30d.length
                    }
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

    const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded]);

    // Evaluate pairs
    const fittingPairs = evaluatePairs(candidatePairs, priceMap, DEFAULT_MIN_CORR, DEFAULT_CROSS_SECTOR_MIN_CORR);

    // Use conviction score for ranking (already calculated in evaluatePairs)
    // Fallback to simple score if conviction not available
    for (const pair of fittingPairs) {
        if (!pair.conviction) {
            const halfLifeFactor = 1 / Math.max(pair.halfLife, 0.5);
            pair.score = pair.correlation * halfLifeFactor * pair.meanReversionRate * 100;
        } else {
            pair.score = pair.conviction; // Use conviction as primary score
        }
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
            maxHalfLife: 45,
            maxHurst: MAX_HURST_THRESHOLD
        },
        windows: WINDOWS,  // Multi-window configuration
        crossSectorEnabled: crossSector,
        totalAssets: universe.length,
        filteredAssets: filtered.length,
        candidatePairs: candidatePairs.length,
        fittingPairs: fittingPairs.length,
        pairs: fittingPairs.map(p => ({
            pair: `${p.asset1}/${p.asset2}`,
            sector: p.sector,
            score: parseFloat(p.score.toFixed(2)),
            conviction: p.conviction ? parseFloat(p.conviction.toFixed(1)) : null,
            hurst: p.hurst ? parseFloat(p.hurst.toFixed(3)) : null,
            hurstClassification: p.hurstClassification || null,
            correlation: parseFloat(p.correlation.toFixed(3)),
            beta: parseFloat(p.beta.toFixed(3)),
            halfLife: parseFloat(p.halfLife.toFixed(1)),
            zScore: parseFloat(p.zScore.toFixed(2)),
            meanReversionRate: parseFloat(p.meanReversionRate.toFixed(3)),
            fundingSpread: parseFloat(p.fundingSpread.toFixed(2)),
            optimalEntry: p.optimalEntry,
            maxHistoricalZ: parseFloat(p.maxHistoricalZ.toFixed(2)),
            dualBeta: p.dualBeta || null
        }))
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'discovered_pairs.json'), JSON.stringify(output, null, 2));

    // Build watchlist pairs
    const watchlistData = watchlistPairs.map(p => {
        const entryThreshold = p.optimalEntry;
        const signalStrength = Math.min(Math.abs(p.zScore) / entryThreshold, 1.0);
        const direction = p.zScore < 0 ? 'long' : 'short';
        const isReady = Math.abs(p.zScore) >= entryThreshold;
        const betaValue = parseFloat(p.beta.toFixed(3));

        return {
            pair: `${p.asset1}/${p.asset2}`,
            asset1: p.asset1,
            asset2: p.asset2,
            sector: p.sector,
            qualityScore: parseFloat(p.score.toFixed(2)),
            conviction: p.conviction ? parseFloat(p.conviction.toFixed(1)) : null,
            hurst: p.hurst ? parseFloat(p.hurst.toFixed(3)) : null,
            hurstClassification: p.hurstClassification || null,
            correlation: parseFloat(p.correlation.toFixed(3)),
            beta: betaValue,
            initialBeta: betaValue,  // Set initial beta at discovery
            betaDrift: 0,            // No drift at discovery
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
        description: `Top ${TOP_PER_SECTOR} pairs per sector${crossSector ? ` + top ${TOP_CROSS_SECTOR} cross-sector` : ''} by conviction score (Hurst < ${MAX_HURST_THRESHOLD} filter applied)`,
        crossSectorEnabled: crossSector,
        hurstThreshold: MAX_HURST_THRESHOLD,
        totalPairs: watchlistData.length,
        pairs: watchlistData
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 2));

    // Save watchlist to Supabase (persistence)
    let removedPairs = 0;
    try {
        await db.upsertWatchlist(watchlistData);
        console.log(`[SCANNER] Saved ${watchlistData.length} pairs to Supabase`);
        
        // Clean up old pairs: keep only new discoveries + active trades
        const newPairNames = new Set(watchlistData.map(p => p.pair));
        const activeTrades = await db.getTrades();
        const activeTradePairs = new Set(activeTrades.map(t => t.pair));
        
        // Get all current watchlist pairs from DB
        const currentWatchlist = await db.getWatchlist();
        
        // Find pairs to remove (not in new scan AND not in active trades)
        const pairsToRemove = currentWatchlist.filter(p => 
            !newPairNames.has(p.pair) && !activeTradePairs.has(p.pair)
        );
        
        // Delete stale pairs
        for (const pair of pairsToRemove) {
            try {
                await db.deleteWatchlistPair(pair.pair);
                removedPairs++;
            } catch (e) {
                console.error(`[SCANNER] Failed to remove ${pair.pair}:`, e.message);
            }
        }
        
        if (removedPairs > 0) {
            console.log(`[SCANNER] Cleaned up ${removedPairs} stale pairs from watchlist`);
        }
        if (activeTradePairs.size > 0) {
            const preserved = currentWatchlist.filter(p => 
                activeTradePairs.has(p.pair) && !newPairNames.has(p.pair)
            );
            if (preserved.length > 0) {
                console.log(`[SCANNER] Preserved ${preserved.length} pairs with active trades: ${preserved.map(p => p.pair).join(', ')}`);
            }
        }
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
        removedPairs: removedPairs,
        unmappedSymbols: unmapped
    };
}

module.exports = { main };
