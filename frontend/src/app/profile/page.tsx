"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { User, Plus, RefreshCw, TrendingUp, TrendingDown, X } from "lucide-react";
import { TradesTable } from "@/components/TradesTable";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ProfilePage() {
  const [trades, setTrades] = useState<api.Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    pair: "",
    asset1: "",
    asset2: "",
    sector: "",
    direction: "long" as "long" | "short",
    longWeight: "50",
    shortWeight: "50",
    longEntryPrice: "",
    shortEntryPrice: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tradesRes = await api.getTrades();
      const manualTrades = (tradesRes.trades || []).filter(
        (t) => t.source === "manual" || t.source === "telegram"
      );
      setTrades(manualTrades);
    } catch (err) {
      console.error("Error fetching trades:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch trades");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    
    if (field === "asset1" || field === "asset2") {
      const a1 = field === "asset1" ? value : formData.asset1;
      const a2 = field === "asset2" ? value : formData.asset2;
      if (a1 && a2) {
        setFormData((prev) => ({ ...prev, pair: `${a1}/${a2}` }));
      }
    }
  };

  const handleSubmit = async () => {
    if (!formData.pair || !formData.asset1 || !formData.asset2) {
      setError("Please fill in all required fields");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const trade: Partial<api.Trade> = {
        pair: formData.pair,
        asset1: formData.asset1.toUpperCase(),
        asset2: formData.asset2.toUpperCase(),
        sector: formData.sector || "Manual",
        direction: formData.direction,
        longAsset: formData.direction === "long" ? formData.asset1.toUpperCase() : formData.asset2.toUpperCase(),
        shortAsset: formData.direction === "long" ? formData.asset2.toUpperCase() : formData.asset1.toUpperCase(),
        longWeight: parseFloat(formData.longWeight) || 50,
        shortWeight: parseFloat(formData.shortWeight) || 50,
        longEntryPrice: parseFloat(formData.longEntryPrice) || 0,
        shortEntryPrice: parseFloat(formData.shortEntryPrice) || 0,
      };

      await api.createTrade(trade);
      setDialogOpen(false);
      setFormData({
        pair: "",
        asset1: "",
        asset2: "",
        sector: "",
        direction: "long",
        longWeight: "50",
        shortWeight: "50",
        longEntryPrice: "",
        shortEntryPrice: "",
      });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create trade");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseTrade = async (pair: string) => {
    if (!confirm(`Close trade ${pair}?`)) return;

    try {
      await api.closeTrade(pair, "MANUAL");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close trade");
    }
  };

  const totalPnL = trades.reduce((sum, t) => sum + (t.currentPnL || 0), 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <User className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">My Trades</h1>
            <p className="text-sm text-muted-foreground">Manual positions</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={fetchData} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {/* Disabled for now */}
          {/* <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Trade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Manual Trade</DialogTitle>
                <DialogDescription>
                  Record a trade you entered manually
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Asset 1 (Long)</label>
                    <Input
                      placeholder="BTC"
                      value={formData.asset1}
                      onChange={(e) => handleInputChange("asset1", e.target.value.toUpperCase())}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Asset 2 (Short)</label>
                    <Input
                      placeholder="ETH"
                      value={formData.asset2}
                      onChange={(e) => handleInputChange("asset2", e.target.value.toUpperCase())}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Pair Name</label>
                    <Input
                      placeholder="BTC/ETH"
                      value={formData.pair}
                      onChange={(e) => handleInputChange("pair", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Sector</label>
                    <Input
                      placeholder="L1, DeFi..."
                      value={formData.sector}
                      onChange={(e) => handleInputChange("sector", e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">Direction</label>
                  <div className="flex gap-2 mt-1">
                    <Button
                      type="button"
                      variant={formData.direction === "long" ? "default" : "outline"}
                      size="sm"
                      onClick={() => handleInputChange("direction", "long")}
                      className="flex-1"
                    >
                      <TrendingUp className="w-4 h-4 mr-1" />
                      Long {formData.asset1 || "A1"}
                    </Button>
                    <Button
                      type="button"
                      variant={formData.direction === "short" ? "default" : "outline"}
                      size="sm"
                      onClick={() => handleInputChange("direction", "short")}
                      className="flex-1"
                    >
                      <TrendingDown className="w-4 h-4 mr-1" />
                      Short {formData.asset1 || "A1"}
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Long Weight %</label>
                    <Input
                      type="number"
                      placeholder="50"
                      value={formData.longWeight}
                      onChange={(e) => handleInputChange("longWeight", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Short Weight %</label>
                    <Input
                      type="number"
                      placeholder="50"
                      value={formData.shortWeight}
                      onChange={(e) => handleInputChange("shortWeight", e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Long Entry Price</label>
                    <Input
                      type="number"
                      step="any"
                      placeholder="0.00"
                      value={formData.longEntryPrice}
                      onChange={(e) => handleInputChange("longEntryPrice", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Short Entry Price</label>
                    <Input
                      type="number"
                      step="any"
                      placeholder="0.00"
                      value={formData.shortEntryPrice}
                      onChange={(e) => handleInputChange("shortEntryPrice", e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={submitting}>
                  {submitting && <RefreshCw className="w-4 h-4 animate-spin mr-2" />}
                  Add Trade
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog> */}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-baseline gap-8 pb-6 border-b border-border">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Open P&L</p>
          <span className={cn(
            "text-3xl font-bold tabular-nums",
            totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
          )}>
            {totalPnL >= 0 ? "+" : ""}{totalPnL.toFixed(2)}%
          </span>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Positions</p>
          <span className="text-3xl font-bold tabular-nums">{trades.length}</span>
        </div>
      </div>

      {/* Trades */}
      <div>
        <h2 className="text-lg font-semibold mb-4">My Positions</h2>
        {trades.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-lg">
            <User className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">No manual trades yet</p>
          </div>
        ) : (
          <div className="space-y-4">
            <TradesTable trades={trades} showActions onClose={handleCloseTrade} />
          </div>
        )}
      </div>
    </div>
  );
}
