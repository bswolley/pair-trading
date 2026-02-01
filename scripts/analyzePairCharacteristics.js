#!/usr/bin/env node

/**
 * Analyze which pair characteristics lead to better mean-reversion performance
 * Help identify the "best" pairs before entering trades
 */

const { getClient } = require('../server/db/supabase');

async function main() {
  const client = getClient();
  if (!client) {
    console.log('❌ Supabase not configured');
    process.exit(1);
  }

  console.log('=== PAIR CHARACTERISTICS ANALYSIS ===\n');

  // Get all completed trades
  const { data: trades, error } = await client
    .from('trade_history')
    .select('*')
    .order('exit_time', { ascending: false });

  if (error) {
    console.error('Error fetching trades:', error);
    process.exit(1);
  }

  console.log(`Analyzing ${trades.length} completed trades...\n`);

  // ============================================
  // 1. INDIVIDUAL PAIR PERFORMANCE
  // ============================================
  console.log('=== 1. INDIVIDUAL PAIR PERFORMANCE ===\n');

  const pairStats = {};
  trades.forEach(t => {
    if (!pairStats[t.pair]) {
      pairStats[t.pair] = { trades: [], pnls: [], sectors: new Set() };
    }
    pairStats[t.pair].trades.push(t);
    if (t.total_pnl !== null) pairStats[t.pair].pnls.push(t.total_pnl);
    if (t.sector) pairStats[t.pair].sectors.add(t.sector);
  });

  // Sort by number of trades
  const sortedPairs = Object.entries(pairStats)
    .filter(([_, stats]) => stats.trades.length >= 2) // Min 2 trades for reliability
    .sort((a, b) => b[1].trades.length - a[1].trades.length);

  console.log('Pairs with 2+ trades:\n');
  console.log('Pair                Trades   Avg PnL    Win Rate   Total PnL   Sector');
  console.log('─────────────────   ──────   ────────   ─────────  ──────────  ──────────');

  sortedPairs.forEach(([pair, stats]) => {
    const avg = stats.pnls.reduce((a,b) => a+b, 0) / stats.pnls.length;
    const winRate = (stats.pnls.filter(p => p > 0).length / stats.pnls.length * 100);
    const total = stats.pnls.reduce((a,b) => a+b, 0);
    const sector = Array.from(stats.sectors).join(',');

    console.log(
      `${pair.padEnd(19)} ${String(stats.trades.length).padStart(6)}   ${avg.toFixed(2).padStart(7)}%   ${winRate.toFixed(1).padStart(8)}%  ${total.toFixed(2).padStart(9)}%  ${sector}`
    );
  });

  // ============================================
  // 2. ASSET-LEVEL PERFORMANCE
  // ============================================
  console.log('\n\n=== 2. INDIVIDUAL ASSET PERFORMANCE ===\n');
  console.log('Which assets make the best pairs?\n');

  const assetStats = {};
  trades.forEach(t => {
    [t.asset1, t.asset2].forEach(asset => {
      if (!assetStats[asset]) {
        assetStats[asset] = { count: 0, pnls: [], longCount: 0, shortCount: 0 };
      }
      assetStats[asset].count++;
      if (t.total_pnl !== null) assetStats[asset].pnls.push(t.total_pnl);

      if (t.long_asset === asset) assetStats[asset].longCount++;
      if (t.short_asset === asset) assetStats[asset].shortCount++;
    });
  });

  const sortedAssets = Object.entries(assetStats)
    .filter(([_, stats]) => stats.count >= 3)
    .sort((a, b) => {
      const aAvg = a[1].pnls.reduce((sum, p) => sum + p, 0) / a[1].pnls.length;
      const bAvg = b[1].pnls.reduce((sum, p) => sum + p, 0) / b[1].pnls.length;
      return bAvg - aAvg;
    });

  console.log('Assets with 3+ trades (sorted by avg PnL):\n');
  console.log('Asset     Trades   Avg PnL    Win Rate   Long/Short');
  console.log('────────  ──────   ────────   ─────────  ──────────');

  sortedAssets.slice(0, 20).forEach(([asset, stats]) => {
    const avg = stats.pnls.reduce((a,b) => a+b, 0) / stats.pnls.length;
    const winRate = (stats.pnls.filter(p => p > 0).length / stats.pnls.length * 100);

    console.log(
      `${asset.padEnd(9)} ${String(stats.count).padStart(6)}   ${avg.toFixed(2).padStart(7)}%   ${winRate.toFixed(1).padStart(8)}%  ${stats.longCount}L/${stats.shortCount}S`
    );
  });

  // ============================================
  // 3. CORRELATION AT ENTRY
  // ============================================
  console.log('\n\n=== 3. ENTRY CORRELATION IMPACT ===\n');

  const corrBuckets = {
    '0.60-0.70': [],
    '0.70-0.80': [],
    '0.80-0.90': [],
    '0.90+': []
  };

  trades.forEach(t => {
    if (t.correlation === null || t.total_pnl === null) return;
    const corr = t.correlation;
    if (corr >= 0.9) corrBuckets['0.90+'].push(t.total_pnl);
    else if (corr >= 0.8) corrBuckets['0.80-0.90'].push(t.total_pnl);
    else if (corr >= 0.7) corrBuckets['0.70-0.80'].push(t.total_pnl);
    else if (corr >= 0.6) corrBuckets['0.60-0.70'].push(t.total_pnl);
  });

  console.log('Correlation Range   Count   Avg PnL    Win Rate');
  console.log('─────────────────   ─────   ────────   ─────────');
  Object.entries(corrBuckets).forEach(([range, pnls]) => {
    if (pnls.length === 0) return;
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    console.log(`${range.padEnd(19)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  });

  // ============================================
  // 4. HALF-LIFE AT ENTRY
  // ============================================
  console.log('\n\n=== 4. HALF-LIFE AT ENTRY IMPACT ===\n');
  console.log('Do faster-reverting pairs perform better?\n');

  const hlBuckets = {
    '< 2 days (fast)': [],
    '2-5 days': [],
    '5-10 days': [],
    '10+ days (slow)': []
  };

  trades.forEach(t => {
    if (t.half_life === null || t.total_pnl === null) return;
    const hl = t.half_life;
    if (hl >= 10) hlBuckets['10+ days (slow)'].push(t.total_pnl);
    else if (hl >= 5) hlBuckets['5-10 days'].push(t.total_pnl);
    else if (hl >= 2) hlBuckets['2-5 days'].push(t.total_pnl);
    else hlBuckets['< 2 days (fast)'].push(t.total_pnl);
  });

  console.log('Half-Life Range     Count   Avg PnL    Win Rate');
  console.log('─────────────────   ─────   ────────   ─────────');
  Object.entries(hlBuckets).forEach(([range, pnls]) => {
    if (pnls.length === 0) return;
    const avg = pnls.reduce((a,b) => a+b, 0) / pnls.length;
    const wr = (pnls.filter(p => p > 0).length / pnls.length * 100);
    console.log(`${range.padEnd(19)} ${String(pnls.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  });

  // ============================================
  // 5. COMBINED QUALITY SCORE
  // ============================================
  console.log('\n\n=== 5. HIGH-QUALITY PAIR CHARACTERISTICS ===\n');
  console.log('What makes a "perfect" pair?\n');

  // Define ideal characteristics based on data
  const highQualityTrades = trades.filter(t => {
    if (t.total_pnl === null) return false;

    const hasHighZ = t.entry_z_score && Math.abs(t.entry_z_score) >= 2.5;
    const hasGoodHurst = t.hurst && t.hurst >= 0.35 && t.hurst <= 0.45;
    const hasHighCorr = t.correlation && t.correlation >= 0.75;
    const hasFastHL = t.half_life && t.half_life <= 5;

    return hasHighZ && hasGoodHurst && hasHighCorr && hasFastHL;
  });

  const highQualityPnls = highQualityTrades.map(t => t.total_pnl);
  const allPnls = trades.map(t => t.total_pnl).filter(p => p !== null);

  console.log('HIGH-QUALITY PAIRS (Z≥2.5, H 0.35-0.45, Corr≥0.75, HL≤5d):');
  console.log(`  Count: ${highQualityTrades.length} trades`);
  if (highQualityPnls.length > 0) {
    const avgHQ = highQualityPnls.reduce((a,b) => a+b, 0) / highQualityPnls.length;
    const wrHQ = (highQualityPnls.filter(p => p > 0).length / highQualityPnls.length * 100);
    console.log(`  Avg PnL: ${avgHQ.toFixed(2)}%`);
    console.log(`  Win Rate: ${wrHQ.toFixed(1)}%`);
  }

  console.log('\nALL TRADES:');
  const avgAll = allPnls.reduce((a,b) => a+b, 0) / allPnls.length;
  const wrAll = (allPnls.filter(p => p > 0).length / allPnls.length * 100);
  console.log(`  Count: ${allPnls.length} trades`);
  console.log(`  Avg PnL: ${avgAll.toFixed(2)}%`);
  console.log(`  Win Rate: ${wrAll.toFixed(1)}%`);

  // ============================================
  // 6. SECTOR COMBINATIONS
  // ============================================
  console.log('\n\n=== 6. SAME-SECTOR vs CROSS-SECTOR ===\n');

  const sameSector = [];
  const crossSector = [];

  trades.forEach(t => {
    if (t.total_pnl === null || !t.sector) return;

    if (t.sector.includes('×')) {
      crossSector.push(t.total_pnl);
    } else {
      sameSector.push(t.total_pnl);
    }
  });

  console.log('Type            Count   Avg PnL    Win Rate');
  console.log('──────────────  ─────   ────────   ─────────');

  if (sameSector.length > 0) {
    const avg = sameSector.reduce((a,b) => a+b, 0) / sameSector.length;
    const wr = (sameSector.filter(p => p > 0).length / sameSector.length * 100);
    console.log(`Same Sector     ${String(sameSector.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  }

  if (crossSector.length > 0) {
    const avg = crossSector.reduce((a,b) => a+b, 0) / crossSector.length;
    const wr = (crossSector.filter(p => p > 0).length / crossSector.length * 100);
    console.log(`Cross-Sector    ${String(crossSector.length).padStart(5)}   ${avg.toFixed(2).padStart(7)}%   ${wr.toFixed(1).padStart(8)}%`);
  }

  // ============================================
  // 7. RECOMMENDATIONS
  // ============================================
  console.log('\n\n=== 7. RECOMMENDATIONS FOR PAIR SELECTION ===\n');

  // Find best performing assets
  const topAssets = sortedAssets.slice(0, 10).map(([asset]) => asset);
  console.log('Top 10 Assets (by avg PnL):');
  console.log(`  ${topAssets.join(', ')}`);

  // Find best sectors
  const sectorPerf = {};
  trades.forEach(t => {
    if (!t.sector || t.total_pnl === null) return;
    if (!sectorPerf[t.sector]) sectorPerf[t.sector] = [];
    sectorPerf[t.sector].push(t.total_pnl);
  });

  const topSectors = Object.entries(sectorPerf)
    .filter(([_, pnls]) => pnls.length >= 3)
    .map(([sector, pnls]) => ({
      sector,
      avg: pnls.reduce((a,b) => a+b, 0) / pnls.length,
      count: pnls.length
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  console.log('\nTop 5 Sectors (min 3 trades):');
  topSectors.forEach(s => {
    console.log(`  ${s.sector}: ${s.avg.toFixed(2)}% avg (${s.count} trades)`);
  });

  console.log('\n📊 IDEAL PAIR CHARACTERISTICS:');
  console.log('  ✅ Z-Score: ≥ 2.5 (higher = better edge)');
  console.log('  ✅ Hurst: 0.35-0.45 (sweet spot for mean-reversion)');
  console.log('  ✅ Correlation: ≥ 0.75 (tighter relationship)');
  console.log('  ✅ Half-Life: ≤ 5 days (faster reversion)');
  console.log('  ✅ Sector: Meme, RWA, or within same sector');
  console.log('  ✅ Assets: Focus on proven performers');

  console.log('\n✓ Analysis complete');
}

main().catch(console.error);
