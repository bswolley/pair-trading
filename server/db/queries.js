/**
 * Database Queries
 * 
 * Abstracts database operations - uses Supabase when configured,
 * falls back to JSON files for local development.
 */

const fs = require('fs');
const path = require('path');
const { getClient, isSupabaseConfigured } = require('./supabase');

const CONFIG_DIR = path.join(__dirname, '../../config');

// ============================================
// JSON FILE HELPERS (fallback)
// ============================================

function loadJSON(filename) {
  const fp = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function saveJSON(filename, data) {
  fs.writeFileSync(path.join(CONFIG_DIR, filename), JSON.stringify(data, null, 2));
}

// ============================================
// WATCHLIST QUERIES
// ============================================

async function getWatchlist(filters = {}) {
  const client = getClient();
  
  if (client) {
    let query = client.from('watchlist').select('*');
    
    if (filters.sector) {
      query = query.eq('sector', filters.sector);
    }
    if (filters.ready) {
      query = query.eq('is_ready', true);
    }
    
    query = query.order('signal_strength', { ascending: false });
    
    const { data, error } = await query;
    if (error) throw error;
    
    // Transform DB columns to camelCase for API
    return data.map(transformWatchlistFromDB);
  }
  
  // Fallback to JSON
  const data = loadJSON('watchlist.json') || { pairs: [] };
  let pairs = data.pairs || [];
  
  if (filters.sector) {
    pairs = pairs.filter(p => p.sector === filters.sector);
  }
  if (filters.ready) {
    pairs = pairs.filter(p => p.isReady);
  }
  
  pairs.sort((a, b) => (b.signalStrength || 0) - (a.signalStrength || 0));
  
  return pairs;
}

async function getWatchlistPair(pair) {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('watchlist')
      .select('*')
      .or(`pair.eq.${pair},pair.eq.${pair.replace('_', '/')}`)
      .maybeSingle();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data ? transformWatchlistFromDB(data) : null;
  }
  
  const data = loadJSON('watchlist.json') || { pairs: [] };
  return (data.pairs || []).find(
    p => p.pair === pair || p.pair === pair.replace('_', '/')
  );
}

async function upsertWatchlist(pairs) {
  const client = getClient();
  
  if (client) {
    const dbPairs = pairs.map(transformWatchlistToDB);
    const { error } = await client
      .from('watchlist')
      .upsert(dbPairs, { onConflict: 'pair' });
    if (error) throw error;
    return true;
  }
  
  // Fallback to JSON
  const data = { timestamp: new Date().toISOString(), pairs };
  saveJSON('watchlist.json', data);
  return true;
}

async function deleteWatchlistPair(pair) {
  const client = getClient();
  
  if (client) {
    const { error } = await client
      .from('watchlist')
      .delete()
      .or(`pair.eq.${pair},pair.eq.${pair.replace('_', '/')}`);
    if (error) throw error;
    return true;
  }
  
  const data = loadJSON('watchlist.json') || { pairs: [] };
  const idx = (data.pairs || []).findIndex(
    p => p.pair === pair || p.pair === pair.replace('_', '/')
  );
  if (idx === -1) return false;
  data.pairs.splice(idx, 1);
  saveJSON('watchlist.json', data);
  return true;
}

// ============================================
// TRADES QUERIES
// ============================================

async function getTrades() {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('trades')
      .select('*')
      .order('entry_time', { ascending: false });
    if (error) throw error;
    return data.map(transformTradeFromDB);
  }
  
  const data = loadJSON('active_trades_sim.json') || { trades: [] };
  return data.trades || [];
}

async function getTrade(pair) {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('trades')
      .select('*')
      .or(`pair.eq.${pair},pair.eq.${pair.replace('_', '/')}`)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? transformTradeFromDB(data) : null;
  }
  
  const data = loadJSON('active_trades_sim.json') || { trades: [] };
  return (data.trades || []).find(
    t => t.pair === pair || t.pair === pair.replace('_', '/')
  );
}

async function createTrade(trade) {
  const client = getClient();
  
  if (client) {
    const dbTrade = transformTradeToDB(trade);
    const { data, error } = await client
      .from('trades')
      .insert(dbTrade)
      .select()
      .single();
    if (error) throw error;
    return transformTradeFromDB(data);
  }
  
  const data = loadJSON('active_trades_sim.json') || { trades: [] };
  data.trades.push(trade);
  saveJSON('active_trades_sim.json', data);
  return trade;
}

