"use client";

import { useEffect, useState, useCallback } from "react";
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
import { Loader2, Calendar, Clock } from "lucide-react";
import * as api from "@/lib/api";

interface ZScoreChartProps {
  pair: string;
  entryThreshold?: number;
  days?: number;
  cachedData?: api.ZScoreResponse | null;
  onDataLoaded?: (data: api.ZScoreResponse) => void;
}

type Resolution = '1d' | '1h';

export function ZScoreChart({ 
  pair, 
  entryThreshold = 2.0, 
  days = 30,
  cachedData,
  onDataLoaded 
}: ZScoreChartProps) {
  const [resolution, setResolution] = useState<Resolution>('1d');
  const [loading, setLoading] = useState(!cachedData);
  const [error, setError] = useState<string | null>(null);
  const [dailyData, setDailyData] = useState<api.ZScoreDataPoint[]>(cachedData?.data || []);
  const [hourlyData, setHourlyData] = useState<api.ZScoreDataPoint[]>([]);
  const [dailyStats, setDailyStats] = useState<api.ZScoreResponse["stats"] | null>(cachedData?.stats || null);
  const [hourlyStats, setHourlyStats] = useState<api.ZScoreResponse["stats"] | null>(null);
  const [hourlyLoaded, setHourlyLoaded] = useState(false);

  // Get current data based on resolution
  const data = resolution === '1d' ? dailyData : hourlyData;
  const stats = resolution === '1d' ? dailyStats : hourlyStats;

  // Fetch daily data
  useEffect(() => {
    if (cachedData) {
      setDailyData(cachedData.data);
      setDailyStats(cachedData.stats);
      setLoading(false);
      return;
    }
    
    async function fetchDailyData() {
      setLoading(true);
      setError(null);
      try {
        const response = await api.getZScoreHistory(pair, days, '1d');
        setDailyData(response.data);
        setDailyStats(response.stats);
        onDataLoaded?.(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch data");
      } finally {
        setLoading(false);
      }
    }
    fetchDailyData();
  }, [pair, days, cachedData, onDataLoaded]);

  // Fetch hourly data when tab is selected
  const fetchHourlyData = useCallback(async () => {
    if (hourlyLoaded) return;
    
    setLoading(true);
    setError(null);
    try {
      // Fetch 60 days of hourly data (matches divergence analysis)
      const response = await api.getZScoreHistory(pair, 60, '1h');
      setHourlyData(response.data);
      setHourlyStats(response.stats);
      setHourlyLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch hourly data");
    } finally {
      setLoading(false);
    }
  }, [pair, hourlyLoaded]);

  // Handle tab change
  const handleResolutionChange = (newResolution: Resolution) => {
    setResolution(newResolution);
    if (newResolution === '1h' && !hourlyLoaded) {
      fetchHourlyData();
    }
  };

  if (loading && data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading chart...</span>
      </div>
    );
  }

  if (error && data.length === 0) {
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
  const CustomTooltip = ({ active, payload }: any) => {
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
      {/* Resolution Tabs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => handleResolutionChange('1d')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            resolution === '1d'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          <Calendar className="w-4 h-4" />
          Daily (30d)
        </button>
        <button
          onClick={() => handleResolutionChange('1h')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            resolution === '1h'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          <Clock className="w-4 h-4" />
          Hourly (60d)
          {loading && resolution === '1h' && (
            <Loader2 className="w-3 h-3 animate-spin" />
          )}
        </button>
        <span className="text-xs text-muted-foreground ml-2">
          {resolution === '1h' ? '30-day rolling window (matches entry thresholds)' : '20-day rolling window'}
        </span>
      </div>

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
                if (resolution === '1h') {
                  // For hourly, show date and time
                  const parts = value.split(' ');
                  if (parts.length === 2) {
                    const datePart = parts[0].split('-');
                    return `${datePart[1]}/${datePart[2]}`;
                  }
                }
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
        {resolution === '1h' && (
          <div className="text-yellow-500">
            • Hourly data matches divergence analysis
          </div>
        )}
      </div>
    </div>
  );
}
