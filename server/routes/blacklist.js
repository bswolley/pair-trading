/**
 * Blacklist API Routes
 * 
 * GET /api/blacklist - Get blacklisted assets
 * POST /api/blacklist - Add asset to blacklist
 * DELETE /api/blacklist/:asset - Remove from blacklist
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');

// GET /api/blacklist - List all blacklisted assets
router.get('/', async (req, res) => {
  try {
    const data = await db.getBlacklist();
    res.json({
      count: data.assets?.length || 0,
      assets: data.assets || [],
      reasons: data.reasons || {}
    });
  } catch (err) {
    console.error('[BLACKLIST] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blacklist - Add asset
router.post('/', async (req, res) => {
  try {
    const { asset, reason } = req.body;
    
    if (!asset) {
      return res.status(400).json({ error: 'asset required' });
    }
    
    const symbol = asset.toUpperCase();
    const data = await db.getBlacklist();
    
    if (data.assets?.includes(symbol)) {
      return res.status(400).json({ error: 'Asset already blacklisted' });
    }
    
    await db.addToBlacklist(symbol, reason);
    
    res.status(201).json({ success: true, asset: symbol, reason });
  } catch (err) {
    console.error('[BLACKLIST] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/blacklist/:asset - Remove asset
router.delete('/:asset', async (req, res) => {
  try {
    const { asset } = req.params;
    const symbol = asset.toUpperCase();
    
    const data = await db.getBlacklist();
    
    if (!data.assets?.includes(symbol)) {
      return res.status(404).json({ error: 'Asset not in blacklist' });
    }
    
    await db.removeFromBlacklist(symbol);
    
    res.json({ success: true, removed: symbol });
  } catch (err) {
    console.error('[BLACKLIST] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
