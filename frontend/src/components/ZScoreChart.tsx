"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Loader2 } from "lucide-react";
import * as api from "@/lib/api";

interface ZScoreChartProps {
  pair: string;
  entryThreshold?: number;
  days?: number;
  cachedData?: api.ZScoreResponse | null;
  onDataLoaded?: (data: api.ZScoreResponse) => void;
}

export function ZScoreChart({ 
  pair, 
  entryThreshold = 2.0, 
  days = 30,
  cachedData,
  onDataLoaded 
}: ZScoreChartProps) {
  const [loading, setLoading] = useState(!cachedData);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<api.ZScoreDataPoint[]>(cachedData?.data || []);
  const [stats, setStats] = useState<api.ZScoreResponse["stats"] | null>(cachedData?.stats || null);

  useEffect(() => {
    // If we have cached data, use it
    if (cachedData) {
      setData(cachedData.data);
      setStats(cachedData.stats);
      setLoading(false);
      return;
    }
    
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const response = await api.getZScoreHistory(pair, days);
        setData(response.data);
        setStats(response.stats);
        // Store in cache via callback
        onDataLoaded?.(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch data");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [pair, days, cachedData, onDataLoaded]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading chart...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400">
        {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No data available
      </div>
    );
  }

  // Calculate min/max for Y axis with some padding
  const zScores = data.map((d) => d.zScore);
  const minZ = Math.min(...zScores, -entryThreshold - 0.5);
  const maxZ = Math.max(...zScores, entryThreshold + 0.5);

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      const z = d.zScore ?? 0;
      return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{d.date}</p>
          <p className="text-sm">
            Z-Score:{" "}
            <span className={z >= 0 ? "text-red-400" : "text-emerald-400"}>
              {z.toFixed(2)}
            </span>
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Current Z</span>
            <p className={`font-semibold ${(stats.currentZ ?? 0) >= 0 ? "text-red-400" : "text-emerald-400"}`}>
              {stats.currentZ?.toFixed(2) ?? "—"}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Correlation</span>
            <p className="font-semibold">{stats.correlation != null ? ((stats.correlation * 100).toFixed(1) + "%") : "—"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Half-Life</span>
            <p className="font-semibold">
              {stats.halfLife === null || stats.halfLife === undefined
                ? <span className="text-yellow-400">∞</span>
                : `${stats.halfLife.toFixed(1)}d`}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Beta</span>
            <p className="font-semibold">{stats.beta?.toFixed(3) ?? "—"}</p>
          </div>
        </div>
      )}

      {/* Chart */}
      <div style={{ width: '100%', height: 500 }}>
        <ResponsiveContainer width="100%" height={500}>
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.3} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              tickFormatter={(value) => {
                const d = new Date(value);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[minZ, maxZ]}
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              tickFormatter={(value) => value.toFixed(1)}
            />
            <Tooltip content={<CustomTooltip />} />
            
            {/* Entry threshold lines */}
            <ReferenceLine
              y={entryThreshold}
              stroke="#ef4444"
              strokeDasharray="5 5"
              strokeOpacity={0.7}
              label={{
                value: `+${entryThreshold}`,
                position: "right",
                fill: "#ef4444",
                fontSize: 10,
              }}
            />
            <ReferenceLine
              y={-entryThreshold}
              stroke="#10b981"
              strokeDasharray="5 5"
              strokeOpacity={0.7}
              label={{
                value: `-${entryThreshold}`,
                position: "right",
                fill: "#10b981",
                fontSize: 10,
              }}
            />
            
            {/* Mean line */}
            <ReferenceLine y={0} stroke="#6b7280" strokeOpacity={0.5} />

            {/* Z-Score line */}
            <Line
              type="monotone"
              dataKey="zScore"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "#8b5cf6" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5" style={{ backgroundColor: '#8b5cf6' }} />
          <span>Z-Score</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5 border-t-2 border-dashed" style={{ borderColor: '#ef4444' }} />
          <span>Short (+{entryThreshold})</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5 border-t-2 border-dashed" style={{ borderColor: '#10b981' }} />
          <span>Long (-{entryThreshold})</span>
        </div>
      </div>
    </div>
  );
}

