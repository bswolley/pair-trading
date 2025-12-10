/**
 * Monitor Service - Core monitoring logic extracted from monitorWatchlist.js
 * 
 * Checks watchlist for entries and active trades for exits.
 * Returns structured result for API/Telegram.
 * 
 * Uses database (Supabase) when configured, falls back to JSON files.
 */

const axios = require('axios');
const { Hyperliquid } = require('hyperliquid');
const { 
    checkPairFitness, 
    calculateCorrelation,
    testCointegration,
    calculateHurst,
    calculateDualBeta,
    calculateConvictionScore 
} = require('../../lib/pairAnalysis');
const { fetchCurrentFunding, calculateNetFunding } = require('../../lib/funding');
const db = require('../db/queries');

// Lazy import to avoid circular dependency (scheduler imports monitor)
let _triggerScanOnCapacity = null;
function getTriggerScanOnCapacity() {
    if (!_triggerScanOnCapacity) {
        _triggerScanOnCapacity = require('./scheduler').triggerScanOnCapacity;
    }
    return _triggerScanOnCapacity;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_CONCURRENT_TRADES = parseInt(process.env.MAX_CONCURRENT_TRADES) || 5;

// Thresholds
const DEFAULT_ENTRY_THRESHOLD = 2.0;
const FINAL_EXIT_ZSCORE = 0.5;         // Final exit when |Z| < 0.5 (full mean reversion)
const STOP_LOSS_MULTIPLIER = 1.2;      // Exit if Z exceeds maxHistoricalZ by 20%
const STOP_LOSS_ENTRY_MULTIPLIER = 1.5;  // Or if Z exceeds entry by 50%
const STOP_LOSS_FLOOR = 3.0;           // Minimum stop-loss threshold
const MIN_CORRELATION_30D = 0.6;
const CORRELATION_BREAKDOWN = 0.4;
const HALFLIFE_MULTIPLIER = 2;

// Exit strategy - aligned with percentage-based reversion analysis
// Partial exit: when |Z| < 50% of entry threshold OR PnL >= 3% (whichever first)
// Final exit: when |Z| < 0.5 (full mean reversion) or PnL >= 5%
const PARTIAL_EXIT_SIZE = 0.5;         // Exit 50% of position at partial reversion
const PARTIAL_EXIT_PNL = 3.0;          // OR exit 50% at +3% PnL (whichever comes first)
const FINAL_EXIT_PNL = 5.0;            // Exit remaining at +5% PnL (alternative to Z target)

/**
 * Calculate trade health score
 * Answers: "Is the trade going in the right direction?"
 * 
 * @returns {{ score: number, status: string, emoji: string, signals: string[] }}
 */
function calculateHealthScore(trade, currentFitness) {
    const signals = [];
    let score = 0;
    
    const entryZ = Math.abs(trade.entryZScore || 2.0);
    const currentZ = Math.abs(currentFitness.zScore || trade.currentZ || entryZ);
    const entryHL = trade.halfLife || 15;
    const currentHL = currentFitness.halfLife;
    const entryCorr = trade.correlation || 0.8;
    const currentCorr = currentFitness.correlation;
    const currentHurst = trade.currentHurst;
    const pnl = trade.currentPnL || 0;
    const betaDrift = trade.betaDrift || 0;
    
    // 1. Z-Score Direction (+2/-2)
    const zDelta = entryZ - currentZ;
    const zPctChange = entryZ > 0 ? (zDelta / entryZ * 100) : 0;
    if (currentZ < entryZ * 0.9) {
        score += 2;
        signals.push('Z reverting ' + zPctChange.toFixed(0) + '%');
    } else if (currentZ > entryZ * 1.2) {
        score -= 2;
        signals.push('Z diverging!');
    }
    
    // 2. PnL (+2/-2)
    if (pnl > 1) {
        score += 2;
        signals.push('PnL +' + pnl.toFixed(1) + '%');
    } else if (pnl > 0) {
        score += 1;
    } else if (pnl < -2) {
        score -= 2;
        signals.push('PnL ' + pnl.toFixed(1) + '%');
    }
    
    // 3. Correlation (+1/-2)
    if (currentCorr >= 0.6) {
        score += 1;
    } else if (currentCorr < 0.5) {
        score -= 2;
        signals.push('Corr ' + currentCorr.toFixed(2));
    }
    
    // 4. Half-life stability (+1/-2)
    // Note: HL change is already shown in main status line, so don't duplicate in signals
    if (currentHL !== null && currentHL !== undefined && isFinite(currentHL) && entryHL > 0) {
        const hlRatio = currentHL / entryHL;
        if (hlRatio <= 1.5) {
            score += 1;
        } else if (hlRatio > 3) {
            score -= 2;
            // Don't push to signals - HL is already in main status line
        } else {
            score -= 1;
        }
    }
    
    // 5. Hurst (+1/-2)
    if (currentHurst !== null && currentHurst !== undefined) {
        if (currentHurst < 0.45) {
            score += 1;
        } else if (currentHurst >= 0.5) {
            score -= 2;
            signals.push('H=' + currentHurst.toFixed(2) + ' trending');
        }
    }
    
    // 6. Beta drift (+1/-1)
    if (betaDrift < 0.10) {
        score += 1;
    } else if (betaDrift > 0.25) {
        score -= 1;
        signals.push('β drift ' + (betaDrift * 100).toFixed(0) + '%');
    }
    
    // Determine status
    let status, emoji;
    if (score >= 5) {
        status = 'STRONG';
        emoji = '🟢';
    } else if (score >= 2) {
        status = 'OK';
        emoji = '🟡';
    } else if (score >= 0) {
        status = 'WEAK';
        emoji = '🟠';
    } else {
        status = 'BROKEN';
        emoji = '🔴';
    }
    
    return { score, status, emoji, signals };
}

async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        return true;
    } catch (e) {
        console.error('[TELEGRAM]', e.response?.data?.description || e.message);
        return false;
    }
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