async function updateTrade(pair, updates) {
  const client = getClient();
  
  if (client) {
    const dbUpdates = transformTradeToDB(updates);
    const { data, error } = await client
      .from('trades')
      .update(dbUpdates)
      .or(`pair.eq.${pair},pair.eq.${pair.replace('_', '/')}`)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data ? transformTradeFromDB(data) : null;
  }
  
  const data = loadJSON('active_trades_sim.json') || { trades: [] };
  const idx = data.trades.findIndex(
    t => t.pair === pair || t.pair === pair.replace('_', '/')
  );
  if (idx === -1) return null;
  Object.assign(data.trades[idx], updates);
  saveJSON('active_trades_sim.json', data);
  return data.trades[idx];
}

async function deleteTrade(pair) {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('trades')
      .delete()
      .or(`pair.eq.${pair},pair.eq.${pair.replace('_', '/')}`)
      .select()
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? transformTradeFromDB(data) : null;
  }
  
  const data = loadJSON('active_trades_sim.json') || { trades: [] };
  const idx = data.trades.findIndex(
    t => t.pair === pair || t.pair === pair.replace('_', '/')
  );
  if (idx === -1) return null;
  const removed = data.trades.splice(idx, 1)[0];
  saveJSON('active_trades_sim.json', data);
  return removed;
}

// ============================================
// HISTORY QUERIES
// ============================================

async function getHistory(filters = {}) {
  const client = getClient();
  
  if (client) {
    let query = client.from('trade_history').select('*');
    
    if (filters.sector) {
      query = query.eq('sector', filters.sector);
    }
    if (filters.limit) {
      query = query.limit(filters.limit);
    }
    
    query = query.order('exit_time', { ascending: false });
    
    const { data, error } = await query;
    if (error) throw error;
    return data.map(transformHistoryFromDB);
  }
  
  const data = loadJSON('trade_history.json') || { trades: [] };
  let trades = data.trades || [];
  
  if (filters.sector) {
    trades = trades.filter(t => t.sector === filters.sector);
  }
  
  trades.sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime));
  
  if (filters.limit) {
    trades = trades.slice(0, filters.limit);
  }
  
  return trades;
}

async function addToHistory(trade) {
  const client = getClient();
  
  if (client) {
    const dbTrade = transformHistoryToDB(trade);
    const { error } = await client.from('trade_history').insert(dbTrade);
    if (error) throw error;
    
    // Update stats
    await updateStats(trade.totalPnL >= 0, trade.totalPnL);
    return true;
  }
  
  const data = loadJSON('trade_history.json') || { 
    trades: [], 
    stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } 
  };
  
  data.trades.push(trade);
  data.stats.totalTrades++;
  if (trade.totalPnL >= 0) data.stats.wins++; else data.stats.losses++;
  data.stats.totalPnL = (data.stats.totalPnL || 0) + trade.totalPnL;
  data.stats.winRate = ((data.stats.wins / data.stats.totalTrades) * 100).toFixed(1);
  
  saveJSON('trade_history.json', data);
  return true;
}

async function getStats() {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('stats')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, winRate: 0 };
    }
    return {
      totalTrades: data.total_trades,
      wins: data.wins,
      losses: data.losses,
      totalPnL: data.total_pnl,
      winRate: data.win_rate
    };
  }
  
  const data = loadJSON('trade_history.json') || { stats: {} };
  return data.stats || { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 };
}

async function updateStats(isWin, pnl = 0) {
  const client = getClient();
  if (!client) return;
  
  const { data: current } = await client
    .from('stats')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  
  const newTotal = (current?.total_trades || 0) + 1;
  const newWins = (current?.wins || 0) + (isWin ? 1 : 0);
  const newLosses = (current?.losses || 0) + (isWin ? 0 : 1);
  const newPnL = (current?.total_pnl || 0) + pnl;
  const newWinRate = newTotal > 0 ? (newWins / newTotal) * 100 : 0;
  
  await client
    .from('stats')
    .update({
      total_trades: newTotal,
      wins: newWins,
      losses: newLosses,
      total_pnl: newPnL,
      win_rate: newWinRate
    })
    .eq('id', 1);
}

// ============================================
// SCHEDULER STATE QUERIES
// ============================================

