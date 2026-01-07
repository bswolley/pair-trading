"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { List, RefreshCw, TrendingUp, TrendingDown, Zap, HelpCircle, LineChart, AlertTriangle, CheckCircle, XCircle, Filter, Play } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import { PairAnalysisModal } from "@/components/PairAnalysisModal";

// Metric tooltips with time windows
const METRIC_TOOLTIPS = {
  zScore: "Standard deviations from the mean spread (30-day window). Negative = long signal, Positive = short signal.",
  entry: "Z-Score threshold for entry. Dynamic based on historical divergence analysis.",
  signal: "Progress toward entry threshold. 100% = ready to trade.",
  hurst: "Mean-reversion strength (60-day R/S analysis). H < 0.5 = mean-reverting, H > 0.5 = trending. Only pairs with H < 0.5 are kept.",
  conviction: "Trade quality score (0-100) combining: correlation (30d), R² (90d), half-life (30d), Hurst (60d), cointegration (90d), beta stability.",
  halfLife: "Expected days for spread to revert halfway to mean (30-day window). Matches trading horizon.",
  correlation: "Pearson correlation of log returns (30-day window). Higher = stronger co-movement.",
  weights: "Position sizing from hedge ratio (β). Calculated: w1 = 1/(1+β), w2 = β/(1+β). Uses 30-day β from OLS regression.",
  betaDrift: "% change in beta since scanner discovered pair. High drift (>15%) = hedge ratio unstable since discovery. Note: Trade drift is measured from trade entry, not discovery.",
  volume: "24h trading volume (USD). Low volume divergences may revert better than high volume (liquidity noise vs fundamental shift).",
  volRatio: "Spread volatility / Directional volatility. Lower = better beta neutralization. <0.3 excellent, 0.3-0.5 good, >0.5 poor.",
};

