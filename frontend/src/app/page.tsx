"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TradesTable } from "@/components/TradesTable";
import { ApproachingList } from "@/components/ApproachingList";
import { 
  Bot, RefreshCw, TrendingUp, TrendingDown, Activity, Zap
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

export default function BotDashboard() {
  const [trades, setTrades] = useState<api.Trade[]>([]);
  const [watchlist, setWatchlist] = useState<api.WatchlistPair[]>([]);
  const [stats, setStats] = useState<api.Stats | null>(null);
  const [scheduler, setScheduler] = useState<api.StatusResponse["scheduler"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, tradesRes, watchlistRes] = await Promise.all([
        api.getStatus(),
        api.getTrades(),
        api.getWatchlist(),
      ]);

      setTrades(tradesRes.trades || []);
      setWatchlist(watchlistRes.pairs || []);
      setStats({
        totalTrades: statusRes.history.totalTrades,
        wins: statusRes.history.wins,
        losses: statusRes.history.losses,
        totalPnL: parseFloat(statusRes.history.totalPnL),
        winRate: statusRes.history.totalTrades > 0 
          ? ((statusRes.history.wins / statusRes.history.totalTrades) * 100).toFixed(1)
          : "0",
      });
      setScheduler(statusRes.scheduler);
      setLastUpdate(new Date());
    } catch (err) {
      console.error("Error fetching data:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const totalPnL = trades.reduce((sum, t) => sum + (t.currentPnL || 0), 0);
  
  // Exclude pairs that already have active trades or asset overlap
  const activePairs = new Set(trades.map((t) => t.pair));
  const assetsInUse = new Set<string>();
  trades.forEach((t) => {
    if (t.asset1) assetsInUse.add(t.asset1);
    if (t.asset2) assetsInUse.add(t.asset2);
  });
  
  // Filter out pairs with exact match OR asset overlap
  const isAvailable = (p: api.WatchlistPair) => 
    !activePairs.has(p.pair) && !assetsInUse.has(p.asset1) && !assetsInUse.has(p.asset2);
  
  const approachingPairs = watchlist.filter(
    (p) => p.signalStrength >= 0.5 && isAvailable(p)
  );
  const readyPairs = watchlist.filter((p) => p.isReady && isAvailable(p));

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Bot Dashboard</h1>
            <div className="text-sm text-muted-foreground space-y-0.5">
              {scheduler?.monitor?.lastRun ? (
                <p>
                  Monitor: {new Date(scheduler.monitor.lastRun).toLocaleTimeString()}
                  {" → "}
                  {new Date(new Date(scheduler.monitor.lastRun).getTime() + 15 * 60 * 1000).toLocaleTimeString()}
                </p>
              ) : <p>Monitor: Loading...</p>}
              {scheduler?.scan?.lastRun ? (
                <p>
                  Scan: {new Date(scheduler.scan.lastRun).toLocaleTimeString()}
                  {" → "}
                  {new Date(new Date(scheduler.scan.lastRun).getTime() + 12 * 60 * 60 * 1000).toLocaleTimeString()}
                  {scheduler.scan.crossSectorEnabled && " (cross-sector)"}
                </p>
              ) : <p>Scan: Not run yet</p>}
            </div>
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

      {/* Stats Row - Simple, no cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-wrap items-baseline gap-4 sm:gap-6 lg:gap-8 pb-6 border-b border-border">
        {/* Open P&L */}
        <div>
          <p className="text-sm text-muted-foreground mb-1">Open P&L</p>
          <div className="flex items-center gap-2">
            {totalPnL >= 0 ? (
              <TrendingUp className="w-5 h-5 text-emerald-400" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-400" />
            )}
            <span className={cn(
              "text-3xl font-bold tabular-nums",
              totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
            )}>
              {totalPnL >= 0 ? "+" : ""}{totalPnL.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Realized P&L */}
        <div>
          <p className="text-sm text-muted-foreground mb-1">Realized</p>
          <span className={cn(
            "text-3xl font-bold tabular-nums",
            (stats?.totalPnL || 0) >= 0 ? "text-emerald-400" : "text-red-400"
          )}>
            {(stats?.totalPnL || 0) >= 0 ? "+" : ""}{(stats?.totalPnL || 0).toFixed(2)}%
          </span>
        </div>

        {/* Win Rate */}
        <div>
          <p className="text-sm text-muted-foreground mb-1">Win Rate</p>
          <span className="text-3xl font-bold tabular-nums">
            {stats?.winRate || 0}%
          </span>
          <span className="text-sm text-muted-foreground ml-2">
            {stats?.wins || 0}W / {stats?.losses || 0}L
          </span>
        </div>

        {/* Positions */}
        <div>
          <p className="text-sm text-muted-foreground mb-1">Positions</p>
          <span className="text-3xl font-bold tabular-nums">{trades.length}</span>
          <span className="text-sm text-muted-foreground ml-1">active</span>
        </div>

        {/* Approaching */}
        <div>
          <p className="text-sm text-muted-foreground mb-1">Approaching</p>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            <span className="text-3xl font-bold tabular-nums">{approachingPairs.length}</span>
            {readyPairs.length > 0 && (
              <span className="text-sm text-emerald-400">({readyPairs.length} ready)</span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Trades */}
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Active Positions</h2>
          </div>
          
          {trades.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-lg">
              <Activity className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>No active trades</p>
              <p className="text-sm mt-1">Waiting for entry signals...</p>
            </div>
          ) : (
            <TradesTable trades={trades} />
          )}
        </div>

        {/* Approaching List */}
        <div>
          <ApproachingList pairs={watchlist.filter(isAvailable)} />
        </div>
      </div>
    </div>
  );
}
