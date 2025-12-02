#!/usr/bin/env node
/**
 * Migrate manual trades from active_trades.json to Supabase
 * Run once: node scripts/migrateManualTrades.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function migrate() {
  const filePath = path.join(__dirname, '../config/active_trades.json');
  
  if (!fs.existsSync(filePath)) {
    console.log('No active_trades.json found');
    return;
  }
  
  const trades = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const pairs = Object.keys(trades);
  
  if (pairs.length === 0) {
    console.log('No trades to migrate');
    return;
  }
  
  console.log(`Migrating ${pairs.length} manual trade(s)...`);
  
  for (const pairKey of pairs) {
    const t = trades[pairKey];
    const pair = pairKey.replace('_', '/');
    const [asset1, asset2] = pairKey.split('_');
    
    const dir = t.direction || 'long';
    const weight1 = (t.weight1 || 0.5) * 100;
    const weight2 = (t.weight2 || 0.5) * 100;
    
    const dbTrade = {
      pair,
      asset1,
      asset2,
      sector: 'Manual',
      entry_time: t.entryDate || new Date().toISOString(),
      entry_z_score: 0,
      entry_price1: t.entryPrice1,
      entry_price2: t.entryPrice2,
      direction: dir,
      long_asset: dir === 'long' ? asset1 : asset2,
      short_asset: dir === 'long' ? asset2 : asset1,
      long_weight: dir === 'long' ? weight1 : weight2,
      short_weight: dir === 'long' ? weight2 : weight1,
      long_entry_price: dir === 'long' ? t.entryPrice1 : t.entryPrice2,
      short_entry_price: dir === 'long' ? t.entryPrice2 : t.entryPrice1,
      correlation: 0,
      beta: 1,
      half_life: 0,
      source: 'manual'
    };
    
    const { error } = await supabase
      .from('trades')
      .upsert(dbTrade, { onConflict: 'pair' });
    
    if (error) {
      console.error(`Error migrating ${pair}:`, error.message);
    } else {
      console.log(`✅ Migrated ${pair}`);
    }
  }
  
  console.log('\nDone! You can now delete config/active_trades.json');
}

migrate().catch(console.error);

