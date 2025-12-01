"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/StatCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { History, RefreshCw, TrendingUp, Target, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface HistoryTrade {
  pair: string;
  sector?: string;
  entryTime: string;
  exitTime: string;
  entryZScore: number;
  exitZScore: number;
  totalPnL: number;
  daysInTrade: number;
  exitReason?: string;
}

interface HistoryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  winRate: string;
}

export default function HistoryPage() {
  const [trades, setTrades] = useState<HistoryTrade[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      setTrades(data.trades || []);
      setStats(data.stats || null);
    } catch (error) {
      console.error("Error fetching history:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Calculate additional stats
  const avgPnL =
    trades.length > 0
      ? trades.reduce((sum, t) => sum + t.totalPnL, 0) / trades.length
      : 0;
  const avgDays =
    trades.length > 0
      ? trades.reduce((sum, t) => sum + t.daysInTrade, 0) / trades.length
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <History className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Trade History</h1>
            <p className="text-sm text-muted-foreground">
              {trades.length} closed trades
            </p>
          </div>
        </div>
        <Button onClick={fetchData} disabled={loading} variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total P&L"
            value={`${stats.totalPnL >= 0 ? "+" : ""}${stats.totalPnL.toFixed(2)}%`}
            trend={stats.totalPnL >= 0 ? "up" : "down"}
            icon={<TrendingUp className="w-5 h-5" />}
          />
          <StatCard
            title="Win Rate"
            value={`${stats.winRate}%`}
            subtitle={`${stats.wins}W / ${stats.losses}L`}
            icon={<Target className="w-5 h-5" />}
          />
          <StatCard
            title="Avg P&L"
            value={`${avgPnL >= 0 ? "+" : ""}${avgPnL.toFixed(2)}%`}
            trend={avgPnL >= 0 ? "up" : "down"}
          />
          <StatCard
            title="Avg Duration"
            value={`${avgDays.toFixed(1)}d`}
            icon={<Clock className="w-5 h-5" />}
          />
        </div>
      )}

      {/* Trades Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Closed Trades</CardTitle>
        </CardHeader>
        <CardContent>
          {trades.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No trade history yet
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead>Exit Reason</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">Z Entry→Exit</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades
                  .slice()
                  .reverse()
                  .map((trade, idx) => (
                    <TableRow key={`${trade.pair}-${idx}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{trade.pair}</span>
                          {trade.sector && (
                            <Badge variant="secondary" className="text-xs">
                              {trade.sector}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            trade.exitReason === "TARGET"
                              ? "default"
                              : trade.exitReason === "STOP_LOSS"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {trade.exitReason || "MANUAL"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "font-medium",
                            trade.totalPnL >= 0 ? "text-green-600" : "text-red-600"
                          )}
                        >
                          {trade.totalPnL >= 0 ? "+" : ""}
                          {trade.totalPnL.toFixed(2)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {trade.entryZScore?.toFixed(2)} → {trade.exitZScore?.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {trade.daysInTrade?.toFixed(1)}d
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm">
                        {trade.exitTime
                          ? new Date(trade.exitTime).toLocaleDateString()
                          : "?"}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


