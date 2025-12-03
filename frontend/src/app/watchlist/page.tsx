"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { List, RefreshCw, TrendingUp, TrendingDown, Zap, LineChart } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import { ZScoreChart } from "@/components/ZScoreChart";

export default function WatchlistPage() {
  const [pairs, setPairs] = useState<api.WatchlistPair[]>([]);
  const [sectors, setSectors] = useState<Array<{ name: string; count: number }>>([]);
  const [activePairs, setActivePairs] = useState<Set<string>>(new Set());
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartPair, setChartPair] = useState<api.WatchlistPair | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [watchlistRes, sectorsRes, tradesRes] = await Promise.all([
        api.getWatchlist(selectedSector ? { sector: selectedSector } : undefined),
        api.getWatchlistSectors(),
        api.getTrades(),
      ]);

      setPairs(watchlistRes.pairs || []);
      setSectors(sectorsRes.sectors || []);
      setActivePairs(new Set((tradesRes.trades || []).map((t) => t.pair)));
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

  // Exclude pairs that already have active trades
  const readyPairs = pairs.filter((p) => p.isReady && !activePairs.has(p.pair));
  const approachingPairs = pairs.filter((p) => !p.isReady && p.signalStrength >= 0.5 && !activePairs.has(p.pair));

  return (
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
          <p className="text-sm text-muted-foreground mb-1">Ready</p>
          <span className="text-3xl font-bold tabular-nums text-emerald-400">{readyPairs.length}</span>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Approaching</p>
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
            <Zap className="w-5 h-5 text-emerald-400" />
            <h2 className="font-semibold text-emerald-400">Ready for Entry</h2>
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

      {/* All Pairs Table */}
      <div>
        <h2 className="font-semibold mb-3">All Pairs</h2>
        <p className="text-xs text-muted-foreground mb-3">Click on a pair to view Z-Score chart</p>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Pair</th>
                <th className="text-left px-4 py-3 font-medium">Sector</th>
                <th className="text-right px-4 py-3 font-medium">Z-Score</th>
                <th className="text-right px-4 py-3 font-medium">Entry @</th>
                <th className="text-right px-4 py-3 font-medium">Signal</th>
                <th className="text-right px-4 py-3 font-medium">Hurst</th>
                <th className="text-right px-4 py-3 font-medium">Conv</th>
                <th className="text-right px-4 py-3 font-medium">HL</th>
                <th className="text-right px-4 py-3 font-medium">Corr</th>
                <th className="text-right px-4 py-3 font-medium">Beta</th>
                <th className="text-right px-4 py-3 font-medium">β Drift</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pairs.map((pair) => {
                const signalPct = Math.round(pair.signalStrength * 100);
                const isApproaching = pair.signalStrength >= 0.5;

                return (
                  <tr
                    key={pair.pair}
                    className={cn(
                      "cursor-pointer hover:bg-muted/50 transition-colors",
                      pair.isReady && "bg-emerald-500/5"
                    )}
                    onClick={() => setChartPair(pair)}
                  >
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        {pair.pair}
                        {pair.isReady && (
                          <Badge className="bg-emerald-500 text-xs">Ready</Badge>
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
                      {pair.halfLife?.toFixed(1)}d
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {pair.correlation?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {pair.beta?.toFixed(3)}
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

      {/* Z-Score Chart Dialog */}
      <Dialog open={!!chartPair} onOpenChange={(open) => !open && setChartPair(null)}>
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LineChart className="w-5 h-5" />
              {chartPair?.pair} Z-Score History
              <Badge variant="outline" className="ml-2">{chartPair?.sector}</Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-[350px]">
            {chartPair && (
              <ZScoreChart
                pair={chartPair.pair}
                entryThreshold={chartPair.entryThreshold}
                days={30}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
