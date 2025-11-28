#!/usr/bin/env node

/**
 * Show History - Display completed trades
 * 
 * Usage: node scripts/showHistory.js
 */

const fs = require('fs');
const path = require('path');

function loadTradeHistory() {
  const filepath = path.join(__dirname, '../config/trade_history.json');
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }
  return { trades: [], stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0 } };
}

function main() {
  console.log('\n📜 Trade History\n');
  
  const history = loadTradeHistory();
  
  if (history.trades.length === 0) {
    console.log('  No completed trades yet.\n');
    return;
  }
  
  // Stats summary
  const stats = history.stats;
  const statsEmoji = stats.totalPnL >= 0 ? '🟢' : '🔴';
  console.log('  📈 Overall Stats');
  console.log(`  ├ Total Trades: ${stats.totalTrades}`);
  console.log(`  ├ Win Rate: ${stats.winRate || 0}% (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  ├ Avg P&L: ${stats.avgPnL >= 0 ? '+' : ''}${stats.avgPnL || 0}%`);
  console.log(`  └ ${statsEmoji} Cumulative P&L: ${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}%`);
  
  console.log('\n' + '─'.repeat(80) + '\n');
  console.log('  Recent Trades (newest first)\n');
  
  // Show trades (newest first)
  const recentTrades = [...history.trades].reverse().slice(0, 20);
  
  for (const trade of recentTrades) {
    const pnlEmoji = trade.totalPnL >= 0 ? '🟢' : '🔴';
    const pnlSign = trade.totalPnL >= 0 ? '+' : '';
    const entryDate = new Date(trade.entryTime).toLocaleDateString();
    const exitDate = new Date(trade.exitTime).toLocaleDateString();
    
    console.log(`  ${pnlEmoji} ${trade.pair}`);
    console.log(`    ├ ${entryDate} → ${exitDate} (${trade.daysInTrade}d)`);
    console.log(`    ├ Z: ${trade.entryZScore.toFixed(2)} → ${trade.exitZScore.toFixed(2)}`);
    console.log(`    └ P&L: ${pnlSign}${trade.totalPnL.toFixed(2)}%`);
    console.log('');
  }
  
  if (history.trades.length > 20) {
    console.log(`  ... and ${history.trades.length - 20} more trades`);
  }
}

main();

