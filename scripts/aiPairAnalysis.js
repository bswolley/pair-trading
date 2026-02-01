#!/usr/bin/env node

/**
 * AI Pair Analysis Agent
 * 
 * Standalone script to analyze a pair using on-chain data + AI synthesis
 * 
 * Usage:
 *   node scripts/aiPairAnalysis.js <ASSET1> <ASSET2>
 *   node scripts/aiPairAnalysis.js LINEA POL
 *   node scripts/aiPairAnalysis.js ARB OP --json
 * 
 * Options:
 *   --json    Output raw JSON instead of formatted report
 *   --no-ai   Skip AI synthesis, just show collected data
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { fetchAllDataForSymbol } = require('../lib/ai/dataCollectors');
const { synthesizePairData } = require('../lib/ai/grok');

// Try to get pair context from watchlist
async function getPairContext(asset1, asset2) {
    try {
        const db = require('../server/db/queries');
        const pair = `${asset1}/${asset2}`;
        const watchlistPair = await db.getWatchlistPair(pair);

        if (watchlistPair) {
            return {
                correlation: watchlistPair.correlation,
                halfLife: watchlistPair.half_life || watchlistPair.halfLife,
                zScore: watchlistPair.z_score || watchlistPair.zScore,
                hurst: watchlistPair.hurst,
                isCointegrated: watchlistPair.is_cointegrated || true,
                entryThreshold: watchlistPair.entry_threshold || watchlistPair.entryThreshold,
                fromWatchlist: true
            };
        }
    } catch (e) {
        // DB not available, continue without context
    }

    // Try to get from analyze if available
    try {
        const { checkPairFitness, calculateHurst } = require('../lib/pairAnalysis');
        const { Hyperliquid } = require('hyperliquid');

        const sdk = new Hyperliquid();
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => { };
        console.error = () => { };
        await sdk.connect();
        console.log = origLog;
        console.error = origErr;

        const endTime = Date.now();
        const startTime = endTime - (35 * 24 * 60 * 60 * 1000);

        const [candles1, candles2] = await Promise.all([
            sdk.info.getCandleSnapshot(`${asset1}-PERP`, '1d', startTime, endTime),
            sdk.info.getCandleSnapshot(`${asset2}-PERP`, '1d', startTime, endTime)
        ]);

        console.log = () => { };
        console.error = () => { };
        await sdk.disconnect();
        console.log = origLog;
        console.error = origErr;

        if (candles1?.length >= 20 && candles2?.length >= 20) {
            const prices1 = candles1.sort((a, b) => a.t - b.t).map(c => parseFloat(c.c));
            const prices2 = candles2.sort((a, b) => a.t - b.t).map(c => parseFloat(c.c));

            const fitness = checkPairFitness(prices1.slice(-30), prices2.slice(-30));

            // Calculate Hurst on spread
            let hurst = null;
            if (prices1.length >= 40 && prices2.length >= 40) {
                const hurstLen = Math.min(prices1.length, prices2.length, 60);
                const spreads = [];
                for (let i = 0; i < hurstLen; i++) {
                    const idx = prices1.length - hurstLen + i;
                    spreads.push(Math.log(prices1[idx]) - fitness.beta * Math.log(prices2[idx]));
                }
                const hurstResult = calculateHurst(spreads);
                if (hurstResult.isValid) {
                    hurst = hurstResult.hurst;
                }
            }

            return {
                correlation: fitness.correlation,
                halfLife: fitness.halfLife,
                zScore: fitness.zScore,
                hurst: hurst,
                isCointegrated: fitness.isCointegrated,
                fromLiveData: true
            };
        }
    } catch (e) {
        // Continue without context
    }

    return {
        correlation: null,
        halfLife: null,
        zScore: null,
        hurst: null,
        isCointegrated: null,
        fromLiveData: false,
        fromWatchlist: false
    };
}

/**
 * Generate formatted report
 */
