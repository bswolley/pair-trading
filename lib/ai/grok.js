/**
 * Grok AI Wrapper
 * 
 * Uses xAI's Grok API (OpenAI-compatible) for synthesis
 * Falls back to console output if no API key configured
 */

const OpenAI = require('openai');

let grokClient = null;

function getGrokClient() {
    if (grokClient) return grokClient;

    const apiKey = process.env.XAI_API_KEY;

    if (!apiKey) {
        console.warn('[GROK] No XAI_API_KEY configured - AI synthesis will be skipped');
        return null;
    }

    grokClient = new OpenAI({
        apiKey: apiKey,
        baseURL: 'https://api.x.ai/v1',
    });

    return grokClient;
}

/**
 * Query Grok for pair analysis synthesis
 */
async function synthesizePairData(asset1Data, asset2Data, pairContext) {
    const client = getGrokClient();

    if (!client) {
        return {
            available: false,
            reason: 'No XAI_API_KEY configured',
            fallback: generateFallbackAnalysis(asset1Data, asset2Data, pairContext)
        };
    }

    const prompt = buildSynthesisPrompt(asset1Data, asset2Data, pairContext);

    try {
        // Calculate date range for searches (today + 90 days)
        const today = new Date();
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + 90);

        const fromDate = today.toISOString().split('T')[0];
        const toDate = futureDate.toISOString().split('T')[0];

        const response = await client.chat.completions.create({
            model: process.env.GROK_MODEL || 'grok-4-fast',
            messages: [
                {
                    role: 'system',
                    content: `You are a quantitative crypto analyst specializing in pairs trading. 
You analyze ON-CHAIN and VERIFIED data to assess pair trade opportunities.
You focus on facts, not sentiment or speculation.
You are direct and concise.
Today's date is ${fromDate}. Only report FUTURE events (after today).
Always return valid JSON when requested.`
                },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 2000,
            // Search filters for web and X
            search_parameters: {
                // Web search - focus on authoritative unlock data sources
                allowed_domains: [
                    'tokenomist.ai',      // Primary unlock tracker (formerly tokenunlocks)
                    'tokenunlocks.app',   // Legacy domain
                    'defillama.com',
                    'coingecko.com',
                    'messari.io',
                    'unlocks.app'         // Another unlock tracker
                ],
                // X/Twitter search - filter by date range
                from_date: fromDate,
                to_date: toDate,
                // Exclude known bot/spam accounts
                excluded_x_handles: [
                    'cryptobotspam',
                    'airdrop_hunter'
                ]
            }
        });

        const content = response.choices[0]?.message?.content || '';

        // Log raw response if DEBUG enabled
        if (process.env.DEBUG_AI || process.env.DEBUG) {
            console.log('\n' + '='.repeat(80));
            console.log('RAW GROK RESPONSE:');
            console.log('='.repeat(80));
            console.log(content);
            console.log('='.repeat(80) + '\n');
        }

        // Try to extract JSON
        try {
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ||
                content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const json = jsonMatch[1] || jsonMatch[0];
                return {
                    available: true,
                    analysis: JSON.parse(json),
                    rawResponse: content
                };
            }
        } catch (e) {
            // Return raw response if JSON parse fails
        }

        return {
            available: true,
            analysis: null,
            rawResponse: content
        };

    } catch (error) {
        return {
            available: false,
            reason: error.message,
            fallback: generateFallbackAnalysis(asset1Data, asset2Data, pairContext)
        };
    }
}

/**
 * Build the synthesis prompt with all collected data
 */
