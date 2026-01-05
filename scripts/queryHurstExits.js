#!/usr/bin/env node

/**
 * Query production database for trades closed due to Hurst regime exits
 */

const { getClient } = require('../server/db/supabase');

async function main() {
  const client = getClient();
  if (!client) {
    console.log('❌ Supabase not configured');
    process.exit(1);
  }

  console.log('=== HURST EXIT THRESHOLD: 0.55 ===\n');

  // Query 1: Trades exited due to Hurst
  console.log('Querying trades closed due to Hurst regime exit...\n');
  const { data: hurstExits, error: error1 } = await client
    .from('trade_history')
    .select('pair, entry_time, exit_time, hurst, exit_hurst, exit_reason, total_pnl, days_in_trade')
    .or('exit_reason.ilike.%Hurst%,exit_reason.ilike.%regime%')
    .order('exit_time', { ascending: false });

  if (error1) {
    console.error('Error:', error1);
  } else if (hurstExits.length === 0) {
    console.log('No trades found with Hurst-related exits.');
  } else {
    console.log(`Found ${hurstExits.length} trades closed due to Hurst regime shift:\n`);
    hurstExits.forEach((t, i) => {
      console.log(`${i+1}. ${t.pair}`);
      console.log(`   Entry H: ${t.hurst?.toFixed(3) || 'N/A'} → Exit H: ${t.exit_hurst?.toFixed(3) || 'N/A'}`);
      console.log(`   Reason: ${t.exit_reason}`);
      console.log(`   PnL: ${t.total_pnl?.toFixed(2)}% | Hold: ${t.days_in_trade?.toFixed(1)} days`);
      console.log('');
    });

    const pnls = hurstExits.map(t => t.total_pnl).filter(p => p != null);
    const avgPnl = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    console.log(`Stats: Avg PnL = ${avgPnl.toFixed(2)}%, Win rate = ${(pnls.filter(p => p > 0).length / pnls.length * 100).toFixed(1)}%\n`);
  }

  // Query 2: Active trades with current Hurst
  console.log('\n=== ACTIVE TRADES ===\n');
  const { data: active, error: error2 } = await client
    .from('trades')
    .select('pair, hurst, current_hurst, current_pnl, current_z')
    .order('entry_time', { ascending: false });

  if (error2) {
    console.error('Error:', error2);
  } else if (active.length === 0) {
    console.log('No active trades.');
  } else {
    console.log(`${active.length} active trades:\n`);
    active.forEach(t => {
      let status = '✅';
      if (t.current_hurst >= 0.55) status = '🔴 TRENDING';
      else if (t.current_hurst >= 0.5) status = '🟡 WARNING';
      console.log(`${t.pair.padEnd(20)} Entry H: ${(t.hurst?.toFixed(3) || 'N/A').padStart(5)} → Current: ${(t.current_hurst?.toFixed(3) || 'N/A').padStart(5)} ${status} | PnL: ${t.current_pnl?.toFixed(2)}%`);
    });
  }

  console.log('\n✓ Done');
}

main().catch(console.error);