function generateReport(asset1Data, asset2Data, pairContext, aiAnalysis) {
    const timestamp = new Date().toISOString();
    const pair = `${asset1Data.symbol}/${asset2Data.symbol}`;

    // Determine trade direction from Z-score
    const zScore = parseFloat(pairContext?.zScore) || 0;
    const tradeDir = zScore >= 0
        ? { long: asset2Data.symbol, short: asset1Data.symbol, desc: `Short ${asset1Data.symbol} / Long ${asset2Data.symbol}` }
        : { long: asset1Data.symbol, short: asset2Data.symbol, desc: `Long ${asset1Data.symbol} / Short ${asset2Data.symbol}` };

    let report = `
╔══════════════════════════════════════════════════════════════════╗
║              AI PAIR ANALYSIS REPORT                             ║
║              ${pair.padEnd(20)} ${timestamp.split('T')[0]}             ║
║              ${tradeDir.desc.padEnd(42)}   ║
╚══════════════════════════════════════════════════════════════════╝

`;

    // AI Recommendation (if available)
    if (aiAnalysis?.available && aiAnalysis.analysis) {
        const a = aiAnalysis.analysis;
        const recEmoji = a.recommendation === 'APPROVE' ? '✅' :
            a.recommendation === 'REJECT' ? '❌' : '⚠️';

        report += `
┌──────────────────────────────────────────────────────────────────┐
│  AI RECOMMENDATION: ${recEmoji} ${a.recommendation.padEnd(10)} (Confidence: ${(a.confidence * 100).toFixed(0)}%)         │
├──────────────────────────────────────────────────────────────────┤
│  ${a.summary?.substring(0, 64) || 'No summary'}
│  ${a.summary?.substring(64, 128) || ''}
└──────────────────────────────────────────────────────────────────┘
`;

        // Entry Timing Analysis (Z-Score based)
        if (a.entryTiming) {
            const entryEmoji = a.entryTiming.recommendation === 'ENTER_NOW' ? '🟢' :
                a.entryTiming.recommendation === 'WAIT' ? '🟡' : '🔴';
            report += `
ENTRY TIMING (Z-Score Analysis):
  Current Z: ${a.entryTiming.currentZScore || statisticalContext?.zScore || 'N/A'}
  Signal: ${a.entryTiming.signal || 'N/A'}
  ${entryEmoji} ${a.entryTiming.recommendation || 'N/A'}: ${a.entryTiming.reasoning || ''}
  ${a.entryTiming.recommendation === 'WAIT' ? `Target Entry Z: ${a.entryTiming.targetZScore || '|Z| > 1.5'}` : ''}
`;
        }

        if (a.riskFactors?.length > 0) {
            report += `
RISK FACTORS:
`;
            for (const risk of a.riskFactors) {
                const sevEmoji = risk.severity === 'HIGH' ? '🔴' :
                    risk.severity === 'MEDIUM' ? '🟡' : '🟢';
                report += `  ${sevEmoji} [${risk.severity}] ${risk.factor}: ${risk.description}\n`;
            }
        }

        if (a.tokenUnlocks) {
            report += `
TOKEN UNLOCKS (from AI web search):
`;
            const tu = a.tokenUnlocks;
            if (tu.asset1?.hasUpcoming) {
                report += `  ${asset1Data.symbol}: ${tu.asset1.nextUnlock || 'Soon'} - ${tu.asset1.amount || 'Unknown amount'} (${tu.asset1.type || 'Unknown type'})\n`;
            } else {
                report += `  ${asset1Data.symbol}: No major unlocks found in next 90 days\n`;
            }
            if (tu.asset2?.hasUpcoming) {
                report += `  ${asset2Data.symbol}: ${tu.asset2.nextUnlock || 'Soon'} - ${tu.asset2.amount || 'Unknown amount'} (${tu.asset2.type || 'Unknown type'})\n`;
            } else {
                report += `  ${asset2Data.symbol}: No major unlocks found in next 90 days\n`;
            }
            if (tu.asymmetryRisk && tu.asymmetryRisk !== 'NONE') {
                const riskEmoji = tu.asymmetryRisk === 'HIGH' ? '🔴' : tu.asymmetryRisk === 'MEDIUM' ? '🟡' : '🟢';
                report += `  Asymmetry Risk: ${riskEmoji} ${tu.asymmetryRisk}\n`;
            }
            if (tu.notes) {
                report += `  Note: ${tu.notes}\n`;
            }
        }

        // Sentiment Analysis Section
        if (a.sentiment) {
            report += `
SENTIMENT ANALYSIS (from X/Twitter):
`;
            const s = a.sentiment;

            // Asset 1 sentiment
            const sent1Emoji = s.asset1?.sentiment === 'BULLISH' ? '🟢' :
                s.asset1?.sentiment === 'BEARISH' ? '🔴' : '⚪';
            report += `  ${asset1Data.symbol}: ${sent1Emoji} ${s.asset1?.sentiment || 'N/A'}\n`;
            if (s.asset1?.keyNews?.length > 0) {
                report += `    News: ${s.asset1.keyNews.slice(0, 2).join('; ')}\n`;
            }
            if (s.asset1?.redFlags?.length > 0) {
                report += `    ⚠️ Red Flags: ${s.asset1.redFlags.join('; ')}\n`;
            }

            // Asset 2 sentiment
            const sent2Emoji = s.asset2?.sentiment === 'BULLISH' ? '🟢' :
                s.asset2?.sentiment === 'BEARISH' ? '🔴' : '⚪';
            report += `  ${asset2Data.symbol}: ${sent2Emoji} ${s.asset2?.sentiment || 'N/A'}\n`;
            if (s.asset2?.keyNews?.length > 0) {
                report += `    News: ${s.asset2.keyNews.slice(0, 2).join('; ')}\n`;
            }
            if (s.asset2?.redFlags?.length > 0) {
                report += `    ⚠️ Red Flags: ${s.asset2.redFlags.join('; ')}\n`;
            }

            // Divergence
            if (s.divergence) {
                report += `  Divergence: ${s.divergence}\n`;
            }
            if (s.tradingImplication) {
                report += `  Trade Impact: ${s.tradingImplication}\n`;
            }
        }

        if (a.monitoringPoints?.length > 0) {
            report += `
MONITORING POINTS:
`;
            for (const point of a.monitoringPoints) {
                report += `  • ${point}\n`;
            }
        }
    } else if (aiAnalysis?.fallback) {
        report += `
┌──────────────────────────────────────────────────────────────────┐
│  ⚠️  AI SYNTHESIS UNAVAILABLE - AUTOMATED RISK CHECK ONLY        │
└──────────────────────────────────────────────────────────────────┘
`;
        if (aiAnalysis.fallback.riskFactors?.length > 0) {
            report += `
DETECTED RISKS:
`;
            for (const risk of aiAnalysis.fallback.riskFactors) {
                const sevEmoji = risk.severity === 'HIGH' ? '🔴' :
                    risk.severity === 'MEDIUM' ? '🟡' : '🟢';
                report += `  ${sevEmoji} [${risk.severity}] ${risk.factor}: ${risk.description}\n`;
            }
        }
    }

    // Statistical Context
    report += `
═══════════════════════════════════════════════════════════════════
STATISTICAL CONTEXT
═══════════════════════════════════════════════════════════════════
`;
    if (pairContext.fromWatchlist || pairContext.fromLiveData) {
        report += `  Source: ${pairContext.fromWatchlist ? 'Watchlist' : 'Live Calculation'}
  Correlation: ${pairContext.correlation?.toFixed(3) || 'N/A'}
  Half-Life: ${pairContext.halfLife?.toFixed(1) || 'N/A'} days
  Z-Score: ${pairContext.zScore?.toFixed(2) || 'N/A'}
  Hurst: ${pairContext.hurst?.toFixed(3) || 'N/A'}
  Cointegrated: ${pairContext.isCointegrated ? 'Yes' : 'No'}
`;
    } else {
        report += `  No statistical context available (pair not in watchlist)
`;
    }

    // Asset 1 Data
    report += `
═══════════════════════════════════════════════════════════════════
ASSET 1: ${asset1Data.symbol}
═══════════════════════════════════════════════════════════════════
`;
    report += formatAssetSection(asset1Data);

    // Asset 2 Data
    report += `
═══════════════════════════════════════════════════════════════════
ASSET 2: ${asset2Data.symbol}
═══════════════════════════════════════════════════════════════════
`;
    report += formatAssetSection(asset2Data);

    // Comparison
    report += `
═══════════════════════════════════════════════════════════════════
COMPARISON
═══════════════════════════════════════════════════════════════════
`;
    report += generateComparison(asset1Data, asset2Data);

    report += `
═══════════════════════════════════════════════════════════════════
Generated: ${timestamp}
Data Sources: CoinGecko, DeFiLlama, Hyperliquid
AI: ${aiAnalysis?.available ? 'Grok (xAI)' : 'Not configured'}
═══════════════════════════════════════════════════════════════════
`;

    // Append raw AI response if available (for debugging)
    if (aiAnalysis?.rawResponse) {
        report += `

═══════════════════════════════════════════════════════════════════
RAW AI RESPONSE (for debugging)
═══════════════════════════════════════════════════════════════════
${aiAnalysis.rawResponse}
═══════════════════════════════════════════════════════════════════
`;
    }

    return report;
}

