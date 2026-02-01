#!/usr/bin/env node

const activeAssets = new Set(['LTC', 'BERA', 'XRP', 'WLD', 'kBONK', 'DOGE', 'kFLOKI', 'kNEIRO']);

const watchlist = [
  ['kBONK/POPCAT', 1, 2.61, 0.422, 0.861],
  ['XRP/FARTCOIN', 1, 2.91, 0.321, 0.703],
  ['kBONK/DOGE', 1, 2.6431, 0.27, 0.7489],
  ['kFLOKI/kNEIRO', 1, 2.9356, 0.502, 0.8621],
  ['kBONK/BRETT', 1, 2.6, 0.382, 0.942],
  ['LTC/BERA', 1, 2.54, 0.379, 0.681],
  ['XRP/WLD', 1, 3.255, 0.465, 0.7776],
  ['FARTCOIN/ONDO', 1, 2.22, 0.363, 0.771],
  ['FARTCOIN/LINK', 1, 2.41, 0.226, 0.702],
  ['SOL/ENA', 0.96, 1.92, 0.366, 0.738],
  ['BNB/LINK', 0.92, 1.84, 0.303, 0.769],
  ['NEAR/LTC', 0.9, 2.25, 0.405, 0.891],
  ['FARTCOIN/MOODENG', 0.9, 2.25, 0.22, 0.685],
  ['AVAX/LTC', 0.81, 2.02, 0.294, 0.836]
];

console.log('Active Trades (4): LTC/BERA, XRP/WLD, kBONK/DOGE, kFLOKI/kNEIRO');
console.log('Active Assets: ' + Array.from(activeAssets).join(', '));
console.log('\nWatchlist Pairs 80%+ of Entry Threshold:\n');
console.log('Pair                  Signal   Z-Score   Hurst   Corr    Status');
console.log('───────────────────   ──────   ───────   ─────   ─────   ──────────────────────');

let eligibleCount = 0;

watchlist.forEach(([pair, signal, zScore, hurst, corr]) => {
  const [a1, a2] = pair.split('/');
  const hasOverlap = activeAssets.has(a1) || activeAssets.has(a2);
  const blocked = [];
  if (activeAssets.has(a1)) blocked.push(a1);
  if (activeAssets.has(a2)) blocked.push(a2);

  let status;
  if (hasOverlap) {
    status = `❌ Blocked (${blocked.join(', ')})`;
  } else {
    status = '🟢 ELIGIBLE';
    eligibleCount++;
  }

  console.log(
    `${pair.padEnd(21)} ${(signal * 100).toFixed(0).padStart(6)}%  ${zScore.toFixed(2).padStart(7)}   ${hurst.toFixed(2).padStart(5)}  ${corr.toFixed(2).padStart(5)}   ${status}`
  );
});

console.log('\n' + '='.repeat(80));
if (eligibleCount === 0) {
  console.log('\n⚠️  NO ELIGIBLE PAIRS - All top pairs have asset overlap with active trades');
  console.log('\nThis is why the 5th slot remains empty despite having capacity.');
  console.log('\nSolutions:');
  console.log('  1. Wait for one trade to exit, freeing up assets');
  console.log('  2. Manually close a losing trade to open up asset slots');
  console.log('  3. Add more diverse asset pairs to watchlist');
} else {
  console.log(`\n✓ Found ${eligibleCount} eligible pair(s)`);
}
