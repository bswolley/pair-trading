const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function fixStats() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
  
  // Get all history trades and sum PnL
  const { data: trades, error } = await supabase
    .from('trade_history')
    .select('total_pnl');
  
  if (error) {
    console.error('Error fetching trades:', error);
    return;
  }
  
  const totalPnL = trades.reduce((sum, t) => sum + (t.total_pnl || 0), 0);
  const wins = trades.filter(t => (t.total_pnl || 0) >= 0).length;
  const losses = trades.filter(t => (t.total_pnl || 0) < 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
  console.log('Calculated stats:');
  console.log(`  Total Trades: ${totalTrades}`);
  console.log(`  Wins: ${wins}, Losses: ${losses}`);
  console.log(`  Total P&L: ${totalPnL.toFixed(4)}%`);
  console.log(`  Win Rate: ${winRate.toFixed(2)}%`);
  
  // Update stats table
  const { error: updateError } = await supabase
    .from('stats')
    .update({
      total_trades: totalTrades,
      wins: wins,
      losses: losses,
      total_pnl: totalPnL,
      win_rate: winRate
    })
    .eq('id', 1);
  
  if (updateError) {
    console.error('Error updating stats:', updateError);
    return;
  }
  
  console.log('\n✅ Stats fixed!');
}

fixStats();