function formatAssetSection(data) {
    let section = '';

    // Metrics
    if (data.metrics?.available) {
        const m = data.metrics;
        section += `
MARKET METRICS:
  Market Cap: ${m.marketCapFormatted}
  24h Volume: ${m.volume24hFormatted}
  Price: $${m.price?.toFixed(6) || 'N/A'}
  
  Price Changes:
    24h: ${m.priceChange24h}
    7d:  ${m.priceChange7d}
    30d: ${m.priceChange30d}
  
  Supply: ${m.circulatingPercent} circulating
  ATH: $${m.ath?.toFixed(4) || 'N/A'} (${m.athChangePercent} from ATH)
  ${m.githubCommits4w ? `Dev Activity: ${m.githubCommits4w} commits (4w)` : ''}
  ${m.twitterFollowers ? `Twitter: ${m.twitterFollowers.toLocaleString()} followers` : ''}
  Categories: ${m.categories?.join(', ') || 'N/A'}
`;
    } else {
        section += `\nMARKET METRICS: Not available (${data.metrics?.reason || 'Unknown'})\n`;
    }

    // TVL
    if (data.tvl?.available) {
        if (data.tvl.type === 'chain') {
            section += `
CHAIN TVL (DeFiLlama):
  Chain: ${data.tvl.chain}
  Total TVL: ${data.tvl.tvlFormatted}
  7d Change: ${data.tvl.weekChange}
  30d Change: ${data.tvl.monthChange}
`;
        } else {
            section += `
PROTOCOL TVL (DeFiLlama):
  Protocol: ${data.tvl.protocol}
  Current TVL: ${data.tvl.tvlFormatted}
  7d Change: ${data.tvl.weekChange}
  30d Change: ${data.tvl.monthChange}
  Category: ${data.tvl.category || 'N/A'}
`;
        }
    } else {
        section += `\nTVL DATA: Not available (${data.tvl?.reason || 'No mapping'})\n`;
    }

    // Funding
    if (data.funding?.available) {
        section += `
HYPERLIQUID:
  Funding (8h): ${data.funding.funding8hPercent}
  Funding (Ann): ${data.funding.fundingAnnualized}
  Open Interest: ${data.funding.openInterestFormatted}
  24h Volume: ${data.funding.volume24hFormatted}
`;
    } else {
        section += `\nHYPERLIQUID: Not available (${data.funding?.reason || 'Unknown'})\n`;
    }

    // Unlocks
    if (data.unlocks?.available) {
        if (data.unlocks.source === 'tokenunlocks_api') {
            if (data.unlocks.hasUpcoming) {
                section += `
TOKEN UNLOCKS: ⚠️ UPCOMING (from TokenUnlocks API)
  Date: ${data.unlocks.nextUnlock}
  Amount: ${data.unlocks.amount}
  % of Supply: ${data.unlocks.percentOfSupply}
  Type: ${data.unlocks.type}
`;
            } else {
                section += `\nTOKEN UNLOCKS: No significant unlocks in next 90 days\n`;
            }
        } else if (data.unlocks.source === 'coingecko_supply') {
            section += `
TOKEN UNLOCK ESTIMATE (from supply data):
  Circulating: ${data.unlocks.circulatingPercent}
  Remaining to Vest: ${data.unlocks.remainingToVest}
  ${data.unlocks.note}
  → ${data.unlocks.recommendation || 'Check tokenomist.ai for schedule'}
`;
        } else if (data.unlocks.hasUpcoming) {
            section += `
TOKEN UNLOCKS: ⚠️ UPCOMING
  Date: ${data.unlocks.nextUnlock}
  Amount: ${data.unlocks.amount}
  % of Supply: ${data.unlocks.percentOfSupply}
  Type: ${data.unlocks.type}
`;
        } else {
            section += `\nTOKEN UNLOCKS: No significant upcoming unlocks\n`;
        }
    } else {
        section += `\nTOKEN UNLOCKS: ${data.unlocks?.reason || 'Data not available'}
  ${data.unlocks?.note || ''}\n`;
    }

    return section;
}