function buildSynthesisPrompt(asset1Data, asset2Data, pairContext) {
    // Determine correct trade direction based on Z-score
    const zScore = parseFloat(pairContext.zScore) || 0;
    const tradeDirection = getTradeDirection(zScore, asset1Data.symbol, asset2Data.symbol);

    return `
PAIRS TRADE ANALYSIS REQUEST

═══════════════════════════════════════════════════════════════
PAIR: ${asset1Data.symbol} / ${asset2Data.symbol}
TRADE: ${tradeDirection.description}
(${tradeDirection.longAsset} Long ${tradeDirection.longPct}% / ${tradeDirection.shortAsset} Short ${tradeDirection.shortPct}%)
═══════════════════════════════════════════════════════════════

STATISTICAL CONTEXT (from quant system):
- Correlation: ${pairContext.correlation || 'N/A'}
- Half-Life: ${pairContext.halfLife || 'N/A'} days
- Z-Score: ${pairContext.zScore || 'N/A'} ${getZScoreInterpretation(pairContext.zScore)}
- Hurst Exponent: ${pairContext.hurst || 'N/A'} ${getHurstInterpretation(pairContext.hurst)}
- Cointegrated: ${pairContext.isCointegrated ? 'Yes' : 'No'}

TRADE DIRECTION (Z-score based):
- Current Z = ${zScore.toFixed(2)} → ${tradeDirection.reasoning}
- This trade: Long ${tradeDirection.longAsset}, Short ${tradeDirection.shortAsset}

Z-SCORE TRADING CONTEXT:
- Entry typically at |Z| > 1.5-2.0 (spread is stretched)
- Current Z=${pairContext.zScore || 'N/A'} means: ${getZScoreTradeSignal(pairContext.zScore)}
- Positive Z → Asset1 overvalued vs Asset2 → Short Asset1/Long Asset2
- Negative Z → Asset1 undervalued vs Asset2 → Long Asset1/Short Asset2

═══════════════════════════════════════════════════════════════
WEB SEARCH TASK - TOKEN UNLOCKS (CRITICAL)
═══════════════════════════════════════════════════════════════

Search for BOTH assets individually:

ASSET 1 (${asset1Data.symbol}):
- Search: "tokenomist.ai ${asset1Data.metrics?.name || asset1Data.symbol}"
- Search: "${asset1Data.metrics?.name || asset1Data.symbol} token unlock December 2025"
- Search: "${asset1Data.symbol} vesting schedule"

ASSET 2 (${asset2Data.symbol}):
- Search: "tokenomist.ai ${asset2Data.metrics?.name || asset2Data.symbol}"
- Search: "${asset2Data.metrics?.name || asset2Data.symbol} token unlock December 2025"
- Search: "${asset2Data.symbol} vesting schedule"

Report ALL upcoming unlocks (next 90 days) with:
- Exact date and time if available
- Amount (tokens + USD value)
- Type (team/investor/ecosystem/cliff)

IMPORTANT: Search EACH asset separately. Do not skip asset2.
If no future unlocks found for an asset, explicitly state "No upcoming unlocks found".

═══════════════════════════════════════════════════════════════════
X/TWITTER SENTIMENT & NEWS ANALYSIS
═══════════════════════════════════════════════════════════════════

Search X/Twitter for EACH asset (last 7 days):

ASSET 1 (${asset1Data.symbol}):
- Search: "${asset1Data.symbol} OR ${asset1Data.metrics?.name || asset1Data.symbol}" (recent posts)
- Look for: partnerships, launches, integrations, major news

ASSET 2 (${asset2Data.symbol}):
- Search: "${asset2Data.symbol} OR ${asset2Data.metrics?.name || asset2Data.symbol}" (recent posts)
- Look for: partnerships, launches, integrations, major news

Analyze and report:
1. SENTIMENT: Bullish/Bearish/Neutral for each asset
2. KEY NEWS: Any major announcements (partnerships, launches, etc.)
3. RED FLAGS: FUD, exploit rumors, team issues, regulatory concerns
4. SENTIMENT DIVERGENCE: Is one asset getting more positive/negative attention?

IMPORTANT: Focus on VERIFIED accounts and factual news, not random opinions.
Flag any potential manipulation (coordinated pumps, suspicious activity).

═══════════════════════════════════════════════════════════════
ASSET 1: ${asset1Data.symbol}
═══════════════════════════════════════════════════════════════

MARKET METRICS (CoinGecko):
${formatMetricsForPrompt(asset1Data.metrics)}

TVL DATA (DeFiLlama):
${formatTVLForPrompt(asset1Data.tvl)}

FUNDING RATE (Hyperliquid):
${formatFundingForPrompt(asset1Data.funding)}

SUPPLY DATA:
${formatUnlocksForPrompt(asset1Data.unlocks)}

═══════════════════════════════════════════════════════════════
ASSET 2: ${asset2Data.symbol}
═══════════════════════════════════════════════════════════════

MARKET METRICS (CoinGecko):
${formatMetricsForPrompt(asset2Data.metrics)}

TVL DATA (DeFiLlama):
${formatTVLForPrompt(asset2Data.tvl)}

FUNDING RATE (Hyperliquid):
${formatFundingForPrompt(asset2Data.funding)}

SUPPLY DATA:
${formatUnlocksForPrompt(asset2Data.unlocks)}

═══════════════════════════════════════════════════════════════
ANALYSIS REQUEST
═══════════════════════════════════════════════════════════════

Using the data above AND your web search results, analyze:

1. Z-SCORE & ENTRY TIMING
   - Is the current Z-score favorable for entry?
   - If Z near 0: NO trade signal - recommend waiting
   - If |Z| > 1.5: Assess if fundamentals support the trade direction
   - Consider: Is now a good time to enter, or should we wait?

2. FUNDAMENTAL ALIGNMENT
   - Do these assets have a logical reason to move together?
   - Are they in similar categories/chains?
   - Do their fundamentals (TVL, volume, dev activity) move together?

3. DIVERGENCE RISK FACTORS
   - Any significant metric divergences (TVL change, volume, etc.)?
   - Token unlock asymmetry?
   - Funding rate imbalance suggesting crowded positioning?
   - Market cap disparity concerns?

4. DATA QUALITY ASSESSMENT
   - Is there enough verified data for both assets?
   - Any data gaps that increase uncertainty?

5. RECOMMENDATION
   - Should this pair be traded NOW given Z-score?
   - If not now, at what Z-score level would you recommend entry?
   - What are the key risks to monitor?

Return your analysis as JSON:

\`\`\`json
{
  "recommendation": "APPROVE" | "CAUTION" | "REJECT",
  "confidence": 0.0-1.0,
  "entryTiming": {
    "currentZScore": "value",
    "signal": "STRONG" | "MODERATE" | "WEAK" | "NO_SIGNAL",
    "recommendation": "ENTER_NOW" | "WAIT" | "AVOID",
    "targetZScore": "suggested entry Z-score if waiting",
    "reasoning": "why now or why wait"
  },
  "fundamentalAlignment": {
    "score": "STRONG" | "MODERATE" | "WEAK",
    "reasoning": "brief explanation"
  },
  "tokenUnlocks": {
    "asset1": {
      "hasUpcoming": true/false,
      "nextUnlock": "date or null",
      "amount": "description or null",
      "type": "team/investor/ecosystem or null",
      "source": "tokenomist.ai or web search"
    },
    "asset2": {
      "hasUpcoming": true/false,
      "nextUnlock": "date or null", 
      "amount": "description or null",
      "type": "team/investor/ecosystem or null",
      "source": "tokenomist.ai or web search"
    },
    "asymmetryRisk": "HIGH" | "MEDIUM" | "LOW" | "NONE",
    "notes": "any important unlock-related observations"
  },
  "sentiment": {
    "asset1": {
      "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
      "keyNews": ["news item 1", "news item 2"],
      "redFlags": ["red flag if any"],
      "source": "X/Twitter search"
    },
    "asset2": {
      "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
      "keyNews": ["news item 1", "news item 2"],
      "redFlags": ["red flag if any"],
      "source": "X/Twitter search"
    },
    "divergence": "description of sentiment difference between assets",
    "tradingImplication": "how sentiment affects the trade direction"
  },
  "riskFactors": [
    {
      "factor": "name of risk",
      "severity": "HIGH" | "MEDIUM" | "LOW",
      "description": "brief description"
    }
  ],
  "dataQuality": {
    "asset1": "GOOD" | "PARTIAL" | "POOR",
    "asset2": "GOOD" | "PARTIAL" | "POOR"
  },
  "keyMetrics": {
    "fundingSpread": "value or N/A",
    "tvlDivergence": "value or N/A",
    "volumeRatio": "value or N/A",
    "marketCapRatio": "value or N/A"
  },
  "monitoringPoints": ["point 1", "point 2"],
  "summary": "2-3 sentence executive summary"
}
\`\`\`
`;
}

