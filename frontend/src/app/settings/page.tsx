"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Settings, Plus, X, RefreshCw } from "lucide-react";

export default function SettingsPage() {
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newAsset, setNewAsset] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/blacklist");
      const data = await res.json();
      setBlacklist(data.assets || []);
    } catch (error) {
      console.error("Error fetching blacklist:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAdd = async () => {
    if (!newAsset.trim()) return;
    
    try {
      const res = await fetch("/api/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: newAsset.toUpperCase() }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setBlacklist(data.assets);
        setNewAsset("");
      }
    } catch (error) {
      console.error("Error adding to blacklist:", error);
    }
  };

  const handleRemove = async (asset: string) => {
    try {
      const res = await fetch("/api/blacklist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setBlacklist(data.assets);
      }
    } catch (error) {
      console.error("Error removing from blacklist:", error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Settings className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure pair trading parameters
            </p>
          </div>
        </div>
        <Button onClick={fetchData} disabled={loading} variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Blacklist */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Asset Blacklist</CardTitle>
          <CardDescription>
            Assets to exclude from pair scanning and trading. Useful for avoiding
            assets undergoing fundamental repricing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add new */}
          <div className="flex gap-2">
            <Input
              placeholder="Enter asset symbol (e.g., COMP)"
              value={newAsset}
              onChange={(e) => setNewAsset(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="max-w-xs"
            />
            <Button onClick={handleAdd} disabled={!newAsset.trim()}>
              <Plus className="w-4 h-4 mr-2" />
              Add
            </Button>
          </div>

          {/* Current blacklist */}
          <div className="flex flex-wrap gap-2">
            {blacklist.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No assets blacklisted
              </p>
            ) : (
              blacklist.map((asset) => (
                <Badge
                  key={asset}
                  variant="secondary"
                  className="text-sm py-1 px-3 flex items-center gap-2"
                >
                  {asset}
                  <button
                    onClick={() => handleRemove(asset)}
                    className="hover:text-destructive"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Thresholds (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Trading Thresholds</CardTitle>
          <CardDescription>
            Current thresholds used by the bot (configured in code)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">Exit Threshold</p>
              <p className="text-lg font-mono font-medium">|Z| &lt; 0.5</p>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">Stop Loss</p>
              <p className="text-lg font-mono font-medium">|Z| &gt; 3.0</p>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">Partial TP</p>
              <p className="text-lg font-mono font-medium">+3% → 50%</p>
            </div>
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">Final TP</p>
              <p className="text-lg font-mono font-medium">+5% or Z&lt;0.5</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