function generateComparison(asset1Data, asset2Data) {
    let comp = '';

    // Market Cap Comparison
    if (asset1Data.metrics?.available && asset2Data.metrics?.available) {
        const mc1 = asset1Data.metrics.marketCap || 0;
        const mc2 = asset2Data.metrics.marketCap || 0;
        const ratio = mc1 / mc2;
        comp += `
Market Cap Ratio: ${ratio.toFixed(2)}x (${asset1Data.symbol}/${asset2Data.symbol})
  ${asset1Data.symbol}: ${asset1Data.metrics.marketCapFormatted}
  ${asset2Data.symbol}: ${asset2Data.metrics.marketCapFormatted}
`;
    }

    // Volume Comparison
    if (asset1Data.metrics?.available && asset2Data.metrics?.available) {
        const v1 = asset1Data.metrics.volume24h || 0;
        const v2 = asset2Data.metrics.volume24h || 0;
        const ratio = v1 / v2;
        comp += `
Volume Ratio: ${ratio.toFixed(2)}x
  ${asset1Data.symbol}: ${asset1Data.metrics.volume24hFormatted}
  ${asset2Data.symbol}: ${asset2Data.metrics.volume24hFormatted}
`;
    }

    // Funding Spread
    if (asset1Data.funding?.available && asset2Data.funding?.available) {
        const spread = asset1Data.funding.funding8h - asset2Data.funding.funding8h;
        const spreadAnn = spread * 3 * 365 * 100;
        comp += `
Funding Spread: ${(spread * 100).toFixed(4)}% per 8h (${spreadAnn.toFixed(1)}% annualized)
  ${asset1Data.symbol}: ${asset1Data.funding.funding8hPercent}
  ${asset2Data.symbol}: ${asset2Data.funding.funding8hPercent}
  Net (Long ${asset1Data.symbol}): ${spread >= 0 ? 'You PAY' : 'You RECEIVE'} ${Math.abs(spread * 100).toFixed(4)}%
`;
    }

    // TVL Comparison (if both DeFi)
    if (asset1Data.tvl?.available && asset2Data.tvl?.available) {
        comp += `
TVL Comparison:
  ${asset1Data.symbol}: ${asset1Data.tvl.tvlFormatted} (${asset1Data.tvl.weekChange} 7d)
  ${asset2Data.symbol}: ${asset2Data.tvl.tvlFormatted} (${asset2Data.tvl.weekChange} 7d)
`;
    }

    // Unlock/Vesting Analysis
    const unlock1 = asset1Data.unlocks;
    const unlock2 = asset2Data.unlocks;

    if (unlock1?.available || unlock2?.available) {
        comp += `
Token Vesting Analysis:
`;
        // Check remaining supply to vest
        const remaining1 = unlock1?.remainingToVest ? parseFloat(unlock1.remainingToVest) : null;
        const remaining2 = unlock2?.remainingToVest ? parseFloat(unlock2.remainingToVest) : null;

        if (remaining1 !== null && remaining2 !== null) {
            comp += `  ${asset1Data.symbol}: ${unlock1.circulatingPercent} circulating (${unlock1.remainingToVest} locked)\n`;
            comp += `  ${asset2Data.symbol}: ${unlock2.circulatingPercent} circulating (${unlock2.remainingToVest} locked)\n`;

            if (Math.abs(remaining1 - remaining2) > 15) {
                const higher = remaining1 > remaining2 ? asset1Data.symbol : asset2Data.symbol;
                comp += `  ⚠️ ${higher} has significantly more supply locked - higher dilution risk\n`;
            }
        } else if (unlock1?.hasUpcoming && !unlock2?.hasUpcoming) {
            comp += `  ⚠️ ${asset1Data.symbol} has upcoming unlock, ${asset2Data.symbol} does not\n`;
        } else if (unlock2?.hasUpcoming && !unlock1?.hasUpcoming) {
            comp += `  ✅ ${asset2Data.symbol} has upcoming unlock, ${asset1Data.symbol} does not\n`;
        }

        comp += `  → Check tokenomist.ai for detailed schedules\n`;
    }

    return comp;
}

