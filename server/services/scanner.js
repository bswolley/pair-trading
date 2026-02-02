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
    calculateConvictionScore,
    calculateVolatilityMetrics,
    analyzeHistoricalDivergences
} = require('../../lib/pairAnalysis');
const db = require('../db/queries');

const CONFIG_DIR = path.join(__dirname, '../../config');

const MIN_ENTRY_THRESHOLD = 2.5; // Safety floor - never enter below this Z-score (raised from 2.0 based on performance data)

/**
 * Simplified divergence analysis using daily prices (no extra API calls)
 * Used by scanner for quick pair filtering
 */
function analyzeLocalDivergences(prices1, prices2, beta) {
    if (prices1.length < 15 || prices2.length < 15) {
        return { optimalEntry: MIN_ENTRY_THRESHOLD, maxHistoricalZ: 2.0, thresholds: {} };
    }

    // Calculate spreads and z-scores from daily data
    const spreads = prices1.map((p1, i) => Math.log(p1) - beta * Math.log(prices2[i]));
    const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const stdDevSpread = Math.sqrt(
        spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length
    );

    if (stdDevSpread === 0) {
        return { optimalEntry: MIN_ENTRY_THRESHOLD, maxHistoricalZ: 2.0, thresholds: {} };
    }

    const zScores = spreads.map(s => (s - meanSpread) / stdDevSpread);

    // Find max historical z-score
    const maxHistoricalZ = Math.max(...zScores.map(z => Math.abs(z)));

    // Analyze threshold crossings with percentage-based reversion (to 50% of threshold)
    const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
    const profile = {};

    for (const threshold of thresholds) {
        let events = 0;
        let reverted = 0;
        const percentReversionTarget = threshold * 0.5; // 50% of threshold

        for (let i = 1; i < zScores.length; i++) {
            const absZ = Math.abs(zScores[i]);
            const prevAbsZ = Math.abs(zScores[i - 1]);

            // Crossed above threshold
            if (prevAbsZ < threshold && absZ >= threshold) {
                events++;
                // Check if it reverted to < 50% of threshold (percentage-based)
                for (let j = i + 1; j < zScores.length; j++) {
                    if (Math.abs(zScores[j]) < percentReversionTarget) {
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

    // Find optimal entry using percentage-based reversion
    // Option B: Highest threshold with >= 90% reversion rate and min 3 events
    // Matches logic in lib/pairAnalysis.js analyzeHistoricalDivergences()
    let optimalEntry = 1.5;
    for (let i = thresholds.length - 1; i >= 0; i--) {
        const t = thresholds[i];
        const stats = profile[t];
        const rate = parseFloat(stats.rate);
        if (stats.events >= 3 && rate >= 90) {
            optimalEntry = t;
            break;
        }
    }
    // Fallback: if no threshold meets criteria, find highest with >= 80% and min 2 events
    if (optimalEntry === 1.5) {
        for (let i = thresholds.length - 1; i >= 0; i--) {
            const t = thresholds[i];
            const stats = profile[t];
            const rate = parseFloat(stats.rate);
            if (stats.events >= 2 && rate >= 80) {
                optimalEntry = t;
                break;
            }
        }
    }

    // Enforce minimum threshold floor
    optimalEntry = Math.max(optimalEntry, MIN_ENTRY_THRESHOLD);

    return { optimalEntry, maxHistoricalZ, thresholds: profile };
}

const DEFAULT_MIN_VOLUME = 500_000;
const DEFAULT_MIN_OI = 100_000;
const DEFAULT_MIN_CORR = 0.6;
const DEFAULT_CROSS_SECTOR_MIN_CORR = 0.7; // Higher threshold for cross-sector
const MAX_HURST_THRESHOLD = 0.50; // Only keep mean-reverting pairs (H < 0.5) - random walk threshold

// Asset tier definitions - based on market cap, liquidity, and reliability
// Updated based on actual Hyperliquid liquidity and market structure
const ASSET_TIERS = {
    majors: ['BTC', 'ETH', 'SOL'],
    bluechip: [
        // L1s (top tier, high liquidity)
        'AVAX', 'DOT', 'ATOM', 'NEAR', 'SUI', 'APT', 'TON', 'ADA', 'XRP', 'LTC', 'TRX',
        'INJ', 'SEI', 'TIA',
        // L2s
        'ARB', 'OP', 'MATIC', 'POL', 'MNT', 'STRK',
        // DeFi (established protocols)
        'LINK', 'AAVE', 'UNI', 'MKR', 'LDO', 'CRV', 'SNX', 'DYDX', 'GMX', 'PENDLE',
        'JUP', 'RUNE',
        // AI (top projects)
        'RENDER', 'RNDR', 'FET', 'TAO', 'WLD', 'VIRTUAL', 'AIXBT',
        // Exchange tokens
        'BNB', 'HYPE', 'LIT',
        // Privacy (established, high demand)
        'XMR', 'ZEC',
        // Top meme coins (high liquidity, established)
        'DOGE', 'kSHIB', 'kPEPE', 'WIF', 'POPCAT', 'kBONK', 'PENGU'
    ],
    established: [
        // L1/L2 (newer but proven)
        'MANTA', 'BERA', 'MOVE', 'INIT', 'HBAR', 'FOGO',
        // Privacy (smaller but proven)
        'ZEN',
        // DeFi (proven but smaller)
        'ENA', 'ETHFI', 'COMP', 'EIGEN', 'ZRO', 'JTO', 'AERO', 'USUAL',
        // AI (established but smaller)
        'GRIFFAIN', 'ZEREBRO', 'GRASS', 'IO', 'AR',
        // Gaming
        'IMX', 'GALA', 'SAND', 'ILV', 'BEAM', 'PRIME', 'PIXEL',
        // Infrastructure
        'ENS', 'TRB', 'BAND', 'API3', 'PYTH',
        // RWA
        'ONDO', 'OM',
        // NFT
        'BLUR',
        // Meme (established but lower liquidity)
        'MEME', 'kFLOKI', 'BOME', 'MEW', 'MYRO', 'kNEIRO', 'NEIROETH', 'BRETT',
        'MOODENG', 'FARTCOIN', 'GOAT', 'PNUT', 'CHILLGUY'
    ]
};

// Quality multipliers for conviction scoring
const QUALITY_MULTIPLIERS = {
    majors: 2.0,
    bluechip: 1.5,
    established: 1.2,
    other: 1.0
};

// Time windows for different metrics
// All metrics use 1-hour candles for granularity and statistical power
const WINDOWS = {
    cointegration: 90,  // Beta, Z-score, half-life: 90 days × 24h = 2160 points
    correlation: 60,    // Correlation: 60 days × 24h = 1440 points
    hurst: 60,          // Hurst: 60 days × 24h = 1440 points (needs 40+ for R/S)
    risk: 180           // Risk metrics: 180 days × 24h = 4320 points (future use)
};
const TOP_PER_SECTOR = 3;
const TOP_CROSS_SECTOR = 5; // Top 5 cross-sector pairs total
const EXIT_THRESHOLD = 0.5;
const MIN_REVERSION_RATE = 50; // Don't mark READY if reversion rate < 50% at current Z level

/**
 * Get the quality tier of an asset
 * @param {string} symbol - Asset symbol (e.g., "SOL", "LINK")
 * @returns {string} - Tier name: "majors", "bluechip", "established", or "other"
 */
function getAssetTier(symbol) {
    if (ASSET_TIERS.majors.includes(symbol)) return 'majors';
    if (ASSET_TIERS.bluechip.includes(symbol)) return 'bluechip';
    if (ASSET_TIERS.established.includes(symbol)) return 'established';
    return 'other';
}

/**
 * Calculate quality multiplier for a pair based on asset tiers
 * @param {string} symbol1 - First asset symbol
 * @param {string} symbol2 - Second asset symbol
 * @returns {number} - Quality multiplier (1.0 to 2.0)
 */
function getPairQualityMultiplier(symbol1, symbol2) {
    const tier1 = getAssetTier(symbol1);
    const tier2 = getAssetTier(symbol2);

    // Use the higher quality tier's multiplier (favors pairs with at least one strong asset)
    const mult1 = QUALITY_MULTIPLIERS[tier1] || 1.0;
    const mult2 = QUALITY_MULTIPLIERS[tier2] || 1.0;

    return Math.max(mult1, mult2);
}

/**
 * Check if current Z-score has acceptable historical reversion rate
 * Returns { isSafe: boolean, reversionRate: number|null, nearestThreshold: number|null, warning: string|null }
 */
function checkReversionSafety(currentZ, divergenceProfile) {
    if (!divergenceProfile || Object.keys(divergenceProfile).length === 0) {
        return { isSafe: true, reversionRate: null, nearestThreshold: null, warning: null };
    }

    const absZ = Math.abs(currentZ);
    const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];

    // Find the nearest threshold at or below current Z
    let nearestThreshold = null;
    for (let i = thresholds.length - 1; i >= 0; i--) {
        if (absZ >= thresholds[i]) {
            nearestThreshold = thresholds[i];
            break;
        }
    }

    if (nearestThreshold === null) {
        return { isSafe: true, reversionRate: null, nearestThreshold: null, warning: null };
    }

    const stats = divergenceProfile[nearestThreshold.toString()];
    if (!stats || stats.events === 0) {
        // No events at this threshold - can't judge, but warn if Z is extreme
        if (absZ >= 2.5) {
            return {
                isSafe: false,
                reversionRate: null,
                nearestThreshold,
                warning: `Z=${absZ.toFixed(2)} but no historical events at ${nearestThreshold}`
            };
        }
        return { isSafe: true, reversionRate: null, nearestThreshold, warning: null };
    }

    const reversionRate = parseFloat(stats.rate);
    const isSafe = reversionRate >= MIN_REVERSION_RATE;

    let warning = null;
    if (!isSafe) {
        warning = `Z=${absZ.toFixed(2)} but only ${stats.rate} reversion at ${nearestThreshold} (${stats.events} events)`;
    }

    return { isSafe, reversionRate, nearestThreshold, warning };
}

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

async function fetchHistoricalPrices(sdk, symbols, verbose = false) {
    const priceMap = new Map();
    const endTime = Date.now();
    // Hourly: 90 days for cointegration, correlation, z-score, half-life
    // Daily: 60 days for Hurst (trading-horizon mean reversion check)
    const startTimeHourly = endTime - ((WINDOWS.cointegration + 5) * 24 * 60 * 60 * 1000);
    const startTimeDaily = endTime - ((WINDOWS.hurst + 5) * 24 * 60 * 60 * 1000);

    let fetchSuccess = 0;
    let fetchFailed = 0;
    let insufficientData = 0;

    if (verbose) console.log(`\n[FETCHING prices for ${symbols.length} symbols...]`);

    // Rate limit calculation (from Hyperliquid docs):
    // - candleSnapshot weight = 20 + floor(items / 60)
    // - 2160 hourly candles = 20 + 36 = 56 weight
    // - 60 daily candles = 20 + 1 = 21 weight
    // - Per symbol = ~77 weight (hourly + daily)
    // - Limit = 1200 weight/minute
    // - Safe rate = ~15 symbols/minute = 1 symbol every 4 seconds
    // - Being slightly aggressive: 3 seconds per symbol

    const symbolDelayMs = 3000;  // 3 seconds between symbols (~20 symbols/min)

    if (verbose) {
        const estimatedTime = Math.ceil(symbols.length * symbolDelayMs / 1000);
        console.log(`  Rate limit safe mode: ~${estimatedTime}s estimated (${symbols.length} symbols × 3s)`);
    }

    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        
        try {
            // Sequential calls to respect rate limits
            const hourlyData = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1h', startTimeHourly, endTime);
            
            // Small delay between hourly and daily calls
            await new Promise(resolve => setTimeout(resolve, 300));
            
            const dailyData = await sdk.info.getCandleSnapshot(`${symbol}-PERP`, '1d', startTimeDaily, endTime);

            if (hourlyData && hourlyData.length > 0) {
                const sortedHourly = hourlyData.sort((a, b) => a.t - b.t);
                const allHourlyPrices = sortedHourly.map(c => parseFloat(c.c));

                // Daily for Hurst (trading-horizon behavior)
                let dailyPrices = null;
                if (dailyData && dailyData.length > 0) {
                    const sortedDaily = dailyData.sort((a, b) => a.t - b.t);
                    dailyPrices = sortedDaily.map(c => parseFloat(c.c));
                }

                // Need at least 500 hourly points
                if (allHourlyPrices.length >= 500) {
                    priceMap.set(symbol, {
                        h90: allHourlyPrices.slice(-(90 * 24)),
                        h60: allHourlyPrices.slice(-(60 * 24)),
                        h30: allHourlyPrices.slice(-(30 * 24)),
                        d60: dailyPrices ? dailyPrices.slice(-60) : null
                    });
                    fetchSuccess++;
                    if (verbose) console.log(`  ✓ ${symbol} (${i + 1}/${symbols.length})`);
                } else {
                    insufficientData++;
                    if (verbose) console.log(`  ✗ ${symbol}: insufficient (${allHourlyPrices.length} pts)`);
                }
            } else {
                fetchFailed++;
                if (verbose) console.log(`  ✗ ${symbol}: no data`);
            }
            } catch (error) {
            fetchFailed++;
            if (verbose) console.log(`  ✗ ${symbol}: ${error.message}`);
        }

        // Rate limit delay between symbols
        if (i < symbols.length - 1) {
            await new Promise(resolve => setTimeout(resolve, symbolDelayMs));
        }
    }

    if (verbose) {
        console.log(`\n[FETCH SUMMARY]`);
        console.log(`  Success: ${fetchSuccess}/${symbols.length}`);
        console.log(`  Failed: ${fetchFailed}`);
        console.log(`  Insufficient data: ${insufficientData}`);
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

    // Flatten all assets for major-anchored pairs
    const allAssets = [];
    for (const [sector, assets] of Object.entries(sectorGroups)) {
        assets.forEach(asset => {
            allAssets.push({ ...asset, sector });
        });
    }

    // Sort by volume for quality filtering
    allAssets.sort((a, b) => b.volume24h - a.volume24h);

    // STRATEGY 1: Major-Anchored Pairs (highest priority)
    // Pair each Major (BTC, ETH, SOL) with ALL bluechip and established altcoins
    // Majors are most liquid - best anchors for stat arb
    const majors = allAssets.filter(a => ASSET_TIERS.majors.includes(a.symbol));
    const bluechips = allAssets.filter(a => ASSET_TIERS.bluechip.includes(a.symbol));
    const established = allAssets.filter(a => ASSET_TIERS.established.includes(a.symbol));
    const qualityAltcoins = [...bluechips, ...established];

    console.log(`[SCANNER] Major-anchored pairs: ${majors.length} majors × ${qualityAltcoins.length} quality altcoins`);

    for (const major of majors) {
        // Pair each major with ALL bluechips and established
        for (const alt of qualityAltcoins) {
            // Skip if same asset
            if (major.symbol === alt.symbol) continue;
            
            const sector = major.sector === alt.sector ? major.sector : `${major.sector}×${alt.sector}`;
            const tier = ASSET_TIERS.bluechip.includes(alt.symbol) ? 'bluechip' : 'established';
            pairs.push({
                sector,
                asset1: major,
                asset2: alt,
                // Major-anchored pairs use lower correlation threshold (0.6)
                // They're intentionally cross-sector by design - majors are best anchors
                isCrossSector: false,
                pairType: `major_${tier}`
            });
        }
    }

    // STRATEGY 2: Same-sector pairs (bluechip × bluechip within same sector)
    for (const [sector, assets] of Object.entries(sectorGroups)) {
        if (assets.length < 2) continue;
        assets.sort((a, b) => b.volume24h - a.volume24h);

        // Only pair bluechips and established within same sector
        const qualityAssets = assets.filter(a =>
            ASSET_TIERS.bluechip.includes(a.symbol) ||
            ASSET_TIERS.established.includes(a.symbol)
        );

        for (let i = 0; i < qualityAssets.length; i++) {
            for (let j = i + 1; j < qualityAssets.length; j++) {
                pairs.push({
                    sector,
                    asset1: qualityAssets[i],
                    asset2: qualityAssets[j],
                    isCrossSector: false,
                    pairType: 'same_sector_quality'
                });
            }
        }
    }

    // STRATEGY 3: Cross-sector pairs (only for bluechips)
    if (includeCrossSector) {
        const sectors = Object.keys(sectorGroups);
        const TOP_PER_SECTOR_CROSS = 3; // Reduced from 5 - focus on highest quality

        for (let s1 = 0; s1 < sectors.length; s1++) {
            for (let s2 = s1 + 1; s2 < sectors.length; s2++) {
                const sector1 = sectors[s1];
                const sector2 = sectors[s2];

                // Only use bluechip assets for cross-sector
                const assets1 = sectorGroups[sector1]
                    ?.filter(a => ASSET_TIERS.bluechip.includes(a.symbol))
                    .slice(0, TOP_PER_SECTOR_CROSS) || [];
                const assets2 = sectorGroups[sector2]
                    ?.filter(a => ASSET_TIERS.bluechip.includes(a.symbol))
                    .slice(0, TOP_PER_SECTOR_CROSS) || [];

                for (const a1 of assets1) {
                    for (const a2 of assets2) {
                        pairs.push({
                            sector: `${sector1}×${sector2}`,
                            asset1: a1,
                            asset2: a2,
                            isCrossSector: true,
                            pairType: 'cross_sector_bluechip'
                        });
                    }
                }
            }
        }
    }

    console.log(`[SCANNER] Generated ${pairs.length} candidate pairs (major-anchored: ${majors.length} × ${qualityAltcoins.length}, same-sector, cross-sector)`);
    return pairs;
}

function evaluatePairs(candidatePairs, priceMap, minCorrelation, crossSectorMinCorrelation, verbose = false) {
    const fittingPairs = [];
    let evaluated = 0;
    let skippedNoData = 0;
    let skippedInsufficientData = 0;
    let failedCorr = 0;
    let failedCoint = 0;
    let failedHalfLife = 0;
    let failedHurst = 0;
    let errors = 0;

    for (const pair of candidatePairs) {
        const pairName = `${pair.asset1.symbol}/${pair.asset2.symbol}`;
        const priceData1 = priceMap.get(pair.asset1.symbol);
        const priceData2 = priceMap.get(pair.asset2.symbol);

        if (!priceData1 || !priceData2) {
            skippedNoData++;
            if (verbose) console.log(`  ${pairName}: SKIP (no price data)`);
            continue;
        }

        // Align each window separately
        // Align hourly windows (all metrics now use 1-hour candles)
        const align = (arr1, arr2) => {
            if (!arr1 || !arr2) return [null, null];
            const len = Math.min(arr1.length, arr2.length);
            return [arr1.slice(-len), arr2.slice(-len)];
        };

        // All windows are now hourly for granularity
        const [prices1_h90, prices2_h90] = align(priceData1.h90, priceData2.h90); // 2160 pts
        const [prices1_h60, prices2_h60] = align(priceData1.h60, priceData2.h60); // 1440 pts
        const [prices1_h30, prices2_h30] = align(priceData1.h30, priceData2.h30); // 720 pts

        // Need at least 500 hourly points (~20 days) for reliable analysis
        if (!prices1_h90 || prices1_h90.length < 500) {
            skippedInsufficientData++;
            if (verbose) console.log(`  ${pairName}: SKIP (insufficient data: ${prices1_h90?.length || 0} pts)`);
            continue;
        }

        // Use higher correlation threshold for cross-sector pairs
        const requiredCorr = pair.isCrossSector ? crossSectorMinCorrelation : minCorrelation;
        evaluated++;

        try {
            // CORRELATION (60-day hourly window = 1440 points)
            // Captures recent co-movement with intra-day granularity
            const { correlation, beta: beta60d } = calculateCorrelation(prices1_h60, prices2_h60);

            // COINTEGRATION TEST (90-day hourly = 2160 points)
            // Beta, Z-score, half-life all from same window for consistency
            const coint = testCointegration(prices1_h90, prices2_h90);
            const cointDataPoints = Math.min(prices1_h90.length, prices2_h90.length);

            // Use 90-day beta from cointegration for spread calculations
            const beta = coint.beta || beta60d;

            // Must pass correlation AND cointegration test
            // Half-life check: 5-10 days has higher win rate (based on performance data)
            // Note: half-life from hourly data is in HOURS, convert to days
            const halfLifeDays = coint.halfLife / 24;
            
            // Verbose logging for each filter step
            if (verbose) {
                console.log(`  ${pairName}: Corr=${correlation.toFixed(2)} (need>=${requiredCorr}) | ADF=${coint.adfStat.toFixed(2)} (coint=${coint.isCointegrated}) | HL=${halfLifeDays.toFixed(1)}d`);
            }
            
            if (correlation < requiredCorr) {
                failedCorr++;
                if (verbose) console.log(`    → FAIL: Correlation ${correlation.toFixed(2)} < ${requiredCorr}`);
                continue;
            }
            
            if (!coint.isCointegrated) {
                failedCoint++;
                if (verbose) console.log(`    → FAIL: Not cointegrated (ADF=${coint.adfStat.toFixed(2)})`);
                continue;
            }
            
            if (halfLifeDays > 10) {
                failedHalfLife++;
                if (verbose) console.log(`    → FAIL: Half-life ${halfLifeDays.toFixed(1)}d > 10d`);
                continue;
            }

            // HURST (60-day DAILY data) - measures trading-horizon mean reversion
            // Using daily data because Hurst should reflect behavior at trade duration (days)
            // Hourly Hurst captures short-term noise that doesn't affect multi-day trades
            const prices1_d60 = priceData1.d60;
            const prices2_d60 = priceData2.d60;
            let hurst = { isValid: false, hurst: 0.5 };
            let hurstLen = 0;
            
            if (prices1_d60 && prices2_d60 && prices1_d60.length >= 40) {
                hurstLen = Math.min(prices1_d60.length, prices2_d60.length);
                const spreads60d = [];
                for (let i = 0; i < hurstLen; i++) {
                    const p1 = prices1_d60[prices1_d60.length - hurstLen + i];
                    const p2 = prices2_d60[prices2_d60.length - hurstLen + i];
                    spreads60d.push(Math.log(p1) - beta * Math.log(p2));
                }
                hurst = calculateHurst(spreads60d);
            }

            // Skip pairs that are not mean-reverting (H >= threshold)
                if (hurst.isValid && hurst.hurst >= MAX_HURST_THRESHOLD) {
                failedHurst++;
                if (verbose) console.log(`    → FAIL: Hurst ${hurst.hurst.toFixed(2)} >= ${MAX_HURST_THRESHOLD}`);
                continue;
            }
            
            if (verbose) console.log(`    → PASS: All filters passed! Hurst=${hurst.hurst.toFixed(2)}`);

                // Calculate dual beta for regression quality (90-day hourly)
                const dualBeta = calculateDualBeta(prices1_h90, prices2_h90, coint.halfLife);

                // Calculate conviction score
                const conviction = calculateConvictionScore({
                    correlation: correlation,
                    r2: dualBeta.structural.r2,
                    halfLife: halfLifeDays,  // Convert to days for scoring
                    hurst: hurst.hurst,
                    isCointegrated: coint.isCointegrated,
                    adfStat: coint.adfStat,
                    betaDrift: dualBeta.drift
                });

                // Divergence analysis (30-day hourly for recent patterns)
                const divergenceProfile = analyzeLocalDivergences(prices1_h30, prices2_h30, beta);

                // Calculate volatility metrics (30-day hourly for recent vol)
                const volMetrics = calculateVolatilityMetrics(prices1_h30, prices2_h30, beta);

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
                    isCointegrated: coint.isCointegrated,  // Hourly cointegration test (2160 points)
                    adfStat: coint.adfStat,                // ADF statistic from proper test
                    pValue: coint.pValue,                  // P-value category
                    halfLife: halfLifeDays,                // Half-life in DAYS (converted from hourly)
                    halfLifeHours: coint.halfLife,         // Raw half-life in hours
                    zScore: coint.zScore,                  // Z-score from 90-day hourly
                    meanReversionRate: coint.meanReversionRate,
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
                    // Volatility metrics (beta neutralization)
                    spreadVol: volMetrics.spreadVol,
                    volRatio: volMetrics.volRatio,
                    // Window info for transparency (all hourly)
                    windows: {
                        cointegration: cointDataPoints,  // 90d × 24h = 2160 target
                        correlation: prices1_h60.length, // 60d × 24h = 1440 target
                        hurst: hurstLen,                 // 60d × 24h = 1440 target
                        reactive: prices1_h30.length     // 30d × 24h = 720 target
                    }
                });
        } catch (error) {
            errors++;
            if (verbose) console.log(`  ${pairName}: ERROR - ${error.message}`);
        }
    }

    // Log summary statistics
    if (verbose) {
        console.log(`\n[EVAL SUMMARY]`);
        console.log(`  Total candidates: ${candidatePairs.length}`);
        console.log(`  Skipped (no data): ${skippedNoData}`);
        console.log(`  Skipped (insufficient): ${skippedInsufficientData}`);
        console.log(`  Evaluated: ${evaluated}`);
        console.log(`  Failed Correlation: ${failedCorr}`);
        console.log(`  Failed Cointegration: ${failedCoint}`);
        console.log(`  Failed Half-Life: ${failedHalfLife}`);
        console.log(`  Failed Hurst: ${failedHurst}`);
        console.log(`  Errors: ${errors}`);
        console.log(`  PASSED: ${fittingPairs.length}`);
    }

    return fittingPairs;
}

/**
 * Main scan function - returns structured result
 * @param {Object} options - Scan options
 * @param {boolean} options.crossSector - Include cross-sector pairs (default: false)
 * @param {boolean} options.verbose - Log each pair evaluation (default: false)
 */
async function main(options = {}) {
    const { crossSector = false, verbose = false } = options;

    const { symbolToSector, sectors } = loadSectorMap();

    // Load blacklist from database (production source of truth)
    const blacklistData = await db.getBlacklist();
    const blacklist = new Set(blacklistData?.assets || []);
    if (blacklist.size > 0) {
        console.log(`[SCANNER] Blacklisted assets (${blacklist.size}): ${[...blacklist].join(', ')}`);
    }

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

    const priceMap = await fetchHistoricalPrices(sdk, [...symbolsNeeded], verbose);

    // Evaluate pairs
    if (verbose) console.log(`\n[EVALUATING ${candidatePairs.length} pairs...]`);
    const fittingPairs = evaluatePairs(candidatePairs, priceMap, DEFAULT_MIN_CORR, DEFAULT_CROSS_SECTOR_MIN_CORR, verbose);

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

    // Calculate signal strength for each pair (how close to entry threshold)
    // Use fixed MIN_ENTRY_THRESHOLD (2.5) for all pairs - simpler and comparable
    for (const pair of fittingPairs) {
        pair.signalStrength = Math.abs(pair.zScore) / MIN_ENTRY_THRESHOLD;
    }

    // HYBRID SELECTION: Top by conviction + Top by signal strength
    // This ensures we get both quality pairs AND actionable opportunities
    const selectedPairs = new Set(); // Track selected pair names for deduplication
    const watchlistPairs = [];

    // Helper to add pair if not already selected
    const addPair = (pair) => {
        const pairKey = `${pair.asset1}/${pair.asset2}`;
        if (!selectedPairs.has(pairKey)) {
            selectedPairs.add(pairKey);
            watchlistPairs.push(pair);
            return true;
        }
        return false;
    };

    // === SAME-SECTOR SELECTION ===
    // Sort by conviction for quality pairs
    const sameSectorByConviction = fittingPairs
        .filter(p => !p.isCrossSector)
        .sort((a, b) => b.conviction - a.conviction);

    // Sort by signal strength for actionable pairs
    const sameSectorBySignal = fittingPairs
        .filter(p => !p.isCrossSector)
        .sort((a, b) => b.signalStrength - a.signalStrength);

    const sectorConvictionCounts = {};
    const sectorSignalCounts = {};

    // Top 3 per sector by CONVICTION
    for (const pair of sameSectorByConviction) {
        sectorConvictionCounts[pair.sector] = sectorConvictionCounts[pair.sector] || 0;
        if (sectorConvictionCounts[pair.sector] < TOP_PER_SECTOR) {
            if (addPair(pair)) {
                sectorConvictionCounts[pair.sector]++;
            }
        }
    }

    // Top 3 per sector by SIGNAL STRENGTH (deduplicated)
    for (const pair of sameSectorBySignal) {
        sectorSignalCounts[pair.sector] = sectorSignalCounts[pair.sector] || 0;
        if (sectorSignalCounts[pair.sector] < TOP_PER_SECTOR) {
            if (addPair(pair)) {
                sectorSignalCounts[pair.sector]++;
            }
        }
    }

    // === CROSS-SECTOR SELECTION ===
    const crossSectorByConviction = fittingPairs
        .filter(p => p.isCrossSector)
        .sort((a, b) => b.conviction - a.conviction);

    const crossSectorBySignal = fittingPairs
        .filter(p => p.isCrossSector)
        .sort((a, b) => b.signalStrength - a.signalStrength);

    let crossConvictionCount = 0;
    let crossSignalCount = 0;

    // Top 5 cross-sector by CONVICTION
    for (const pair of crossSectorByConviction) {
        if (crossConvictionCount < TOP_CROSS_SECTOR) {
            if (addPair(pair)) {
                crossConvictionCount++;
            }
        }
    }

    // Top 5 cross-sector by SIGNAL STRENGTH (deduplicated)
    for (const pair of crossSectorBySignal) {
        if (crossSignalCount < TOP_CROSS_SECTOR) {
            if (addPair(pair)) {
                crossSignalCount++;
            }
        }
    }

    console.log(`[SCANNER] Selected ${watchlistPairs.length} pairs (conviction + signal hybrid)`);
    // Note: Entry thresholds already calculated from 30-day hourly data in analyzeLocalDivergences

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
            maxHalfLife: 10,
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
            dualBeta: p.dualBeta || null,
            // Cointegration test results (hourly data)
            isCointegrated: p.isCointegrated,
            adfStat: p.adfStat ? parseFloat(p.adfStat.toFixed(3)) : null,
            pValue: p.pValue || null,
            cointDataPoints: p.windows?.cointegration || null
        }))
    };

    fs.writeFileSync(path.join(CONFIG_DIR, 'discovered_pairs.json'), JSON.stringify(output, null, 2));

    // Build watchlist pairs
    const watchlistData = watchlistPairs.map(p => {
        // Use fixed MIN_ENTRY_THRESHOLD (2.5) for all pairs
        const entryThreshold = MIN_ENTRY_THRESHOLD;
        const signalStrength = Math.min(Math.abs(p.zScore) / entryThreshold, 1.0);
        const direction = p.zScore < 0 ? 'long' : 'short';
        const atThreshold = Math.abs(p.zScore) >= entryThreshold;
        const betaValue = parseFloat(p.beta.toFixed(3));

        // Safety check: don't mark READY if reversion rate at current Z is poor
        const safety = checkReversionSafety(p.zScore, p.divergenceProfilePercent);
        const isReady = atThreshold && safety.isSafe;

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
            // Volume data (for volume-informed signal analysis)
            volume1: p.volume1 ? parseFloat(p.volume1.toFixed(2)) : null,
            volume2: p.volume2 ? parseFloat(p.volume2.toFixed(2)) : null,
            // Volatility metrics (beta neutralization analysis)
            spreadVol: p.spreadVol,
            volRatio: p.volRatio,
            // Safety check fields
            reversionWarning: safety.warning,
            reversionRate: safety.reversionRate,
            lastScan: new Date().toISOString()
        };
    });

    // Save watchlist to local JSON (backup)
    const watchlist = {
        timestamp: new Date().toISOString(),
        description: `Hybrid selection: Top ${TOP_PER_SECTOR} by conviction + Top ${TOP_PER_SECTOR} by signal per sector${crossSector ? ` + Top ${TOP_CROSS_SECTOR}+${TOP_CROSS_SECTOR} cross-sector` : ''} (Hurst < ${MAX_HURST_THRESHOLD} filter)`,
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

        // Also remove pairs containing blacklisted assets (even if they were in new scan)
        const blacklistedPairs = currentWatchlist.filter(p =>
            (blacklist.has(p.asset1) || blacklist.has(p.asset2)) &&
            !activeTradePairs.has(p.pair)
        );

        // Warn about blacklisted pairs with active trades (can't auto-remove)
        const blacklistedWithTrades = currentWatchlist.filter(p =>
            (blacklist.has(p.asset1) || blacklist.has(p.asset2)) &&
            activeTradePairs.has(p.pair)
        );
        if (blacklistedWithTrades.length > 0) {
            console.log(`[SCANNER] ⚠️ Blacklisted pairs with active trades (manual exit required): ${blacklistedWithTrades.map(p => p.pair).join(', ')}`);
        }

        // Combine removal lists (dedupe)
        const allToRemove = [...new Set([...pairsToRemove, ...blacklistedPairs])];

        // Delete stale + blacklisted pairs
        for (const pair of allToRemove) {
            try {
                await db.deleteWatchlistPair(pair.pair);
                removedPairs++;
                if (blacklist.has(pair.asset1) || blacklist.has(pair.asset2)) {
                    console.log(`[SCANNER] Removed blacklisted pair: ${pair.pair}`);
                }
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

    // Count cross-sector pairs in final watchlist
    const crossSectorCount = watchlistPairs.filter(p => p.isCrossSector).length;

    return {
        totalAssets: universe.length,
        filteredAssets: filtered.length,
        candidatePairs: candidatePairs.length,
        fittingPairs: fittingPairs.length,
        watchlistPairs: watchlistPairs.length,
        crossSectorPairs: crossSectorCount,
        crossSectorEnabled: crossSector,
        removedPairs: removedPairs,
        unmappedSymbols: unmapped
    };
}

module.exports = { main };