async function getSchedulerState() {
  const client = getClient();
  if (!client) return null;
  
  const { data, error } = await client
    .from('stats')
    .select('last_scan_time, last_monitor_time, cross_sector_enabled')
    .eq('id', 1)
    .maybeSingle();
  
  if (error || !data) return null;
  
  return {
    lastScanTime: data.last_scan_time,
    lastMonitorTime: data.last_monitor_time,
    crossSectorEnabled: data.cross_sector_enabled || false
  };
}

async function updateSchedulerState(updates) {
  const client = getClient();
  if (!client) return;
  
  const updateData = {};
  if (updates.lastScanTime !== undefined) {
    updateData.last_scan_time = updates.lastScanTime;
  }
  if (updates.lastMonitorTime !== undefined) {
    updateData.last_monitor_time = updates.lastMonitorTime;
  }
  if (updates.crossSectorEnabled !== undefined) {
    updateData.cross_sector_enabled = updates.crossSectorEnabled;
  }
  
  if (Object.keys(updateData).length > 0) {
    await client
      .from('stats')
      .update(updateData)
      .eq('id', 1);
  }
}

// ============================================
// BLACKLIST QUERIES
// ============================================

async function getBlacklist() {
  const client = getClient();
  
  if (client) {
    const { data, error } = await client
      .from('blacklist')
      .select('*')
      .order('added_at', { ascending: false });
    if (error) throw error;
    return {
      assets: data.map(d => d.asset),
      reasons: Object.fromEntries(data.map(d => [d.asset, d.reason]))
    };
  }
  
  const data = loadJSON('blacklist.json') || { assets: [], reasons: {} };
  return data;
}

async function addToBlacklist(asset, reason = null) {
  const client = getClient();
  const symbol = asset.toUpperCase();
  
  if (client) {
    const { error } = await client
      .from('blacklist')
      .insert({ asset: symbol, reason });
    if (error && error.code !== '23505') throw error; // Ignore duplicate
    return true;
  }
  
  const data = loadJSON('blacklist.json') || { assets: [], reasons: {} };
  if (!data.assets.includes(symbol)) {
    data.assets.push(symbol);
    if (reason) data.reasons[symbol] = reason;
    data.updatedAt = new Date().toISOString();
    saveJSON('blacklist.json', data);
  }
  return true;
}

async function removeFromBlacklist(asset) {
  const client = getClient();
  const symbol = asset.toUpperCase();
  
  if (client) {
    const { error } = await client
      .from('blacklist')
      .delete()
      .eq('asset', symbol);
    if (error) throw error;
    return true;
  }
  
  const data = loadJSON('blacklist.json') || { assets: [], reasons: {} };
  data.assets = data.assets.filter(a => a !== symbol);
  delete data.reasons?.[symbol];
  saveJSON('blacklist.json', data);
  return true;
}

// ============================================
// TRANSFORM HELPERS (DB <-> API format)
// ============================================