// Time windows - must match scanner for consistency
const WINDOWS = {
    cointegration: 90,  // Structural test - longer window for confidence
    hurst: 60,          // Needs 40+ data points for R/S analysis
    reactive: 30        // Z-score, correlation, beta - responsive to recent market
};

async function fetchPrices(sdk, sym1, sym2) {
    const endTime = Date.now();
    // Fetch enough data for cointegration window (90 days) + buffer
    const startTime = endTime - ((WINDOWS.cointegration + 5) * 24 * 60 * 60 * 1000);

    try {
        const [d1, d2] = await Promise.all([
            sdk.info.getCandleSnapshot(`${sym1}-PERP`, '1d', startTime, endTime),
            sdk.info.getCandleSnapshot(`${sym2}-PERP`, '1d', startTime, endTime)
        ]);

        if (!d1?.length || !d2?.length) return null;

        const m1 = new Map(), m2 = new Map();
        d1.forEach(c => m1.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));
        d2.forEach(c => m2.set(new Date(c.t).toISOString().split('T')[0], parseFloat(c.c)));

        const dates = [...m1.keys()].filter(d => m2.has(d)).sort();
        if (dates.length < 10) return null;

        return {
            prices1_90d: dates.slice(-90).map(d => m1.get(d)),
            prices2_90d: dates.slice(-90).map(d => m2.get(d)),
            prices1_60d: dates.slice(-60).map(d => m1.get(d)),
            prices2_60d: dates.slice(-60).map(d => m2.get(d)),
            prices1_30d: dates.slice(-30).map(d => m1.get(d)),
            prices2_30d: dates.slice(-30).map(d => m2.get(d)),
            prices1_7d: dates.slice(-7).map(d => m1.get(d)),
            prices2_7d: dates.slice(-7).map(d => m2.get(d)),
            currentPrice1: m1.get(dates[dates.length - 1]),
            currentPrice2: m2.get(dates[dates.length - 1])
        };
    } catch (e) {
        return null;
    }
}

function validateEntry(prices, entryThreshold = DEFAULT_ENTRY_THRESHOLD) {
    // REACTIVE METRICS (30-day) - for trading decisions
    const fit30d = checkPairFitness(prices.prices1_30d, prices.prices2_30d);

    // STRUCTURAL TEST (90-day) - internally consistent with 90d beta
    let isCointegrated90d = false;
    let adfStat90d = -2.5; // Default fallback
    if (prices.prices1_90d && prices.prices1_90d.length >= 60) {
        const { beta: beta90d } = calculateCorrelation(prices.prices1_90d, prices.prices2_90d);
        const coint90d = testCointegration(prices.prices1_90d, prices.prices2_90d, beta90d);
        isCointegrated90d = coint90d.isCointegrated;
        adfStat90d = coint90d.adfStat || -2.5;
    } else {
        // Fallback to 30d if not enough data (fit30d doesn't have adfStat, use default)
        isCointegrated90d = fit30d.isCointegrated;
        // Keep default -2.5 since checkPairFitness doesn't return adfStat
    }

    // Calculate 7d Z-score using 30d mean/std as baseline (same as analyzePair)
    // This ensures 7d check validates "is divergence still active?" not "is 7d internally diverged?"
    let zScore7d = null;
    let fit7d = null;
    try {
        if (prices.prices1_7d.length >= 7 && prices.prices2_7d.length >= 7) {
            fit7d = checkPairFitness(prices.prices1_7d, prices.prices2_7d);
            
            // Calculate 7d Z-score using 30d baseline (consistent with analyzePair)
            // Use the 30d spreads for mean/std, but current (7d endpoint) price for current spread
            const beta30d = fit30d.beta;
            const spreads30d = prices.prices1_30d.map((p1, i) => 
                Math.log(p1) - beta30d * Math.log(prices.prices2_30d[i])
            );
            const mean30d = spreads30d.reduce((a, b) => a + b, 0) / spreads30d.length;
            const std30d = Math.sqrt(
                spreads30d.reduce((sum, s) => sum + Math.pow(s - mean30d, 2), 0) / spreads30d.length
            );
            
            // Current spread from most recent price (end of 7d window)
            const currentPrice1 = prices.prices1_7d[prices.prices1_7d.length - 1];
            const currentPrice2 = prices.prices2_7d[prices.prices2_7d.length - 1];
            const currentSpread = Math.log(currentPrice1) - beta30d * Math.log(currentPrice2);
            
            zScore7d = std30d > 0 ? (currentSpread - mean30d) / std30d : null;
        }
    } catch (e) { }

    const signal30d = Math.abs(fit30d.zScore) >= entryThreshold;
    // Use 30d-baseline Z-score for 7d validation (consistent with analyzePair)
    const signal7d = zScore7d !== null && Math.abs(zScore7d) >= entryThreshold * 0.8;
    const sameDirection = zScore7d !== null && (fit30d.zScore * zScore7d > 0);

    const valid = signal30d &&
        fit30d.correlation >= MIN_CORRELATION_30D &&
        isCointegrated90d &&  // Use 90-day cointegration test
        fit30d.halfLife <= 30 &&
        (!fit7d || (signal7d && sameDirection));

    // Determine rejection reason (for debugging)
    let reason = 'ok';
    if (!signal30d) {
        reason = 'no_signal';
    } else if (fit30d.correlation < MIN_CORRELATION_30D) {
        reason = 'low_corr';
    } else if (!isCointegrated90d) {
        reason = 'not_coint_90d';
    } else if (fit30d.halfLife > 30) {
        reason = 'slow_reversion';
    } else if (fit7d && !signal7d) {
        reason = '7d_weak_signal';
    } else if (fit7d && !sameDirection) {
        reason = '7d_conflict';
    }

    return {
        valid,
        fit30d,
        fit7d,
        zScore7d,  // 7d Z-score calculated using 30d baseline
        isCointegrated90d,
        adfStat90d,
        signal7d,
        sameDirection,
        reason
    };
}

function calcPnL(trade, prices) {
    const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
    const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;
    const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
    const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
    return longPnL + shortPnL;
}

