#!/usr/bin/env node

/**
 * Test path dependency risk at a specific entry time
 * Usage: node scripts/testPathDependencyAtEntry.js SYMBOL1 SYMBOL2 ENTRY_TIME
 * Example: node scripts/testPathDependencyAtEntry.js LINEA ONDO "2025-12-01T12:00:00Z"
 */

require('dotenv').config();
const { analyzePair } = require('../lib/pairAnalysis');

const [,, symbol1, symbol2, entryTimeStr] = process.argv;

if (!symbol1 || !symbol2 || !entryTimeStr) {
  console.error('Usage: node scripts/testPathDependencyAtEntry.js SYMBOL1 SYMBOL2 ENTRY_TIME');
  console.error('Example: node scripts/testPathDependencyAtEntry.js LINEA ONDO "2025-12-01T12:00:00Z"');
  process.exit(1);
}

const entryTime = new Date(entryTimeStr);
if (isNaN(entryTime.getTime())) {
  console.error('Invalid entry time format. Use ISO format: "2025-12-01T12:00:00Z"');
  process.exit(1);
}

async function testPathDependency() {
  console.log(`\nTesting path dependency risk for ${symbol1}/${symbol2} at entry time: ${entryTime.toISOString()}\n`);
  
  try {
    const result = await analyzePair({
      symbol1: symbol1.toUpperCase(),
      symbol2: symbol2.toUpperCase(),
      cutoffTime: entryTime.getTime()
    });
    
    if (result.error) {
      console.error('Error:', result.error);
      return;
    }
    
    const standardized = result.standardized;
    const pathDependencyRisks = standardized.pathDependencyRisks || {};
    
    console.log('Path Dependency Risk at Entry Time:');
    console.log('=====================================\n');
    
    // Show 24hr, 48hr, 7d from pathDependencyRisks object
    ['24hr', '48hr', '7d'].forEach(period => {
      const risk = pathDependencyRisks[period];
      if (risk) {
        console.log(`${period}:`);
        console.log('  Risk Level:', risk.pathDependencyRiskLevel || 'N/A');
        console.log('  Volatility Ratio:', risk.volatilityRatio ? `${risk.volatilityRatio.toFixed(2)}x` : 'N/A');
        console.log('  Description:', risk.pathDependencyRisk || 'N/A');
        console.log('');
      }
    });
    
    // Also show 30d if available
    const tf30 = result.timeframes?.[30];
    if (tf30?.pathDependencyRisk) {
      console.log('30d:');
      console.log('  Risk Level:', tf30.pathDependencyRiskLevel || 'N/A');
      console.log('  Volatility Ratio:', tf30.volatilityRatio ? `${tf30.volatilityRatio.toFixed(2)}x` : 'N/A');
      console.log('  Description:', tf30.pathDependencyRisk || 'N/A');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

testPathDependency();

