const axios = require('axios');
const fs = require('fs');
const { obv } = require('indicatorts');
const { Hyperliquid } = require('hyperliquid');
const config = require('../config');

async function analyzePairs() {
  console.log('=== PAIR TRADING ANALYSIS WITH OBV ===\n');
  
  try {
    // Get pairs from single source of truth
    const pairs = config.getDefaultPairs().map(pair => ({
      ...pair,
      asset1: `${pair.symbol1}USDT`,
      asset2: `${pair.symbol2}USDT`
    }));
    
    const timeframes = config.getTimeframes();
    const obvTimeframes = config.getOBVTimeframes();
    const results = [];
    
    for (const pair of pairs) {
      console.log(`Analyzing ${pair.name}...`);
      
      const pairResults = {
        pair: pair.name,
        symbol1: pair.symbol1,
        symbol2: pair.symbol2,
        leftSide: pair.leftSide,
        direction: pair.direction,
        timeframes: {}
      };
      
      // Fetch current market cap data
      console.log(`  Fetching current market cap data...`);
      let currentMcap1 = null, currentMcap2 = null;
      try {
        const [mcap1, mcap2] = await Promise.all([
          axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${pair.symbol1}&tsyms=USD`),
          axios.get(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${pair.symbol2}&tsyms=USD`)
        ]);
        if (mcap1.data.RAW && mcap1.data.RAW[pair.symbol1] && mcap1.data.RAW[pair.symbol1].USD) {
          currentMcap1 = mcap1.data.RAW[pair.symbol1].USD.MKTCAP;
        }
        if (mcap2.data.RAW && mcap2.data.RAW[pair.symbol2] && mcap2.data.RAW[pair.symbol2].USD) {
          currentMcap2 = mcap2.data.RAW[pair.symbol2].USD.MKTCAP;
        }
      } catch (mcapError) {
        console.log(`  Market cap fetch failed: ${mcapError.message}`);
      }
      
      // Fetch full 180 days of data first for cumulative OBV calculation (using CryptoCompare for OBV)
      console.log(`  Fetching full 180-day data for cumulative OBV (CryptoCompare)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      let fullPrices1, fullPrices2, fullVolumes1, fullVolumes2, fullOBV1, fullOBV2;
      try {
        const limit = 185;
        const toTs = Math.floor(Date.now() / 1000);
        
        // Add delay between requests to avoid rate limits
        const cc1 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
          params: { fsym: pair.symbol1, tsym: 'USD', limit: limit, toTs: toTs }
        });
        
        // Wait before second request
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const cc2 = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
          params: { fsym: pair.symbol2, tsym: 'USD', limit: limit, toTs: toTs }
        });
        
        if (cc1.data.Response === 'Error' || cc2.data.Response === 'Error') {
          throw new Error(`CryptoCompare error: ${cc1.data.Message || cc2.data.Message}`);
        }
        
        const data1 = cc1.data.Data.Data || [];
        const data2 = cc2.data.Data.Data || [];
        
        const data1Map = new Map();
        const data2Map = new Map();
        
        data1.forEach(d => {
          const date = new Date(d.time * 1000).toISOString().split('T')[0];
          data1Map.set(date, d);
        });
        
        data2.forEach(d => {
          const date = new Date(d.time * 1000).toISOString().split('T')[0];
          data2Map.set(date, d);
        });
        
        const commonDates = [...data1Map.keys()].filter(d => data2Map.has(d)).sort();
        
        if (commonDates.length < 180) {
          throw new Error(`Insufficient overlapping data: ${commonDates.length} days`);
        }
        
        const selectedDates = commonDates.slice(-180);
        
        fullPrices1 = selectedDates.map(date => data1Map.get(date).close);
        fullPrices2 = selectedDates.map(date => data2Map.get(date).close);
        fullVolumes1 = selectedDates.map(date => data1Map.get(date).volumeto || data1Map.get(date).volumefrom || 0);
        fullVolumes2 = selectedDates.map(date => data2Map.get(date).volumeto || data2Map.get(date).volumefrom || 0);
        
        if (fullPrices1 && fullPrices1.length >= 180 && fullVolumes1 && fullVolumes1.length >= 180) {
          // Calculate OBV once for the full period
          fullOBV1 = obv(fullPrices1, fullVolumes1);
          fullOBV2 = obv(fullPrices2, fullVolumes2);
          
          // Store current prices
          pairResults.currentPrice1 = fullPrices1[fullPrices1.length - 1];
          pairResults.currentPrice2 = fullPrices2[fullPrices2.length - 1];
        }
        
        // Store market cap
        pairResults.currentMcap1 = currentMcap1;
        pairResults.currentMcap2 = currentMcap2;
      } catch (error) {
        // OBV data is optional - analysis can continue without it
        if (error.message.includes('rate limit')) {
          console.log(`  ⚠️  CryptoCompare rate limit hit - OBV data unavailable (analysis will continue without OBV)`);
        } else {
          console.log(`  ⚠️  OBV data unavailable: ${error.message} (analysis will continue without OBV)`);
        }
      }
      
      // Reuse Hyperliquid connection for all timeframes of this pair
      // Hyperliquid is MANDATORY for prices - fail if we can't connect
      let sdk = null;
      let originalLog, originalError;
      try {
        // Suppress WebSocket noise
        originalLog = console.log;
        originalError = console.error;
        const noop = () => {};
        console.log = noop;
        console.error = noop;
        
        sdk = new Hyperliquid();
        await sdk.connect();
        
        // Restore console
        console.log = originalLog;
        console.error = originalError;
        console.log(`  Connected to Hyperliquid for ${pair.name}...`);
      } catch (error) {
        // Restore console before throwing
        if (originalLog) console.log = originalLog;
        if (originalError) console.error = originalError;
        throw new Error(`Hyperliquid connection failed (MANDATORY for prices): ${error.message}`);
      }
      
      // Analyze main timeframes (30d, 90d, 180d) for correlation, beta, z-score, etc.
      for (const days of timeframes) {
        console.log(`  Analyzing ${days}-day period...`);
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        try {
          let prices1, prices2, currentPrice1, currentPrice2, volumes1, volumes2;
          
          // Use Hyperliquid for all pairs (MANDATORY - sdk should already be connected)
          try {
            if (!sdk) {
              throw new Error('Hyperliquid connection lost - cannot continue (MANDATORY for prices)');
            }
            console.log(`    Using Hyperliquid API for ${pair.symbol1} and ${pair.symbol2}...`);
            
            const endTime = Date.now();
            const startTime = endTime - ((days + 5) * 24 * 60 * 60 * 1000);
            
            const [hl1Data, hl2Data] = await Promise.all([
              sdk.info.getCandleSnapshot(`${pair.symbol1}-PERP`, '1d', startTime, endTime),
              sdk.info.getCandleSnapshot(`${pair.symbol2}-PERP`, '1d', startTime, endTime)
            ]);
            
            if (hl1Data && hl1Data.length > 0 && hl2Data && hl2Data.length > 0) {
              const hl1Parsed = hl1Data.map(c => ({
                time: c.t,
                open: parseFloat(c.o),
                high: parseFloat(c.h),
                low: parseFloat(c.l),
                close: parseFloat(c.c),
                volume: parseFloat(c.v)
              }));
              
              const hl2Parsed = hl2Data.map(c => ({
                time: c.t,
                open: parseFloat(c.o),
                high: parseFloat(c.h),
                low: parseFloat(c.l),
                close: parseFloat(c.c),
                volume: parseFloat(c.v)
              }));
              
              // Align by timestamp
              const hl1Map = new Map();
              const hl2Map = new Map();
              
              hl1Parsed.forEach(d => {
                const date = new Date(d.time).toISOString().split('T')[0];
                hl1Map.set(date, d);
              });
              
              hl2Parsed.forEach(d => {
                const date = new Date(d.time).toISOString().split('T')[0];
                hl2Map.set(date, d);
              });
              
              const commonDates = [...hl1Map.keys()].filter(d => hl2Map.has(d)).sort();
              
              if (commonDates.length >= days) {
                const selectedDates = commonDates.slice(-days);
                prices1 = selectedDates.map(date => hl1Map.get(date).close);
                prices2 = selectedDates.map(date => hl2Map.get(date).close);
                volumes1 = selectedDates.map(date => hl1Map.get(date).volume || 0);
                volumes2 = selectedDates.map(date => hl2Map.get(date).volume || 0);
                
                // Current price is the last date
                currentPrice1 = hl1Map.get(selectedDates[selectedDates.length - 1]).close;
                currentPrice2 = hl2Map.get(selectedDates[selectedDates.length - 1]).close;
              } else {
                throw new Error(`Insufficient overlapping Hyperliquid data: ${commonDates.length} days (need ${days})`);
              }
            } else {
              throw new Error('No data from Hyperliquid');
            }
          } catch (hyperliquidError) {
            // Hyperliquid is MANDATORY for prices - no fallback to CryptoCompare
            throw new Error(`Hyperliquid failed (MANDATORY for prices): ${hyperliquidError.message}`);
          }
          
          if (!prices1 || prices1.length < days || !prices2 || prices2.length < days) {
            throw new Error(`Insufficient data: prices1=${prices1?.length || 0}, prices2=${prices2?.length || 0}`);
          }
          
          // Calculate returns
          const returns = [];
          for (let i = 1; i < prices1.length; i++) {
            const ret1 = (prices1[i] - prices1[i-1]) / prices1[i-1];
            const ret2 = (prices2[i] - prices2[i-1]) / prices2[i-1];
            returns.push({ asset1: ret1, asset2: ret2 });
          }
          
          // Calculate correlation
          const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
          const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;
          
          let covariance = 0;
          let variance1 = 0;
          let variance2 = 0;
          
          for (const ret of returns) {
            const dev1 = ret.asset1 - mean1;
            const dev2 = ret.asset2 - mean2;
            covariance += dev1 * dev2;
            variance1 += dev1 * dev1;
            variance2 += dev2 * dev2;
          }
          
          covariance /= returns.length;
          variance1 /= returns.length;
          variance2 /= returns.length;
          
          const correlation = covariance / (Math.sqrt(variance1) * Math.sqrt(variance2));
          const beta = covariance / variance2;
          
          // Calculate spread
          const spreads = [];
          for (let i = 0; i < prices1.length; i++) {
            const spread = Math.log(prices1[i]) - beta * Math.log(prices2[i]);
            spreads.push(spread);
          }
          
          // Rolling Z-score (30-day window)
          const zScoreWindow = 30;
          const recentSpreads = spreads.slice(-Math.min(zScoreWindow, spreads.length));
          
          const meanSpread = recentSpreads.reduce((sum, s) => sum + s, 0) / recentSpreads.length;
          const varianceSpread = recentSpreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / recentSpreads.length;
          const stdDevSpread = Math.sqrt(varianceSpread);
          
          const currentSpread = Math.log(currentPrice1) - beta * Math.log(currentPrice2);
          const zScore = (currentSpread - meanSpread) / stdDevSpread;
          
          // Calculate Gamma (beta stability) - compare short-term vs long-term beta
          let gamma = 0;
          if (days === 7) {
            // For 7d, compare first half vs second half (3-4 days each)
            if (returns.length >= 6) {
              const midPoint = Math.floor(returns.length / 2);
              const firstHalf = returns.slice(0, midPoint);
              const secondHalf = returns.slice(midPoint);
              
              // First half beta
              const fhMean1 = firstHalf.reduce((sum, r) => sum + r.asset1, 0) / firstHalf.length;
              const fhMean2 = firstHalf.reduce((sum, r) => sum + r.asset2, 0) / firstHalf.length;
              let fhCov = 0, fhVar2 = 0;
              for (const ret of firstHalf) {
                fhCov += (ret.asset1 - fhMean1) * (ret.asset2 - fhMean2);
                fhVar2 += Math.pow(ret.asset2 - fhMean2, 2);
              }
              fhCov /= firstHalf.length;
              fhVar2 /= firstHalf.length;
              const fhBeta = fhVar2 > 0 ? fhCov / fhVar2 : beta;
              
              // Second half beta
              const shMean1 = secondHalf.reduce((sum, r) => sum + r.asset1, 0) / secondHalf.length;
              const shMean2 = secondHalf.reduce((sum, r) => sum + r.asset2, 0) / secondHalf.length;
              let shCov = 0, shVar2 = 0;
              for (const ret of secondHalf) {
                shCov += (ret.asset1 - shMean1) * (ret.asset2 - shMean2);
                shVar2 += Math.pow(ret.asset2 - shMean2, 2);
              }
              shCov /= secondHalf.length;
              shVar2 /= secondHalf.length;
              const shBeta = shVar2 > 0 ? shCov / shVar2 : beta;
              
              // Gamma = average deviation from overall beta
              gamma = (Math.abs(fhBeta - beta) + Math.abs(shBeta - beta)) / 2;
            }
          } else if (returns.length >= 15) {
            // For longer timeframes, compare short-term vs long-term
            const shortWindow = Math.max(7, Math.floor(returns.length / 3));
            const shortReturns = returns.slice(-shortWindow);
            
            if (shortReturns.length >= 7) {
              // Short-term beta
              const shortMean1 = shortReturns.reduce((sum, r) => sum + r.asset1, 0) / shortReturns.length;
              const shortMean2 = shortReturns.reduce((sum, r) => sum + r.asset2, 0) / shortReturns.length;
              let shortCov = 0, shortVar2 = 0;
              for (const ret of shortReturns) {
                shortCov += (ret.asset1 - shortMean1) * (ret.asset2 - shortMean2);
                shortVar2 += Math.pow(ret.asset2 - shortMean2, 2);
              }
              shortCov /= shortReturns.length;
              shortVar2 /= shortReturns.length;
              const shortBeta = shortVar2 > 0 ? shortCov / shortVar2 : beta;
              
              // Gamma = absolute change in beta (beta stability - lower is better)
              gamma = Math.abs(shortBeta - beta);
            }
          }
          
          // Volatility
          const volatility1 = Math.sqrt(variance1) * Math.sqrt(252);
          const volatility2 = Math.sqrt(variance2) * Math.sqrt(252);
          
          // Mean reversion
          let meanReversionScore = 0;
          for (let i = 1; i < spreads.length; i++) {
            const deviation = spreads[i-1] - meanSpread;
            const change = spreads[i] - spreads[i-1];
            if (deviation > 0 && change < 0) meanReversionScore++;
            if (deviation < 0 && change > 0) meanReversionScore++;
          }
          const meanReversionRate = meanReversionScore / (spreads.length - 1);
          
          // Calculate Theta (mean reversion speed) - Z-score change per day
          // Estimate by looking at spread autocorrelation/mean reversion tendency
          let theta = 0;
          if (days === 7 && spreads.length >= 5) {
            // For 7d, use simpler calculation: look at recent spread movements
            // Calculate how much spread has moved toward mean over the period
            const spreadStart = spreads[0];
            const spreadEnd = spreads[spreads.length - 1];
            const deviationStart = spreadStart - meanSpread;
            const deviationEnd = spreadEnd - meanSpread;
            
            // If spread is moving toward mean, calculate rate
            if (Math.abs(deviationStart) > Math.abs(deviationEnd) && Math.abs(deviationStart) > 0.001) {
              // Spread is reverting to mean
              const zStart = (spreadStart - meanSpread) / stdDevSpread;
              const zEnd = (spreadEnd - meanSpread) / stdDevSpread;
              const zChange = Math.abs(zStart) - Math.abs(zEnd);
              if (zChange > 0) {
                // Theta = Z-score change per day (positive = mean reverting)
                theta = zChange / days;
              } else if (zChange < 0) {
                // Negative theta = diverging from mean (bad for pair trading)
                theta = zChange / days;
              }
            } else if (Math.abs(deviationEnd) > Math.abs(deviationStart) && Math.abs(deviationEnd) > 0.001) {
              // Spread is diverging from mean (negative theta)
              const zStart = (spreadStart - meanSpread) / stdDevSpread;
              const zEnd = (spreadEnd - meanSpread) / stdDevSpread;
              const zChange = Math.abs(zStart) - Math.abs(zEnd);
              if (zChange < 0) {
                // Theta = negative (diverging)
                theta = zChange / days;
              }
            } else if (meanReversionRate > 0.4) {
              // Alternative: if mean reversion rate is decent, estimate theta
              const currentZAbs = Math.abs(zScore);
              if (currentZAbs > 0.1) {
                // Estimate based on mean reversion rate
                theta = meanReversionRate * currentZAbs / days;
              }
            }
          } else if (spreads.length >= 10) {
            // Use the existing autocorrelation calculation from cointegration
            // But calculate it more directly from spread levels (not changes)
            const spreadLevels = spreads;
            const meanSpreadLevel = spreadLevels.reduce((sum, s) => sum + s, 0) / spreadLevels.length;
            
            // Autocorrelation of spread levels (lag-1)
            let numerator = 0, denominator = 0;
            for (let i = 1; i < spreadLevels.length; i++) {
              const dev1 = spreadLevels[i] - meanSpreadLevel;
              const dev0 = spreadLevels[i-1] - meanSpreadLevel;
              numerator += dev1 * dev0;
              denominator += dev0 * dev0;
            }
            const autocorr = denominator > 0 ? numerator / denominator : 0;
            
            // Theta = mean reversion rate (positive when mean reverting)
            // Negative autocorr = mean reverting (spread tends to revert to mean)
            // Positive autocorr = trending (spread continues in same direction)
            if (autocorr < 0 && Math.abs(autocorr) < 1) {
              // Mean reverting: calculate half-life
              // Half-life = -ln(2) / ln(1 + autocorr) when autocorr is negative
              const halfLife = -Math.log(2) / Math.log(1 + autocorr);
              if (halfLife > 0 && isFinite(halfLife) && halfLife < 1000) {
                // Theta = Z-score units per day (approximate)
                // If half-life is H days, and current Z is |Z|, then theta ≈ |Z| / H
                const currentZAbs = Math.abs(zScore);
                if (currentZAbs > 0.1) {
                  theta = currentZAbs / halfLife;
                } else {
                  // If Z is already near zero, estimate from mean reversion rate
                  theta = meanReversionRate * 0.1; // Approximate
                }
              }
            } else if (meanReversionRate > 0.4) {
              // Alternative: use mean reversion rate directly
              // If mean reversion rate is decent, estimate theta from that
              const currentZAbs = Math.abs(zScore);
              if (currentZAbs > 0.1) {
                // Estimate: if 40%+ of moves are mean reverting, theta ≈ meanReversionRate * |Z| / days
                theta = meanReversionRate * currentZAbs / Math.min(days, 30);
              }
            }
            
            // Final fallback: if still 0 but cointegrated, use a minimal estimate
            if (theta === 0 && isCointegrated && Math.abs(zScore) > 0.5) {
              // If cointegrated but theta is 0, estimate conservatively
              // Assume slow mean reversion: ~0.01 Z per day for large deviations
              theta = Math.abs(zScore) / (days * 2); // Very conservative estimate
            }
          }
          
          // Cointegration
          const spreadDiffs = [];
          for (let i = 1; i < spreads.length; i++) {
            spreadDiffs.push(spreads[i] - spreads[i-1]);
          }
          
          const meanDiff = spreadDiffs.reduce((sum, d) => sum + d, 0) / spreadDiffs.length;
          let autocorr = 0;
          let varDiff = 0;
          for (let i = 0; i < spreadDiffs.length; i++) {
            const dev = spreadDiffs[i] - meanDiff;
            varDiff += dev * dev;
            if (i > 0) {
              autocorr += (spreadDiffs[i] - meanDiff) * (spreadDiffs[i-1] - meanDiff);
            }
          }
          varDiff /= spreadDiffs.length;
          autocorr /= (spreadDiffs.length - 1);
          const autocorrCoeff = varDiff > 0 ? autocorr / varDiff : 0;
          const adfStat = -autocorrCoeff * Math.sqrt(spreads.length);
          const isCointegrated = adfStat < -2.5 || (meanReversionRate > 0.5 && Math.abs(autocorrCoeff) < 0.3);
          
          // Calculate OBV - FIXED
          let obv1ChangePct = null;
          let obv2ChangePct = null;
          let obv1Change = null;
          let obv2Change = null;
          let obv1Trend = null;
          let obv2Trend = null;
          let obvPriceAnalysis1 = '';
          let obvPriceAnalysis2 = '';
          
          // Debug volumes
          if (!volumes1 || volumes1.length === 0) {
            console.log(`    WARNING: volumes1 is empty for ${pair.name} ${days}d`);
          }
          if (!volumes2 || volumes2.length === 0) {
            console.log(`    WARNING: volumes2 is empty for ${pair.name} ${days}d`);
          }
          
          if (volumes1 && volumes1.length > 0 && volumes2 && volumes2.length > 0 &&
              prices1.length === volumes1.length && prices2.length === volumes2.length) {
            
            // Check if volumes have actual data
            volumes1Sum = volumes1.reduce((sum, v) => sum + Math.abs(v || 0), 0);
            volumes2Sum = volumes2.reduce((sum, v) => sum + Math.abs(v || 0), 0);
            
            console.log(`    OBV check: volumes1=${volumes1.length} (sum=${volumes1Sum.toFixed(0)}), volumes2=${volumes2.length} (sum=${volumes2Sum.toFixed(0)})`);
            
            if (volumes1Sum > 0 && volumes2Sum > 0) {
              try {
                // Use cumulative OBV from full period if available
                if (fullOBV1 && fullOBV2 && fullOBV1.length >= days && fullOBV2.length >= days) {
                  // Extract OBV values for this timeframe from the cumulative calculation
                  // Take the last N days from the full OBV array
                  const obv1Slice = fullOBV1.slice(-days);
                  const obv2Slice = fullOBV2.slice(-days);
                  const vol1Slice = fullVolumes1.slice(-days);
                  const vol2Slice = fullVolumes2.slice(-days);
                  
                  const obv1Start = obv1Slice[0];
                  const obv1End = obv1Slice[obv1Slice.length - 1];
                  const obv2Start = obv2Slice[0];
                  const obv2End = obv2Slice[obv2Slice.length - 1];
                  
                  // Calculate OBV change for this timeframe window
                  obv1Change = obv1End - obv1Start;
                  obv2Change = obv2End - obv2Start;
                  
                  // Store the slice for reporting
                  obv1Values = obv1Slice;
                  obv2Values = obv2Slice;
                  
                  // Update volumes sum for this timeframe
                  volumes1Sum = vol1Slice.reduce((sum, v) => sum + Math.abs(v || 0), 0);
                  volumes2Sum = vol2Slice.reduce((sum, v) => sum + Math.abs(v || 0), 0);
                } else {
                  // Fallback: calculate OBV separately for this window (not ideal but works)
                  obv1Values = obv(prices1, volumes1);
                  obv2Values = obv(prices2, volumes2);
                  
                  if (obv1Values && obv1Values.length > 1 && obv2Values && obv2Values.length > 1) {
                    const obv1Start = obv1Values[0];
                    const obv1End = obv1Values[obv1Values.length - 1];
                    const obv2Start = obv2Values[0];
                    const obv2End = obv2Values[obv2Values.length - 1];
                    
                    obv1Change = obv1End - obv1Start;
                    obv2Change = obv2End - obv2Start;
                  }
                }
                
                if (obv1Values && obv1Values.length > 1 && obv2Values && obv2Values.length > 1) {
                  // Determine trend: positive = accumulating, negative = distributing
                  obv1Trend = obv1Change > 0 ? 'Accumulating' : obv1Change < 0 ? 'Distributing' : 'Neutral';
                  obv2Trend = obv2Change > 0 ? 'Accumulating' : obv2Change < 0 ? 'Distributing' : 'Neutral';
                  
                  // For display, normalize by average daily volume for readability (but it's not a true percentage)
                  if (Math.abs(obv1Change) > 0) {
                    const avgDailyVol1 = volumes1Sum / volumes1.length;
                    if (avgDailyVol1 > 0) {
                      obv1ChangePct = (obv1Change / avgDailyVol1) * 100;
                    }
                  }
                  
                  if (Math.abs(obv2Change) > 0) {
                    const avgDailyVol2 = volumes2Sum / volumes2.length;
                    if (avgDailyVol2 > 0) {
                      obv2ChangePct = (obv2Change / avgDailyVol2) * 100;
                    }
                  }
                  
                  console.log(`    OBV calculated: ${pair.symbol1}=${obv1ChangePct?.toFixed(1) || 'N/A'}%, ${pair.symbol2}=${obv2ChangePct?.toFixed(1) || 'N/A'}%`);
                  
                  // OBV vs Price analysis (last 10 days)
                  if (prices1.length >= 10 && obv1Values.length >= 10) {
                    const recentPrices1 = prices1.slice(-10);
                    const recentOBV1 = obv1Values.slice(-10);
                    const priceTrend1 = recentPrices1[recentPrices1.length - 1] > recentPrices1[0];
                    const obvTrend1 = recentOBV1[recentOBV1.length - 1] > recentOBV1[0];
                    
                    if (priceTrend1 && obvTrend1) {
                      obvPriceAnalysis1 = 'Price+OBV up = STRONG';
                    } else if (priceTrend1 && !obvTrend1) {
                      obvPriceAnalysis1 = 'Price up, OBV down = DIVERGENCE';
                    } else if (priceTrend1 && Math.abs(recentOBV1[recentOBV1.length - 1] - recentOBV1[0]) / Math.abs(recentOBV1[0]) < 0.1) {
                      obvPriceAnalysis1 = 'Price up, OBV flat = WEAK';
                    }
                  }
                  
                  if (prices2.length >= 10 && obv2Values.length >= 10) {
                    const recentPrices2 = prices2.slice(-10);
                    const recentOBV2 = obv2Values.slice(-10);
                    const priceTrend2 = recentPrices2[recentPrices2.length - 1] > recentPrices2[0];
                    const obvTrend2 = recentOBV2[recentOBV2.length - 1] > recentOBV2[0];
                    
                    if (priceTrend2 && obvTrend2) {
                      obvPriceAnalysis2 = 'Price+OBV up = STRONG';
                    } else if (priceTrend2 && !obvTrend2) {
                      obvPriceAnalysis2 = 'Price up, OBV down = DIVERGENCE';
                    } else if (priceTrend2 && Math.abs(recentOBV2[recentOBV2.length - 1] - recentOBV2[0]) / Math.abs(recentOBV2[0]) < 0.1) {
                      obvPriceAnalysis2 = 'Price up, OBV flat = WEAK';
                    }
                  }
                } else {
                  console.log(`    OBV values empty: obv1=${obv1Values?.length || 0}, obv2=${obv2Values?.length || 0}`);
                }
              } catch (obvError) {
                console.log(`    OBV error: ${obvError.message}`);
              }
            } else {
              console.log(`    OBV skipped: volumes too low`);
            }
          }
          
          // Determine trade signal - use proper thresholds
          // For LONG: want Z < -1 (undervalued, good for long)
          // For SHORT: want Z > 1 (overvalued, good for short)
          const leftSideUndervalued = pair.direction === 'long' ? zScore < -1 : false;
          const leftSideOvervalued = pair.direction === 'short' ? zScore > 1 : false;
          const tradeReady = pair.direction === 'short' ? leftSideOvervalued : leftSideUndervalued;
          
          // Get price at start and end of period
          const price1Start = prices1[0];
          const price1End = prices1[prices1.length - 1];
          const price2Start = prices2[0];
          const price2End = prices2[prices2.length - 1];
          
          // Fetch market cap for this timeframe (use historical data if available, otherwise estimate from price)
          let mcap1 = null, mcap2 = null;
          try {
            // For historical mcap, we'd need historical data - for now use current mcap as proxy
            // Or calculate from price if we have supply data
            mcap1 = currentMcap1; // Using current as proxy for now
            mcap2 = currentMcap2;
          } catch (e) {
            // Ignore
          }
          
          // Calculate hedge ratio (beta is the hedge ratio - how much of asset2 per $1 of asset1)
          const hedgeRatio = beta;
          
          pairResults.timeframes[days] = {
            days: days,
            correlation: correlation,
            beta: beta,
            hedgeRatio: hedgeRatio,
            gamma: gamma,
            theta: theta,
            zScore: zScore,
            currentSpread: currentSpread,
            isCointegrated: isCointegrated,
            price1Start: price1Start,
            price1End: price1End,
            price2Start: price2Start,
            price2End: price2End,
            mcap1: mcap1,
            mcap2: mcap2,
            obv1ChangePct: obv1ChangePct,
            obv2ChangePct: obv2ChangePct,
            obv1Change: obv1Change,
            obv2Change: obv2Change,
            obv1Trend: obv1Trend,
            obv2Trend: obv2Trend,
            obv1Start: obv1Values && obv1Values.length > 0 ? obv1Values[0] : null,
            obv1End: obv1Values && obv1Values.length > 0 ? obv1Values[obv1Values.length - 1] : null,
            obv2Start: obv2Values && obv2Values.length > 0 ? obv2Values[0] : null,
            obv2End: obv2Values && obv2Values.length > 0 ? obv2Values[obv2Values.length - 1] : null,
            totalVol1: volumes1Sum,
            totalVol2: volumes2Sum,
            obvPriceAnalysis1: obvPriceAnalysis1,
            obvPriceAnalysis2: obvPriceAnalysis2,
            leftSideUndervalued: leftSideUndervalued,
            leftSideOvervalued: leftSideOvervalued,
            tradeReady: tradeReady
          };
        } catch (error) {
          console.log(`  Error for ${days}-day: ${error.message}`);
          pairResults.timeframes[days] = {
            days: days,
            error: error.message
          };
        }
      }
      
      // Calculate OBV for 7d and 30d timeframes separately
      console.log(`  Calculating OBV for 7d and 30d periods...`);
      for (const obvDays of obvTimeframes) {
        if (!pairResults.timeframes[obvDays]) {
          pairResults.timeframes[obvDays] = { days: obvDays };
        }
        
        try {
          // Extract OBV values for this timeframe from the cumulative calculation
          if (fullOBV1 && fullOBV2 && fullOBV1.length >= obvDays && fullOBV2.length >= obvDays) {
            const obv1Slice = fullOBV1.slice(-obvDays);
            const obv2Slice = fullOBV2.slice(-obvDays);
            const vol1Slice = fullVolumes1.slice(-obvDays);
            const vol2Slice = fullVolumes2.slice(-obvDays);
            
            const obv1Start = obv1Slice[0];
            const obv1End = obv1Slice[obv1Slice.length - 1];
            const obv2Start = obv2Slice[0];
            const obv2End = obv2Slice[obv2Slice.length - 1];
            
            const obv1Change = obv1End - obv1Start;
            const obv2Change = obv2End - obv2Start;
            const obv1Trend = obv1Change > 0 ? 'Accumulating' : obv1Change < 0 ? 'Distributing' : 'Neutral';
            const obv2Trend = obv2Change > 0 ? 'Accumulating' : obv2Change < 0 ? 'Distributing' : 'Neutral';
            
            const volumes1Sum = vol1Slice.reduce((sum, v) => sum + Math.abs(v || 0), 0);
            const volumes2Sum = vol2Slice.reduce((sum, v) => sum + Math.abs(v || 0), 0);
            
            pairResults.timeframes[obvDays].obv1Change = obv1Change;
            pairResults.timeframes[obvDays].obv2Change = obv2Change;
            pairResults.timeframes[obvDays].obv1Trend = obv1Trend;
            pairResults.timeframes[obvDays].obv2Trend = obv2Trend;
            pairResults.timeframes[obvDays].obv1Start = obv1Start;
            pairResults.timeframes[obvDays].obv1End = obv1End;
            pairResults.timeframes[obvDays].obv2Start = obv2Start;
            pairResults.timeframes[obvDays].obv2End = obv2End;
            pairResults.timeframes[obvDays].totalVol1 = volumes1Sum;
            pairResults.timeframes[obvDays].totalVol2 = volumes2Sum;
          }
        } catch (error) {
          console.log(`  Error calculating OBV for ${obvDays}d: ${error.message}`);
        }
      }
      
      // Disconnect Hyperliquid if we connected (suppress WebSocket noise)
      if (sdk) {
        const disconnectLog = console.log;
        const disconnectError = console.error;
        try {
          const noop = () => {};
          console.log = noop;
          console.error = noop;
          
          await sdk.disconnect();
          
          console.log = disconnectLog;
          console.error = disconnectError;
          console.log(`  Disconnected from Hyperliquid for ${pair.name}`);
        } catch (error) {
          // Restore console
          console.log = disconnectLog;
          console.error = disconnectError;
          // Ignore disconnect errors
        }
      }
      
      results.push(pairResults);
    }
    
    generateReport(results);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

function generateReport(results) {
  const obvTimeframes = [7, 30];
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  // Generate executive summary
  const summary = results.map(pair => {
    const bestTimeframe = Object.values(pair.timeframes)
      .filter(tf => !tf.error && tf.correlation !== undefined && [30, 90, 180].includes(tf.days))
      .sort((a, b) => {
        if (pair.direction === 'long') {
          return a.zScore - b.zScore; // Lower is better for long
        } else {
          return b.zScore - a.zScore; // Higher is better for short
        }
      })[0];
    
    const signal = bestTimeframe ? (pair.direction === 'long' 
      ? (bestTimeframe.zScore < -1 ? 'READY' : 'WAIT')
      : (bestTimeframe.zScore > 1 ? 'READY' : 'WAIT')) : 'NO DATA';
    
    return `| **${pair.pair}** | ${pair.direction === 'long' ? `LONG ${pair.leftSide}` : `SHORT ${pair.leftSide}`} | ${bestTimeframe ? bestTimeframe.zScore.toFixed(2) : 'N/A'} | ${signal} |`;
  }).join('\n');
  
  const report = `# Pair Trading Analysis Report

**Generated:** ${dateStr}

---

## Executive Summary

| Pair | Strategy | Best Z-Score | Signal |
|------|----------|-------------|--------|
${summary}

---

${results.map(pair => {
  const directionText = pair.direction === 'long' 
    ? `**LONG ${pair.leftSide} / SHORT ${pair.symbol2}**` 
    : `**SHORT ${pair.leftSide} / LONG ${pair.symbol2}**`;
  
  // Get best signal across timeframes
  const allTimeframes = Object.values(pair.timeframes)
    .filter(tf => !tf.error && tf.correlation !== undefined && [7, 30, 90, 180].includes(tf.days))
    .sort((a, b) => a.days - b.days);
  
  const bestSignal = allTimeframes.find(tf => 
    pair.direction === 'long' ? tf.zScore < -1 : tf.zScore > 1
  );
  
  const signalStatus = bestSignal 
    ? `**TRADE READY** (${bestSignal.days}d Z-score: ${bestSignal.zScore.toFixed(2)})`
    : `**WAIT** (No strong signal across timeframes)`;
  
  const summaryTable = `## ${pair.pair}

${directionText}

**Current Prices & Market Caps:**
- **${pair.symbol1}:** $${pair.currentPrice1?.toFixed(2) || 'N/A'} ($${(pair.currentMcap1 / 1e9).toFixed(2)}B)
- **${pair.symbol2}:** $${pair.currentPrice2?.toFixed(2) || 'N/A'} ($${(pair.currentMcap2 / 1e9).toFixed(2)}B)

**Signal Status:** ${signalStatus}

### Statistical Metrics

| Timeframe | Correlation | Beta | Z-Score | Cointegrated | Hedge Ratio | Gamma | Theta |
|-----------|-------------|------|---------|--------------|-------------|-------|-------|
${allTimeframes.map(tf => {
  const corr = tf.correlation !== null && tf.correlation !== undefined ? tf.correlation.toFixed(3) : 'N/A';
  const beta = tf.beta !== null && tf.beta !== undefined ? tf.beta.toFixed(3) : 'N/A';
  const zScore = tf.zScore !== null && tf.zScore !== undefined ? tf.zScore.toFixed(2) : 'N/A';
  const hedgeRatio = tf.hedgeRatio !== null && tf.hedgeRatio !== undefined ? tf.hedgeRatio.toFixed(3) : 'N/A';
  const gamma = tf.gamma !== null && tf.gamma !== undefined ? tf.gamma.toFixed(3) : 'N/A';
  const theta = tf.theta !== null && tf.theta !== undefined ? tf.theta.toFixed(3) : 'N/A';
  const coint = tf.isCointegrated ? 'Yes' : 'No';
  
  // Add signal indicator
  let signal = '';
  if (pair.direction === 'long' && tf.zScore < -1) signal = ' [READY]';
  else if (pair.direction === 'short' && tf.zScore > 1) signal = ' [READY]';
  
  return `| **${tf.days}d** | ${corr} | ${beta} | ${zScore}${signal} | ${coint} | ${hedgeRatio} | ${gamma} | ${theta} |`;
}).join('\n')}

### Price Movement

| Timeframe | ${pair.symbol1} | ${pair.symbol2} |
|-----------|----------------|-----------------|
${allTimeframes.map(tf => {
  const price1Start = tf.price1Start ? tf.price1Start.toFixed(2) : 'N/A';
  const price1End = tf.price1End ? tf.price1End.toFixed(2) : 'N/A';
  const price2Start = tf.price2Start ? tf.price2Start.toFixed(2) : 'N/A';
  const price2End = tf.price2End ? tf.price2End.toFixed(2) : 'N/A';
  const change1 = tf.price1Start && tf.price1End ? (((tf.price1End - tf.price1Start) / tf.price1Start) * 100).toFixed(1) : 'N/A';
  const change2 = tf.price2Start && tf.price2End ? (((tf.price2End - tf.price2Start) / tf.price2Start) * 100).toFixed(1) : 'N/A';
  return `| **${tf.days}d** | $${price1Start} → $${price1End} (${change1}%) | $${price2Start} → $${price2End} (${change2}%) |`;
}).join('\n')}
`;

  // OBV section
  const obvRows = Object.values(pair.timeframes)
    .filter(tf => !tf.error && tf.obv1Change !== null && obvTimeframes.includes(tf.days))
    .sort((a, b) => a.days - b.days);
  
  const obvDetails = obvRows.length > 0 ? `
### On-Balance Volume (OBV)

| Timeframe | ${pair.symbol1} OBV | ${pair.symbol2} OBV |
|-----------|-------------------|-------------------|
${obvRows.map(tf => {
    const obv1 = tf.obv1Change !== null && tf.obv1Change !== undefined 
      ? (tf.obv1Change > 0 ? '+' : '') + tf.obv1Change.toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const obv2 = tf.obv2Change !== null && tf.obv2Change !== undefined 
      ? (tf.obv2Change > 0 ? '+' : '') + tf.obv2Change.toLocaleString('en-US', {maximumFractionDigits: 0}) 
      : 'N/A';
    const trend1 = tf.obv1Change > 0 ? '+' : tf.obv1Change < 0 ? '-' : '';
    const trend2 = tf.obv2Change > 0 ? '+' : tf.obv2Change < 0 ? '-' : '';
    return `| **${tf.days}d** | ${trend1}${obv1} | ${trend2}${obv2} |`;
  }).join('\n')}
` : '';

  return summaryTable + obvDetails;
}).join('\n\n---\n\n')}

---

## Notes

- **Z-Score:** Negative = left token undervalued (good for LONG), Positive = left token overvalued (good for SHORT)
- **Gamma:** Lower = more stable hedge ratio (better)
- **Theta:** Higher = faster mean reversion (better)
- **OBV:** Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
- **Cointegration:** Yes = pair moves together (better for pair trading)

*Data sources: Hyperliquid (prices), CryptoCompare (OBV/volume)*
`;

  const reportsDir = 'reports';
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  fs.writeFileSync(`${reportsDir}/pair_obv_analysis.md`, report);
  
  console.log('\nANALYSIS COMPLETE');
  console.log(`Report saved to: ${reportsDir}/pair_obv_analysis.md`);
  
  results.forEach(pair => {
    console.log(`\n${pair.pair}:`);
    Object.values(pair.timeframes).forEach(tf => {
      if (tf.error) {
        console.log(`  ${tf.days}d: ERROR - ${tf.error}`);
      } else {
        const status = pair.direction === 'short' 
          ? (tf.leftSideOvervalued ? 'OVERVALUED [READY]' : 'NOT OVERVALUED [WAIT]')
          : (tf.leftSideUndervalued ? 'UNDERVALUED [READY]' : 'NOT UNDERVALUED [WAIT]');
        const corr = tf.correlation !== null && tf.correlation !== undefined ? tf.correlation.toFixed(3) : 'N/A';
        const beta = tf.beta !== null && tf.beta !== undefined ? tf.beta.toFixed(3) : 'N/A';
        const z = tf.zScore !== null && tf.zScore !== undefined ? tf.zScore.toFixed(2) : 'N/A';
        console.log(`  ${tf.days}d: Corr ${corr}, Beta ${beta}, Z ${z}, ${pair.leftSide} ${status}, OBV: ${tf.obv1Trend || 'N/A'}`);
      }
    });
  });
}

analyzePairs();

