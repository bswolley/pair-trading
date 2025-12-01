/**
 * Trades API Routes
 * 
 * GET /api/trades - List active trades
 * POST /api/trades - Create new trade
 * PUT /api/trades/:pair - Update trade
 * DELETE /api/trades/:pair - Close/delete trade
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');

// GET /api/trades - List all active trades
router.get('/', async (req, res) => {
    try {
        const trades = await db.getTrades();
        res.json({
            count: trades.length,
            trades
        });
    } catch (err) {
        console.error('[TRADES] GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trades/:pair - Get specific trade
router.get('/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const trade = await db.getTrade(pair);

        if (!trade) {
            return res.status(404).json({ error: 'Trade not found' });
        }

        res.json(trade);
    } catch (err) {
        console.error('[TRADES] GET/:pair error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trades - Create new trade (manual entry)
router.post('/', async (req, res) => {
    try {
        const {
            pair, asset1, asset2, sector,
            longAsset, shortAsset, longWeight, shortWeight,
            longEntryPrice, shortEntryPrice,
            entryZScore, beta, halfLife, correlation
        } = req.body;

        if (!pair || !asset1 || !asset2) {
            return res.status(400).json({ error: 'pair, asset1, asset2 required' });
        }

        // Check if trade already exists
        const existing = await db.getTrade(pair);
        if (existing) {
            return res.status(400).json({ error: 'Trade already exists' });
        }

        const direction = longAsset === asset1 ? 'long' : 'short';

        const trade = {
            pair,
            asset1,
            asset2,
            sector: sector || 'Unknown',
            entryTime: new Date().toISOString(),
            entryZScore: entryZScore || 0,
            direction,
            longAsset: longAsset || asset1,
            shortAsset: shortAsset || asset2,
            longWeight: longWeight || 50,
            shortWeight: shortWeight || 50,
            longEntryPrice: longEntryPrice || 0,
            shortEntryPrice: shortEntryPrice || 0,
            beta: beta || 1,
            halfLife: halfLife || 10,
            correlation: correlation || 0.8,
            source: 'manual'
        };

        const created = await db.createTrade(trade);
        res.status(201).json({ success: true, trade: created });
    } catch (err) {
        console.error('[TRADES] POST error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/trades/:pair - Update trade
router.put('/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const updates = req.body;

        // Only allow specific fields to be updated
        const allowedFields = ['partialExitTaken', 'partialExitPnL', 'partialExitTime', 'notes', 'currentPnL', 'currentZ'];
        const filteredUpdates = {};
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                filteredUpdates[field] = updates[field];
            }
        }

        const updated = await db.updateTrade(pair, filteredUpdates);

        if (!updated) {
            return res.status(404).json({ error: 'Trade not found' });
        }

        res.json({ success: true, trade: updated });
    } catch (err) {
        console.error('[TRADES] PUT error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trades/:pair - Close/delete trade
router.delete('/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const { reason, pnl } = req.body || {};

        const trade = await db.deleteTrade(pair);

        if (!trade) {
            return res.status(404).json({ error: 'Trade not found' });
        }

        // Add to history
        const historyRecord = {
            ...trade,
            exitTime: new Date().toISOString(),
            exitReason: reason || 'MANUAL',
            totalPnL: pnl || trade.currentPnL || 0,
            daysInTrade: ((Date.now() - new Date(trade.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1)
        };

        await db.addToHistory(historyRecord);

        res.json({ success: true, message: 'Trade closed', record: historyRecord });
    } catch (err) {
        console.error('[TRADES] DELETE error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
