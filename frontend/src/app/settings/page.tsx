"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Settings, RefreshCw, Ban, Plus, Trash2, Play, Clock, Server, Shuffle } from "lucide-react";
import * as api from "@/lib/api";

export default function SettingsPage() {
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [newAsset, setNewAsset] = useState("");
  const [newReason, setNewReason] = useState("");
  const [scheduler, setScheduler] = useState<api.StatusResponse["scheduler"] | null>(null);
  const [crossSectorEnabled, setCrossSectorEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [blacklistRes, statusRes, crossSectorRes] = await Promise.all([
        api.getBlacklist(),
        api.getStatus(),
        api.getCrossSectorEnabled().catch(() => ({ crossSectorEnabled: false })),
      ]);

      setBlacklist(blacklistRes.assets || []);
      setReasons(blacklistRes.reasons || {});
      setScheduler(statusRes.scheduler);
      setCrossSectorEnabled(crossSectorRes.crossSectorEnabled);
    } catch (err) {
      console.error("Error fetching settings:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddToBlacklist = async () => {
    if (!newAsset.trim()) return;
    
    setActionLoading("add");
    try {
      await api.addToBlacklist(newAsset.trim(), newReason.trim() || undefined);
      setNewAsset("");
      setNewReason("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add to blacklist");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveFromBlacklist = async (asset: string) => {
    setActionLoading(`remove-${asset}`);
    try {
      await api.removeFromBlacklist(asset);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove from blacklist");
    } finally {
      setActionLoading(null);
    }
  };

  const handleTriggerMonitor = async () => {
    setActionLoading("monitor");
    try {
      await api.triggerMonitor();
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger monitor");
    } finally {
      setActionLoading(null);
    }
  };

  const handleTriggerScan = async (crossSector?: boolean) => {
    setActionLoading("scan");
    try {
      await api.triggerScan({ crossSector });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger scan");
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleCrossSector = async () => {
    setActionLoading("cross");
    try {
      const result = await api.setCrossSectorEnabled(!crossSectorEnabled);
      setCrossSectorEnabled(result.crossSectorEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle cross-sector");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Settings className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-sm text-muted-foreground">Scheduler & blacklist</p>
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

      <div className="grid md:grid-cols-2 gap-8">
        {/* Scheduler */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">Scheduler</h2>
          </div>
          
          <div className="space-y-3">
            {/* Monitor */}
            <div className="flex items-center justify-between p-4 rounded-lg border border-border">
              <div>
                <p className="font-medium">Monitor</p>
                <p className="text-sm text-muted-foreground">Every 15 min</p>
                {scheduler?.monitor.lastRun && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last: {new Date(scheduler.monitor.lastRun).toLocaleString()}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTriggerMonitor}
                disabled={true}
              >
                <Play className="w-4 h-4 opacity-50" />
              </Button>
            </div>

            {/* Scan */}
            <div className="flex items-center justify-between p-4 rounded-lg border border-border">
              <div>
                <p className="font-medium">Pair Scan</p>
                <p className="text-sm text-muted-foreground">Every 12 hours</p>
                {scheduler?.scan.lastRun && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last: {new Date(scheduler.scan.lastRun).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleTriggerScan()}
                  disabled={true}
                >
                  <Play className="w-4 h-4 opacity-50" />
                </Button>
              </div>
            </div>

            {/* Cross-Sector Toggle */}
            <div className="flex items-center justify-between p-4 rounded-lg border border-border">
              <div>
                <div className="flex items-center gap-2">
                  <Shuffle className="w-4 h-4 text-muted-foreground" />
                  <p className="font-medium">Cross-Sector Pairs</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Include pairs across different sectors (e.g., L1×DeFi)
                </p>
              </div>
              <Button
                size="sm"
                variant={crossSectorEnabled ? "default" : "outline"}
                onClick={handleToggleCrossSector}
                disabled={true}
              >
                {crossSectorEnabled ? "ON" : "OFF"}
              </Button>
            </div>
          </div>
        </div>

        {/* Blacklist */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Ban className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">Blacklist</h2>
            <span className="text-sm text-muted-foreground">({blacklist.length})</span>
          </div>

          {/* Add new - Disabled for now */}
          {/* <div className="flex gap-2 mb-4">
            <Input
              placeholder="Asset"
              value={newAsset}
              onChange={(e) => setNewAsset(e.target.value.toUpperCase())}
              className="w-24"
              disabled
            />
            <Input
              placeholder="Reason (optional)"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              className="flex-1"
              disabled
            />
            <Button
              onClick={handleAddToBlacklist}
              disabled={true}
              size="icon"
            >
              <Plus className="w-4 h-4 opacity-50" />
            </Button>
          </div> */}

          {/* List */}
          <div className="space-y-2">
            {blacklist.length === 0 ? (
              <p className="text-center text-muted-foreground py-8 border border-dashed border-border rounded-lg">
                No blacklisted assets
              </p>
            ) : (
              blacklist.map((asset) => (
                <div
                  key={asset}
                  className="flex items-center justify-between p-3 rounded-lg border border-border"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive">{asset}</Badge>
                    {reasons[asset] && (
                      <span className="text-sm text-muted-foreground">{reasons[asset]}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveFromBlacklist(asset)}
                    disabled={true}
                  >
                    <Trash2 className="w-4 h-4 opacity-50" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* API Info */}
      <div className="pt-6 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <Server className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Backend</span>
        </div>
        <code className="text-sm bg-muted px-3 py-2 rounded-lg block">
          {process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002"}
        </code>
      </div>
    </div>
  );
}
