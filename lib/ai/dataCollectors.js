/**
 * On-Chain & Verified Data Collectors
 * 
 * Fetches data that CAN'T BE FAKED for AI synthesis
 */

const axios = require('axios');

// Cache for dynamic symbol resolution
const symbolCache = {
    coinGecko: {},
    defiLlama: {}
};

/**
 * Dynamically resolve CoinGecko ID from symbol using search API
 */
async function resolveCoinGeckoId(symbol) {
    const upper = symbol.toUpperCase();

    // Check static mapping first
    if (SYMBOL_MAP.coinGecko[upper]) {
        return SYMBOL_MAP.coinGecko[upper];
    }

    // Check cache
    if (symbolCache.coinGecko[upper]) {
        return symbolCache.coinGecko[upper];
    }

    // Search CoinGecko
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/search', {
            params: { query: symbol },
            timeout: 5000
        });

        // Find best match (highest market cap rank with matching symbol)
        const coins = response.data.coins || [];
        const match = coins.find(c => c.symbol.toUpperCase() === upper);

        if (match) {
            symbolCache.coinGecko[upper] = match.id;
            console.log(`  [CoinGecko] Resolved ${upper} -> ${match.id}`);
            return match.id;
        }
    } catch (error) {
        console.log(`  [CoinGecko] Search failed for ${upper}: ${error.message}`);
    }

    return null;
}

/**
 * Dynamically resolve DeFiLlama protocol slug from symbol
 */
async function resolveDeFiLlamaProtocol(symbol) {
    const upper = symbol.toUpperCase();

    // Check static mapping first
    if (SYMBOL_MAP.defiLlama[upper]) {
        return { type: 'protocol', slug: SYMBOL_MAP.defiLlama[upper] };
    }

    // Check chain mapping
    if (SYMBOL_MAP.defiLlamaChains[upper]) {
        return { type: 'chain', slug: SYMBOL_MAP.defiLlamaChains[upper] };
    }

    // Check cache
    if (symbolCache.defiLlama[upper]) {
        return symbolCache.defiLlama[upper];
    }

    // Search DeFiLlama protocols
    try {
        const response = await axios.get('https://api.llama.fi/protocols', {
            timeout: 8000
        });

        // Find protocol matching symbol
        const protocols = response.data || [];
        const match = protocols.find(p =>
            p.symbol?.toUpperCase() === upper ||
            p.name?.toUpperCase() === upper
        );

        if (match) {
            const result = { type: 'protocol', slug: match.slug };
            symbolCache.defiLlama[upper] = result;
            console.log(`  [DeFiLlama] Resolved ${upper} -> ${match.slug}`);
            return result;
        }
    } catch (error) {
        // Silently fail - not all tokens have protocols
    }

    return null;
}