// Format volume as compact string (e.g. $1.2M, $500K)
function formatVolume(vol: number | null | undefined): string {
  if (vol === null || vol === undefined) return "—";
  if (vol >= 1e9) return `$${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `$${(vol / 1e6).toFixed(1)}M`;
  if (vol >= 1e3) return `$${(vol / 1e3).toFixed(0)}K`;
  return `$${vol.toFixed(0)}`;
}

// Calculate position weights from beta
function getWeights(beta: number | undefined | null): { w1: number; w2: number } | null {
  if (beta === undefined || beta === null || beta <= 0) return null;
  const w1 = 1 / (1 + beta);
  const w2 = beta / (1 + beta);
  return { w1: Math.round(w1 * 100), w2: Math.round(w2 * 100) };
}

function MetricHeader({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 cursor-help">
          {label}
          <HelpCircle className="w-3 h-3 text-muted-foreground/50" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-left">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

type FilterMode = 'all' | 'ready' | 'blocked' | 'active' | 'approaching';

export default function WatchlistPage() {
  const [pairs, setPairs] = useState<api.WatchlistPair[]>([]);
  const [sectors, setSectors] = useState<Array<{ name: string; count: number }>>([]);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartPair, setChartPair] = useState<api.WatchlistPair | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [watchlistRes, sectorsRes] = await Promise.all([
        api.getWatchlist(selectedSector ? { sector: selectedSector } : undefined),
        api.getWatchlistSectors(),
      ]);

      setPairs(watchlistRes.pairs || []);
      setSectors(sectorsRes.sectors || []);
    } catch (err) {
      console.error("Error fetching watchlist:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch watchlist");
    } finally {
      setLoading(false);
    }
  }, [selectedSector]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Enhanced validation: Check all entry criteria (matching backend logic)
  const validateForEntry = (pair: api.WatchlistPair) => {
    const reasons: string[] = [];

    // Already in a trade (exact pair match) - use backend field
    if (pair.isActive) reasons.push('active_trade');

    // Smart asset overlap - use backend-provided type
    if (pair.hasAssetOverlap && pair.overlapType) {
      reasons.push(pair.overlapType);
    } else if (pair.hasAssetOverlap) {
      reasons.push('asset_overlap');
    }

    // Check 1: Z-Score signal - use signalStrength instead of isReady 
    // (scanner may set isReady=false for safety reasons even when at threshold)
    if (pair.signalStrength < 1) reasons.push('no_signal');

    // Check 2: Hurst < 0.5 (NEW: Critical spread mean-reversion check)
    if (pair.hurst !== null && pair.hurst !== undefined && pair.hurst >= 0.5) {
      reasons.push('hurst_trending');
    }

    // Check 3: Correlation >= 0.6
    if (pair.correlation !== null && pair.correlation !== undefined && pair.correlation < 0.6) {
      reasons.push('low_correlation');
    }

    // Check 4: Half-life <= 30 days
    if (pair.halfLife !== null && pair.halfLife !== undefined && pair.halfLife > 30) {
      reasons.push('slow_reversion');
    }

    // Check 5: Vol ratio <= 0.5 (good beta neutralization)
    if (pair.volRatio !== null && pair.volRatio !== undefined && pair.volRatio > 0.5) {
      reasons.push('high_vol_ratio');
    }

    // Check 6: Reversion safety (from scanner hourly analysis)
    if (pair.reversionWarning) {
      reasons.push('low_reversion');
    }

    // Return all reasons
    return {
      valid: reasons.length === 0,
      reasons: reasons,
      reason: reasons[0] || null  // Keep first reason for backward compatibility
    };
  };

  // Categorize pairs by entry readiness
  const validatedPairs = pairs.map(p => ({
    ...p,
    validation: validateForEntry(p)
  }));

  // Active pairs (currently in trade)
  const activePairsList = validatedPairs.filter((p) => p.isActive);

  // Actually ready to enter (all checks pass)
  const readyPairs = validatedPairs.filter((p) => p.validation.valid);

  // Blocked by validation (at threshold but failed any check INCLUDING active trade)
  // Use signalStrength >= 1 instead of isReady because scanner may set isReady=false for safety reasons
  const blockedPairs = validatedPairs.filter((p) => {
    const atThreshold = p.signalStrength >= 1;
    if (!atThreshold) return false; // Must be at threshold
    // Include all validation failures (including active_trade)
    const blockingReasons = p.validation.reasons?.filter(r => r !== 'no_signal') || [];
    return blockingReasons.length > 0; // Has any validation failure
  });

  // Approaching entry threshold (below threshold, not in active trade)
  const approachingPairs = validatedPairs.filter((p) =>
    p.signalStrength >= 0.5 && p.signalStrength < 1 && !p.isActive
  );

  // Apply filter mode to table
  const filteredPairs = validatedPairs.filter((pair) => {
    if (filterMode === 'ready') return pair.validation.valid;
    if (filterMode === 'active') return pair.isActive;
    if (filterMode === 'blocked') {
      const atThreshold = pair.signalStrength >= 1;
      if (!atThreshold) return false;
      const blockingReasons = pair.validation.reasons?.filter(r => r !== 'no_signal') || [];
      return blockingReasons.length > 0;
    }
    if (filterMode === 'approaching') return pair.signalStrength >= 0.5 && pair.signalStrength < 1;
    return true; // 'all'
  });

  return (
    <TooltipProvider>
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <List className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Watchlist</h1>
            <p className="text-sm text-muted-foreground">{pairs.length} pairs monitored</p>
          </div>
        </div>
        <Button onClick={fetchData} disabled={loading} variant="outline" size="sm">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="flex items-baseline gap-8 pb-6 border-b border-border">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Total Pairs</p>
          <span className="text-3xl font-bold tabular-nums">{pairs.length}</span>
        </div>
        <div>
          <div className="flex items-center gap-1 mb-1">
            <Play className="w-4 h-4 text-blue-400" />
            <p className="text-sm text-muted-foreground">Active</p>
          </div>
          <span className="text-3xl font-bold tabular-nums text-blue-400">{activePairsList.length}</span>
        </div>
        <div>
          <div className="flex items-center gap-1 mb-1">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            <p className="text-sm text-muted-foreground">Ready</p>
          </div>
          <span className="text-3xl font-bold tabular-nums text-emerald-400">{readyPairs.length}</span>
        </div>
        <div>
          <div className="flex items-center gap-1 mb-1">
            <XCircle className="w-4 h-4 text-red-400" />
            <p className="text-sm text-muted-foreground">Blocked</p>
          </div>
          <span className="text-3xl font-bold tabular-nums text-red-400">{blockedPairs.length}</span>
        </div>
        <div>
          <div className="flex items-center gap-1 mb-1">
            <TrendingUp className="w-4 h-4 text-yellow-400" />
            <p className="text-sm text-muted-foreground">Approaching</p>
          </div>
          <span className="text-3xl font-bold tabular-nums text-yellow-400">{approachingPairs.length}</span>
        </div>
      </div>

      {/* Sector Filter */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={selectedSector === null ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedSector(null)}
        >
          All
        </Button>
        {sectors.map((sector) => (
          <Button
            key={sector.name}
            variant={selectedSector === sector.name ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedSector(sector.name)}
          >
            {sector.name} <span className="ml-1 text-muted-foreground">({sector.count})</span>
          </Button>
        ))}
      </div>

      {/* Ready Pairs */}
      {readyPairs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="font-semibold text-emerald-400">Ready for Entry</h2>
            <span className="text-xs text-muted-foreground">(All validation checks passed)</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {readyPairs.map((pair) => (
              <div
                key={pair.pair}
                className="flex items-center justify-between p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10"
              >
                <div>
                  <p className="font-medium">{pair.pair}</p>
                  <p className="text-xs text-muted-foreground">{pair.sector}</p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1 font-mono">
                    {pair.zScore < 0 ? (
                      <TrendingUp className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <TrendingDown className="w-4 h-4 text-red-400" />
                    )}
                    {pair.zScore.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground">@ {pair.entryThreshold}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocked Pairs */}
      {blockedPairs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <XCircle className="w-5 h-5 text-red-400" />
            <h2 className="font-semibold text-red-400">Blocked - Strong Signal, Failed Validation</h2>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {blockedPairs.map((pair) => {
              const reasonLabels: Record<string, string> = {
                'hurst_trending': `Trending spread (H=${pair.hurst?.toFixed(2) ?? '?'})`,
                'low_correlation': `Low correlation (${((pair.correlation ?? 0) * 100).toFixed(0)}%)`,
                'slow_reversion': `Slow reversion (HL=${pair.halfLife?.toFixed(1) ?? '?'}d)`,
                'low_reversion': `Low reversion rate (${pair.reversionRate !== null && pair.reversionRate !== undefined ? pair.reversionRate.toFixed(0) + '%' : '?'})`,
                'high_vol_ratio': `High vol ratio (${pair.volRatio?.toFixed(2) ?? '?'} > 0.5)`,
                'active_trade': 'Already in trade',
                'asset_overlap': `Asset overlap (${pair.overlapAsset || pair.asset1})`,
                'long_conflict': `${pair.overlapAsset} already short elsewhere`,
                'short_conflict': `${pair.overlapAsset} already long elsewhere`,
                'max_exposure': `${pair.overlapAsset} at max exposure (2 trades)`,
                'no_signal': `Below threshold (${Math.round(pair.signalStrength * 100)}%)`,
              };
              return (
                <div
                  key={pair.pair}
                  className="flex items-center justify-between p-3 rounded-lg border border-red-500/30 bg-red-500/10"
                >
                  <div>
                    <p className="font-medium">{pair.pair}</p>
                    <p className="text-xs text-red-400">
                      {reasonLabels[pair.validation.reason || ''] || 'Unknown reason'}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center gap-1 font-mono">
                      {pair.zScore < 0 ? (
                        <TrendingUp className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-red-400" />
                      )}
                      {pair.zScore.toFixed(2)}
                    </div>
                    <p className="text-xs text-muted-foreground">@ {pair.entryThreshold}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* All Pairs Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold">All Pairs</h2>
            <p className="text-xs text-muted-foreground mt-1">Click on a pair to view Z-Score chart</p>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <div className="flex gap-1">
              <Button
                variant={filterMode === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterMode('all')}
              >
                All ({validatedPairs.length})
              </Button>
              <Button
                variant={filterMode === 'active' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterMode('active')}
                className={filterMode === 'active' ? 'bg-blue-500 hover:bg-blue-600' : ''}
              >
                <Play className="w-3 h-3 mr-1" />
                Active ({activePairsList.length})
              </Button>
              <Button
                variant={filterMode === 'ready' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterMode('ready')}
                className={filterMode === 'ready' ? 'bg-emerald-500 hover:bg-emerald-600' : ''}
              >
                <CheckCircle className="w-3 h-3 mr-1" />
                Ready ({readyPairs.length})
              </Button>
              <Button
                variant={filterMode === 'blocked' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterMode('blocked')}
                className={filterMode === 'blocked' ? 'bg-red-500 hover:bg-red-600' : ''}
              >
                <XCircle className="w-3 h-3 mr-1" />
                Blocked ({blockedPairs.length})
              </Button>
              <Button
                variant={filterMode === 'approaching' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterMode('approaching')}
                className={filterMode === 'approaching' ? 'bg-yellow-500 hover:bg-yellow-600' : ''}
              >
                <TrendingUp className="w-3 h-3 mr-1" />
                Approaching ({approachingPairs.length})
              </Button>
            </div>
          </div>
        </div>
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Pair</th>
                <th className="text-left px-4 py-3 font-medium">Sector</th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Z-Score" tooltip={METRIC_TOOLTIPS.zScore} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Entry @" tooltip={METRIC_TOOLTIPS.entry} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Signal" tooltip={METRIC_TOOLTIPS.signal} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Hurst" tooltip={METRIC_TOOLTIPS.hurst} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Conv" tooltip={METRIC_TOOLTIPS.conviction} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="HL" tooltip={METRIC_TOOLTIPS.halfLife} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Corr" tooltip={METRIC_TOOLTIPS.correlation} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Weights" tooltip={METRIC_TOOLTIPS.weights} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Volume" tooltip={METRIC_TOOLTIPS.volume} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="Vol Ratio" tooltip={METRIC_TOOLTIPS.volRatio} />
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  <MetricHeader label="β Drift" tooltip={METRIC_TOOLTIPS.betaDrift} />
                </th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredPairs.map((pair) => {
                const signalPct = Math.round(pair.signalStrength * 100);
                const isApproaching = pair.signalStrength >= 0.5;
                const nonActiveTradeReasons = pair.validation.reasons?.filter(r => r !== 'active_trade' && r !== 'no_signal') || [];
                // A pair is blocked if signal is at threshold (100%) but has validation failures
                // Use signalStrength >= 1 instead of isReady because scanner may set isReady=false for safety reasons
                const atThreshold = pair.signalStrength >= 1;
                const isBlocked = atThreshold && nonActiveTradeReasons.length > 0;

                return (
                  <tr
                    key={pair.pair}
                    className={cn(
                      "cursor-pointer hover:bg-muted/50 transition-colors",
                      pair.isActive && "bg-blue-500/10",
                      pair.validation.valid && !pair.isActive && "bg-emerald-500/5",
                      isBlocked && !pair.isActive && "bg-red-500/5",
                      pair.hasAssetOverlap && !pair.isActive && "bg-orange-500/5"
                    )}
                    onClick={() => setChartPair(pair)}
                  >
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        {pair.pair}
                        {pair.isActive && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className="bg-blue-500 text-xs flex items-center gap-1 cursor-help">
                                <Play className="w-3 h-3" />
                                Active
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs bg-black text-white border-gray-700">
                              <div className="space-y-1 text-xs">
                                <p className="font-semibold text-blue-400">Currently trading this pair</p>
                                <p className="text-gray-300">Check the Trades page for position details.</p>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {pair.validation.valid && !pair.isActive && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className="bg-emerald-500 text-xs flex items-center gap-1 cursor-help">
                                <CheckCircle className="w-3 h-3" />
                                Ready
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs bg-black text-white border-gray-700">
                              <div className="space-y-1 text-xs">
                                <p className="font-semibold text-emerald-400">All validation checks passed:</p>
                                <p className="text-white">• Z-Score: {pair.zScore.toFixed(2)} ≥ {pair.entryThreshold.toFixed(1)}</p>
                                <p className="text-white">• Hurst: {pair.hurst?.toFixed(2) ?? '?'} &lt; 0.5 (mean-reverting)</p>
                                <p className="text-white">• Correlation: {((pair.correlation ?? 0) * 100).toFixed(0)}% ≥ 60%</p>
                                <p className="text-white">• Half-life: {pair.halfLife?.toFixed(1) ?? '?'}d ≤ 30d</p>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {isBlocked && !pair.isActive && !pair.hasAssetOverlap && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className="bg-red-500 text-xs flex items-center gap-1 cursor-help">
                                <XCircle className="w-3 h-3" />
                                Blocked
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs bg-black text-white border-gray-700">
                              <div className="space-y-1 text-xs">
                                <p className="font-semibold text-red-400">Blocked by {pair.validation.reasons?.length || 1} issue{(pair.validation.reasons?.length || 1) > 1 ? 's' : ''}:</p>
                                {pair.validation.reasons?.includes('active_trade') && (
                                  <p className="text-yellow-400">• Already in active trade</p>
                                )}
                                {pair.validation.reasons?.includes('asset_overlap') && (
                                  <p className="text-yellow-400">• Asset already in use ({pair.overlapAsset || pair.asset1} in another trade)</p>
                                )}
                                {pair.validation.reasons?.includes('long_conflict') && (
                                  <p className="text-yellow-400">• Conflict: {pair.overlapAsset} is SHORT in another trade (can&apos;t go LONG)</p>
                                )}
                                {pair.validation.reasons?.includes('short_conflict') && (
                                  <p className="text-yellow-400">• Conflict: {pair.overlapAsset} is LONG in another trade (can&apos;t go SHORT)</p>
                                )}
                                {pair.validation.reasons?.includes('max_exposure') && (
                                  <p className="text-yellow-400">• Max exposure: {pair.overlapAsset} already in 2 trades</p>
                                )}
                                {pair.validation.reasons?.includes('no_signal') && (
                                  <p className="text-red-400">• Z-Score {pair.zScore.toFixed(2)} &lt; {pair.entryThreshold.toFixed(1)} (weak signal)</p>
                                )}
                                {pair.validation.reasons?.includes('hurst_trending') && (
                                  <>
                                    <p className="text-red-400">• Hurst {pair.hurst?.toFixed(2) ?? '?'} ≥ 0.5 (spread trending)</p>
                                    <p className="text-gray-400 text-[10px] ml-2">Individual assets may mean-revert but spread trends</p>
                                  </>
                                )}
                                {pair.validation.reasons?.includes('low_correlation') && (
                                  <>
                                    <p className="text-red-400">• Correlation {((pair.correlation ?? 0) * 100).toFixed(0)}% &lt; 60%</p>
                                    <p className="text-gray-400 text-[10px] ml-2">Assets not moving together strongly enough</p>
                                  </>
                                )}
                                {pair.validation.reasons?.includes('slow_reversion') && (
                                  <>
                                    <p className="text-red-400">• Half-life {pair.halfLife?.toFixed(1) ?? '?'}d &gt; 30d</p>
                                    <p className="text-gray-400 text-[10px] ml-2">Mean reversion too slow for trading</p>
                                  </>
                                )}
                                {pair.validation.reasons?.includes('high_vol_ratio') && (
                                  <>
                                    <p className="text-red-400">• Vol ratio {pair.volRatio?.toFixed(2) ?? '?'} &gt; 0.5</p>
                                    <p className="text-gray-400 text-[10px] ml-2">Poor beta neutralization - spread too volatile vs direction</p>
                                  </>
                                )}
                                {pair.validation.reasons?.includes('low_reversion') && (
                                  <>
                                    <p className="text-red-400">• Reversion rate {pair.reversionRate !== null && pair.reversionRate !== undefined ? pair.reversionRate.toFixed(0) + '%' : '?'} &lt; 50%</p>
                                    <p className="text-gray-400 text-[10px] ml-2">Historically poor reversion at current Z level</p>
                                  </>
                                )}
                                {(!pair.validation.reasons || pair.validation.reasons.length === 0) && (
                                  <p className="text-yellow-400">• Unknown validation issue</p>
                                )}
                                <div className="mt-2 pt-2 border-t border-gray-700">
                                  <p className="text-gray-300">All metrics:</p>
                                  <p className={pair.zScore >= pair.entryThreshold ? "text-emerald-400" : "text-red-400"}>
                                    • Z-Score: {pair.zScore.toFixed(2)} (need ≥ {pair.entryThreshold.toFixed(1)})
                                  </p>
                                  <p className={(pair.hurst ?? 0) < 0.5 ? "text-emerald-400" : "text-red-400"}>
                                    • Hurst: {pair.hurst?.toFixed(2) ?? 'N/A'} (need &lt; 0.5)
                                  </p>
                                  <p className={(pair.correlation ?? 0) >= 0.6 ? "text-emerald-400" : "text-red-400"}>
                                    • Corr: {((pair.correlation ?? 0) * 100).toFixed(0)}% (need ≥ 60%)
                                  </p>
                                  <p className={(pair.halfLife ?? 999) <= 30 ? "text-emerald-400" : "text-red-400"}>
                                    • HL: {pair.halfLife?.toFixed(1) ?? '∞'}d (need ≤ 30d)
                                  </p>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {pair.hasAssetOverlap && !pair.isActive && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className={cn(
                                "text-xs flex items-center gap-1 cursor-help",
                                pair.overlapType === 'max_exposure' ? "bg-yellow-500" : "bg-orange-500"
                              )}>
                                <AlertTriangle className="w-3 h-3" />
                                {pair.overlapType === 'max_exposure' ? 'Max' : 
                                 pair.overlapType === 'long_conflict' || pair.overlapType === 'short_conflict' ? 'Conflict' : 'Overlap'}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs bg-black text-white border-gray-700">
                              <div className="space-y-1 text-xs">
                                {pair.overlapType === 'long_conflict' && (
                                  <>
                                    <p className="font-semibold text-orange-400">Conflicting Position</p>
                                    <p className="text-gray-300">
                                      Can&apos;t go LONG on {pair.overlapAsset} - it&apos;s already SHORT in another trade.
                                    </p>
                                  </>
                                )}
                                {pair.overlapType === 'short_conflict' && (
                                  <>
                                    <p className="font-semibold text-orange-400">Conflicting Position</p>
                                    <p className="text-gray-300">
                                      Can&apos;t go SHORT on {pair.overlapAsset} - it&apos;s already LONG in another trade.
                                    </p>
                                  </>
                                )}
                                {pair.overlapType === 'max_exposure' && (
                                  <>
                                    <p className="font-semibold text-yellow-400">Max Exposure Reached</p>
                                    <p className="text-gray-300">
                                      {pair.overlapAsset} is already in 2 trades. Same-side overlap is allowed but limited to 2 trades per asset.
                                    </p>
                                  </>
                                )}
                                {!pair.overlapType && (
                                  <>
                                    <p className="font-semibold text-orange-400">Asset Overlap</p>
                                    <p className="text-gray-300">
                                      {pair.asset1} or {pair.asset2} is being used in another position.
                                    </p>
                                  </>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-xs">{pair.sector}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className="flex items-center justify-end gap-1">
                        {pair.zScore < 0 ? (
                          <TrendingUp className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <TrendingDown className="w-3 h-3 text-red-400" />
                        )}
                        {pair.zScore.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{pair.entryThreshold.toFixed(1)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn(
                        "font-medium",
                        pair.isReady ? "text-emerald-400" : isApproaching ? "text-yellow-400" : "text-muted-foreground"
                      )}>
                        {signalPct}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {pair.hurst !== undefined && pair.hurst !== null ? (
                        <span className={cn(
                          "font-mono text-xs",
                          pair.hurst < 0.4 ? "text-emerald-400" :
                          pair.hurst < 0.5 ? "text-emerald-400/70" :
                          pair.hurst < 0.55 ? "text-yellow-400" :
                          "text-red-400"
                        )}>
                          {pair.hurst.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {pair.conviction !== undefined && pair.conviction !== null ? (
                        <span className={cn(
                          "font-mono text-xs font-medium",
                          pair.conviction >= 70 ? "text-emerald-400" :
                          pair.conviction >= 50 ? "text-yellow-400" :
                          "text-muted-foreground"
                        )}>
                          {Math.round(pair.conviction)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {pair.halfLife === null || pair.halfLife === undefined 
                        ? <span className="text-yellow-400/70">∞</span>
                        : `${pair.halfLife.toFixed(1)}d`}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {pair.correlation?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {(() => {
                        const weights = getWeights(pair.beta);
                        if (!weights) return <span className="text-muted-foreground/50">—</span>;
                        return (
                          <span className="text-muted-foreground">
                            <span className="text-emerald-400">{weights.w1}%</span>
                            <span className="mx-0.5">/</span>
                            <span className="text-red-400">{weights.w2}%</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono text-xs text-muted-foreground cursor-help">
                            {formatVolume(Math.min(pair.volume1 ?? 0, pair.volume2 ?? 0))}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <p>{pair.asset1}: {formatVolume(pair.volume1)}</p>
                          <p>{pair.asset2}: {formatVolume(pair.volume2)}</p>
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {pair.volRatio !== undefined && pair.volRatio !== null ? (
                        <span className={cn(
                          "font-mono text-xs",
                          pair.volRatio < 0.3 ? "text-emerald-400" :
                          pair.volRatio < 0.5 ? "text-yellow-400" :
                          "text-red-400"
                        )}>
                          {pair.volRatio.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {pair.betaDrift !== undefined && pair.betaDrift !== null ? (
                        <span className={cn(
                          "font-mono text-xs",
                          pair.betaDrift > 0.15 ? "text-yellow-400" :
                          pair.betaDrift > 0.05 ? "text-muted-foreground" :
                          "text-emerald-400"
                        )}>
                          {(pair.betaDrift * 100).toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <LineChart className="w-4 h-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pair Analysis Modal (Chart + Full Report) */}
      <PairAnalysisModal
        pair={chartPair}
        open={!!chartPair}
        onOpenChange={(open) => !open && setChartPair(null)}
      />
    </div>
    </TooltipProvider>
  );
}
