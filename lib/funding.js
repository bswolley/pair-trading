/**
 * Funding rate utilities for Hyperliquid perpetuals
 * 
 * Funding is paid/received every 8 hours (3x per day)
 * - Positive funding: longs pay shorts
 * - Negative funding: shorts pay longs
 */

const axios = require('axios');

const HL_API = 'https://api.hyperliquid.xyz/info';

/**
 * Fetch current funding rates and asset contexts for all perps
 * @returns {Promise<Map<string, {funding: number, premium: number, openInterest: number, markPx: number}>>}
 */
async function fetchCurrentFunding() {
    try {
        const response = await axios.post(HL_API, { type: 'metaAndAssetCtxs' });
        const [meta, contexts] = response.data;

        const fundingMap = new Map();

        for (let i = 0; i < meta.universe.length; i++) {
            const assetName = meta.universe[i].name;
            const ctx = contexts[i];

            if (ctx) {
                fundingMap.set(assetName, {
                    funding: parseFloat(ctx.funding || 0),
                    premium: parseFloat(ctx.premium || 0),
                    openInterest: parseFloat(ctx.openInterest || 0),
                    markPx: parseFloat(ctx.markPx || 0),
                    dayNtlVlm: parseFloat(ctx.dayNtlVlm || 0)
                });
            }
        }

        return fundingMap;
    } catch (error) {
        console.error('Error fetching funding:', error.message);
        return new Map();
    }
}

/**
 * Fetch predicted funding rates from multiple venues
 * @returns {Promise<Map<string, {hlPerp: number, binPerp: number, bybitPerp: number}>>}
 */
async function fetchPredictedFunding() {
    try {
        const response = await axios.post(HL_API, { type: 'predictedFundings' });

        const predMap = new Map();

        for (const [coin, venues] of response.data) {
            const predicted = { hlPerp: null, binPerp: null, bybitPerp: null };

            for (const [venue, data] of venues) {
                if (venue === 'HlPerp') predicted.hlPerp = parseFloat(data.fundingRate);
                if (venue === 'BinPerp') predicted.binPerp = parseFloat(data.fundingRate);
                if (venue === 'BybitPerp') predicted.bybitPerp = parseFloat(data.fundingRate);
            }

            predMap.set(coin, predicted);
        }

        return predMap;
    } catch (error) {
        console.error('Error fetching predicted funding:', error.message);
        return new Map();
    }
}

/**
 * Calculate net funding for a pair trade
 * Net = (short leg funding) - (long leg funding)
 * Positive net = you earn funding, Negative = you pay
 * 
 * @param {string} longAsset - Asset you're long
 * @param {string} shortAsset - Asset you're short
 * @param {Map} fundingMap - Map from fetchCurrentFunding()
 * @returns {{netFunding8h: number, netFundingDaily: number, netFundingMonthly: number, longFunding: number, shortFunding: number}}
 */
function calculateNetFunding(longAsset, shortAsset, fundingMap) {
    const longData = fundingMap.get(longAsset);
    const shortData = fundingMap.get(shortAsset);

    if (!longData || !shortData) {
        return {
            netFunding8h: null,
            netFundingDaily: null,
            netFundingMonthly: null,
            longFunding: null,
            shortFunding: null
        };
    }

    const longFunding = longData.funding;
    const shortFunding = shortData.funding;

    // Net = what shorts receive - what longs pay
    // If you're long A and short B:
    // - You pay A's funding (if positive)
    // - You receive B's funding (if positive)
    // Net = shortFunding - longFunding
    const netFunding8h = shortFunding - longFunding;
    const netFundingDaily = netFunding8h * 3; // 3 funding periods per day
    const netFundingMonthly = netFundingDaily * 30;

    return {
        netFunding8h,
        netFundingDaily,
        netFundingMonthly,
        longFunding,
        shortFunding
    };
}

/**
 * Format funding rate for display
 * @param {number} rate - Funding rate (e.g., 0.0001 = 0.01%)
 * @param {string} period - '8h', 'daily', 'monthly'
 * @returns {string}
 */
function formatFunding(rate, period = '8h') {
    if (rate === null || rate === undefined) return 'N/A';

    const pct = (rate * 100).toFixed(4);
    const sign = rate >= 0 ? '+' : '';

    switch (period) {
        case '8h':
            return `${sign}${pct}%/8h`;
        case 'daily':
            return `${sign}${pct}%/day`;
        case 'monthly':
            return `${sign}${(rate * 100).toFixed(2)}%/mo`;
        default:
            return `${sign}${pct}%`;
    }
}

/**
 * Get funding summary for a pair
 * @param {string} longAsset 
 * @param {string} shortAsset 
 * @param {Map} fundingMap 
 * @returns {string} Formatted summary string
 */
function getFundingSummary(longAsset, shortAsset, fundingMap) {
    const net = calculateNetFunding(longAsset, shortAsset, fundingMap);

    if (net.netFunding8h === null) {
        return 'Funding: N/A';
    }

    const emoji = net.netFunding8h >= 0 ? '💚' : '💔';
    const sign = net.netFunding8h >= 0 ? '+' : '';
    const pct8h = (net.netFunding8h * 100).toFixed(4);
    const pctMo = (net.netFundingMonthly * 100).toFixed(2);

    return `${emoji} ${sign}${pct8h}%/8h (${sign}${pctMo}%/mo)`;
}

module.exports = {
    fetchCurrentFunding,
    fetchPredictedFunding,
    calculateNetFunding,
    formatFunding,
    getFundingSummary
};

