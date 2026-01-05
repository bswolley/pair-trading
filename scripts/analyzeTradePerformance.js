#!/usr/bin/env node

/**
 * Comprehensive trade performance analysis
 * Analyzes trade_history to understand what works and what doesn't
 */

const { getClient } = require('../server/db/supabase');

async function main() {
  const client = getClient();
  if (!client) {
    console.log('❌ Supabase not configured');
    process.exit(1);
  }

  console.log('=== COMPREHENSIVE TRADE PERFORMANCE ANALYSIS ===\n');

  // Get all completed trades
  const { data: trades, error } = await client
    .from('trade_history')
    .select('*')
    .order('exit_time', { ascending: false });

  if (error) {
    console.error('Error fetching trades:', error);
    process.exit(1);
  }

  console.log(`Total trades analyzed: ${trades.length}\n`);

  // ============================================
  // 1. OVERALL PERFORMANCE
  // ============================================
  console.log('=== 1. OVERALL PERFORMANCE ===\n');

  const pnls = trades.map(t => t.total_pnl).filter(p => p !== null);
  const winners = pnls.filter(p => p > 0);
  const losers = pnls.filter(p => p < 0);
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
  const avgPnl = totalPnl / pnls.length;
  const winRate = (winners.length / pnls.length * 100);
  const avgWin = winners.length > 0 ? winners.reduce((a,b) => a+b, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((a,b) => a+b, 0) / losers.length : 0;
  const profitFactor = avgWin !== 0 && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  console.log(`Total PnL: ${totalPnl.toFixed(2)}%`);
  console.log(`Average PnL: ${avgPnl.toFixed(2)}%`);
  console.log(`Win Rate: ${winRate.toFixed(1)}% (${winners.length}W / ${losers.length}L)`);
  console.log(`Average Winner: ${avgWin.toFixed(2)}%`);
  console.log(`Average Loser: ${avgLoss.toFixed(2)}%`);
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`Best Trade: ${Math.max(...pnls).toFixed(2)}%`);
  console.log(`Worst Trade: ${Math.min(...pnls).toFixed(2)}%`);

  // ============================================
  // 2. EXIT REASON ANALYSIS
  // ============================================
  console.log('\n\n=== 2. EXIT REASON ANALYSIS ===\n');

  const exitReasons = {};
  trades.forEach(t => {
    const reason = t.exit_reason || 'UNKNOWN';
    if (!exitReasons[reason]) {
      exitReasons[reason] = { trades: [], pnls: [] };
    }
    exitReasons[reason].trades.push(t);
    if (t.total_pnl !== null) exitReasons[reason].pnls.push(t.total_pnl);
  });

  // Sort by frequency
  const sortedReasons = Object.entries(exitReasons).sort((a, b) => b[1].trades.length - a[1].trades.length);

  console.log('Reason              Count    Avg PnL    Win Rate    Total PnL');
  console.log('─────────────────   ─────    ────────   ─────────   ─────────');

  sortedReasons.forEach(([reason, data]) => {
    const avgPnl = data.pnls.length > 0 ? data.pnls.reduce((a,b) => a+b, 0) / data.pnls.length : 0;
    const winRate = data.pnls.length > 0 ? (data.pnls.filter(p => p > 0).length / data.pnls.length * 100) : 0;
    const totalPnl = data.pnls.reduce((a,b) => a+b, 0);

    console.log(
      `${reason.padEnd(19)} ${String(data.trades.length).padStart(5)}    ${avgPnl.toFixed(2).padStart(7)}%   ${winRate.toFixed(1).padStart(8)}%   ${totalPnl.toFixed(2).padStart(8)}%`
    );
  });

  // Detailed breakdown of each exit reason
  console.log('\n--- DETAILED EXIT REASON BREAKDOWN ---\n');

  sortedReasons.forEach(([reason, data]) => {
    console.log(`\n${reason} (${data.trades.length} trades):`);

    const avgPnl = data.pnls.reduce((a,b) => a+b, 0) / data.pnls.length;
    const winners = data.pnls.filter(p => p > 0);
    const losers = data.pnls.filter(p => p < 0);

    console.log(`  Avg PnL: ${avgPnl.toFixed(2)}%`);
    console.log(`  Win Rate: ${(winners.length / data.pnls.length * 100).toFixed(1)}%`);
    console.log(`  Avg Winner: ${winners.length > 0 ? (winners.reduce((a,b) => a+b, 0) / winners.length).toFixed(2) : 'N/A'}%`);
    console.log(`  Avg Loser: ${losers.length > 0 ? (losers.reduce((a,b) => a+b, 0) / losers.length).toFixed(2) : 'N/A'}%`);

    // Show sample trades
    console.log('  Sample trades:');
    data.trades.slice(0, 3).forEach(t => {
      console.log(`    - ${t.pair}: ${t.total_pnl?.toFixed(2)}% (${t.days_in_trade?.toFixed(1)}d)`);
    });
  });

  // ============================================
  // 3. ENTRY METRICS ANALYSIS
  // ============================================
  console.log('\n\n=== 3. ENTRY METRICS ANALYSIS ===\n');

  // Entry Z-score vs Performance
  console.log('--- Entry Z-Score Impact ---');
  const zScoreBuckets = {
    '1.5-2.0': [],
    '2.0-2.5': [],
    '2.5-3.0': [],
    '3.0+': []
  };

  trades.forEach(t => {
    if (t.entry_z_score === null || t.total_pnl === null) return;
    const z = Math.abs(t.entry_z_score);
    if (z >= 3.0) zScoreBuckets['3.0+'].push(t.total_pnl);
    else if (z >= 2.5) zScoreBuckets['2.5-3.0'].push(t.total_pnl);
    else if (z >= 2.0) zScoreBuckets['2.0-2.5'].push(t.total_pnl);
    else if (z >= 1.5) zScoreBuckets['1.5-2.0'].push(t.total_pnl);
  });

  console.log('\nZ-Score Range   Count   Avg PnL    Win Rate');
  console.log('────────────    ─────   ────────   ─────────');
  Object.entries(zScoreBuckets).forEach(([range, pnls]) => {
    if (pnls.length === 0) return;
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    console.log(`${range.padEnd(15)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  });

  // Hurst at entry vs Performance
  console.log('\n--- Entry Hurst Impact ---');
  const hurstBuckets = {
    '< 0.35 (excellent)': [],
    '0.35-0.40': [],
    '0.40-0.45': [],
    '0.45-0.50': [],
    '≥ 0.50 (trending)': []
  };

  trades.forEach(t => {
    if (t.hurst === null || t.total_pnl === null) return;
    const h = t.hurst;
    if (h >= 0.5) hurstBuckets['≥ 0.50 (trending)'].push(t.total_pnl);
    else if (h >= 0.45) hurstBuckets['0.45-0.50'].push(t.total_pnl);
    else if (h >= 0.40) hurstBuckets['0.40-0.45'].push(t.total_pnl);
    else if (h >= 0.35) hurstBuckets['0.35-0.40'].push(t.total_pnl);
    else hurstBuckets['< 0.35 (excellent)'].push(t.total_pnl);
  });

  console.log('\nHurst Range         Count   Avg PnL    Win Rate');
  console.log('─────────────────   ─────   ────────   ─────────');
  Object.entries(hurstBuckets).forEach(([range, pnls]) => {
    if (pnls.length === 0) return;
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    console.log(`${range.padEnd(19)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  });

  // ============================================
  // 4. HOLDING PERIOD ANALYSIS
  // ============================================
  console.log('\n\n=== 4. HOLDING PERIOD ANALYSIS ===\n');

  const holdingBuckets = {
    '< 1 day': [],
    '1-3 days': [],
    '3-7 days': [],
    '7-14 days': [],
    '14+ days': []
  };

  trades.forEach(t => {
    if (t.days_in_trade === null || t.total_pnl === null) return;
    const days = t.days_in_trade;
    if (days >= 14) holdingBuckets['14+ days'].push(t.total_pnl);
    else if (days >= 7) holdingBuckets['7-14 days'].push(t.total_pnl);
    else if (days >= 3) holdingBuckets['3-7 days'].push(t.total_pnl);
    else if (days >= 1) holdingBuckets['1-3 days'].push(t.total_pnl);
    else holdingBuckets['< 1 day'].push(t.total_pnl);
  });

  console.log('Hold Period     Count   Avg PnL    Win Rate');
  console.log('─────────────   ─────   ────────   ─────────');
  Object.entries(holdingBuckets).forEach(([range, pnls]) => {
    if (pnls.length === 0) return;
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    console.log(`${range.padEnd(15)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  });

  // ============================================
  // 5. SECTOR ANALYSIS
  // ============================================
  console.log('\n\n=== 5. SECTOR ANALYSIS ===\n');

  const sectors = {};
  trades.forEach(t => {
    const sector = t.sector || 'UNKNOWN';
    if (!sectors[sector]) {
      sectors[sector] = [];
    }
    if (t.total_pnl !== null) sectors[sector].push(t.total_pnl);
  });

  const sortedSectors = Object.entries(sectors).sort((a, b) => b[1].length - a[1].length);

  console.log('Sector                 Count   Avg PnL    Win Rate    Total PnL');
  console.log('────────────────────   ─────   ────────   ─────────   ─────────');
  sortedSectors.forEach(([sector, pnls]) => {
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    const total = pnls.reduce((a,b) => a+b, 0);
    console.log(
      `${sector.padEnd(22)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%   ${total.toFixed(2).padStart(8)}%`
    );
  });

  // ============================================
  // 6. BEST AND WORST PERFORMERS
  // ============================================
  console.log('\n\n=== 6. BEST PERFORMERS ===\n');

  const sortedByPnl = [...trades]
    .filter(t => t.total_pnl !== null)
    .sort((a, b) => b.total_pnl - a.total_pnl);

  console.log('Top 10 Winners:');
  sortedByPnl.slice(0, 10).forEach((t, i) => {
    console.log(
      `${i+1}. ${t.pair.padEnd(20)} ${t.total_pnl.toFixed(2).padStart(6)}%  (${t.days_in_trade?.toFixed(1)}d, ${t.exit_reason})`
    );
  });

  console.log('\n=== 7. WORST PERFORMERS ===\n');

  console.log('Top 10 Losers:');
  sortedByPnl.slice(-10).reverse().forEach((t, i) => {
    console.log(
      `${i+1}. ${t.pair.padEnd(20)} ${t.total_pnl.toFixed(2).padStart(6)}%  (${t.days_in_trade?.toFixed(1)}d, ${t.exit_reason})`
    );
  });

  // ============================================
  // 8. KEY INSIGHTS & RECOMMENDATIONS
  // ============================================
  console.log('\n\n=== 8. KEY INSIGHTS ===\n');

  // Compare exit reasons
  const targetPnls = exitReasons['TARGET']?.pnls || [];
  const stopLossPnls = exitReasons['STOP_LOSS']?.pnls || [];
  const hurstPnls = exitReasons['HURST_REGIME']?.pnls || [];
  const breakdownPnls = exitReasons['BREAKDOWN']?.pnls || [];

  console.log('Exit Strategy Effectiveness:');
  if (targetPnls.length > 0) {
    const avgTarget = targetPnls.reduce((a,b) => a+b, 0) / targetPnls.length;
    console.log(`  ✅ TARGET exits: ${avgTarget.toFixed(2)}% avg (${targetPnls.length} trades)`);
  }
  if (stopLossPnls.length > 0) {
    const avgStop = stopLossPnls.reduce((a,b) => a+b, 0) / stopLossPnls.length;
    console.log(`  🛑 STOP_LOSS exits: ${avgStop.toFixed(2)}% avg (${stopLossPnls.length} trades)`);
  }
  if (hurstPnls.length > 0) {
    const avgHurst = hurstPnls.reduce((a,b) => a+b, 0) / hurstPnls.length;
    console.log(`  📈 HURST_REGIME exits: ${avgHurst.toFixed(2)}% avg (${hurstPnls.length} trades)`);
  }
  if (breakdownPnls.length > 0) {
    const avgBreakdown = breakdownPnls.reduce((a,b) => a+b, 0) / breakdownPnls.length;
    console.log(`  💔 BREAKDOWN exits: ${avgBreakdown.toFixed(2)}% avg (${breakdownPnls.length} trades)`);
  }

  console.log('\n✓ Analysis complete');
}

main().catch(console.error);
