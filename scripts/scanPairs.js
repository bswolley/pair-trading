#!/usr/bin/env node

/**
 * Pairs Scanner - Discovers tradeable pairs from Hyperliquid perpetuals
 * 
 * Steps:
 * 1. Fetch universe (all perps with price, volume, funding, OI)
 * 2. Filter by liquidity (24h volume > $500k, OI > $100k)
 * 3. Group by sector
 * 4. Generate pair combinations within each sector
 * 
 * Usage: node scripts/scanPairs.js [--min-volume 500000] [--min-oi 100000]
 */

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');

// Default thresholds
const DEFAULT_MIN_VOLUME = 500_000;  // $500k 24h volume
const DEFAULT_MIN_OI = 100_000;       // $100k open interest

// Parse CLI args
const args = process.argv.slice(2);
let minVolume = DEFAULT_MIN_VOLUME;
let minOI = DEFAULT_MIN_OI;

const volIdx = args.indexOf('--min-volume');
if (volIdx !== -1 && args[volIdx + 1]) {
  minVolume = parseFloat(args[volIdx + 1]);
}
const oiIdx = args.indexOf('--min-oi');
if (oiIdx !== -1 && args[oiIdx + 1]) {
  minOI = parseFloat(args[oiIdx + 1]);
}

/**
 * Load sector mapping from config
 */
function loadSectorMap() {
  const configPath = path.join(__dirname, '../config/sectors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // Build reverse map: symbol -> sector
  const symbolToSector = {};
  const sectors = config._sectors || [];
  
  for (const sector of sectors) {
    if (config[sector]) {
      for (const symbol of config[sector]) {
        symbolToSector[symbol] = sector;
      }
    }
  }
  
  return { symbolToSector, sectors, config };
}

/**
 * Fetch all perpetuals with market data from Hyperliquid
 */
async function fetchUniverse() {
  const sdk = new Hyperliquid();
  
  // Suppress WebSocket noise
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  
  try {
    await sdk.connect();
    console.log = originalLog;
    console.error = originalError;
    
    // Get metadata (asset info)
    const meta = await sdk.info.perpetuals.getMeta();
    const assetMap = {};
    meta.universe.forEach((asset, idx) => {
      assetMap[idx] = {
        name: asset.name.replace('-PERP', ''),
        szDecimals: asset.szDecimals
      };
    });
    
    // Get market data (prices, volumes, OI, funding)
    const marketData = await sdk.info.perpetuals.getMetaAndAssetCtxs();
    
    const assets = [];
    
    if (marketData && marketData[1]) {
      for (let i = 0; i < marketData[1].length; i++) {
        const ctx = marketData[1][i];
        const info = assetMap[i];
        
        if (!info) continue;
        
        const markPx = parseFloat(ctx.markPx || 0);
        const volume24h = parseFloat(ctx.dayNtlVlm || 0);
        const openInterest = parseFloat(ctx.openInterest || 0) * markPx;
        const funding = parseFloat(ctx.funding || 0);
        
        assets.push({
          symbol: info.name,
          price: markPx,
          volume24h,
          openInterest,
          fundingRate: funding,
          fundingAnnualized: funding * 24 * 365 * 100 // annualized %
        });
      }
    }
    
    // Disconnect
    console.log = () => {};
    console.error = () => {};
    await sdk.disconnect();
    console.log = originalLog;
    console.error = originalError;
    
    return assets;
    
  } catch (error) {
    console.log = originalLog;
    console.error = originalError;
    throw error;
  }
}

/**
 * Filter assets by liquidity thresholds
 */
function filterByLiquidity(assets, minVol, minOI) {
  return assets.filter(a => a.volume24h >= minVol && a.openInterest >= minOI);
}

/**
 * Group assets by sector
 */
function groupBySector(assets, symbolToSector) {
  const groups = {};
  const unmapped = [];
  
  for (const asset of assets) {
    const sector = symbolToSector[asset.symbol];
    if (sector) {
      if (!groups[sector]) groups[sector] = [];
      groups[sector].push(asset);
    } else {
      unmapped.push(asset.symbol);
    }
  }
  
  return { groups, unmapped };
}

/**
 * Generate all pair combinations within each sector
 */
function generatePairs(sectorGroups) {
  const pairs = [];
  
  for (const [sector, assets] of Object.entries(sectorGroups)) {
    if (assets.length < 2) continue;
    
    // Sort by volume (most liquid first)
    assets.sort((a, b) => b.volume24h - a.volume24h);
    
    // Generate all combinations
    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        pairs.push({
          sector,
          asset1: assets[i].symbol,
          asset2: assets[j].symbol,
          volume1: assets[i].volume24h,
          volume2: assets[j].volume24h,
          funding1: assets[i].fundingAnnualized,
          funding2: assets[j].fundingAnnualized,
          fundingSpread: assets[i].fundingAnnualized - assets[j].fundingAnnualized
        });
      }
    }
  }
  
  return pairs;
}

