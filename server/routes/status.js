/**
 * Status API Routes
 * 
 * GET /api/status - Get current bot status
 * GET /api/status/scheduler - Get scheduler status
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { getSchedulerStatus } = require('../services/scheduler');

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

module.exports = router;