function transformWatchlistFromDB(row) {
  return {
    pair: row.pair,
    asset1: row.asset1,
    asset2: row.asset2,
    sector: row.sector,
    qualityScore: row.quality_score,
    conviction: row.conviction,
    hurst: row.hurst,
    hurstClassification: row.hurst_classification,
    correlation: row.correlation,
    beta: row.beta,
    initialBeta: row.initial_beta,
    betaDrift: row.beta_drift,
    halfLife: row.half_life,
    meanReversionRate: row.mean_reversion_rate,
    zScore: row.z_score,
    signalStrength: row.signal_strength,
    direction: row.direction,
    isReady: row.is_ready,
    entryThreshold: row.entry_threshold,
    exitThreshold: row.exit_threshold,
    maxHistoricalZ: row.max_historical_z,
    fundingSpread: row.funding_spread,
    volume1: row.volume1,
    volume2: row.volume2,
    reversionWarning: row.reversion_warning,
    reversionRate: row.reversion_rate,
    addedManually: row.added_manually,
    lastScan: row.last_scan,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function transformWatchlistToDB(pair) {
  return {
    pair: pair.pair,
    asset1: pair.asset1,
    asset2: pair.asset2,
    sector: pair.sector,
    quality_score: pair.qualityScore,
    conviction: pair.conviction,
    hurst: pair.hurst,
    hurst_classification: pair.hurstClassification,
    correlation: pair.correlation,
    beta: pair.beta,
    initial_beta: pair.initialBeta,
    beta_drift: pair.betaDrift,
    half_life: pair.halfLife,
    mean_reversion_rate: pair.meanReversionRate,
    z_score: pair.zScore,
    signal_strength: pair.signalStrength,
    direction: pair.direction,
    is_ready: pair.isReady,
    entry_threshold: pair.entryThreshold,
    exit_threshold: pair.exitThreshold,
    max_historical_z: pair.maxHistoricalZ,
    funding_spread: pair.fundingSpread,
    volume1: pair.volume1,
    volume2: pair.volume2,
    reversion_warning: pair.reversionWarning,
    reversion_rate: pair.reversionRate,
    added_manually: pair.addedManually,
    last_scan: pair.lastScan || new Date().toISOString()
  };
}

function transformTradeFromDB(row) {
  return {
    id: row.id,
    pair: row.pair,
    asset1: row.asset1,
    asset2: row.asset2,
    sector: row.sector,
    entryTime: row.entry_time,
    entryZScore: row.entry_z_score,
    entryPrice1: row.entry_price1,
    entryPrice2: row.entry_price2,
    entryThreshold: row.entry_threshold,
    direction: row.direction,
    longAsset: row.long_asset,
    shortAsset: row.short_asset,
    longWeight: row.long_weight,
    shortWeight: row.short_weight,
    longEntryPrice: row.long_entry_price,
    shortEntryPrice: row.short_entry_price,
    correlation: row.correlation,
    beta: row.beta,
    halfLife: row.half_life,
    hurst: row.hurst,
    maxHistoricalZ: row.max_historical_z,
    currentZ: row.current_z,
    currentPnL: row.current_pnl,
    currentCorrelation: row.current_correlation,
    currentHalfLife: row.current_half_life,
    currentBeta: row.current_beta,
    currentHurst: row.current_hurst,
    betaDrift: row.beta_drift,
    maxBetaDrift: row.max_beta_drift,
    partialExitTaken: row.partial_exit_taken,
    partialExitPnL: row.partial_exit_pnl,
    partialExitTime: row.partial_exit_time,
    healthScore: row.health_score,
    healthStatus: row.health_status,
    healthSignals: row.health_signals,
    source: row.source,
    notes: row.notes
  };
}

function transformTradeToDB(trade) {
  const result = {};
  
  if (trade.pair !== undefined) result.pair = trade.pair;
  if (trade.asset1 !== undefined) result.asset1 = trade.asset1;
  if (trade.asset2 !== undefined) result.asset2 = trade.asset2;
  if (trade.sector !== undefined) result.sector = trade.sector;
  if (trade.entryTime !== undefined) result.entry_time = trade.entryTime;
  if (trade.entryZScore !== undefined) result.entry_z_score = trade.entryZScore;
  if (trade.entryPrice1 !== undefined) result.entry_price1 = trade.entryPrice1;
  if (trade.entryPrice2 !== undefined) result.entry_price2 = trade.entryPrice2;
  if (trade.entryThreshold !== undefined) result.entry_threshold = trade.entryThreshold;
  if (trade.direction !== undefined) result.direction = trade.direction;
  if (trade.longAsset !== undefined) result.long_asset = trade.longAsset;
  if (trade.shortAsset !== undefined) result.short_asset = trade.shortAsset;
  if (trade.longWeight !== undefined) result.long_weight = trade.longWeight;
  if (trade.shortWeight !== undefined) result.short_weight = trade.shortWeight;
  if (trade.longEntryPrice !== undefined) result.long_entry_price = trade.longEntryPrice;
  if (trade.shortEntryPrice !== undefined) result.short_entry_price = trade.shortEntryPrice;
  if (trade.correlation !== undefined) result.correlation = trade.correlation;
  if (trade.beta !== undefined) result.beta = trade.beta;
  if (trade.halfLife !== undefined) result.half_life = trade.halfLife;
  if (trade.hurst !== undefined) result.hurst = trade.hurst;
  if (trade.maxHistoricalZ !== undefined) result.max_historical_z = trade.maxHistoricalZ;
  if (trade.currentZ !== undefined) result.current_z = trade.currentZ;
  if (trade.currentPnL !== undefined) result.current_pnl = trade.currentPnL;
  if (trade.currentCorrelation !== undefined) result.current_correlation = trade.currentCorrelation;
  if (trade.currentHalfLife !== undefined) result.current_half_life = trade.currentHalfLife;
  if (trade.currentBeta !== undefined) result.current_beta = trade.currentBeta;
  if (trade.currentHurst !== undefined) result.current_hurst = trade.currentHurst;
  if (trade.betaDrift !== undefined) result.beta_drift = trade.betaDrift;
  if (trade.maxBetaDrift !== undefined) result.max_beta_drift = trade.maxBetaDrift;
  if (trade.partialExitTaken !== undefined) result.partial_exit_taken = trade.partialExitTaken;
  if (trade.partialExitPnL !== undefined) result.partial_exit_pnl = trade.partialExitPnL;
  if (trade.partialExitTime !== undefined) result.partial_exit_time = trade.partialExitTime;
  if (trade.healthScore !== undefined) result.health_score = trade.healthScore;
  if (trade.healthStatus !== undefined) result.health_status = trade.healthStatus;
  if (trade.healthSignals !== undefined) result.health_signals = trade.healthSignals;
  if (trade.source !== undefined) result.source = trade.source;
  if (trade.notes !== undefined) result.notes = trade.notes;
  
  return result;
}

function transformHistoryFromDB(row) {
  return {
    id: row.id,
    pair: row.pair,
    asset1: row.asset1,
    asset2: row.asset2,
    sector: row.sector,
    entryTime: row.entry_time,
    entryZScore: row.entry_z_score,
    direction: row.direction,
    longAsset: row.long_asset,
    shortAsset: row.short_asset,
    longWeight: row.long_weight,
    shortWeight: row.short_weight,
    correlation: row.correlation,
    beta: row.beta,
    halfLife: row.half_life,
    hurst: row.hurst,
    betaDrift: row.beta_drift,
    maxBetaDrift: row.max_beta_drift,
    exitTime: row.exit_time,
    exitZScore: row.exit_z_score,
    exitHurst: row.exit_hurst,
    exitReason: row.exit_reason,
    totalPnL: row.total_pnl,
    daysInTrade: row.days_in_trade,
    partialExitTaken: row.partial_exit_taken,
    partialExitPnL: row.partial_exit_pnl,
    healthScore: row.health_score,
    healthStatus: row.health_status,
    healthSignals: row.health_signals,
    source: row.source
  };
}

function transformHistoryToDB(trade) {
  return {
    pair: trade.pair,
    asset1: trade.asset1,
    asset2: trade.asset2,
    sector: trade.sector,
    entry_time: trade.entryTime,
    entry_z_score: trade.entryZScore,
    entry_price1: trade.entryPrice1,
    entry_price2: trade.entryPrice2,
    direction: trade.direction,
    long_asset: trade.longAsset,
    short_asset: trade.shortAsset,
    long_weight: trade.longWeight,
    short_weight: trade.shortWeight,
    long_entry_price: trade.longEntryPrice,
    short_entry_price: trade.shortEntryPrice,
    correlation: trade.correlation,
    beta: trade.beta,
    half_life: trade.halfLife,
    hurst: trade.hurst,
    beta_drift: trade.betaDrift,
    max_beta_drift: trade.maxBetaDrift,
    exit_time: trade.exitTime || new Date().toISOString(),
    exit_z_score: trade.exitZScore,
    exit_hurst: trade.exitHurst,
    exit_reason: trade.exitReason,
    total_pnl: trade.totalPnL,
    days_in_trade: trade.daysInTrade,
    partial_exit_taken: trade.partialExitTaken,
    partial_exit_pnl: trade.partialExitPnL,
    health_score: trade.healthScore,
    health_status: trade.healthStatus,
    health_signals: trade.healthSignals,
    source: trade.source
  };
}

module.exports = {
  // Watchlist
  getWatchlist,
  getWatchlistPair,
  upsertWatchlist,
  deleteWatchlistPair,
  
  // Trades
  getTrades,
  getTrade,
  createTrade,
  updateTrade,
  deleteTrade,
  
  // History
  getHistory,
  addToHistory,
  getStats,
  
  // Scheduler State
  getSchedulerState,
  updateSchedulerState,
  
  // Blacklist
  getBlacklist,
  addToBlacklist,
  removeFromBlacklist,
  
  // Helpers
  loadJSON,
  saveJSON
};