// Symbol mapping for different APIs (static mappings for common tokens)
const SYMBOL_MAP = {
    // DeFiLlama protocol slugs (for DeFi protocol TVL)
    defiLlama: {
        'AAVE': 'aave',
        'UNI': 'uniswap',
        'CRV': 'curve-dex',
        'LDO': 'lido',
        'MKR': 'makerdao',
        'SNX': 'synthetix',
        'COMP': 'compound-finance',
        'SUSHI': 'sushi',
        'YFI': 'yearn-finance',
        'DYDX': 'dydx',
        'GMX': 'gmx',
        'PENDLE': 'pendle',
        'JUP': 'jupiter',
        'RAY': 'raydium',
        '1INCH': '1inch-network',
        'BAL': 'balancer-v2',
        'CAKE': 'pancakeswap',
        'RUNE': 'thorchain',
        'OSMO': 'osmosis',
        'VELO': 'velodrome',
        'AERO': 'aerodrome',
    },
    // DeFiLlama chain slugs (for L2/chain TVL)
    // Note: Some tokens (TIA/Celestia) are data availability layers without direct TVL
    defiLlamaChains: {
        'ARB': 'Arbitrum',
        'OP': 'Optimism',
        'MATIC': 'Polygon',
        'POL': 'Polygon',
        'AVAX': 'Avalanche',
        'SOL': 'Solana',
        'ETH': 'Ethereum',
        'BNB': 'BSC',
        'NEAR': 'Near',
        'SUI': 'Sui',
        'APT': 'Aptos',
        'SEI': 'Sei',
        'INJ': 'Injective',
        'LINEA': 'Linea',
        'BASE': 'Base',
        'BLAST': 'Blast',
        'CELO': 'Celo',
        'FTM': 'Fantom',
        'HBAR': 'Hedera',
        'XLM': 'Stellar',
        // TIA (Celestia) is a DA layer, not tracked as a chain
    },
    // CoinGecko IDs
    coinGecko: {
        'BTC': 'bitcoin',
        'ETH': 'ethereum',
        'SOL': 'solana',
        'ARB': 'arbitrum',
        'OP': 'optimism',
        'MATIC': 'matic-network',
        'POL': 'matic-network',
        'AVAX': 'avalanche-2',
        'ATOM': 'cosmos',
        'DOT': 'polkadot',
        'LINK': 'chainlink',
        'UNI': 'uniswap',
        'AAVE': 'aave',
        'LDO': 'lido-dao',
        'MKR': 'maker',
        'SNX': 'havven',
        'CRV': 'curve-dao-token',
        'DOGE': 'dogecoin',
        'SHIB': 'shiba-inu',
        'PEPE': 'pepe',
        'WIF': 'dogwifcoin',
        'BONK': 'bonk',
        'BRETT': 'based-brett',
        'FLOKI': 'floki',
        'PNUT': 'peanut-the-squirrel',
        'PENGU': 'pudgy-penguins',
        'VIRTUAL': 'virtual-protocol',
        'FET': 'fetch-ai',
        'RENDER': 'render-token',
        'TAO': 'bittensor',
        'NEAR': 'near',
        'SUI': 'sui',
        'APT': 'aptos',
        'INJ': 'injective-protocol',
        'TIA': 'celestia',
        'SEI': 'sei-network',
        'LINEA': 'linea',
        'BNB': 'binancecoin',
        'XRP': 'ripple',
        'ADA': 'cardano',
        'TRX': 'tron',
        'WLD': 'worldcoin-wld',
        'FIL': 'filecoin',
        'ENA': 'ethena',
        'HBAR': 'hedera-hashgraph',
        'XLM': 'stellar',
        'ETC': 'ethereum-classic',
        'GAS': 'gas',
    }
};

/**
 * Fetch TVL data from DeFiLlama
 * Handles both DeFi protocols and L2 chains
 */
async function fetchTVLData(symbol) {
    // Use dynamic resolution (checks static maps first, then searches)
    const resolved = await resolveDeFiLlamaProtocol(symbol);

    if (!resolved) {
        // Not a DeFi protocol or chain with TVL
        return { available: false, reason: 'Not a DeFi protocol (no TVL data)' };
    }

    if (resolved.type === 'chain') {
        return fetchChainTVL(resolved.slug);
    } else {
        return fetchProtocolTVL(resolved.slug);
    }
}

/**
 * Fetch chain TVL (for L2s like ARB, OP)
 */
