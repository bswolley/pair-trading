#!/usr/bin/env node

/**
 * Migrate JSON data to Supabase
 * 
 * Run this once after setting up Supabase tables.
 * Make sure SUPABASE_URL and SUPABASE_KEY are set in .env
 * 
 * Usage: node scripts/migrateToSupabase.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const CONFIG_DIR = path.join(__dirname, '../config');

function loadJSON(filename) {
  const fp = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

async function migrateWatchlist() {
  console.log('\n📋 Migrating watchlist...');
  
  const data = loadJSON('watchlist.json');
  if (!data?.pairs?.length) {
    console.log('   No watchlist data to migrate');
    return 0;
  }
  
  const rows = data.pairs.map(p => ({
    pair: p.pair,
    asset1: p.asset1,
    asset2: p.asset2,
    sector: p.sector,
    quality_score: p.qualityScore,
    correlation: p.correlation,
    beta: p.beta,
    half_life: p.halfLife,
    mean_reversion_rate: p.meanReversionRate,
    z_score: p.zScore,
    signal_strength: p.signalStrength,
    direction: p.direction,
    is_ready: p.isReady,
    entry_threshold: p.entryThreshold,
    exit_threshold: p.exitThreshold || 0.5,
    max_historical_z: p.maxHistoricalZ,
    funding_spread: p.fundingSpread,
    added_manually: p.addedManually || false,
    last_scan: data.timestamp
  }));
  
  const { error } = await supabase
    .from('watchlist')
    .upsert(rows, { onConflict: 'pair' });
  
  if (error) {
    console.error('   ❌ Error:', error.message);
    return 0;
  }
  
  console.log(`   ✅ Migrated ${rows.length} pairs`);
  return rows.length;
}

async function migrateTrades() {
  console.log('\n📈 Migrating active trades...');
  
  const data = loadJSON('active_trades_sim.json');
  if (!data?.trades?.length) {
    console.log('   No active trades to migrate');
    return 0;
  }
  
  const rows = data.trades.map(t => ({
    pair: t.pair,
    asset1: t.asset1,
    asset2: t.asset2,
    sector: t.sector,
    entry_time: t.entryTime,
    entry_z_score: t.entryZScore,
    entry_price1: t.entryPrice1,
    entry_price2: t.entryPrice2,
    entry_threshold: t.entryThreshold,
    direction: t.direction,
    long_asset: t.longAsset,
    short_asset: t.shortAsset,
    long_weight: t.longWeight,
    short_weight: t.shortWeight,
    long_entry_price: t.longEntryPrice,
    short_entry_price: t.shortEntryPrice,
    correlation: t.correlation,
    beta: t.beta,
    half_life: t.halfLife,
    current_z: t.currentZ,
    current_pnl: t.currentPnL,
    current_correlation: t.currentCorrelation,
    current_half_life: t.currentHalfLife,
    partial_exit_taken: t.partialExitTaken || false,
    partial_exit_pnl: t.partialExitPnL,
    partial_exit_time: t.partialExitTime,
    source: t.source || 'bot'
  }));
  
  const { error } = await supabase.from('trades').insert(rows);
  
  if (error) {
    console.error('   ❌ Error:', error.message);
    return 0;
  }
  
  console.log(`   ✅ Migrated ${rows.length} trades`);
  return rows.length;
}

async function migrateHistory() {
  console.log('\n📜 Migrating trade history...');
  
  const data = loadJSON('trade_history.json');
  if (!data?.trades?.length) {
    console.log('   No history to migrate');
    return 0;
  }
  
  const rows = data.trades.map(t => ({
    pair: t.pair,
    asset1: t.asset1,
    asset2: t.asset2,
    sector: t.sector,
    entry_time: t.entryTime,
    entry_z_score: t.entryZScore,
    entry_price1: t.entryPrice1,
    entry_price2: t.entryPrice2,
    direction: t.direction,
    long_asset: t.longAsset,
    short_asset: t.shortAsset,
    long_weight: t.longWeight,
    short_weight: t.shortWeight,
    long_entry_price: t.longEntryPrice,
    short_entry_price: t.shortEntryPrice,
    correlation: t.correlation,
    beta: t.beta,
    half_life: t.halfLife,
    exit_time: t.exitTime,
    exit_z_score: t.exitZScore,
    exit_reason: t.exitReason,
    total_pnl: t.totalPnL,
    days_in_trade: t.daysInTrade,
    partial_exit_taken: t.partialExitTaken || false,
    partial_exit_pnl: t.partialExitPnL,
    source: t.source || 'bot'
  }));
  
  const { error } = await supabase.from('trade_history').insert(rows);
  
  if (error) {
    console.error('   ❌ Error:', error.message);
    return 0;
  }
  
  // Update stats
  if (data.stats) {
    await supabase.from('stats').update({
      total_trades: data.stats.totalTrades || 0,
      wins: data.stats.wins || 0,
      losses: data.stats.losses || 0,
      total_pnl: data.stats.totalPnL || 0,
      win_rate: parseFloat(data.stats.winRate) || 0
    }).eq('id', 1);
  }
  
  console.log(`   ✅ Migrated ${rows.length} history records`);
  return rows.length;
}

async function migrateBlacklist() {
  console.log('\n🚫 Migrating blacklist...');
  
  const data = loadJSON('blacklist.json');
  if (!data?.assets?.length) {
    console.log('   No blacklist to migrate');
    return 0;
  }
  
  const rows = data.assets.map(asset => ({
    asset,
    reason: data.reasons?.[asset] || null
  }));
  
  const { error } = await supabase
    .from('blacklist')
    .upsert(rows, { onConflict: 'asset' });
  
  if (error) {
    console.error('   ❌ Error:', error.message);
    return 0;
  }
  
  console.log(`   ✅ Migrated ${rows.length} blacklisted assets`);
  return rows.length;
}

async function main() {
  console.log('🚀 Supabase Migration Tool');
  console.log('==========================');
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  
  // Test connection
  console.log('\n🔌 Testing connection...');
  const { data, error } = await supabase.from('stats').select('id').limit(1);
  if (error) {
    console.error('❌ Connection failed:', error.message);
    console.log('\nMake sure you have run the schema.sql in Supabase SQL Editor first!');
    process.exit(1);
  }
  console.log('   ✅ Connection successful');
  
  // Run migrations
  const results = {
    watchlist: await migrateWatchlist(),
    trades: await migrateTrades(),
    history: await migrateHistory(),
    blacklist: await migrateBlacklist()
  };
  
  // Summary
  console.log('\n==========================');
  console.log('📊 Migration Summary');
  console.log('==========================');
  console.log(`   Watchlist:  ${results.watchlist} pairs`);
  console.log(`   Trades:     ${results.trades} active`);
  console.log(`   History:    ${results.history} records`);
  console.log(`   Blacklist:  ${results.blacklist} assets`);
  console.log('\n✅ Migration complete!');
  console.log('\nYou can now set SUPABASE_URL and SUPABASE_KEY in Railway');
  console.log('and the server will use Supabase instead of JSON files.');
}

main().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});

