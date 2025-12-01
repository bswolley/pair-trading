/**
 * History API Routes
 * 
 * GET /api/history - Get trade history
 * GET /api/history/stats - Get aggregated stats
 */

const express = require('express');
const router = express.Router();
const db = require('../db/queries');

// GET /api/history - List all historical trades
router.get('/', async (req, res) => {
  try {
    const { limit, sector } = req.query;
    
    const trades = await db.getHistory({
      sector,
      limit: limit ? parseInt(limit) : undefined
    });
    
    const stats = await db.getStats();
    
    res.json({
      totalCount: stats.totalTrades || trades.length,
      filteredCount: trades.length,
      stats,
      trades
    });
  } catch (err) {
    console.error('[HISTORY] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/stats - Aggregated statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    const trades = await db.getHistory();
    
    if (trades.length === 0) {
      return res.json({
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnL: 0,
        avgPnL: 0,
        avgDuration: 0,
        bestTrade: null,
        worstTrade: null
      });
    }
    
    const totalPnL = trades.reduce((sum, t) => sum + (t.totalPnL || 0), 0);
    const avgDuration = trades.reduce((sum, t) => sum + (parseFloat(t.daysInTrade) || 0), 0) / trades.length;
    
    // Best and worst trades
    const sorted = [...trades].sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));
    
    // Stats by sector
    const bySector = {};
    for (const trade of trades) {
      const sector = trade.sector || 'Unknown';
      if (!bySector[sector]) {
        bySector[sector] = { trades: 0, wins: 0, pnl: 0 };
      }
      bySector[sector].trades++;
      if ((trade.totalPnL || 0) >= 0) bySector[sector].wins++;
      bySector[sector].pnl += trade.totalPnL || 0;
    }
    
    // Stats by exit reason
    const byReason = {};
    for (const trade of trades) {
      const reason = trade.exitReason || 'Unknown';
      if (!byReason[reason]) {
        byReason[reason] = { count: 0, avgPnL: 0, totalPnL: 0 };
      }
      byReason[reason].count++;
      byReason[reason].totalPnL += trade.totalPnL || 0;
    }
    for (const reason of Object.keys(byReason)) {
      byReason[reason].avgPnL = byReason[reason].totalPnL / byReason[reason].count;
    }
    
    res.json({
      totalTrades: stats.totalTrades || trades.length,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      winRate: stats.winRate || 0,
      totalPnL: totalPnL.toFixed(2),
      avgPnL: (totalPnL / trades.length).toFixed(2),
      avgDuration: avgDuration.toFixed(1),
      bestTrade: sorted[0] ? { pair: sorted[0].pair, pnl: sorted[0].totalPnL } : null,
      worstTrade: sorted[sorted.length - 1] ? { pair: sorted[sorted.length - 1].pair, pnl: sorted[sorted.length - 1].totalPnL } : null,
      bySector,
      byReason
    });
  } catch (err) {
    console.error('[HISTORY] GET/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