async function fetchChainTVL(chainName) {
    try {
        // Get all chains data
        const response = await axios.get('https://api.llama.fi/v2/chains', {
            timeout: 10000
        });

        const chain = response.data.find(c => c.name === chainName);

        if (!chain) {
            return { available: false, reason: `Chain ${chainName} not found` };
        }

        // Get historical data for the chain
        const histResponse = await axios.get(`https://api.llama.fi/v2/historicalChainTvl/${chainName}`, {
            timeout: 10000
        });

        const tvlHistory = histResponse.data || [];
        const current = tvlHistory[tvlHistory.length - 1]?.tvl || chain.tvl || 0;
        const weekAgo = tvlHistory[tvlHistory.length - 8]?.tvl || current;
        const monthAgo = tvlHistory[tvlHistory.length - 31]?.tvl || current;

        const weekChange = weekAgo > 0 ? ((current - weekAgo) / weekAgo) * 100 : 0;
        const monthChange = monthAgo > 0 ? ((current - monthAgo) / monthAgo) * 100 : 0;

        return {
            available: true,
            type: 'chain',
            chain: chainName,
            currentTVL: current,
            tvlFormatted: formatUSD(current),
            weekChange: `${weekChange >= 0 ? '+' : ''}${weekChange.toFixed(1)}%`,
            monthChange: `${monthChange >= 0 ? '+' : ''}${monthChange.toFixed(1)}%`,
        };
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

/**
 * Fetch protocol TVL (for DeFi protocols like AAVE, UNI)
 * Uses simple endpoint first (faster), falls back to detailed if needed
 */
async function fetchProtocolTVL(slug) {
    try {
        // Try simple TVL endpoint first (much faster, just current TVL)
        const simpleResponse = await axios.get(`https://api.llama.fi/tvl/${slug}`, {
            timeout: 5000
        });

        const currentTVL = parseFloat(simpleResponse.data) || 0;

        // Try to get detailed data for historical comparison (with short timeout)
        let weekChange = 'N/A';
        let monthChange = 'N/A';
        let category = null;
        let protocolName = slug;

        try {
            const detailedResponse = await axios.get(`https://api.llama.fi/protocol/${slug}`, {
                timeout: 8000
            });
            const data = detailedResponse.data;
            const tvlHistory = data.tvl || [];

            protocolName = data.name || slug;
            category = data.category;

            if (tvlHistory.length > 0) {
                const weekAgo = tvlHistory[tvlHistory.length - 8]?.totalLiquidityUSD || currentTVL;
                const monthAgo = tvlHistory[tvlHistory.length - 31]?.totalLiquidityUSD || currentTVL;

                const weekPct = weekAgo > 0 ? ((currentTVL - weekAgo) / weekAgo) * 100 : 0;
                const monthPct = monthAgo > 0 ? ((currentTVL - monthAgo) / monthAgo) * 100 : 0;

                weekChange = `${weekPct >= 0 ? '+' : ''}${weekPct.toFixed(1)}%`;
                monthChange = `${monthPct >= 0 ? '+' : ''}${monthPct.toFixed(1)}%`;
            }
        } catch (detailError) {
            // Detailed data failed, but we have current TVL
            console.log(`  [TVL] Historical data unavailable for ${slug}, using current only`);
        }

        return {
            available: true,
            type: 'protocol',
            protocol: protocolName,
            currentTVL: currentTVL,
            tvlFormatted: formatUSD(currentTVL),
            weekChange,
            monthChange,
            category,
        };
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

/**
 * Fetch token metrics from CoinGecko (free tier)
 */
async function fetchCoinGeckoData(symbol) {
    // Use dynamic resolution (checks static map first, then searches)
    const id = await resolveCoinGeckoId(symbol);

    if (!id) {
        return { available: false, reason: `Could not resolve CoinGecko ID for ${symbol}` };
    }

    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/coins/${id}`,
            {
                params: {
                    localization: false,
                    tickers: false,
                    community_data: true,
                    developer_data: true,
                    sparkline: false
                },
                timeout: 10000
            }
        );

        const data = response.data;
        const market = data.market_data || {};

        return {
            available: true,
            name: data.name,
            symbol: data.symbol?.toUpperCase(),

            // Price metrics
            price: market.current_price?.usd,
            marketCap: market.market_cap?.usd,
            marketCapFormatted: formatUSD(market.market_cap?.usd),
            volume24h: market.total_volume?.usd,
            volume24hFormatted: formatUSD(market.total_volume?.usd),

            // Price changes
            priceChange24h: `${market.price_change_percentage_24h?.toFixed(1)}%`,
            priceChange7d: `${market.price_change_percentage_7d?.toFixed(1)}%`,
            priceChange30d: `${market.price_change_percentage_30d?.toFixed(1)}%`,

            // Supply metrics
            circulatingSupply: market.circulating_supply,
            totalSupply: market.total_supply,
            maxSupply: market.max_supply,
            circulatingPercent: market.total_supply
                ? `${((market.circulating_supply / market.total_supply) * 100).toFixed(1)}%`
                : 'N/A',

            // ATH/ATL
            ath: market.ath?.usd,
            athDate: market.ath_date?.usd?.split('T')[0],
            athChangePercent: `${market.ath_change_percentage?.usd?.toFixed(1)}%`,

            // Community/Dev (if available)
            twitterFollowers: data.community_data?.twitter_followers,
            redditSubscribers: data.community_data?.reddit_subscribers,
            githubStars: data.developer_data?.stars,
            githubCommits4w: data.developer_data?.commit_count_4_weeks,

            // Categories
            categories: data.categories?.slice(0, 5) || [],
        };
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

/**
 * Fetch funding rates from Hyperliquid
 */
async function fetchFundingData(symbol) {
    try {
        const response = await axios.post('https://api.hyperliquid.xyz/info', {
            type: 'metaAndAssetCtxs'
        }, { timeout: 10000 });

        const [meta, contexts] = response.data;

        const index = meta.universe.findIndex(
            u => u.name.toUpperCase() === symbol.toUpperCase()
        );

        if (index === -1) {
            return { available: false, reason: 'Token not found on Hyperliquid' };
        }

        const ctx = contexts[index];
        const funding8h = parseFloat(ctx.funding || 0);

        return {
            available: true,
            funding8h: funding8h,
            funding8hPercent: `${(funding8h * 100).toFixed(4)}%`,
            fundingAnnualized: `${(funding8h * 3 * 365 * 100).toFixed(1)}%`,
            openInterest: parseFloat(ctx.openInterest || 0),
            openInterestFormatted: formatUSD(parseFloat(ctx.openInterest || 0) * parseFloat(ctx.markPx || 0)),
            markPrice: parseFloat(ctx.markPx || 0),
            volume24h: parseFloat(ctx.dayNtlVlm || 0),
            volume24hFormatted: formatUSD(parseFloat(ctx.dayNtlVlm || 0)),
        };
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

/**
 * Fetch token unlock data from TokenUnlocks API or fallback sources
 */
async function fetchUnlockData(symbol) {
    const upper = symbol.toUpperCase();

    // Try TokenUnlocks API if key is configured
    if (process.env.TOKEN_UNLOCKS_API_KEY) {
        try {
            const response = await axios.get(
                `https://api.tokenunlocks.app/api/v1/token/${upper.toLowerCase()}/unlocks`,
                {
                    headers: { 'x-api-key': process.env.TOKEN_UNLOCKS_API_KEY },
                    timeout: 10000
                }
            );

            const now = new Date();
            const upcoming = (response.data || []).filter(unlock => {
                const unlockDate = new Date(unlock.unlockDate || unlock.date);
                const daysUntil = (unlockDate - now) / (1000 * 60 * 60 * 24);
                return daysUntil > 0 && daysUntil <= 90; // Next 90 days
            });

            if (upcoming.length > 0) {
                const next = upcoming[0];
                return {
                    available: true,
                    source: 'tokenunlocks_api',
                    hasUpcoming: true,
                    nextUnlock: next.unlockDate || next.date,
                    amount: next.amount ? `${(next.amount / 1e6).toFixed(1)}M tokens` : 'Unknown',
                    percentOfSupply: next.percentOfSupply ? `${next.percentOfSupply.toFixed(1)}%` : 'Unknown',
                    type: next.category || next.type || 'Unknown',
                    totalUpcoming: upcoming.length
                };
            }

            return {
                available: true,
                source: 'tokenunlocks_api',
                hasUpcoming: false,
                note: 'No significant unlocks in next 90 days'
            };
        } catch (error) {
            // Fall through to alternative methods
        }
    }

    // Try to get supply info from CoinGecko to estimate vesting
    try {
        const cgId = SYMBOL_MAP.coinGecko[upper];
        if (cgId) {
            const response = await axios.get(
                `https://api.coingecko.com/api/v3/coins/${cgId}`,
                { params: { localization: false, tickers: false }, timeout: 10000 }
            );

            const market = response.data?.market_data;
            if (market) {
                const circulating = market.circulating_supply || 0;
                const total = market.total_supply || 0;
                const max = market.max_supply || total;

                if (total > 0 && circulating > 0) {
                    const vestedPercent = (circulating / total) * 100;
                    const remainingPercent = 100 - vestedPercent;

                    return {
                        available: true,
                        source: 'coingecko_supply',
                        hasUpcoming: remainingPercent > 10,
                        circulatingPercent: `${vestedPercent.toFixed(1)}%`,
                        remainingToVest: `${remainingPercent.toFixed(1)}%`,
                        note: remainingPercent > 30
                            ? `⚠️ ${remainingPercent.toFixed(0)}% of supply still locked - check tokenomist.ai for schedule`
                            : remainingPercent > 10
                                ? `${remainingPercent.toFixed(0)}% remaining to unlock`
                                : 'Most supply already circulating',
                        recommendation: 'Visit tokenomist.ai for detailed schedule'
                    };
                }
            }
        }
    } catch (error) {
        // Continue to fallback
    }

    return {
        available: false,
        reason: 'No unlock data available',
        note: 'Add TOKEN_UNLOCKS_API_KEY to .env for detailed unlock schedules, or check tokenomist.ai manually'
    };
}

/**
 * Fetch all data for a symbol
 */
async function fetchAllDataForSymbol(symbol) {
    console.log(`  Fetching data for ${symbol}...`);

    const [tvl, metrics, funding, unlocks] = await Promise.all([
        fetchTVLData(symbol),
        fetchCoinGeckoData(symbol),
        fetchFundingData(symbol),
        fetchUnlockData(symbol),
    ]);

    return {
        symbol,
        tvl,
        metrics,
        funding,
        unlocks,
        fetchedAt: new Date().toISOString()
    };
}

/**
 * Format USD values
 */
function formatUSD(value) {
    if (!value && value !== 0) return 'N/A';
    if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
}

module.exports = {
    fetchTVLData,
    fetchCoinGeckoData,
    fetchFundingData,
    fetchUnlockData,
    fetchAllDataForSymbol,
};

