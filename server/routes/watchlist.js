/**
 * Watchlist API Routes
 * 
 * GET /api/watchlist - Get all watchlist pairs
 * POST /api/watchlist - Add pair to watchlist
 * POST /api/watchlist/:pair/refresh - Refresh pair metrics (recalculate optimal entry)
 * DELETE /api/watchlist/:pair - Remove pair from watchlist
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { Hyperliquid } = require('hyperliquid');
const { checkPairFitness, analyzeHistoricalDivergences } = require('../../lib/pairAnalysis');

// GET /api/watchlist - List all pairs
router.get('/', async (req, res) => {
    try {
        const { sector, ready } = req.query;

        let pairs = await db.getWatchlist({
            sector,
            ready: ready === 'true'
        });

        // Filter out pairs containing blacklisted assets
        const blacklistData = await db.getBlacklist();
        const blacklist = new Set(blacklistData?.assets || []);
        pairs = pairs.filter(p => !blacklist.has(p.asset1) && !blacklist.has(p.asset2));

        // Get active trades to mark pairs that are already being traded
        const activeTrades = await db.getTrades();
        const activePairs = new Set(activeTrades.map(t => t.pair));
        
        // Smart overlap tracking: track which assets are long vs short
        const MAX_TRADES_PER_ASSET = 2;
        const assetsLong = new Map();  // asset -> count of times it's long
        const assetsShort = new Map(); // asset -> count of times it's short
        const assetTradeCount = new Map(); // asset -> total trade count
        
        activeTrades.forEach(t => {
            if (t.longAsset) {
                assetsLong.set(t.longAsset, (assetsLong.get(t.longAsset) || 0) + 1);
                assetTradeCount.set(t.longAsset, (assetTradeCount.get(t.longAsset) || 0) + 1);
            }
            if (t.shortAsset) {
                assetsShort.set(t.shortAsset, (assetsShort.get(t.shortAsset) || 0) + 1);
                assetTradeCount.set(t.shortAsset, (assetTradeCount.get(t.shortAsset) || 0) + 1);
            }
        });
        
        // Helper function to check smart overlap for a pair
        function checkSmartOverlap(pairLongAsset, pairShortAsset) {
            // Check for conflicting positions (same asset on opposite sides)
            const longConflict = assetsShort.has(pairLongAsset); // We want to long it, but it's already short
            const shortConflict = assetsLong.has(pairShortAsset); // We want to short it, but it's already long
            
            // Check max trades per asset limit
            const longAssetCount = assetTradeCount.get(pairLongAsset) || 0;
            const shortAssetCount = assetTradeCount.get(pairShortAsset) || 0;
            const exceedsLimit = longAssetCount >= MAX_TRADES_PER_ASSET || shortAssetCount >= MAX_TRADES_PER_ASSET;
            
            return {
                hasConflict: longConflict || shortConflict,
                exceedsLimit,
                isBlocked: longConflict || shortConflict || exceedsLimit,
                conflictType: longConflict ? 'long_conflict' : shortConflict ? 'short_conflict' : exceedsLimit ? 'max_exposure' : null,
                conflictAsset: longConflict ? pairLongAsset : shortConflict ? pairShortAsset : 
                               (longAssetCount >= MAX_TRADES_PER_ASSET ? pairLongAsset : 
                                shortAssetCount >= MAX_TRADES_PER_ASSET ? pairShortAsset : null),
                sameDirectionCount: {
                    long: assetsLong.get(pairLongAsset) || 0,
                    short: assetsShort.get(pairShortAsset) || 0
                }
            };
        }

        // Enrich pairs with trade status
        pairs = pairs.map(p => {
            const isActive = activePairs.has(p.pair);
            
            // Determine direction based on z-score
            const pairDir = p.direction || (p.zScore < 0 ? 'long' : 'short');
            const pairLong = pairDir === 'long' ? p.asset1 : p.asset2;
            const pairShort = pairDir === 'long' ? p.asset2 : p.asset1;
            
            // Check smart overlap
            const overlapCheck = isActive ? { isBlocked: true, conflictType: 'active_trade' } : checkSmartOverlap(pairLong, pairShort);
            
            return {
                ...p,
                isActive,
                hasAssetOverlap: !isActive && overlapCheck.isBlocked,
                overlapType: overlapCheck.conflictType,
                overlapAsset: overlapCheck.conflictAsset,
                isBlocked: isActive || overlapCheck.isBlocked,
                // Show if same-side overlap is allowed (helpful for UI)
                sameDirectionTrades: overlapCheck.sameDirectionCount
            };
        });

        res.json({
            timestamp: new Date().toISOString(),
            totalPairs: pairs.length,
            activeTrades: activeTrades.length,
            pairs
        });
    } catch (err) {
        console.error('[WATCHLIST] GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/watchlist/sectors - Get sector summary
router.get('/sectors', async (req, res) => {
    try {
        let pairs = await db.getWatchlist();

        // Filter out blacklisted pairs
        const blacklistData = await db.getBlacklist();
        const blacklist = new Set(blacklistData?.assets || []);
        pairs = pairs.filter(p => !blacklist.has(p.asset1) && !blacklist.has(p.asset2));

        const sectorCounts = {};

        for (const pair of pairs) {
            sectorCounts[pair.sector] = (sectorCounts[pair.sector] || 0) + 1;
        }

        res.json({
            timestamp: new Date().toISOString(),
            sectors: Object.entries(sectorCounts).map(([name, count]) => ({ name, count }))
        });
    } catch (err) {
        console.error('[WATCHLIST] GET/sectors error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/watchlist/:pair - Get specific pair
router.get('/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const found = await db.getWatchlistPair(pair);

        if (!found) {
            return res.status(404).json({ error: 'Pair not found' });
        }

        res.json(found);
    } catch (err) {
        console.error('[WATCHLIST] GET/:pair error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/watchlist - Add pair manually
router.post('/', async (req, res) => {
    try {
        const { pair, asset1, asset2, sector, entryThreshold } = req.body;

        if (!pair || !asset1 || !asset2) {
            return res.status(400).json({ error: 'pair, asset1, asset2 required' });
        }

        // Check if either asset is blacklisted
        const blacklistData = await db.getBlacklist();
        const blacklist = new Set(blacklistData?.assets || []);
        if (blacklist.has(asset1.toUpperCase())) {
            return res.status(400).json({ error: `${asset1} is blacklisted` });
        }
        if (blacklist.has(asset2.toUpperCase())) {
            return res.status(400).json({ error: `${asset2} is blacklisted` });
        }

        const existing = await db.getWatchlistPair(pair);
        if (existing) {
            return res.status(400).json({ error: 'Pair already in watchlist' });
        }

        const newPair = {
            pair,
            asset1,
            asset2,
            sector: sector || 'Manual',
            entryThreshold: entryThreshold || 2.0,
            exitThreshold: 0.5,
            zScore: 0,
            signalStrength: 0,
            isReady: false,
            addedManually: true
        };

        await db.upsertWatchlist([newPair]);

        res.status(201).json({ success: true, pair: newPair });
    } catch (err) {
        console.error('[WATCHLIST] POST error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/watchlist/:pair/refresh - Refresh pair metrics
router.post('/:pair/refresh', async (req, res) => {
    try {
        const pairParam = req.params.pair;
        const [asset1, asset2] = pairParam.replace('_', '/').split('/');

        if (!asset1 || !asset2) {
            return res.status(400).json({ error: 'Invalid pair format' });
        }

        const existing = await db.getWatchlistPair(pairParam.replace('/', '_'));
        if (!existing) {
            return res.status(404).json({ error: 'Pair not found in watchlist' });
        }

        // Fetch fresh prices
        const sdk = new Hyperliquid();
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => { };
        console.error = () => { };
        await sdk.connect();
        console.log = origLog;
        console.error = origErr;

        const endTime = Date.now();
        const startTime = endTime - (35 * 24 * 60 * 60 * 1000); // 35 days

        const [candles1, candles2] = await Promise.all([
            sdk.info.getCandleSnapshot(`${asset1}-PERP`, '1d', startTime, endTime),
            sdk.info.getCandleSnapshot(`${asset2}-PERP`, '1d', startTime, endTime)
        ]);

        console.log = () => { };
        console.error = () => { };
        await sdk.disconnect();
        console.log = origLog;
        console.error = origErr;

        if (!candles1?.length || !candles2?.length) {
            return res.status(500).json({ error: 'Could not fetch price data' });
        }

        // Align prices
        const map1 = new Map(candles1.map(c => [c.t, parseFloat(c.c)]));
        const map2 = new Map(candles2.map(c => [c.t, parseFloat(c.c)]));
        const commonTimes = [...map1.keys()].filter(t => map2.has(t)).sort((a, b) => a - b);
        const prices1 = commonTimes.slice(-30).map(t => map1.get(t));
        const prices2 = commonTimes.slice(-30).map(t => map2.get(t));

        // Calculate fitness
        const fitness = checkPairFitness(prices1, prices2);

        // Calculate optimal entry using HOURLY data (60 days) for accurate divergence analysis
        // This is critical - daily data (30 points) produces unreliable thresholds
        const MIN_ENTRY_THRESHOLD = 2.5; // Safety floor - never enter below this (raised from 2.0 based on performance data)
        let optimalEntry = MIN_ENTRY_THRESHOLD;
        try {
            const divergenceProfile = await analyzeHistoricalDivergences(asset1, asset2, sdk);
            if (divergenceProfile?.optimalEntry) {
                // Enforce minimum threshold floor
                optimalEntry = Math.max(divergenceProfile.optimalEntry, MIN_ENTRY_THRESHOLD);
            }
        } catch (divErr) {
            console.warn(`[WATCHLIST] Divergence analysis failed for ${pair}, using default threshold:`, divErr.message);
        }

        // Calculate signal strength
        const signalStrength = Math.min(Math.abs(fitness.zScore) / optimalEntry, 1.0);
        const isReady = Math.abs(fitness.zScore) >= optimalEntry;
        const direction = fitness.zScore < 0 ? 'long' : 'short';

        // Update in DB
        const updatedPair = {
            ...existing,
            zScore: parseFloat(fitness.zScore.toFixed(2)),
            correlation: parseFloat(fitness.correlation.toFixed(3)),
            beta: parseFloat(fitness.beta.toFixed(3)),
            halfLife: fitness.halfLife ? parseFloat(fitness.halfLife.toFixed(1)) : null,
            entryThreshold: optimalEntry,
            signalStrength: parseFloat(signalStrength.toFixed(2)),
            direction,
            isReady
        };

        await db.upsertWatchlist([updatedPair]);

        res.json({
            success: true,
            pair: updatedPair,
            message: `Updated entry threshold to ${optimalEntry}`
        });

    } catch (err) {
        console.error('[WATCHLIST] REFRESH error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/watchlist/:pair - Remove pair
router.delete('/:pair', async (req, res) => {
    try {
        const { pair } = req.params;

        const deleted = await db.deleteWatchlistPair(pair);

        if (!deleted) {
            return res.status(404).json({ error: 'Pair not found' });
        }

        res.json({ success: true, removed: pair });
    } catch (err) {
        console.error('[WATCHLIST] DELETE error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
