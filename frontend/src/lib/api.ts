/**
 * API Client for Pair Trading Backend
 * 
 * Uses NEXT_PUBLIC_API_URL environment variable.
 * Falls back to local API routes if not set.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

// Types
export interface Trade {
    id?: string;
    pair: string;
    asset1: string;
    asset2: string;
    sector?: string;
    direction: string;
    entryTime: string;
    entryZScore?: number;
    entryThreshold?: number;
    longAsset: string;
    shortAsset: string;
    longWeight: number;
    shortWeight: number;
    longEntryPrice?: number;
    shortEntryPrice?: number;
    correlation?: number;
    beta?: number;
    halfLife?: number;
    hurst?: number;
    currentZ?: number;
    currentPnL?: number;
    currentCorrelation?: number;
    currentHalfLife?: number;
    currentBeta?: number;
    currentHurst?: number;
    betaDrift?: number;
    maxBetaDrift?: number;
    partialExitTaken?: boolean;
    partialExitPnL?: number;
    partialExitTime?: string;
    healthScore?: number;
    healthStatus?: string;
    healthSignals?: string[];
    source?: string;
}

export interface WatchlistPair {
    pair: string;
    asset1: string;
    asset2: string;
    sector?: string;
    qualityScore?: number;
    conviction?: number;
    hurst?: number;
    hurstClassification?: string;
    correlation?: number;
    beta?: number;
    initialBeta?: number;
    betaDrift?: number;
    halfLife?: number;
    meanReversionRate?: number;
    zScore: number;
    signalStrength: number;
    direction?: string;
    isReady?: boolean;
    entryThreshold: number;
    exitThreshold?: number;
    maxHistoricalZ?: number;
}

export interface HistoryTrade extends Trade {
    exitTime?: string;
    exitZScore?: number;
    exitHurst?: number;
    exitReason?: string;
    totalPnL?: number;
    daysInTrade?: number;
}

export interface Stats {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnL: number;
    winRate: number | string;
}

export interface StatusResponse {
    timestamp: string;
    activeTrades: {
        count: number;
        portfolioPnL: string;
        pairs: Array<{
            pair: string;
            sector: string;
            direction: string;
            pnl: string;
            daysInTrade: string;
        }>;
    };
    watchlist: {
        totalPairs: number;
        approaching: Array<{
            pair: string;
            zScore: number;
            entryThreshold: number;
            signalStrength: number;
        }>;
    };
    history: {
        totalTrades: number;
        wins: number;
        losses: number;
        totalPnL: string;
    };
    blacklist: {
        count: number;
    };
    scheduler: {
        monitor: {
            isRunning: boolean;
            lastRun: string | null;
            schedule: string;
        };
        scan: {
            isRunning: boolean;
            lastRun: string | null;
            schedule: string;
            crossSectorEnabled: boolean;
        };
    };
}

// API Functions
async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_URL}${endpoint}`;

    try {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
            },
        });

        if (!res.ok) {
            const error = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(error.error || `API error: ${res.status}`);
        }

        return res.json();
    } catch (error) {
        // Log the actual error for debugging
        console.error(`[API] Fetch failed for ${url}:`, error);
        if (error instanceof TypeError && error.message === 'Failed to fetch') {
            throw new Error(`Cannot reach backend at ${API_URL}. Check CORS settings and ensure the backend is running.`);
        }
        throw error;
    }
}

// Health
export async function getHealth() {
    return fetchAPI<{ status: string; uptime: number; timestamp: string }>('/api/health');
}

// Status
export async function getStatus() {
    return fetchAPI<StatusResponse>('/api/status');
}

// Trades
export async function getTrades() {
    return fetchAPI<{ count: number; trades: Trade[] }>('/api/trades');
}

export async function getTrade(pair: string) {
    return fetchAPI<Trade>(`/api/trades/${encodeURIComponent(pair)}`);
}

export async function createTrade(trade: Partial<Trade>) {
    return fetchAPI<{ success: boolean; trade: Trade }>('/api/trades', {
        method: 'POST',
        body: JSON.stringify(trade),
    });
}

export async function updateTrade(pair: string, updates: Partial<Trade>) {
    return fetchAPI<{ success: boolean; trade: Trade }>(`/api/trades/${encodeURIComponent(pair)}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
    });
}

export async function closeTrade(pair: string, reason?: string, pnl?: number) {
    return fetchAPI<{ success: boolean; message: string; record: HistoryTrade }>(`/api/trades/${encodeURIComponent(pair)}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason, pnl }),
    });
}

// Watchlist
export async function getWatchlist(filters?: { sector?: string; ready?: boolean }) {
    const params = new URLSearchParams();
    if (filters?.sector) params.set('sector', filters.sector);
    if (filters?.ready) params.set('ready', 'true');

    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchAPI<{ timestamp: string; totalPairs: number; pairs: WatchlistPair[] }>(`/api/watchlist${query}`);
}

export async function getWatchlistSectors() {
    return fetchAPI<{ timestamp: string; sectors: Array<{ name: string; count: number }> }>('/api/watchlist/sectors');
}

// History
export async function getHistory(filters?: { sector?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (filters?.sector) params.set('sector', filters.sector);
    if (filters?.limit) params.set('limit', filters.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchAPI<{ totalCount: number; filteredCount: number; stats: Stats; trades: HistoryTrade[] }>(`/api/history${query}`);
}

export async function getHistoryStats() {
    return fetchAPI<Stats & {
        avgPnL: string;
        avgDuration: string;
        bestTrade: { pair: string; pnl: number } | null;
        worstTrade: { pair: string; pnl: number } | null;
        bySector: Record<string, { trades: number; wins: number; pnl: number }>;
        byReason: Record<string, { count: number; avgPnL: number; totalPnL: number }>;
    }>('/api/history/stats');
}

// Blacklist
export async function getBlacklist() {
    return fetchAPI<{ count: number; assets: string[]; reasons: Record<string, string> }>('/api/blacklist');
}

export async function addToBlacklist(asset: string, reason?: string) {
    return fetchAPI<{ success: boolean; asset: string; reason?: string }>('/api/blacklist', {
        method: 'POST',
        body: JSON.stringify({ asset, reason }),
    });
}

export async function removeFromBlacklist(asset: string) {
    return fetchAPI<{ success: boolean; removed: string }>(`/api/blacklist/${encodeURIComponent(asset)}`, {
        method: 'DELETE',
    });
}

// Manual triggers
export async function triggerScan(options?: { crossSector?: boolean }) {
    return fetchAPI<{ success: boolean; duration?: string; fittingPairs?: number; watchlistPairs?: number; crossSectorPairs?: number }>('/api/status/scan', {
        method: 'POST',
        body: JSON.stringify(options || {}),
    });
}

export async function triggerMonitor() {
    return fetchAPI<{ success: boolean; duration?: string }>('/api/status/monitor', {
        method: 'POST',
    });
}

// Cross-sector settings
export async function getCrossSectorEnabled() {
    return fetchAPI<{ crossSectorEnabled: boolean }>('/api/status/cross-sector');
}

export async function setCrossSectorEnabled(enabled: boolean) {
    return fetchAPI<{ success: boolean; crossSectorEnabled: boolean }>('/api/status/cross-sector', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
    });
}

// Z-Score history for charts
export interface ZScoreDataPoint {
    timestamp: number;
    date: string;
    zScore: number;
    price1: number;
    price2: number;
}

export interface ZScoreResponse {
    pair: string;
    asset1: string;
    asset2: string;
    days: number;
    dataPoints: number;
    data: ZScoreDataPoint[];
    stats: {
        correlation: number;
        beta: number;
        halfLife: number;
        currentZ: number;
    };
}

export async function getZScoreHistory(pair: string, days: number = 30) {
    const encodedPair = encodeURIComponent(pair.replace('/', '_'));
    return fetchAPI<ZScoreResponse>(`/api/zscore/${encodedPair}?days=${days}`);
}

// Pair Analysis
export interface AnalysisRegime {
    regime: string;
    confidence: number;
    action: string;
    riskLevel: string;
    zTrend: string;
    zVolatility: number;
}

export interface AnalysisHurst {
    hurst: number | null;
    classification: string;
}

export interface AnalysisDualBeta {
    structural: { beta: number; r2: number; stdErr: number };
    dynamic: { beta: number; r2: number; stdErr: number };
    drift: number;
    isValid: boolean;
}

export interface AnalysisConviction {
    score: number;
    breakdown: {
        correlation: number;
        rSquared: number;
        halfLife: number;
        hurst: number;
        cointegration: number;
        betaStability: number;
    };
}

export interface AnalysisTimeframe {
    days: number;
    correlation?: number;
    beta?: number;
    zScore?: number;
    halfLife?: number | null;
    isCointegrated?: boolean;
    gamma?: number | null;
    theta?: number | null;
    price1Start?: number;
    price1End?: number;
    price2Start?: number;
    price2End?: number;
    error?: string;
}

export interface AnalysisDivergence {
    optimalEntry: number;
    maxHistoricalZ: number;
    currentZ: number;
    thresholds: Record<string, {
        totalEvents: number;
        revertedEvents: number;
        reversionRate: number | null;
        avgDuration: number | null;
        avgPeakZ: number | null;
    }>;
}

export interface AnalysisFunding {
    longAsset: string;
    shortAsset: string;
    longRate: number;
    shortRate: number;
    net8h: number;
    netDaily: number;
    netMonthly: number;
    favorable: boolean;
}

export interface AnalysisExpectedROI {
    currentZ: number;
    fixedExitZ: number;
    roiFixed: string;
    timeToFixed: number;
    percentExitZ: number;
    roiPercent: string;
    timeToPercent: number;
}

export interface AnalysisResponse {
    pair: string;
    asset1: string;
    asset2: string;
    direction: string;
    generatedAt: string;
    processingTimeMs: number;
    currentPrices: Record<string, number>;
    signal: {
        zScore30d: number;
        isReady: boolean;
        direction: string;
        strength: number;
    };
    advanced: {
        regime: AnalysisRegime;
        hurst: AnalysisHurst;
        dualBeta: AnalysisDualBeta | null;
        conviction: AnalysisConviction;
    };
    standardized: {
        beta: number;
        correlation: number;
        zScore: number;
        halfLife: number | null;
        isCointegrated: boolean;
        positionSizing: { weight1: number; weight2: number };
    };
    timeframes: Record<number, AnalysisTimeframe>;
    divergence: AnalysisDivergence | null;
    expectedROI: AnalysisExpectedROI | null;
    percentageReversion: Record<string, { exitZ: number; totalEvents: number; revertedEvents: number; reversionRate: number | null; avgDuration: number | null }> | null;
    funding: AnalysisFunding | null;
    obv: Record<number, Record<string, number>>;
}

export async function getPairAnalysis(asset1: string, asset2: string, direction?: string) {
    const query = direction ? `?direction=${direction}` : '';
    return fetchAPI<AnalysisResponse>(`/api/analyze/${encodeURIComponent(asset1)}/${encodeURIComponent(asset2)}${query}`);
}