/**
 * Main entry point
 */
async function main() {
    const args = process.argv.slice(2);

    // Parse options
    const jsonOutput = args.includes('--json');
    const skipAI = args.includes('--no-ai');

    // Get asset symbols
    const symbols = args.filter(a => !a.startsWith('--'));

    if (symbols.length < 2) {
        console.log(`
AI Pair Analysis Agent
======================

Usage:
  node scripts/aiPairAnalysis.js <ASSET1> <ASSET2> [options]

Examples:
  node scripts/aiPairAnalysis.js LINEA POL
  node scripts/aiPairAnalysis.js ARB OP --json
  node scripts/aiPairAnalysis.js ETH SOL --no-ai

Options:
  --json    Output raw JSON instead of formatted report
  --no-ai   Skip AI synthesis, just show collected data

Environment:
  XAI_API_KEY    Required for AI synthesis (Grok)
`);
        process.exit(1);
    }

    const asset1 = symbols[0].toUpperCase();
    const asset2 = symbols[1].toUpperCase();

    console.log(`\n🔍 AI Pair Analysis: ${asset1}/${asset2}\n`);
    console.log('━'.repeat(50));

    // Step 1: Get statistical context
    console.log('\n📊 Fetching statistical context...');
    const pairContext = await getPairContext(asset1, asset2);
    if (pairContext.fromWatchlist) {
        console.log('   ✓ Found in watchlist');
    } else if (pairContext.fromLiveData) {
        console.log('   ✓ Calculated from live data');
    } else {
        console.log('   ⚠ No statistical context available');
    }

    // Step 2: Collect on-chain data
    console.log('\n📡 Collecting on-chain data...');
    const [asset1Data, asset2Data] = await Promise.all([
        fetchAllDataForSymbol(asset1),
        fetchAllDataForSymbol(asset2)
    ]);
    console.log('   ✓ Data collection complete');

    // Step 3: AI Synthesis
    let aiAnalysis = null;
    if (!skipAI) {
        console.log('\n🤖 Running AI synthesis...');
        if (!process.env.XAI_API_KEY) {
            console.log('   ⚠ XAI_API_KEY not configured - using fallback analysis');
        }
        aiAnalysis = await synthesizePairData(asset1Data, asset2Data, pairContext);
        if (aiAnalysis.available) {
            console.log('   ✓ AI analysis complete');
        } else {
            console.log(`   ⚠ AI unavailable: ${aiAnalysis.reason}`);
        }
    } else {
        console.log('\n🤖 AI synthesis skipped (--no-ai flag)');
    }

    console.log('\n' + '━'.repeat(50));

    // Step 4: Output
    if (jsonOutput) {
        const output = {
            pair: `${asset1}/${asset2}`,
            timestamp: new Date().toISOString(),
            context: pairContext,
            asset1: asset1Data,
            asset2: asset2Data,
            aiAnalysis: aiAnalysis
        };
        console.log(JSON.stringify(output, null, 2));
    } else {
        const report = generateReport(asset1Data, asset2Data, pairContext, aiAnalysis);
        console.log(report);

        // Save report to file
        const reportDir = path.join(__dirname, '..', 'ai_reports');
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }

        const filename = `${asset1}_${asset2}_${new Date().toISOString().split('T')[0]}.txt`;
        const filepath = path.join(reportDir, filename);
        fs.writeFileSync(filepath, report);
        console.log(`\n📄 Report saved: ${filepath}`);
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