/**
 * Check exit conditions - aligned with percentage-based reversion
 * Partial exit (50%): when |Z| < 50% of entry threshold
 * Final exit (remaining): when |Z| < 0.5 or +5% PnL
 */
function checkExitConditions(trade, fitness, currentPnL) {
    const currentZ = Math.abs(fitness.zScore);
    const daysInTrade = (Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24);
    const maxDuration = (trade.halfLife || 15) * HALFLIFE_MULTIPLIER;
    const partialTaken = trade.partialExitTaken || false;

    // Dynamic partial exit threshold = 50% of entry threshold
    const entryThreshold = trade.entryThreshold || DEFAULT_ENTRY_THRESHOLD;
    const partialExitZ = entryThreshold * 0.5;

    // 1. PARTIAL EXIT - Exit 50% when Z reverts to 50% of entry threshold OR PnL >= 3%
    if (!partialTaken && currentZ <= partialExitZ) {
        return {
            shouldExit: true, isPartial: true, exitSize: PARTIAL_EXIT_SIZE,
            reason: 'PARTIAL_REVERSION', emoji: '💰',
            message: `50% reversion (Z=${fitness.zScore.toFixed(2)} < ${partialExitZ.toFixed(1)}, closing 50%)`
        };
    }
    
    if (!partialTaken && currentPnL >= PARTIAL_EXIT_PNL) {
        return {
            shouldExit: true, isPartial: true, exitSize: PARTIAL_EXIT_SIZE,
            reason: 'PARTIAL_TP', emoji: '💰',
            message: `Partial TP: +${currentPnL.toFixed(1)}% (closing 50%)`
        };
    }

    // 2. FINAL EXIT - After partial taken, exit remaining at full reversion or +5% PnL
    if (partialTaken) {
        if (currentPnL >= FINAL_EXIT_PNL) {
            return {
                shouldExit: true, isPartial: false, exitSize: 1.0,
                reason: 'FINAL_TP', emoji: '🎯',
                message: `Final TP: +${currentPnL.toFixed(1)}%`
            };
        }
        if (currentZ <= FINAL_EXIT_ZSCORE) {
            return {
                shouldExit: true, isPartial: false, exitSize: 1.0,
                reason: 'TARGET', emoji: '🎯',
                message: `Full mean reversion (Z=${fitness.zScore.toFixed(2)} < 0.5)`
            };
        }
    }

    // 3. FULL EXIT if no partial taken yet and Z reaches full mean reversion
    if (!partialTaken && currentZ <= FINAL_EXIT_ZSCORE) {
        return {
            shouldExit: true, isPartial: false, exitSize: 1.0,
            reason: 'TARGET', emoji: '🎯',
            message: `Full mean reversion (Z=${fitness.zScore.toFixed(2)} < 0.5)`
        };
    }

    // Dynamic stop-loss based on historical max and entry Z
    const entryZ = Math.abs(trade.entryZScore || 2.0);
    const maxHistZ = trade.maxHistoricalZ || 3.0;
    const dynamicStopLoss = Math.max(
        entryZ * STOP_LOSS_ENTRY_MULTIPLIER,    // 50% beyond entry
        maxHistZ * STOP_LOSS_MULTIPLIER,        // 20% beyond historical max
        STOP_LOSS_FLOOR                          // Minimum floor of 3.0
    );

    if (currentZ >= dynamicStopLoss) {
        return {
            shouldExit: true, isPartial: false, exitSize: 1.0,
            reason: 'STOP_LOSS', emoji: '🛑',
            message: `Stop loss (Z=${fitness.zScore.toFixed(2)} > ${dynamicStopLoss.toFixed(1)})`
        };
    }

    if (daysInTrade > maxDuration) {
        return {
            shouldExit: true, isPartial: false, exitSize: 1.0,
            reason: 'TIME_STOP', emoji: '⏰',
            message: `Time stop (${daysInTrade.toFixed(1)}d > ${maxDuration.toFixed(0)}d)`
        };
    }

    if (fitness.correlation < CORRELATION_BREAKDOWN) {
        return {
            shouldExit: true, isPartial: false, exitSize: 1.0,
            reason: 'BREAKDOWN', emoji: '💔',
            message: `Correlation breakdown (${fitness.correlation.toFixed(2)})`
        };
    }

    return { shouldExit: false, isPartial: false, exitSize: 0, reason: null, emoji: null, message: null };
}

async function enterTrade(pair, fitness, prices, activeTrades, hurst = null, entryThreshold = DEFAULT_ENTRY_THRESHOLD) {
    const absBeta = Math.abs(fitness.beta);
    const w1 = 1 / (1 + absBeta), w2 = absBeta / (1 + absBeta);
    const dir = fitness.zScore < 0 ? 'long' : 'short';

    const trade = {
        pair: pair.pair,
        asset1: pair.asset1,
        asset2: pair.asset2,
        sector: pair.sector,
        entryTime: new Date().toISOString(),
        entryZScore: fitness.zScore,
        entryPrice1: prices.currentPrice1,
        entryPrice2: prices.currentPrice2,
        entryThreshold: entryThreshold,  // Now saved to DB
        correlation: fitness.correlation,
        beta: fitness.beta,
        halfLife: fitness.halfLife,
        hurst: hurst,  // Hurst at entry
        direction: dir,
        longAsset: dir === 'long' ? pair.asset1 : pair.asset2,
        shortAsset: dir === 'long' ? pair.asset2 : pair.asset1,
        longWeight: (dir === 'long' ? w1 : w2) * 100,
        shortWeight: (dir === 'long' ? w2 : w1) * 100,
        longEntryPrice: dir === 'long' ? prices.currentPrice1 : prices.currentPrice2,
        shortEntryPrice: dir === 'long' ? prices.currentPrice2 : prices.currentPrice1,
        maxHistoricalZ: pair.maxHistoricalZ || 3.0,  // For dynamic stop-loss
        source: 'bot'
    };

    // Save to database
    await db.createTrade(trade);
    activeTrades.trades.push(trade);
    return trade;
}

