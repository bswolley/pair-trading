/**
 * Status API Routes
 * 
 * GET /api/status - Get current bot status
 * GET /api/status/scheduler - Get scheduler status
 * POST /api/status/cross-sector - Toggle cross-sector scanning
 * POST /api/status/scan - Trigger scan
 * POST /api/status/monitor - Trigger monitor
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { getSchedulerStatus, runScanNow, runMonitorNow, setCrossSectorEnabled, getCrossSectorEnabled } = require('../services/scheduler');

// GET /api/status - Overall status summary
router.get('/', async (req, res) => {
  try {
    const [trades, watchlist, stats, blacklist] = await Promise.all([
      db.getTrades(),
      db.getWatchlist(),
      db.getStats(),
      db.getBlacklist()
    ]);
    
    // Calculate portfolio P&L
    let portfolioPnL = 0;
    for (const trade of trades) {
      portfolioPnL += trade.currentPnL || 0;
    }
    
    // Find approaching entries
    const approaching = watchlist
      .filter(p => (p.signalStrength || 0) >= 0.5)
      .sort((a, b) => (b.signalStrength || 0) - (a.signalStrength || 0))
      .slice(0, 5);
    
    const scheduler = getSchedulerStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      activeTrades: {
        count: trades.length,
        portfolioPnL: portfolioPnL.toFixed(2),
        pairs: trades.map(t => ({
          pair: t.pair,
          sector: t.sector,
          direction: t.direction,
          pnl: (t.currentPnL || 0).toFixed(2),
          daysInTrade: ((Date.now() - new Date(t.entryTime)) / (1000 * 60 * 60 * 24)).toFixed(1)
        }))
      },
      watchlist: {
        totalPairs: watchlist.length,
        approaching: approaching.map(p => ({
          pair: p.pair,
          zScore: p.zScore,
          entryThreshold: p.entryThreshold,
          signalStrength: p.signalStrength
        }))
      },
      history: {
        totalTrades: stats.totalTrades || 0,
        wins: stats.wins || 0,
        losses: stats.losses || 0,
        totalPnL: (stats.totalPnL || 0).toFixed(2)
      },
      blacklist: {
        count: blacklist.assets?.length || 0
      },
      scheduler
    });
  } catch (err) {
    console.error('[STATUS] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status/scheduler - Scheduler status
router.get('/scheduler', (req, res) => {
  try {
    res.json(getSchedulerStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/status/cross-sector - Toggle cross-sector scanning
router.post('/cross-sector', (req, res) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }
    
    const result = setCrossSectorEnabled(enabled);
    res.json({ 
      success: true, 
      crossSectorEnabled: result 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status/cross-sector - Get cross-sector setting
router.get('/cross-sector', (req, res) => {
  try {
    res.json({ crossSectorEnabled: getCrossSectorEnabled() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/status/scan - Trigger pair scan
router.post('/scan', async (req, res) => {
  try {
    const { crossSector } = req.body;
    const result = await runScanNow({ crossSector });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/status/monitor - Trigger monitor
router.post('/monitor', async (req, res) => {
  try {
    const result = await runMonitorNow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