/**
 * Main entry point
 */
async function main() {
  console.log('🔍 Pairs Scanner\n');
  console.log(`Thresholds: Volume > $${(minVolume / 1000).toFixed(0)}k, OI > $${(minOI / 1000).toFixed(0)}k\n`);
  
  // Load sector mapping
  const { symbolToSector, sectors, config } = loadSectorMap();
  console.log(`Loaded ${Object.keys(symbolToSector).length} symbols across ${sectors.length} sectors\n`);
  
  // Step 1: Fetch universe
  console.log('Fetching Hyperliquid perpetuals...');
  const universe = await fetchUniverse();
  console.log(`  Found ${universe.length} perpetuals\n`);
  
  // Step 2: Filter by liquidity
  const filtered = filterByLiquidity(universe, minVolume, minOI);
  console.log(`After liquidity filter: ${filtered.length} assets\n`);
  
  // Step 3: Group by sector
  const { groups, unmapped } = groupBySector(filtered, symbolToSector);
  
  console.log('Assets by sector:');
  for (const sector of sectors) {
    const count = groups[sector]?.length || 0;
    if (count > 0) {
      const symbols = groups[sector].map(a => a.symbol).join(', ');
      console.log(`  ${sector}: ${count} (${symbols})`);
    }
  }
  
  if (unmapped.length > 0) {
    console.log(`\n⚠️  Unmapped symbols (add to config/sectors.json): ${unmapped.join(', ')}`);
  }
  
  // Step 4: Generate pairs
  const pairs = generatePairs(groups);
  console.log(`\nGenerated ${pairs.length} pairs total\n`);
  
  // Summary by sector
  const pairsBySector = {};
  for (const pair of pairs) {
    pairsBySector[pair.sector] = (pairsBySector[pair.sector] || 0) + 1;
  }
  
  console.log('Pairs by sector:');
  for (const [sector, count] of Object.entries(pairsBySector).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sector}: ${count} pairs`);
  }
  
  // Show top pairs by funding spread (potential carry trade)
  const sortedByFunding = [...pairs].sort((a, b) => Math.abs(b.fundingSpread) - Math.abs(a.fundingSpread));
  console.log('\nTop 10 pairs by funding spread (carry opportunity):');
  for (const pair of sortedByFunding.slice(0, 10)) {
    const spread = pair.fundingSpread > 0 
      ? `+${pair.fundingSpread.toFixed(1)}%` 
      : `${pair.fundingSpread.toFixed(1)}%`;
    console.log(`  ${pair.asset1}/${pair.asset2} (${pair.sector}): ${spread} annualized`);
  }
  
  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    thresholds: { minVolume, minOI },
    totalAssets: universe.length,
    filteredAssets: filtered.length,
    totalPairs: pairs.length,
    pairsBySector,
    pairs: pairs.map(p => ({
      pair: `${p.asset1}/${p.asset2}`,
      sector: p.sector,
      fundingSpread: parseFloat(p.fundingSpread.toFixed(2))
    }))
  };
  
  const outputPath = path.join(__dirname, '../config/discovered_pairs.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Results saved to ${outputPath}`);
  
  return output;
}

// Run
main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = { fetchUniverse, filterByLiquidity, groupBySector, generatePairs };