async function exitTrade(trade, fitness, prices, activeTrades, history, exitReason = 'MANUAL') {
    const idx = activeTrades.trades.findIndex(t => t.pair === trade.pair);
    if (idx === -1) return null;

    const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
    const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;

    const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
    const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
    const fullPositionPnL = longPnL + shortPnL;
    
    // If partial exit was taken, total P&L = 50% from partial + 50% from remaining
    // Otherwise, total P&L = full position P&L
    let totalPnL;
    if (trade.partialExitTaken && trade.partialExitPnL !== undefined) {
        totalPnL = (trade.partialExitPnL * 0.5) + (fullPositionPnL * 0.5);
    } else {
        totalPnL = fullPositionPnL;
    }
    
    const days = ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);

    const record = {
        ...trade,
        exitTime: new Date().toISOString(),
        exitZScore: fitness.zScore,
        exitHurst: trade.currentHurst,  // Hurst at exit
        exitReason,
        totalPnL,
        daysInTrade: parseFloat(days)
    };

    // Save to database: delete from trades, add to history
    await db.deleteTrade(trade.pair);
    await db.addToHistory(record);

    activeTrades.trades.splice(idx, 1);
    return { ...record, totalPnL };
}

function recordPartialExit(trade, fitness, prices, exitSize, history) {
    const curLong = trade.direction === 'long' ? prices.currentPrice1 : prices.currentPrice2;
    const curShort = trade.direction === 'long' ? prices.currentPrice2 : prices.currentPrice1;

    const longPnL = ((curLong - trade.longEntryPrice) / trade.longEntryPrice) * (trade.longWeight / 100) * 100;
    const shortPnL = ((trade.shortEntryPrice - curShort) / trade.shortEntryPrice) * (trade.shortWeight / 100) * 100;
    const totalPnL = longPnL + shortPnL;
    const partialPnL = totalPnL * exitSize;
    const days = ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);

    const record = {
        pair: trade.pair,
        asset1: trade.asset1,
        asset2: trade.asset2,
        direction: trade.direction,
        entryTime: trade.entryTime,
        exitTime: new Date().toISOString(),
        exitType: 'PARTIAL',
        exitSize: `${(exitSize * 100).toFixed(0)}%`,
        exitZScore: fitness.zScore,
        partialPnL,
        totalPnLAtExit: totalPnL,
        daysInTrade: parseFloat(days)
    };

    if (!history.partialExits) history.partialExits = [];
    history.partialExits.push(record);

    return { ...record, isPartial: true };
}

