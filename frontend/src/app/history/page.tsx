"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { History, RefreshCw, TrendingUp, TrendingDown } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

export default function HistoryPage() {
  const [trades, setTrades] = useState<api.HistoryTrade[]>([]);
  const [stats, setStats] = useState<api.Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const historyRes = await api.getHistory();
      setTrades(historyRes.trades || []);
      setStats(historyRes.stats);
    } catch (err) {
      console.error("Error fetching history:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const winRate = stats?.totalTrades ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : "0";
  const avgPnL = stats?.totalTrades ? (stats.totalPnL / stats.totalTrades) : 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <History className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Trade History</h1>
            <p className="text-sm text-muted-foreground">{stats?.totalTrades || 0} completed trades</p>
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
      <div className="flex flex-wrap items-baseline gap-8 pb-6 border-b border-border">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Total P&L</p>
          <span className={cn(
            "text-3xl font-bold tabular-nums",
            (stats?.totalPnL || 0) >= 0 ? "text-emerald-400" : "text-red-400"
          )}>
            {(stats?.totalPnL || 0) >= 0 ? "+" : ""}{(stats?.totalPnL || 0).toFixed(2)}%
          </span>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Win Rate</p>
          <span className="text-3xl font-bold tabular-nums">{winRate}%</span>
          <span className="text-sm text-muted-foreground ml-2">
            <span className="text-emerald-400">{stats?.wins || 0}W</span>
            {" / "}
            <span className="text-red-400">{stats?.losses || 0}L</span>
          </span>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Avg P&L</p>
          <span className={cn(
            "text-3xl font-bold tabular-nums",
            avgPnL >= 0 ? "text-emerald-400" : "text-red-400"
          )}>
            {avgPnL >= 0 ? "+" : ""}{avgPnL.toFixed(2)}%
          </span>
          <span className="text-sm text-muted-foreground ml-1">per trade</span>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Trades</p>
          <span className="text-3xl font-bold tabular-nums">{stats?.totalTrades || 0}</span>
        </div>
      </div>

      {/* Trades Table */}
      <div>
        <h2 className="font-semibold mb-3">All Trades</h2>
        {trades.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-lg">
            <History className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">No trade history yet</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Pair</th>
                  <th className="text-left px-4 py-3 font-medium">Exit</th>
                  <th className="text-right px-4 py-3 font-medium">P&L</th>
                  <th className="text-right px-4 py-3 font-medium">Days</th>
                  <th className="text-right px-4 py-3 font-medium">Exit Z</th>
                  <th className="text-right px-4 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trades.map((trade, idx) => {
                  const pnl = trade.totalPnL || 0;
                  const isWin = pnl >= 0;
                  
                  return (
                    <tr key={`${trade.pair}-${idx}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {isWin ? (
                            <TrendingUp className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <TrendingDown className="w-4 h-4 text-red-400" />
                          )}
                          <span className="font-medium">{trade.pair}</span>
                          <Badge variant="outline" className="text-xs">{trade.sector}</Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            trade.exitReason === "TARGET" || trade.exitReason === "FINAL_TP"
                              ? "default"
                              : trade.exitReason === "STOP_LOSS"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {trade.exitReason || "CLOSED"}
                        </Badge>
                      </td>
                      <td className={cn(
                        "px-4 py-3 text-right font-bold tabular-nums",
                        isWin ? "text-emerald-400" : "text-red-400"
                      )}>
                        {isWin ? "+" : ""}{pnl.toFixed(2)}%
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {trade.daysInTrade?.toFixed(1)}d
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                        {trade.exitZScore?.toFixed(2) || "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {trade.exitTime ? new Date(trade.exitTime).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