/**
 * Determine correct trade direction based on Z-score
 * Positive Z → Asset1 overvalued → Short Asset1, Long Asset2
 * Negative Z → Asset1 undervalued → Long Asset1, Short Asset2
 */
function getTradeDirection(zScore, asset1, asset2) {
    const absZ = Math.abs(zScore);
    const beta = 1; // Simplified; actual beta would give exact percentages

    if (zScore >= 0) {
        // Positive Z: Asset1 overvalued, Short Asset1 / Long Asset2
        return {
            longAsset: asset2,
            shortAsset: asset1,
            longPct: 40,  // Approximate based on typical beta
            shortPct: 60,
            description: `Short ${asset1} / Long ${asset2}`,
            reasoning: `${asset1} is overvalued relative to ${asset2}, expecting convergence`
        };
    } else {
        // Negative Z: Asset1 undervalued, Long Asset1 / Short Asset2
        return {
            longAsset: asset1,
            shortAsset: asset2,
            longPct: 60,
            shortPct: 40,
            description: `Long ${asset1} / Short ${asset2}`,
            reasoning: `${asset1} is undervalued relative to ${asset2}, expecting convergence`
        };
    }
}

// Z-Score interpretation helpers
function getZScoreInterpretation(z) {
    if (z === null || z === undefined || isNaN(z)) return '';
    const absZ = Math.abs(parseFloat(z));
    if (absZ > 2.5) return '(EXTREME - strong reversion expected)';
    if (absZ > 2.0) return '(STRONG signal)';
    if (absZ > 1.5) return '(moderate signal)';
    if (absZ > 1.0) return '(weak signal)';
    return '(near fair value - no signal)';
}