function formatStatusReport(activeTrades, entries, exits, history, approaching = [], fundingMap = new Map()) {
    const time = new Date().toLocaleString('en-US', {
        timeZone: 'UTC', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    let msg = `━━━━━━━━━━━━━━━━━━━━\n📊 STATUS • ${time} UTC\n━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (entries.length > 0 || exits.length > 0) {
        msg += `⚡ ACTIONS\n`;
        entries.forEach(e => msg += `✅ ${e.pair} → ${e.direction === 'long' ? 'Long' : 'Short'} ${e.asset1}\n`);
        exits.forEach(e => {
            let exitLine = `${e.exitEmoji || '🔴'} ${e.pair} [${e.exitReason}] ${e.totalPnL >= 0 ? '+' : ''}${e.totalPnL.toFixed(2)}%`;
            // Add beta drift note if significant
            if (e.maxBetaDrift !== undefined && e.maxBetaDrift > 0.15) {
                exitLine += ` (β drift: ${(e.maxBetaDrift * 100).toFixed(0)}%)`;
            }
            msg += exitLine + '\n';
        });
        msg += `\n`;
    }

    if (activeTrades.length === 0) {
        msg += `📈 No active trades\n`;
    } else {
        let portfolioPnL = 0;
        msg += `📈 POSITIONS (${activeTrades.length})\n\n`;

        for (const t of activeTrades) {
            const pnl = t.currentPnL || 0;
            portfolioPnL += pnl;
            const pnlSign = pnl >= 0 ? '+' : '';
            const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
            const days = ((Date.now() - new Date(t.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1);
            const zEntry = t.entryZScore?.toFixed(2) || '?';
            const zNow = (t.currentZ ?? t.entryZScore)?.toFixed(2) || zEntry;
            
            // Use ∞ symbol for infinity/null half-life
            const hlEntry = (t.halfLife === null || t.halfLife === undefined || !isFinite(t.halfLife)) 
                ? '∞' 
                : t.halfLife.toFixed(1);
            const hlNow = (t.currentHalfLife === null || t.currentHalfLife === undefined || !isFinite(t.currentHalfLife)) 
                ? '∞' 
                : t.currentHalfLife.toFixed(1);

            const netFunding = calculateNetFunding(t.longAsset, t.shortAsset, fundingMap);
            let fundingStr = '';
            if (netFunding.netFunding8h !== null) {
                const fundSign = netFunding.netFunding8h >= 0 ? '+' : '';
                fundingStr = `Fund: ${fundSign}${(netFunding.netFunding8h * 100).toFixed(4)}% / 8h`;
            }

            // Beta drift warning
            let betaDriftStr = '';
            if (t.betaDrift !== undefined && t.betaDrift !== null) {
                const driftPct = (t.betaDrift * 100).toFixed(0);
                if (t.betaDrift > 0.30) {
                    betaDriftStr = `⚠️ BETA DRIFT: ${driftPct}% (critical)`;
                } else if (t.betaDrift > 0.15) {
                    betaDriftStr = `⚡ β drift: ${driftPct}%`;
                }
            }

            const partialTag = t.partialExitTaken ? ' [50% closed]' : '';
            
            // ETA calculation: halfLife * log(|z_current| / |z_target|) / log(2)
            const zTarget = FINAL_EXIT_ZSCORE; // 0.5
            const currentHLValue = t.currentHalfLife || t.halfLife || 15;
            const entryHLValue = t.halfLife || 15;
            const absZ = Math.abs(t.currentZ ?? t.entryZScore ?? 0);
            let etaValue = null;
            if (absZ > zTarget && currentHLValue > 0 && isFinite(currentHLValue)) {
                const halfLivesToExit = Math.log(absZ / zTarget) / Math.log(2);
                etaValue = currentHLValue * halfLivesToExit;
            } else if (absZ <= zTarget) {
                etaValue = 0;
            }
            
            // Time stop calculation: (entryHalfLife × 2) - daysInTrade
            const timeStopMax = entryHLValue * HALFLIFE_MULTIPLIER;
            const timeStopRemaining = timeStopMax - parseFloat(days);
            const showTimeStop = timeStopRemaining < (etaValue ?? Infinity) || timeStopRemaining < 3;
            const timeStopUrgent = timeStopRemaining < 1;
            
            // Hurst warning if drifting toward trending
            let hurstStr = '';
            if (t.currentHurst !== undefined && t.currentHurst !== null) {
                const hEntry = t.hurst?.toFixed(2) || '?';
                const hNow = t.currentHurst.toFixed(2);
                if (t.currentHurst >= 0.5) {
                    hurstStr = `📈 H: ${hEntry}→${hNow} (trending!)`;
                } else if (t.currentHurst >= 0.45) {
                    hurstStr = `⚡ H: ${hEntry}→${hNow}`;
                }
            }
            
            // Health score indicator
            const healthEmoji = t.healthStatus === 'STRONG' ? '🟢' :
                               t.healthStatus === 'OK' ? '🟡' :
                               t.healthStatus === 'WEAK' ? '🟠' : '🔴';
            const healthTag = t.healthScore !== undefined ? ` ${healthEmoji}${t.healthScore}` : '';
            
            msg += `${pnlEmoji} ${t.pair} (${t.sector})${partialTag}${healthTag}\n`;
            msg += `   L ${t.longAsset} ${t.longWeight?.toFixed(0)}% / S ${t.shortAsset} ${t.shortWeight?.toFixed(0)}%\n`;
            // Add "d" suffix only if not infinity
            const hlEntryStr = hlEntry === '∞' ? '∞' : `${hlEntry}d`;
            const hlNowStr = hlNow === '∞' ? '∞' : `${hlNow}d`;
            msg += `   Z: ${zEntry}→${zNow} | HL: ${hlEntryStr}→${hlNowStr}\n`;
            if (showTimeStop) {
                const urgentEmoji = timeStopUrgent ? '⚠️ ' : '';
                msg += `   ⏰ ${urgentEmoji}Time limit: ${timeStopRemaining.toFixed(1)}d\n`;
            }
            if (hurstStr) msg += `   ${hurstStr}\n`;
            if (fundingStr) msg += `   ${fundingStr}\n`;
            if (betaDriftStr) msg += `   ${betaDriftStr}\n`;
            // Health signals (only show if concerning)
            if (t.healthSignals && t.healthSignals.length > 0 && t.healthScore < 5) {
                msg += `   ${t.healthSignals.join(' | ')}\n`;
            }
            msg += `   ${pnlSign}${pnl.toFixed(2)}% | ${days}d\n\n`;
        }

        msg += `${portfolioPnL >= 0 ? '💰' : '📉'} Total: ${portfolioPnL >= 0 ? '+' : ''}${portfolioPnL.toFixed(2)}%\n`;
    }

    if (approaching.length > 0) {
        msg += `\n🎯 APPROACHING ENTRY\n\n`;
        for (const p of approaching.slice(0, 5)) {
            const pct = (p.proximity * 100).toFixed(0);
            const atThreshold = p.proximity >= 1;
            
            // Determine status emoji and block reason
            let status, blockNote;
            if (p.hurstBlocked) {
                status = '📈';
                blockNote = `H=${p.hurst?.toFixed(2)}`;
            } else if (p.hasOverlap) {
                status = '🚫';
                blockNote = `${p.overlappingAsset} in use`;
            } else if (p.reversionWarning) {
                // Safety check: poor reversion rate at current Z level
                status = '⚠️';
                blockNote = `LOW_REVERSION (${p.reversionRate != null ? p.reversionRate.toFixed(0) + '%' : '?'})`;
            } else if (atThreshold && p.blockReason && p.blockReason !== 'below_threshold') {
                status = '⚠️';
                blockNote = p.blockReason.replace(/_/g, ' ');
            } else if (atThreshold) {
                status = '🟡';
                blockNote = 'READY';
            } else {
                status = '⏳';
                blockNote = null;
            }
            
            msg += `${status} ${p.pair} (${p.sector})`;
            if (blockNote) msg += ` [${blockNote}]`;
            msg += `\n`;
            msg += `   Z: ${p.zScore.toFixed(2)} → entry@${p.entryThreshold} [${pct}%]\n\n`;
        }
    }

    if (history.stats.totalTrades > 0) {
        const cumSign = history.stats.totalPnL >= 0 ? '+' : '';
        msg += `\n📜 ${history.stats.wins}W/${history.stats.losses}L • ${cumSign}${history.stats.totalPnL.toFixed(2)}%\n`;
    }

    return msg;
}

/**
 * Main monitor function - returns structured result
 */
async function main() {
    // Load from database (Supabase or JSON fallback)
    const watchlistPairs = await db.getWatchlist();
    if (!watchlistPairs || watchlistPairs.length === 0) {
        return { error: 'No watchlist found' };
    }
    
    // Load blacklist and filter out blacklisted pairs from watchlist
    const blacklistData = await db.getBlacklist();
    const blacklist = new Set(blacklistData?.assets || []);
    const filteredPairs = watchlistPairs.filter(p => 
        !blacklist.has(p.asset1) && !blacklist.has(p.asset2)
    );
    
    if (filteredPairs.length < watchlistPairs.length) {
        const removed = watchlistPairs.length - filteredPairs.length;
        console.log(`[MONITOR] Filtered out ${removed} pairs containing blacklisted assets`);
    }
    
    let watchlist = { pairs: filteredPairs };

    const tradesArray = await db.getTrades();
    let activeTrades = { trades: tradesArray || [] };

    // Check if we should run scanner: capacity available AND no ENTERABLE ready pairs
    const hasCapacity = activeTrades.trades.length < MAX_CONCURRENT_TRADES;
    
    // Get assets currently in positions (for overlap check)
    const assetsInUse = new Set();
    for (const trade of activeTrades.trades) {
        assetsInUse.add(trade.asset1);
        assetsInUse.add(trade.asset2);
    }
    
    // A pair is enterable if: isReady AND not already traded AND no asset overlap
    const hasEnterablePairs = watchlist.pairs.some(p => 
        p.isReady && 
        !activeTrades.trades.some(t => t.pair === p.pair) &&
        !assetsInUse.has(p.asset1) && 
        !assetsInUse.has(p.asset2)
    );
    
    if (hasCapacity && !hasEnterablePairs) {
        console.log(`[MONITOR] Capacity available (${activeTrades.trades.length}/${MAX_CONCURRENT_TRADES}) but no enterable pairs - triggering scan`);
        
        try {
            const triggerScanOnCapacity = getTriggerScanOnCapacity();
            const scanResult = await triggerScanOnCapacity(activeTrades.trades.length, MAX_CONCURRENT_TRADES);
            
            if (scanResult.triggered) {
                console.log(`[MONITOR] Pre-scan completed - found ${scanResult.result?.watchlistPairs || 0} pairs`);
                
                // Scanner already updated watchlist with fresh data - skip this monitor cycle's
                // watchlist processing to avoid API rate limits. Only check active trades for exits.
                console.log(`[MONITOR] Skipping watchlist check (fresh from scan) - only checking active trades`);
                
                // Reload watchlist but mark that we should skip entry checks
                const freshWatchlistPairs = await db.getWatchlist();
                if (freshWatchlistPairs && freshWatchlistPairs.length > 0) {
                    const freshFiltered = freshWatchlistPairs.filter(p => 
                        !blacklist.has(p.asset1) && !blacklist.has(p.asset2)
                    );
                    watchlist = { pairs: freshFiltered };
                }
                
                // Set flag to skip watchlist entry processing this cycle
                watchlist.skipEntryCheck = true;
            } else {
                console.log(`[MONITOR] Scan not triggered: ${scanResult.reason}${scanResult.detail ? ` (${scanResult.detail})` : ''}`);
            }
        } catch (err) {
            console.error(`[MONITOR] Pre-scan error: ${err.message}`);
        }
    }

    const stats = await db.getStats();
    let history = {
        trades: [],
        stats: stats || { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 }
    };

    const sdk = new Hyperliquid();
    const saved = suppressConsole();
    await sdk.connect();
    restoreConsole(saved);

    const fundingMap = await fetchCurrentFunding();

    const entries = [];
    const exits = [];
    const approaching = [];
    const activePairs = new Set(activeTrades.trades.map(t => t.pair));
    const assetsInPositions = new Set();

    for (const trade of activeTrades.trades) {
        assetsInPositions.add(trade.asset1);
        assetsInPositions.add(trade.asset2);
    }

    // Check active trades for exits
    let fullExitCount = 0;  // Track full (not partial) exits
    
    for (const trade of [...activeTrades.trades]) {
        const prices = await fetchPrices(sdk, trade.asset1, trade.asset2);
        if (!prices) continue;

        const fit = checkPairFitness(prices.prices1_30d, prices.prices2_30d);
        trade.currentZ = fit.zScore;
        trade.currentPnL = calcPnL(trade, prices);
        trade.currentCorrelation = fit.correlation;
        trade.currentBeta = fit.beta;
        
        // Current half-life uses current market conditions (fit.halfLife from checkPairFitness)
        // This shows real-time mean-reversion speed - may differ from entry
        // Entry half-life (trade.halfLife) is preserved from trade creation
        trade.currentHalfLife = fit.halfLife === Infinity ? null : fit.halfLife;

        // Calculate current Hurst (60d) - on SPREAD, not individual asset
        if (prices.prices1_60d && prices.prices2_60d &&
            prices.prices1_60d.length >= 40 && prices.prices2_60d.length >= 40) {
            // Use current beta from fit (30d)
            const currentBeta = fit.beta;
            const hurstLen = Math.min(prices.prices1_60d.length, prices.prices2_60d.length);
            const spreads60d = [];
            for (let i = 0; i < hurstLen; i++) {
                spreads60d.push(Math.log(prices.prices1_60d[i]) - currentBeta * Math.log(prices.prices2_60d[i]));
            }
            const hurstResult = calculateHurst(spreads60d);
            if (hurstResult.isValid) {
                trade.currentHurst = hurstResult.hurst;
            }
        }

        // Calculate beta drift (% change from entry)
        if (trade.beta && trade.beta !== 0) {
            trade.betaDrift = Math.abs(fit.beta - trade.beta) / Math.abs(trade.beta);
            // Track max beta drift seen during trade
            trade.maxBetaDrift = Math.max(trade.maxBetaDrift || 0, trade.betaDrift);
        }

        // Calculate health score
        const healthResult = calculateHealthScore(trade, fit);
        trade.healthScore = healthResult.score;
        trade.healthStatus = healthResult.status;
        trade.healthSignals = healthResult.signals;

        const exitCheck = checkExitConditions(trade, fit, trade.currentPnL);

        if (exitCheck.shouldExit) {
            if (exitCheck.isPartial) {
                const result = recordPartialExit(trade, fit, prices, exitCheck.exitSize, history);
                if (result) {
                    result.exitReason = exitCheck.reason;
                    result.exitEmoji = exitCheck.emoji;
                    exits.push(result);
                    trade.partialExitTaken = true;
                    trade.partialExitPnL = trade.currentPnL;
                    trade.partialExitTime = new Date().toISOString();
                }
            } else {
                const result = await exitTrade(trade, fit, prices, activeTrades, history, exitCheck.reason);
                if (result) {
                    result.exitEmoji = exitCheck.emoji;
                    exits.push(result);
                    fullExitCount++;  // Track full exits
                }
            }
        }

        await new Promise(r => setTimeout(r, 200));
    }

    // If we closed any trades and have capacity, trigger fresh scan to find new opportunities
    if (fullExitCount > 0 && activeTrades.trades.length < MAX_CONCURRENT_TRADES) {
        console.log(`[MONITOR] ${fullExitCount} trades closed, ${MAX_CONCURRENT_TRADES - activeTrades.trades.length} slots available - checking if scan needed`);
        
        try {
            const triggerScanOnCapacity = getTriggerScanOnCapacity();
            const scanResult = await triggerScanOnCapacity(activeTrades.trades.length, MAX_CONCURRENT_TRADES);
            
            if (scanResult.triggered) {
                console.log(`[MONITOR] Fresh scan completed - found ${scanResult.result?.watchlistPairs || 0} pairs`);
                
                // Reload watchlist with fresh pairs
                const freshWatchlistPairs = await db.getWatchlist();
                if (freshWatchlistPairs && freshWatchlistPairs.length > 0) {
                    watchlist.pairs = freshWatchlistPairs;
                    console.log(`[MONITOR] Reloaded watchlist with ${freshWatchlistPairs.length} pairs`);
                }
            } else {
                console.log(`[MONITOR] Scan not triggered: ${scanResult.reason}${scanResult.detail ? ` (${scanResult.detail})` : ''}`);
            }
        } catch (err) {
            console.error(`[MONITOR] Error triggering scan: ${err.message}`);
        }
    }

    // Check watchlist for entries (skip if we just ran a scan - data is fresh)
    const watchlistUpdates = [];

    if (watchlist.skipEntryCheck) {
        console.log(`[MONITOR] Skipping watchlist entry checks (fresh scan data)`);
    }

    for (const pair of watchlist.pairs) {
        // Skip API calls for watchlist if we just scanned
        if (watchlist.skipEntryCheck) continue;
        
        const isActiveTrade = activePairs.has(pair.pair);
        const hasOverlap = assetsInPositions.has(pair.asset1) || assetsInPositions.has(pair.asset2);
        const overlappingAsset = assetsInPositions.has(pair.asset1) ? pair.asset1 :
            assetsInPositions.has(pair.asset2) ? pair.asset2 : null;

        const prices = await fetchPrices(sdk, pair.asset1, pair.asset2);
        if (!prices) continue;

        // Use scanner-set threshold only - scanner has hourly data for meaningful calculation
        const entryThreshold = pair.entryThreshold || DEFAULT_ENTRY_THRESHOLD;

        let validation;
        try {
            validation = validateEntry(prices, entryThreshold);
        } catch (e) {
            continue;
        }

        const z = validation.fit30d.zScore;
        const fit = validation.fit30d;
        const signal = Math.abs(z) >= entryThreshold;
        const signalStrength = Math.min(Math.abs(z) / entryThreshold, 1.0);
        const direction = z < 0 ? 'long' : 'short';
        const isReady = signal;

        // Calculate Hurst exponent (requires 60d data) - on SPREAD, not individual asset
        let hurst = null;
        let hurstClassification = null;
        if (prices.prices1_60d && prices.prices2_60d &&
            prices.prices1_60d.length >= 40 && prices.prices2_60d.length >= 40) {
            // Use current beta from fit (30d)
            const hurstLen = Math.min(prices.prices1_60d.length, prices.prices2_60d.length);
            const spreads60d = [];
            for (let i = 0; i < hurstLen; i++) {
                spreads60d.push(Math.log(prices.prices1_60d[i]) - fit.beta * Math.log(prices.prices2_60d[i]));
            }
            const hurstResult = calculateHurst(spreads60d);
            if (hurstResult.isValid) {
                hurst = hurstResult.hurst;
                hurstClassification = hurstResult.classification;
            }
        }

        // Calculate quality score (same formula as scanner)
        const halfLifeFactor = 1 / Math.max(fit.halfLife, 0.5);
        const qualityScore = fit.correlation * halfLifeFactor * (fit.meanReversionRate || 0.5) * 100;

        // Calculate beta drift for watchlist pair
        // Only use initialBeta if already set (by scanner), otherwise DON'T set it
        // This preserves the "beta at discovery" meaning
        const hasInitialBeta = pair.initialBeta !== null && pair.initialBeta !== undefined;
        const initialBeta = hasInitialBeta ? pair.initialBeta : null;
        let betaDrift = null;

        if (initialBeta && initialBeta !== 0) {
            betaDrift = Math.abs(fit.beta - initialBeta) / Math.abs(initialBeta);
        }

        // Calculate dual beta for accurate R² (matches scanner approach)
        // Uses 90d prices with reactive half-life for consistency
        let dualBeta = null;
        let actualR2 = 0.7; // Fallback default
        let dualBetaDrift = betaDrift || 0;
        
        if (prices.prices1_90d && prices.prices2_90d && 
            prices.prices1_90d.length >= 60 && prices.prices2_90d.length >= 60) {
            try {
                dualBeta = calculateDualBeta(prices.prices1_90d, prices.prices2_90d, fit.halfLife);
                actualR2 = dualBeta.structural.r2;
                // Use dualBeta drift if available (more accurate), otherwise fall back to manual calculation
                if (dualBeta.drift !== undefined && dualBeta.drift !== null) {
                    dualBetaDrift = dualBeta.drift;
                }
            } catch (e) {
                // Fallback to default R² if calculation fails
                console.error(`[MONITOR] Dual beta calculation failed for ${pair.pair}:`, e.message);
            }
        }

        // Calculate conviction score using 90d cointegration result for consistency with scanner
        let conviction = null;
        if (hurst !== null) {
            const convictionResult = calculateConvictionScore({
                correlation: fit.correlation,
                r2: actualR2, // Use actual R² from dual beta (matches scanner)
                halfLife: fit.halfLife,
                hurst: hurst,
                isCointegrated: validation.isCointegrated90d,  // Use 90d structural test
                adfStat: validation.adfStat90d,  // Use 90d ADF stat (matches scanner)
                betaDrift: dualBetaDrift
            });
            conviction = convictionResult.score;
        }

        // Always update watchlist with fresh metrics (including active trades)
        // Preserve scanner-set fields that monitor doesn't recalculate
        const watchlistUpdate = {
            pair: pair.pair,
            asset1: pair.asset1,
            asset2: pair.asset2,
            sector: pair.sector,
            qualityScore: parseFloat(qualityScore.toFixed(2)),
            conviction: conviction,
            hurst: hurst,
            hurstClassification: hurstClassification,
            correlation: parseFloat(fit.correlation.toFixed(4)),
            beta: parseFloat(fit.beta.toFixed(4)),
            halfLife: isFinite(fit.halfLife) ? parseFloat(fit.halfLife.toFixed(2)) : null,
            meanReversionRate: parseFloat((fit.meanReversionRate || 0.5).toFixed(4)),
            zScore: parseFloat(z.toFixed(4)),
            signalStrength: parseFloat(signalStrength.toFixed(4)),
            direction,
            isReady,
            entryThreshold,
            // Preserve scanner-calculated fields
            exitThreshold: pair.exitThreshold,
            maxHistoricalZ: pair.maxHistoricalZ,
            fundingSpread: pair.fundingSpread,
            addedManually: pair.addedManually,
            lastScan: new Date().toISOString()
        };

        // Only include beta drift fields if initialBeta was already set by scanner
        if (hasInitialBeta) {
            watchlistUpdate.initialBeta = parseFloat(initialBeta.toFixed(4));
            watchlistUpdate.betaDrift = betaDrift !== null ? parseFloat(betaDrift.toFixed(4)) : null;
        }

        watchlistUpdates.push(watchlistUpdate);

        // Skip entry/approaching logic for pairs already in active trades
        if (isActiveTrade) continue;

        // Hurst validation: only enter mean-reverting pairs (H < 0.5)
        const hurstValid = hurst === null || hurst < 0.5;
        
        // Check max trades dynamically (not just once before loop)
        const currentlyAtMax = activeTrades.trades.length >= MAX_CONCURRENT_TRADES;
        
        // Safety check: don't enter if reversion rate at current Z is too low
        const reversionSafe = !pair.reversionWarning;
        
        if (signal && validation.valid && hurstValid && reversionSafe && !hasOverlap && !currentlyAtMax) {
            const trade = await enterTrade(pair, fit, prices, activeTrades, hurst, entryThreshold);
            entries.push(trade);
            activePairs.add(pair.pair);
            assetsInPositions.add(pair.asset1);
            assetsInPositions.add(pair.asset2);
        } else if (Math.abs(z) >= entryThreshold * 0.5) {
            const absBeta = Math.abs(fit.beta);
            const w1 = (1 / (1 + absBeta)) * 100;
            const w2 = (absBeta / (1 + absBeta)) * 100;
            
            // Determine why entry was blocked (for debugging)
            let blockReason = null;
            if (!signal) {
                blockReason = 'below_threshold';
            } else if (!validation.valid) {
                blockReason = validation.reason;
            } else if (!hurstValid) {
                blockReason = 'hurst_trending';
            } else if (!reversionSafe) {
                blockReason = 'low_reversion';
            } else if (hasOverlap) {
                blockReason = 'asset_overlap';
            } else if (currentlyAtMax) {
                blockReason = 'max_positions';
            }
            
            approaching.push({
                pair: pair.pair,
                asset1: pair.asset1,
                asset2: pair.asset2,
                sector: pair.sector,
                zScore: z,
                entryThreshold,
                proximity: Math.abs(z) / entryThreshold,
                hurst: hurst,
                hurstBlocked: hurst !== null && hurst >= 0.5,
                halfLife: fit.halfLife,
                direction,
                longAsset: z < 0 ? pair.asset1 : pair.asset2,
                shortAsset: z < 0 ? pair.asset2 : pair.asset1,
                longWeight: z < 0 ? w1 : w2,
                shortWeight: z < 0 ? w2 : w1,
                hasOverlap,
                overlappingAsset,
                validationPassed: validation.valid,
                blockReason,
                // Reversion safety from scanner
                reversionWarning: pair.reversionWarning,
                reversionRate: pair.reversionRate
            });
        }

        await new Promise(r => setTimeout(r, 200));
    }

    approaching.sort((a, b) => b.proximity - a.proximity);

    // Update watchlist with fresh metrics
    if (watchlistUpdates.length > 0) {
        try {
            await db.upsertWatchlist(watchlistUpdates);
            console.log(`[MONITOR] Updated ${watchlistUpdates.length} watchlist pairs`);
        } catch (err) {
            console.error('[MONITOR] Failed to update watchlist:', err.message);
        }
    }

    const saved2 = suppressConsole();
    await sdk.disconnect();
    restoreConsole(saved2);

    // Save updated trade state to database
    for (const trade of activeTrades.trades) {
        await db.updateTrade(trade.pair, {
            currentZ: trade.currentZ,
            currentPnL: trade.currentPnL,
            currentCorrelation: trade.currentCorrelation,
            currentHalfLife: trade.currentHalfLife,
            currentBeta: trade.currentBeta,
            currentHurst: trade.currentHurst,
            betaDrift: trade.betaDrift,
            maxBetaDrift: trade.maxBetaDrift,
            partialExitTaken: trade.partialExitTaken,
            partialExitPnL: trade.partialExitPnL,
            partialExitTime: trade.partialExitTime,
            healthScore: trade.healthScore,
            healthStatus: trade.healthStatus,
            healthSignals: trade.healthSignals
        });
    }

    // Send Telegram report
    const tradesWithPnL = activeTrades.trades.map(t => ({
        ...t,
        currentZ: t.currentZ,
        currentPnL: t.currentPnL || 0
    }));

    const report = formatStatusReport(tradesWithPnL, entries, exits, history, approaching, fundingMap);

    if (entries.length > 0 || exits.length > 0 || activeTrades.trades.length > 0 || approaching.length > 0) {
        await sendTelegram(report);
    }

    return {
        activeTrades: activeTrades.trades.length,
        entries: entries.length,
        exits: exits.length,
        approaching: approaching.length,
        portfolioPnL: tradesWithPnL.reduce((sum, t) => sum + (t.currentPnL || 0), 0)
    };
}

module.exports = { main };

