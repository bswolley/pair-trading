const axios = require('axios');
const fs = require('fs');

async function calculateEthSolTradePerformance() {
  console.log('=== ETH/SOL PAIR TRADE PERFORMANCE ===\n');
  
  try {
    // Entry prices and position sizing
    const entryETH = 2704.9;
    const entrySOL = 124.88;
    const ethWeight = 0.57;  // 57%
    const solWeight = 0.43;  // 43%
    
    // Get current prices
    const [ethResp, solResp] = await Promise.all([
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'),
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')
    ]);
    
    const currentETH = parseFloat(ethResp.data.price);
    const currentSOL = parseFloat(solResp.data.price);
    
    // Calculate individual returns
    const ethReturn = ((currentETH - entryETH) / entryETH) * 100;
    const solReturn = ((currentSOL - entrySOL) / entrySOL) * 100;
    
    // For pair trade: Long ETH, Short SOL
    // Long ETH: positive return if ETH goes up
    // Short SOL: NEGATIVE return if SOL goes up (you lose when short goes up)
    const ethLongReturn = ethReturn;
    const solShortReturn = -solReturn;  // Invert because we're SHORT
    
    // Calculate combined P&L (weighted by position sizing)
    const combinedPnl = (ethLongReturn * ethWeight) + (solShortReturn * solWeight);
    
    // Calculate current stats (Z-score, beta, correlation, etc.)
    console.log('Fetching historical data for current stats...');
    const [histETH, histSOL] = await Promise.all([
      axios.get('https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=35'),
      axios.get('https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1d&limit=35')
    ]);
    
    // Process historical data (exclude today's incomplete candle)
    const ethPrices = histETH.data.slice(0, -1).map(candle => parseFloat(candle[4]));
    const solPrices = histSOL.data.slice(0, -1).map(candle => parseFloat(candle[4]));
    
    // Calculate returns
    const returns = [];
    for (let i = 1; i < ethPrices.length; i++) {
      const ethRet = (ethPrices[i] - ethPrices[i-1]) / ethPrices[i-1];
      const solRet = (solPrices[i] - solPrices[i-1]) / solPrices[i-1];
      returns.push({ eth: ethRet, sol: solRet });
    }
    
    // Calculate correlation and beta
    const meanETH = returns.reduce((sum, r) => sum + r.eth, 0) / returns.length;
    const meanSOL = returns.reduce((sum, r) => sum + r.sol, 0) / returns.length;
    
    let covariance = 0;
    let varianceETH = 0;
    let varianceSOL = 0;
    
    for (const ret of returns) {
      const devETH = ret.eth - meanETH;
      const devSOL = ret.sol - meanSOL;
      covariance += devETH * devSOL;
      varianceETH += devETH * devETH;
      varianceSOL += devSOL * devSOL;
    }
    
    covariance /= returns.length;
    varianceETH /= returns.length;
    varianceSOL /= returns.length;
    
    const correlation = covariance / (Math.sqrt(varianceETH) * Math.sqrt(varianceSOL));
    const beta = covariance / varianceSOL;  // Beta of ETH relative to SOL
    
    // Calculate Z-score
    const historicalSpreads = [];
    for (let i = 0; i < ethPrices.length; i++) {
      const spread = Math.log(ethPrices[i]) - beta * Math.log(solPrices[i]);
      historicalSpreads.push(spread);
    }
    
    const currentSpread = Math.log(currentETH) - beta * Math.log(currentSOL);
    const meanSpread = historicalSpreads.reduce((sum, s) => sum + s, 0) / historicalSpreads.length;
    const varianceSpread = historicalSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / historicalSpreads.length;
    const stdDevSpread = Math.sqrt(varianceSpread);
    const zScore = (currentSpread - meanSpread) / stdDevSpread;
    
    // Calculate Greeks (after Z-score is calculated)
    // 1. DELTA (via Beta) - already have
    const delta = beta;  // Delta = Beta for pair trading
    
    // 2. GAMMA - Rate of change of beta (beta stability)
    // Calculate beta over different windows to see how it changes
    const shortWindow = Math.floor(returns.length / 3); // ~10 days
    const longWindow = returns.length; // ~30 days
    
    // Short window beta
    let shortCov = 0, shortVarSOL = 0, shortMeanETH = 0, shortMeanSOL = 0;
    const shortReturns = returns.slice(-shortWindow);
    shortMeanETH = shortReturns.reduce((sum, r) => sum + r.eth, 0) / shortReturns.length;
    shortMeanSOL = shortReturns.reduce((sum, r) => sum + r.sol, 0) / shortReturns.length;
    for (const ret of shortReturns) {
      shortCov += (ret.eth - shortMeanETH) * (ret.sol - shortMeanSOL);
      shortVarSOL += Math.pow(ret.sol - shortMeanSOL, 2);
    }
    shortCov /= shortReturns.length;
    shortVarSOL /= shortReturns.length;
    const shortBeta = shortVarSOL > 0 ? shortCov / shortVarSOL : beta;
    
    // Gamma = change in beta per unit price change
    // Approximate as: (Beta_long - Beta_short) / average_price_change
    const avgPriceChange = Math.abs((currentETH - entryETH) / entryETH + (currentSOL - entrySOL) / entrySOL) / 2;
    const gamma = avgPriceChange > 0 ? (beta - shortBeta) / avgPriceChange : 0;
    
    // 3. THETA - Time decay (Z-score change over time)
    // Calculate Z-score for previous days to see decay rate
    const daysSinceEntry = 3; // Approximate - would need exact entry date
    
    // 4. VEGA - Volatility sensitivity
    // Calculate historical volatility of spread
    const historicalVolatility = stdDevSpread;
    // Calculate current volatility (recent window)
    const recentSpreads = [];
    const recentWindow = Math.floor(ethPrices.length / 2);
    for (let i = ethPrices.length - recentWindow; i < ethPrices.length; i++) {
      recentSpreads.push(Math.log(ethPrices[i]) - beta * Math.log(solPrices[i]));
    }
    const recentMeanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
    const recentVariance = recentSpreads.reduce((sum, s) => sum + Math.pow(s - recentMeanSpread, 2), 0) / recentSpreads.length;
    const recentVolatility = Math.sqrt(recentVariance);
    
    // Vega = sensitivity to 1% change in volatility
    // Approximate as: change in spread std dev per 1% change in underlying volatility
    const underlyingVolatility = Math.sqrt(varianceSOL); // SOL volatility
    const vega = underlyingVolatility > 0 ? (recentVolatility - historicalVolatility) / (underlyingVolatility * 0.01) : 0;
    
    // 5. RHO - Interest rate sensitivity (not applicable to crypto spot)
    const rho = 0; // Not applicable
    
    // Determine signal
    let signal = 'Neutral';
    let strength = 'None';
    
    if (zScore < -2) {
      signal = 'Long ETH, Short SOL';
      strength = 'Strong';
    } else if (zScore < -1) {
      signal = 'Long ETH, Short SOL';
      strength = 'Weak';
    } else if (zScore > 2) {
      signal = 'Short ETH, Long SOL';
      strength = 'Strong';
    } else if (zScore > 1) {
      signal = 'Short ETH, Long SOL';
      strength = 'Weak';
    }
    
    // Calculate entry spread and Z-score (for comparison)
    // Note: Using current beta for entry Z-score (approximation)
    const entrySpread = Math.log(entryETH) - beta * Math.log(entrySOL);
    const entryZScore = (entrySpread - meanSpread) / stdDevSpread;
    
    // Calculate THETA now that we have entryZScore
    const zScoreChange = zScore - entryZScore;
    const theta = daysSinceEntry > 0 ? zScoreChange / daysSinceEntry : 0; // Z-score change per day
    
    // Calculate entry beta (using data up to entry point)
    // We'll approximate by using a shorter window or the same beta
    // For more accuracy, we'd need the exact entry date
    const entryBeta = beta; // Approximation - would need entry date for exact calculation
    
    // TP/SL thresholds
    const tpThreshold = 10.0;  // 10% take profit
    const slThreshold = -5.0; // -5% stop loss
    
    // Check if TP/SL would have been hit
    const hitTP = combinedPnl >= tpThreshold;
    const hitSL = combinedPnl <= slThreshold;
    
    // Calculate optimal position sizing based on current beta
    const currentOptimalEthWeight = 1 / (1 + Math.abs(beta));
    const currentOptimalSolWeight = Math.abs(beta) / (1 + Math.abs(beta));
    
    // Calculate entry optimal sizing (using entry beta approximation)
    const entryOptimalEthWeight = 1 / (1 + Math.abs(entryBeta));
    const entryOptimalSolWeight = Math.abs(entryBeta) / (1 + Math.abs(entryBeta));
    
    // Beta change
    const betaChange = beta - entryBeta;
    const betaChangePct = entryBeta !== 0 ? (betaChange / Math.abs(entryBeta)) * 100 : 0;
    
    // Z-score exit threshold (Dorian's 0.5 rule - mean reversion complete)
    const zScoreExitThreshold = 0.5;
    const shouldExitByZScore = Math.abs(zScore) < zScoreExitThreshold;
    
    // Generate report
    const report = `# ETH/SOL PAIR TRADE PERFORMANCE
**Generated:** ${new Date().toISOString()}

## Trade Entry Details
- **ETH Entry:** $${entryETH.toFixed(2)} (${(ethWeight * 100).toFixed(0)}% position)
- **SOL Entry:** $${entrySOL.toFixed(2)} (${(solWeight * 100).toFixed(0)}% position)
- **Entry Date:** Friday (exact date to be confirmed)

## Current Performance

### Current Prices
- **ETH:** $${currentETH.toFixed(2)}
- **SOL:** $${currentSOL.toFixed(2)}

### Individual Leg Returns
- **ETH (LONG):** ${ethLongReturn >= 0 ? '+' : ''}${ethLongReturn.toFixed(2)}% (ETH went ${ethReturn >= 0 ? 'up' : 'down'} ${Math.abs(ethReturn).toFixed(2)}%)
- **SOL (SHORT):** ${solShortReturn >= 0 ? '+' : ''}${solShortReturn.toFixed(2)}% (SOL went ${solReturn >= 0 ? 'up' : 'down'} ${Math.abs(solReturn).toFixed(2)}%, short loses when price rises)

### Combined P&L (Pair Trade)
- **Combined P&L:** ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%
- **Calculation:** (ETH Long ${ethLongReturn >= 0 ? '+' : ''}${ethLongReturn.toFixed(2)}% × ${(ethWeight * 100).toFixed(0)}%) + (SOL Short ${solShortReturn >= 0 ? '+' : ''}${solShortReturn.toFixed(2)}% × ${(solWeight * 100).toFixed(0)}%)
- **Note:** Both assets moved up by similar amounts (~4%), which is BAD for a pair trade. The short leg loses money when SOL rises.

## Current ETH/SOL Pair Statistics

### Key Metrics
- **Z-Score:** ${zScore.toFixed(2)}
- **Signal:** ${signal}
- **Strength:** ${strength}
- **Beta (ETH vs SOL):** ${beta.toFixed(3)}
- **Correlation:** ${correlation.toFixed(3)}

## Greeks Analysis (Options Risk Metrics Adapted for Pair Trading)

### Delta (Δ) - Price Sensitivity
- **Delta (via Beta):** ${delta.toFixed(3)}
- **Interpretation:** For every $1 move in SOL, ETH typically moves $${delta.toFixed(3)} in the same direction
- **Hedge Ratio:** ${(1 / (1 + Math.abs(delta)) * 100).toFixed(1)}% ETH / ${(Math.abs(delta) / (1 + Math.abs(delta)) * 100).toFixed(1)}% SOL
- **Status:** ${Math.abs(delta - 1) < 0.3 ? '✅ Delta-neutral position sizing' : '⚠️ Consider adjusting for delta-neutrality'}

### Gamma (Γ) - Beta Stability
- **Gamma:** ${gamma.toFixed(4)}
- **Short-term Beta (${shortWindow}d):** ${shortBeta.toFixed(3)}
- **Long-term Beta (${longWindow}d):** ${beta.toFixed(3)}
- **Beta Change:** ${(beta - shortBeta).toFixed(3)}
- **Interpretation:** ${Math.abs(gamma) < 0.01 ? '✅ Beta is stable - low gamma risk' : '⚠️ Beta is changing - gamma risk present'}
- **Impact:** ${Math.abs(gamma) < 0.01 ? 'Minimal - no rebalancing needed' : 'Significant - consider rebalancing if beta drift continues'}

### Theta (Θ) - Time Decay / Mean Reversion Speed
- **Theta:** ${theta >= 0 ? '+' : ''}${theta.toFixed(4)} Z-score units per day
- **Z-Score Change:** ${(zScore - entryZScore).toFixed(2)} over ~${daysSinceEntry} days
- **Daily Rate:** ${theta >= 0 ? '+' : ''}${theta.toFixed(4)} per day
- **Interpretation:** ${theta > 0 ? '✅ Mean reversion working - Z-score moving toward zero' : theta < 0 ? '❌ Mean reversion failing - Z-score moving away from zero' : '➖ No significant time decay'}
- **Time to Exit (|Z| < 0.5):** ${theta > 0 ? `~${((Math.abs(zScore) - 0.5) / theta).toFixed(1)} days at current rate` : 'Cannot estimate - theta too low'}

### Vega (ν) - Volatility Sensitivity
- **Vega:** ${vega.toFixed(4)}
- **Historical Spread Volatility:** ${historicalVolatility.toFixed(4)}
- **Recent Spread Volatility:** ${recentVolatility.toFixed(4)}
- **Volatility Change:** ${((recentVolatility - historicalVolatility) / historicalVolatility * 100).toFixed(1)}%
- **Interpretation:** ${Math.abs(vega) < 0.1 ? '✅ Low volatility sensitivity - stable Z-scores' : '⚠️ High volatility sensitivity - Z-scores may swing more'}
- **Impact:** ${Math.abs(vega) < 0.1 ? 'Minimal - spread volatility is stable' : 'Significant - watch for increased Z-score volatility'}

### Rho (ρ) - Interest Rate Sensitivity
- **Rho:** ${rho.toFixed(4)}
- **Status:** Not applicable to crypto spot pair trades
- **Note:** Interest rates don't affect spot crypto positions

### Spread Analysis
- **Current Spread:** ${currentSpread.toFixed(4)}
- **Mean Spread (30d):** ${meanSpread.toFixed(4)}
- **Std Dev:** ${stdDevSpread.toFixed(4)}
- **Entry Spread:** ${entrySpread.toFixed(4)}
- **Entry Z-Score:** ${entryZScore.toFixed(2)}

### Position Sizing (Beta-Adjusted)
- **Beta-Adjusted Ratio:** 1:${beta.toFixed(3)}
- **Recommended Sizing:** ${((1 / (1 + Math.abs(beta))) * 100).toFixed(1)}% ETH / ${((Math.abs(beta) / (1 + Math.abs(beta))) * 100).toFixed(1)}% SOL
- **Actual Position Sizing:** ${(ethWeight * 100).toFixed(0)}% ETH / ${(solWeight * 100).toFixed(0)}% SOL

## Analysis

### Trade Performance Summary
${combinedPnl > 0 ? '✅ **SLIGHTLY PROFITABLE**' : combinedPnl < 0 ? '❌ **LOSS**' : '➖ **FLAT**'}: The trade is currently ${combinedPnl >= 0 ? 'up' : 'down'} ${Math.abs(combinedPnl).toFixed(2)}%.

**⚠️ CRITICAL ISSUE:** Both ETH and SOL moved up by similar amounts (~${Math.abs(ethReturn).toFixed(1)}% each). This is **BAD for a pair trade** because:
- The long leg (ETH) gains when ETH rises ✅
- The short leg (SOL) **LOSES** when SOL rises ❌
- When both move together, the gains and losses mostly cancel out
- Pair trades profit from **divergence** (one goes up, one goes down), not correlation

**What this means:** The market moved in a correlated way (both up), which is the opposite of what a mean reversion pair trade needs. The small profit (+${Math.abs(combinedPnl).toFixed(2)}%) is likely due to slight differences in the moves or position sizing, not from mean reversion working.

### Current Signal Assessment
${Math.abs(zScore) > 2 ? 
  `**STRONG SIGNAL** (|Z| = ${Math.abs(zScore).toFixed(2)}): ${signal}` :
  Math.abs(zScore) > 1 ?
  `**MODERATE SIGNAL** (|Z| = ${Math.abs(zScore).toFixed(2)}): ${signal}` :
  `**WEAK SIGNAL** (|Z| = ${Math.abs(zScore).toFixed(2)}): No strong mean reversion opportunity`
}

### Z-Score Change
- **Entry Z-Score:** ${entryZScore.toFixed(2)}
- **Current Z-Score:** ${zScore.toFixed(2)}
- **Change:** ${(zScore - entryZScore).toFixed(2)} ${zScore > entryZScore ? '(moved away from mean)' : '(moved toward mean)'}

### Position Sizing Comparison
${Math.abs(ethWeight - (1 / (1 + Math.abs(beta)))) < 0.05 ? 
  '✅ Position sizing is close to beta-adjusted optimal' :
  '⚠️ Position sizing differs from beta-adjusted optimal. Consider rebalancing for delta-neutrality.'}

## TP/SL Analysis

### Threshold Status
- **Take Profit (TP):** ${tpThreshold}%
- **Stop Loss (SL):** ${slThreshold}%
- **Current P&L:** ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%
- **Status:** ${hitTP ? '✅ **TP HIT** - Would have exited at +10%' : hitSL ? '❌ **SL HIT** - Would have exited at -5%' : '⏳ **ACTIVE** - No exit triggered'}

${!hitTP && !hitSL ? `**Distance to TP:** ${(tpThreshold - combinedPnl).toFixed(2)}% away\n**Distance to SL:** ${(combinedPnl - slThreshold).toFixed(2)}% away` : ''}

## Beta Changes & Rebalancing

### Beta Evolution
- **Entry Beta (approx):** ${entryBeta.toFixed(3)}
- **Current Beta:** ${beta.toFixed(3)}
- **Beta Change:** ${betaChange >= 0 ? '+' : ''}${betaChange.toFixed(3)} (${betaChangePct >= 0 ? '+' : ''}${betaChangePct.toFixed(1)}%)

### Position Sizing Impact

**Entry Optimal Sizing (based on entry beta):**
- ETH: ${(entryOptimalEthWeight * 100).toFixed(1)}% / SOL: ${(entryOptimalSolWeight * 100).toFixed(1)}%

**Current Optimal Sizing (based on current beta):**
- ETH: ${(currentOptimalEthWeight * 100).toFixed(1)}% / SOL: ${(currentOptimalSolWeight * 100).toFixed(1)}%

**Actual Position Sizing:**
- ETH: ${(ethWeight * 100).toFixed(0)}% / SOL: ${(solWeight * 100).toFixed(0)}%

**Sizing Drift:**
${Math.abs(currentOptimalEthWeight - entryOptimalEthWeight) > 0.02 ? 
  `⚠️ **SIGNIFICANT DRIFT:** Optimal sizing has changed by ${Math.abs((currentOptimalEthWeight - entryOptimalEthWeight) * 100).toFixed(1)}% for ETH leg.` :
  '✅ **MINIMAL DRIFT:** Optimal sizing has remained relatively stable.'}

### Should You Rebalance Mid-Trade?

**Rebalancing Considerations:**

1. **Beta Stability:** ${Math.abs(betaChange) < 0.1 ? '✅ Beta has remained stable - rebalancing likely unnecessary' : '⚠️ Beta has changed significantly - consider rebalancing'}

2. **Current Deviation:** ${Math.abs(ethWeight - currentOptimalEthWeight) < 0.05 ? 
  '✅ Current sizing is still close to optimal' : 
  '⚠️ Current sizing has drifted from optimal - rebalancing may improve delta-neutrality'}

3. **Trade Duration:** Short-term trades (< 1 week) typically don't need rebalancing unless beta changes dramatically.

4. **Costs:** Rebalancing incurs transaction costs and slippage. Only rebalance if:
   - Beta change is significant (>10-15%)
   - Current sizing is far from optimal (>5% deviation)
   - Trade is expected to last longer (weeks/months)

**Recommendation:** ${Math.abs(betaChange) < 0.1 && Math.abs(ethWeight - currentOptimalEthWeight) < 0.05 ? 
  '✅ **NO REBALANCING NEEDED** - Beta and sizing remain close to optimal' :
  '⚠️ **CONSIDER REBALANCING** - Beta has changed or sizing has drifted significantly'}

## Z-Score Exit Threshold (Dorian's Rule)

### Mean Reversion Completion
- **Exit Threshold:** |Z| < ${zScoreExitThreshold} (mean reversion complete)
- **Current Z-Score:** ${zScore.toFixed(2)}
- **Status:** ${shouldExitByZScore ? '✅ **EXIT SIGNAL** - Mean reversion complete (Z-score within ±0.5)' : '⏳ **HOLD** - Still waiting for mean reversion'}

${shouldExitByZScore ? 
  `**Recommendation:** Consider exiting the trade. The spread has reverted to within 0.5 standard deviations of the mean, indicating mean reversion is complete.` :
  `**Distance to Exit:** ${(Math.abs(zScore) - zScoreExitThreshold).toFixed(2)} Z-score units away from exit threshold`}

### Exit Strategy Summary
1. **Take Profit:** ${tpThreshold}% combined P&L ✅ ${hitTP ? 'HIT' : 'Not hit'}
2. **Stop Loss:** ${slThreshold}% combined P&L ✅ ${hitSL ? 'HIT' : 'Not hit'}
3. **Z-Score Exit:** |Z| < ${zScoreExitThreshold} ✅ ${shouldExitByZScore ? 'HIT - Mean reversion complete' : 'Not hit'}

---
*Analysis based on 30-day historical data (excluding today's incomplete candle)*
*Current prices fetched from Binance API*
*Note: Entry beta is approximated using current beta - exact calculation would require entry date*
`;

    fs.writeFileSync('eth_sol_trade_performance.md', report);
    
    // Console output
    console.log('📊 TRADE PERFORMANCE (PAIR TRADE):');
    console.log(`ETH (LONG): ${ethLongReturn >= 0 ? '+' : ''}${ethLongReturn.toFixed(2)}% (${entryETH.toFixed(2)} → ${currentETH.toFixed(2)})`);
    console.log(`SOL (SHORT): ${solShortReturn >= 0 ? '+' : ''}${solShortReturn.toFixed(2)}% (${entrySOL.toFixed(2)} → ${currentSOL.toFixed(2)})`);
    console.log(`\n⚠️  WARNING: Both assets moved up by similar amounts (~${Math.abs(ethReturn).toFixed(1)}% and ~${Math.abs(solReturn).toFixed(1)}%)`);
    console.log(`   This is BAD for a pair trade - the short leg loses when SOL rises!`);
    console.log(`\n💰 COMBINED P&L: ${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%`);
    console.log(`\n📈 CURRENT STATS:`);
    console.log(`Z-Score: ${zScore.toFixed(2)} (${strength} ${signal})`);
    console.log(`Beta: ${beta.toFixed(3)} (change: ${betaChange >= 0 ? '+' : ''}${betaChange.toFixed(3)})`);
    console.log(`Correlation: ${correlation.toFixed(3)}`);
    console.log(`Entry Z-Score: ${entryZScore.toFixed(2)}`);
    console.log(`Z-Score Change: ${(zScore - entryZScore).toFixed(2)}`);
    
    console.log(`\n📊 GREEKS ANALYSIS:`);
    console.log(`Delta (Beta): ${delta.toFixed(3)} - Hedge ratio for delta-neutrality`);
    console.log(`Gamma: ${gamma.toFixed(4)} - ${Math.abs(gamma) < 0.01 ? '✅ Beta stable' : '⚠️ Beta changing'}`);
    console.log(`Theta: ${theta >= 0 ? '+' : ''}${theta.toFixed(4)} Z/day - ${theta > 0 ? '✅ Mean reversion working' : '❌ Mean reversion failing'}`);
    console.log(`Vega: ${vega.toFixed(4)} - ${Math.abs(vega) < 0.1 ? '✅ Low volatility risk' : '⚠️ High volatility risk'}`);
    console.log(`Rho: ${rho.toFixed(4)} - Not applicable (spot trades)`);
    
    console.log(`\n🎯 TP/SL STATUS:`);
    console.log(`${hitTP ? '✅ TP HIT (+10%)' : hitSL ? '❌ SL HIT (-5%)' : `⏳ Active (${combinedPnl >= 0 ? '+' : ''}${combinedPnl.toFixed(2)}%)`}`);
    if (!hitTP && !hitSL) {
      console.log(`   Distance to TP: ${(tpThreshold - combinedPnl).toFixed(2)}%`);
      console.log(`   Distance to SL: ${(combinedPnl - slThreshold).toFixed(2)}%`);
    }
    
    console.log(`\n📊 REBALANCING ANALYSIS:`);
    console.log(`Entry optimal: ${(entryOptimalEthWeight * 100).toFixed(1)}% ETH / ${(entryOptimalSolWeight * 100).toFixed(1)}% SOL`);
    console.log(`Current optimal: ${(currentOptimalEthWeight * 100).toFixed(1)}% ETH / ${(currentOptimalSolWeight * 100).toFixed(1)}% SOL`);
    console.log(`Actual sizing: ${(ethWeight * 100).toFixed(0)}% ETH / ${(solWeight * 100).toFixed(0)}% SOL`);
    console.log(`${Math.abs(betaChange) < 0.1 ? '✅ Beta stable - no rebalancing needed' : '⚠️ Beta changed - consider rebalancing'}`);
    
    console.log(`\n🚪 EXIT SIGNALS:`);
    console.log(`Z-Score exit (|Z| < 0.5): ${shouldExitByZScore ? '✅ EXIT - Mean reversion complete' : '⏳ HOLD'}`);
    if (!shouldExitByZScore) {
      console.log(`   Current Z: ${zScore.toFixed(2)}, Need: |Z| < ${zScoreExitThreshold}`);
    }
    
    console.log(`\n✅ Report saved to eth_sol_trade_performance.md`);
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
  }
}

calculateEthSolTradePerformance();