function getZScoreTradeSignal(z) {
    if (z === null || z === undefined || isNaN(z)) return 'No data';
    const zVal = parseFloat(z);
    const absZ = Math.abs(zVal);

    if (absZ < 1.0) return 'NO TRADE - spread at fair value, wait for divergence';
    if (absZ < 1.5) return 'WEAK - consider waiting for stronger signal';
    if (absZ < 2.0) return 'MODERATE - acceptable entry if fundamentals align';
    return 'STRONG - good entry point for mean reversion';
}

function getHurstInterpretation(h) {
    if (h === null || h === undefined || isNaN(h)) return '';
    const hVal = parseFloat(h);
    if (hVal < 0.4) return '(mean-reverting ✓)';
    if (hVal < 0.5) return '(slightly mean-reverting)';
    if (hVal < 0.6) return '(random walk - caution)';
    return '(trending - avoid pairs trade!)';
}

function formatMetricsForPrompt(metrics) {
    if (!metrics?.available) {
        return `  Not available: ${metrics?.reason || 'Unknown'}`;
    }
    return `  Name: ${metrics.name}
  Market Cap: ${metrics.marketCapFormatted}
  24h Volume: ${metrics.volume24hFormatted}
  Price Changes: 24h ${metrics.priceChange24h}, 7d ${metrics.priceChange7d}, 30d ${metrics.priceChange30d}
  Circulating Supply: ${metrics.circulatingPercent} of total
  ATH: ${metrics.ath ? `$${metrics.ath.toFixed(4)}` : 'N/A'} (${metrics.athChangePercent} from ATH)
  Categories: ${metrics.categories?.join(', ') || 'N/A'}
  GitHub Commits (4w): ${metrics.githubCommits4w || 'N/A'}
  Twitter Followers: ${metrics.twitterFollowers?.toLocaleString() || 'N/A'}`;
}

function formatTVLForPrompt(tvl) {
    if (!tvl?.available) {
        return `  Not available: ${tvl?.reason || 'Not a DeFi protocol'}`;
    }
    return `  Protocol: ${tvl.protocol}
  Current TVL: ${tvl.tvlFormatted}
  7d Change: ${tvl.weekChange}
  30d Change: ${tvl.monthChange}
  Category: ${tvl.category}
  Chains: ${tvl.chains?.join(', ') || 'N/A'}`;
}

function formatFundingForPrompt(funding) {
    if (!funding?.available) {
        return `  Not available: ${funding?.reason || 'Unknown'}`;
    }
    return `  Funding (8h): ${funding.funding8hPercent}
  Funding (Annualized): ${funding.fundingAnnualized}
  Open Interest: ${funding.openInterestFormatted}
  24h Volume: ${funding.volume24hFormatted}
  Mark Price: $${funding.markPrice?.toFixed(6) || 'N/A'}`;
}

function formatUnlocksForPrompt(unlocks) {
    if (!unlocks?.available) {
        return `  Not available: ${unlocks?.reason || 'Unknown'}
  ${unlocks?.note || ''}`;
    }

    // From TokenUnlocks API
    if (unlocks.source === 'tokenunlocks_api') {
        if (!unlocks.hasUpcoming) {
            return `  No significant unlocks in next 90 days`;
        }
        return `  ⚠️ UPCOMING UNLOCK
  Date: ${unlocks.nextUnlock}
  Amount: ${unlocks.amount}
  % of Supply: ${unlocks.percentOfSupply}
  Type: ${unlocks.type}
  Source: TokenUnlocks API`;
    }

    // From CoinGecko supply analysis
    if (unlocks.source === 'coingecko_supply') {
        return `  Supply Analysis:
  Circulating: ${unlocks.circulatingPercent}
  Remaining to Vest: ${unlocks.remainingToVest}
  Note: ${unlocks.note}
  ${unlocks.recommendation || ''}`;
    }

    // Legacy format fallback
    if (!unlocks.hasUpcoming) {
        return `  No significant upcoming unlocks`;
    }
    return `  ⚠️ UPCOMING UNLOCK
  Date: ${unlocks.nextUnlock}
  Amount: ${unlocks.amount}
  % of Supply: ${unlocks.percentOfSupply}
  Type: ${unlocks.type}`;
}

