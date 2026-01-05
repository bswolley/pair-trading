#!/usr/bin/env node

/**
 * Simulate what performance would have been with new entry rules
 * - Z-Score >= 2.5 (was 2.0)
 * - Hurst < 0.45 (was < 0.5)
 * - Time stop at 1.5x half-life (was 2x)
 */

const { getClient } = require('../server/db/supabase');

async function main() {
  const client = getClient();
  if (!client) {
    console.log('❌ Supabase not configured');
    process.exit(1);
  }

  console.log('=== SIMULATING NEW RULES ON HISTORICAL TRADES ===\n');

  // Get all completed trades
  const { data: trades, error } = await client
    .from('trade_history')
    .select('*')
    .order('exit_time', { ascending: false });

  if (error) {
    console.error('Error fetching trades:', error);
    process.exit(1);
  }

  console.log(`Total historical trades: ${trades.length}\n`);

  // Simulate new entry rules
  const OLD_MIN_Z = 1.5;
  const NEW_MIN_Z = 2.5;
  const OLD_MAX_HURST = 0.5;
  const NEW_MAX_HURST = 0.45;
  const OLD_HL_MULTIPLIER = 2;
  const NEW_HL_MULTIPLIER = 1.5;

  let tradesTooLowZ = 0;
  let tradesTooHighHurst = 0;
  let tradesWouldEnter = [];
  let tradesWouldNotEnter = [];

  trades.forEach(t => {
    let canEnter = true;
    let blockReasons = [];

    // Check Z-score
    const entryZ = Math.abs(t.entry_z_score);
    if (entryZ < NEW_MIN_Z && entryZ >= OLD_MIN_Z) {
      canEnter = false;
      blockReasons.push(`Z=${entryZ.toFixed(2)} < 2.5`);
      tradesTooLowZ++;
    }

    // Check Hurst
    if (t.hurst !== null && t.hurst >= NEW_MAX_HURST && t.hurst < OLD_MAX_HURST) {
      canEnter = false;
      blockReasons.push(`H=${t.hurst.toFixed(3)} >= 0.45`);
      tradesTooHighHurst++;
    }

    if (canEnter) {
      tradesWouldEnter.push(t);
    } else {
      tradesWouldNotEnter.push({ trade: t, reasons: blockReasons });
    }
  });

  console.log('=== ENTRY FILTER IMPACT ===\n');
  console.log(`Would have entered: ${tradesWouldEnter.length} trades`);
  console.log(`Would NOT enter: ${tradesWouldNotEnter.length} trades`);
  console.log(`  - Blocked by Z < 2.5: ${tradesTooLowZ}`);
  console.log(`  - Blocked by H >= 0.45: ${tradesTooHighHurst}`);
  console.log('');

  // Calculate performance of trades that would NOT have entered
  const blockedPnls = tradesWouldNotEnter
    .map(t => t.trade.total_pnl)
    .filter(p => p !== null);

  if (blockedPnls.length > 0) {
    const blockedAvg = blockedPnls.reduce((a,b) => a+b, 0) / blockedPnls.length;
    const blockedWinners = blockedPnls.filter(p => p > 0).length;
    const blockedWinRate = (blockedWinners / blockedPnls.length * 100);
    const blockedTotal = blockedPnls.reduce((a,b) => a+b, 0);

    console.log('=== BLOCKED TRADES PERFORMANCE (what we avoided) ===\n');
    console.log(`Average PnL: ${blockedAvg.toFixed(2)}%`);
    console.log(`Win Rate: ${blockedWinRate.toFixed(1)}%`);
    console.log(`Total PnL: ${blockedTotal.toFixed(2)}%`);
    console.log('');

    console.log('Sample blocked trades:');
    tradesWouldNotEnter.slice(0, 10).forEach((item, i) => {
      const t = item.trade;
      console.log(`  ${i+1}. ${t.pair}: ${t.total_pnl?.toFixed(2)}% (${item.reasons.join(', ')})`);
    });
    console.log('');
  }

  // Calculate performance of trades that WOULD have entered
  const allowedPnls = tradesWouldEnter
    .map(t => t.total_pnl)
    .filter(p => p !== null);

  const allowedAvg = allowedPnls.reduce((a,b) => a+b, 0) / allowedPnls.length;
  const allowedWinners = allowedPnls.filter(p => p > 0).length;
  const allowedWinRate = (allowedWinners / allowedPnls.length * 100);
  const allowedTotal = allowedPnls.reduce((a,b) => a+b, 0);

  console.log('=== ALLOWED TRADES PERFORMANCE (what we keep) ===\n');
  console.log(`Average PnL: ${allowedAvg.toFixed(2)}%`);
  console.log(`Win Rate: ${allowedWinRate.toFixed(1)}%`);
  console.log(`Total PnL: ${allowedTotal.toFixed(2)}%`);
  console.log('');

  // Simulate earlier time stops
  console.log('=== TIME STOP SIMULATION ===\n');

  let timeStopEarlier = 0;
  let savedLosses = 0;

  tradesWouldEnter.forEach(t => {
    if (t.exit_reason === 'TIME_STOP' && t.half_life && t.days_in_trade) {
      const oldTimeStop = t.half_life * OLD_HL_MULTIPLIER;
      const newTimeStop = t.half_life * NEW_HL_MULTIPLIER;

      // If trade exited after new time stop but before old time stop
      if (t.days_in_trade > newTimeStop && t.days_in_trade <= oldTimeStop) {
        timeStopEarlier++;
        // Assume PnL would be 20% better if exited earlier (conservative estimate)
        if (t.total_pnl < 0) {
          savedLosses += Math.abs(t.total_pnl) * 0.2;
        }
      }
    }
  });

  console.log(`Trades that would exit earlier: ${timeStopEarlier}`);
  console.log(`Estimated saved losses: ~${savedLosses.toFixed(2)}% (conservative)`);
  console.log('');

  // Overall comparison
  console.log('=== OVERALL COMPARISON ===\n');

  const oldPnls = trades.map(t => t.total_pnl).filter(p => p !== null);
  const oldAvg = oldPnls.reduce((a,b) => a+b, 0) / oldPnls.length;
  const oldTotal = oldPnls.reduce((a,b) => a+b, 0);
  const oldWinRate = (oldPnls.filter(p => p > 0).length / oldPnls.length * 100);

  console.log('OLD RULES:');
  console.log(`  Trades: ${oldPnls.length}`);
  console.log(`  Avg PnL: ${oldAvg.toFixed(2)}%`);
  console.log(`  Win Rate: ${oldWinRate.toFixed(1)}%`);
  console.log(`  Total PnL: ${oldTotal.toFixed(2)}%`);
  console.log('');

  console.log('NEW RULES (entry filter only):');
  console.log(`  Trades: ${allowedPnls.length}`);
  console.log(`  Avg PnL: ${allowedAvg.toFixed(2)}%`);
  console.log(`  Win Rate: ${allowedWinRate.toFixed(1)}%`);
  console.log(`  Total PnL: ${allowedTotal.toFixed(2)}%`);
  console.log('');

  const estimatedImprovement = allowedTotal + savedLosses - oldTotal;
  console.log('NEW RULES (with earlier time stops):');
  console.log(`  Estimated Total PnL: ${(allowedTotal + savedLosses).toFixed(2)}%`);
  console.log(`  Improvement: ${estimatedImprovement >= 0 ? '+' : ''}${estimatedImprovement.toFixed(2)}%`);
  console.log('');

  // Improvement percentage
  const improvementPct = ((allowedTotal + savedLosses) / oldTotal - 1) * 100;
  console.log(`📊 Estimated Performance Improvement: ${improvementPct >= 0 ? '+' : ''}${improvementPct.toFixed(1)}%`);
  console.log('');

  console.log('✓ Simulation complete');
}

main().catch(console.error);
