/**
 * Watchlist API Routes
 * 
 * GET /api/watchlist - Get all watchlist pairs
 * POST /api/watchlist - Add pair to watchlist
 * DELETE /api/watchlist/:pair - Remove pair from watchlist
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');

// GET /api/watchlist - List all pairs
router.get('/', async (req, res) => {
    try {
        const { sector, ready } = req.query;

        const pairs = await db.getWatchlist({
            sector,
            ready: ready === 'true'
        });

        res.json({
            timestamp: new Date().toISOString(),
            totalPairs: pairs.length,
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
        const pairs = await db.getWatchlist();
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