/**
 * Generate fallback analysis when Grok is not available
 */
function generateFallbackAnalysis(asset1Data, asset2Data, pairContext) {
    const risks = [];

    // Check funding divergence
    if (asset1Data.funding?.available && asset2Data.funding?.available) {
        const fundingDiff = Math.abs(
            asset1Data.funding.funding8h - asset2Data.funding.funding8h
        );
        if (fundingDiff > 0.0001) {
            risks.push({
                factor: 'Funding Rate Divergence',
                severity: fundingDiff > 0.0005 ? 'HIGH' : 'MEDIUM',
                description: `Funding spread: ${(fundingDiff * 100).toFixed(4)}%`
            });
        }
    }

    // Check TVL divergence
    if (asset1Data.tvl?.available && asset2Data.tvl?.available) {
        const tvlChange1 = parseFloat(asset1Data.tvl.weekChange);
        const tvlChange2 = parseFloat(asset2Data.tvl.weekChange);
        if (Math.sign(tvlChange1) !== Math.sign(tvlChange2)) {
            risks.push({
                factor: 'TVL Divergence',
                severity: 'MEDIUM',
                description: `${asset1Data.symbol} TVL ${asset1Data.tvl.weekChange}, ${asset2Data.symbol} TVL ${asset2Data.tvl.weekChange}`
            });
        }
    }

    // Check for upcoming unlocks
    if (asset1Data.unlocks?.hasUpcoming && !asset2Data.unlocks?.hasUpcoming) {
        risks.push({
            factor: 'Asymmetric Token Unlock',
            severity: 'HIGH',
            description: `${asset1Data.symbol} has unlock on ${asset1Data.unlocks.nextUnlock} (${asset1Data.unlocks.percentOfSupply})`
        });
    }
    if (asset2Data.unlocks?.hasUpcoming && !asset1Data.unlocks?.hasUpcoming) {
        risks.push({
            factor: 'Asymmetric Token Unlock',
            severity: 'HIGH',
            description: `${asset2Data.symbol} has unlock on ${asset2Data.unlocks.nextUnlock} (${asset2Data.unlocks.percentOfSupply})`
        });
    }

    // Check market cap ratio
    if (asset1Data.metrics?.available && asset2Data.metrics?.available) {
        const mcap1 = asset1Data.metrics.marketCap || 0;
        const mcap2 = asset2Data.metrics.marketCap || 0;
        const ratio = mcap1 > mcap2 ? mcap1 / mcap2 : mcap2 / mcap1;
        if (ratio > 10) {
            risks.push({
                factor: 'Market Cap Disparity',
                severity: 'MEDIUM',
                description: `${ratio.toFixed(1)}x difference in market cap`
            });
        }
    }

    return {
        recommendation: risks.some(r => r.severity === 'HIGH') ? 'CAUTION' : 'MANUAL_REVIEW',
        confidence: 0.5,
        fundamentalAlignment: {
            score: 'UNKNOWN',
            reasoning: 'AI synthesis not available - manual review recommended'
        },
        riskFactors: risks,
        dataQuality: {
            asset1: asset1Data.metrics?.available ? 'GOOD' : 'PARTIAL',
            asset2: asset2Data.metrics?.available ? 'GOOD' : 'PARTIAL'
        },
        keyMetrics: {
            fundingSpread: asset1Data.funding?.available && asset2Data.funding?.available
                ? `${((asset1Data.funding.funding8h - asset2Data.funding.funding8h) * 100).toFixed(4)}%`
                : 'N/A',
            marketCapRatio: asset1Data.metrics?.available && asset2Data.metrics?.available
                ? `${(asset1Data.metrics.marketCap / asset2Data.metrics.marketCap).toFixed(2)}x`
                : 'N/A'
        },
        monitoringPoints: [
            'Check token unlock schedules manually',
            'Monitor TVL changes for DeFi assets',
            'Watch for funding rate divergence'
        ],
        summary: 'Automated risk check complete. AI synthesis unavailable - configure XAI_API_KEY for full analysis.'
    };
}

module.exports = {
    synthesizePairData,
    getGrokClient,
};

