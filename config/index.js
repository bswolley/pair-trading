/**
 * Single Source of Truth Configuration
 * 
 * All pairs, timeframes, and settings are defined here.
 * Update this file to change defaults across all scripts.
 */

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'pairs.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

module.exports = {
  // Default pairs for batch analysis
  getDefaultPairs: () => config.defaultPairs.map(pair => ({
    name: pair.name,
    symbol1: pair.symbol1,
    symbol2: pair.symbol2,
    direction: pair.direction,
    leftSide: pair.leftSide,
    useHyperliquidAPI: true
  })),
  
  // Default timeframes
  getTimeframes: () => [...config.timeframes],
  
  // OBV timeframes
  getOBVTimeframes: () => [...config.obvTimeframes],
  
  // Z-score window
  getZScoreWindow: () => config.zScoreWindow,
  
  // API settings
  getAPISettings: () => ({ ...config.apiSettings }),
  
  // PDF settings
  getPDFSettings: () => ({ ...config.pdfSettings }),
  
  // Full config (for advanced usage)
  getConfig: () => ({ ...config })
};

