"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/StatCard";
import { TradesTable } from "@/components/TradesTable";
import { ApproachingList } from "@/components/ApproachingList";
import { Bot, RefreshCw, TrendingUp, Activity, Target } from "lucide-react";

interface Trade {
  pair: string;
  sector?: string;
  direction: string;
  currentPnL?: number;
  currentZ?: number;
  entryZScore?: number;
  halfLife?: number;
  currentHalfLife?: number;
  entryTime?: string;
  partialExitTaken?: boolean;
  longAsset?: string;
  shortAsset?: string;
  longWeight?: number;
  shortWeight?: number;
}

interface WatchlistPair {
  pair: string;
  sector?: string;
  zScore: number;
  entryThreshold: number;
  halfLife?: number;
  signalStrength: number;
}

interface HistoryStats {
  totalTrades?: number;
  wins?: number;
  losses?: number;
  totalPnL?: number;
  winRate?: string;
}

export default function BotDashboard() {
  const [botTrades, setBotTrades] = useState<Trade[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistPair[]>([]);
  const [historyStats, setHistoryStats] = useState<HistoryStats>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [tradesRes, watchlistRes, historyRes] = await Promise.all([
        fetch("/api/trades"),
        fetch("/api/watchlist"),
        fetch("/api/history"),
      ]);

      const tradesData = await tradesRes.json();
      const watchlistData = await watchlistRes.json();
      const historyData = await historyRes.json();

      setBotTrades(tradesData.botTrades || []);
      setWatchlist(watchlistData.pairs || []);
      setHistoryStats(historyData.stats || {});
      setLastUpdate(new Date());
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Calculate stats
  const totalPnL = botTrades.reduce((sum, t) => sum + (t.currentPnL || 0), 0);
  const activeTrades = botTrades.length;
  const winRate = historyStats.winRate || "0";
  const approachingCount = watchlist.filter((p) => p.signalStrength >= 0.5).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Bot Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {lastUpdate
                ? `Last updated: ${lastUpdate.toLocaleTimeString()}`
                : "Loading..."}
            </p>
          </div>
        </div>
        <Button onClick={fetchData} disabled={loading} variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Bot P&L"
          value={`${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}%`}
          trend={totalPnL >= 0 ? "up" : "down"}
          icon={<TrendingUp className="w-5 h-5" />}
        />
        <StatCard
          title="Active Trades"
          value={activeTrades}
          icon={<Activity className="w-5 h-5" />}
        />
        <StatCard
          title="Win Rate"
          value={`${winRate}%`}
          subtitle={`${historyStats.wins || 0}W / ${historyStats.losses || 0}L`}
          icon={<Target className="w-5 h-5" />}
        />
        <StatCard
          title="Approaching"
          value={approachingCount}
          subtitle="≥50% to entry"
          icon={<Target className="w-5 h-5" />}
        />
      </div>

      {/* Main Content */}
      <div className="grid md:grid-cols-3 gap-6">
        {/* Trades Table */}
        <div className="md:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Bot Positions</CardTitle>
            </CardHeader>
            <CardContent>
              <TradesTable trades={botTrades} />
            </CardContent>
          </Card>
        </div>

        {/* Approaching List */}
        <div>
          <ApproachingList pairs={watchlist} />
        </div>
      </div>
    </div>
  );
}
