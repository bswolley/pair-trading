"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { List, RefreshCw, Search, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface WatchlistPair {
  pair: string;
  asset1: string;
  asset2: string;
  sector: string;
  qualityScore: number;
  correlation: number;
  beta: number;
  halfLife: number;
  meanReversionRate: number;
  zScore: number;
  signalStrength: number;
  direction: string;
  isReady: boolean;
  entryThreshold: number;
  exitThreshold: number;
  maxHistoricalZ: number;
}

type SortField = "qualityScore" | "signalStrength" | "halfLife" | "correlation";

export default function WatchlistPage() {
  const [pairs, setPairs] = useState<WatchlistPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("signalStrength");
  const [sortAsc, setSortAsc] = useState(false);
  const [timestamp, setTimestamp] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/watchlist");
      const data = await res.json();
      setPairs(data.pairs || []);
      setTimestamp(data.timestamp);
    } catch (error) {
      console.error("Error fetching watchlist:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  // Filter and sort
  const filteredPairs = pairs
    .filter(
      (p) =>
        p.pair.toLowerCase().includes(search.toLowerCase()) ||
        p.sector.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const mult = sortAsc ? 1 : -1;
      return (a[sortField] - b[sortField]) * mult;
    });

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <TableHead
      className="cursor-pointer hover:bg-muted/50"
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center gap-1">
        {label}
        <ArrowUpDown className="w-3 h-3" />
      </div>
    </TableHead>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <List className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Watchlist</h1>
            <p className="text-sm text-muted-foreground">
              {timestamp
                ? `Updated: ${new Date(timestamp).toLocaleString()}`
                : "Loading..."}
            </p>
          </div>
        </div>
        <Button onClick={fetchData} disabled={loading} variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search pairs or sectors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {filteredPairs.length} Pairs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader className="text-right">
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead>Sector</TableHead>
                <SortHeader field="qualityScore" label="Quality" />
                <SortHeader field="correlation" label="Corr" />
                <SortHeader field="halfLife" label="HL" />
                <TableHead className="text-right">Z-Score</TableHead>
                <TableHead className="text-right">Entry@</TableHead>
                <SortHeader field="signalStrength" label="Signal" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPairs.map((pair) => {
                const signalPct = (pair.signalStrength * 100).toFixed(0);
                const isApproaching = pair.signalStrength >= 0.5;
                const isReady = pair.signalStrength >= 1;

                return (
                  <TableRow key={pair.pair}>
                    <TableCell className="font-medium">{pair.pair}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{pair.sector}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {pair.qualityScore.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {pair.correlation.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {pair.halfLife.toFixed(1)}d
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span
                        className={cn(
                          pair.zScore > 0 ? "text-red-600" : "text-green-600"
                        )}
                      >
                        {pair.zScore.toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {pair.entryThreshold}
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "font-medium",
                          isReady
                            ? "text-green-600"
                            : isApproaching
                              ? "text-yellow-600"
                              : "text-muted-foreground"
                        )}
                      >
                        {signalPct}%
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}


