"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/StatCard";
import { User, Plus, RefreshCw, TrendingUp } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface UserTrade {
  pair: string;
  symbol1: string;
  symbol2: string;
  entryDate: string;
  entryPrice1: number;
  entryPrice2: number;
  weight1: number;
  weight2: number;
  direction: string;
  isUserTrade?: boolean;
}

export default function ProfilePage() {
  const [userTrades, setUserTrades] = useState<UserTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newTrade, setNewTrade] = useState({
    symbol1: "",
    symbol2: "",
    entryPrice1: "",
    entryPrice2: "",
    weight1: "50",
    weight2: "50",
    direction: "long",
    entryDate: new Date().toISOString().slice(0, 16),
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trades");
      const data = await res.json();
      setUserTrades(data.userTrades || []);
    } catch (error) {
      console.error("Error fetching trades:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAddTrade = async () => {
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol1: newTrade.symbol1.toUpperCase(),
          symbol2: newTrade.symbol2.toUpperCase(),
          entryPrice1: parseFloat(newTrade.entryPrice1),
          entryPrice2: parseFloat(newTrade.entryPrice2),
          weight1: parseFloat(newTrade.weight1) / 100,
          weight2: parseFloat(newTrade.weight2) / 100,
          direction: newTrade.direction,
          entryDate: new Date(newTrade.entryDate).toISOString(),
        }),
      });

      if (res.ok) {
        setDialogOpen(false);
        setNewTrade({
          symbol1: "",
          symbol2: "",
          entryPrice1: "",
          entryPrice2: "",
          weight1: "50",
          weight2: "50",
          direction: "long",
          entryDate: new Date().toISOString().slice(0, 16),
        });
        fetchData();
      }
    } catch (error) {
      console.error("Error adding trade:", error);
    }
  };

  // Calculate stats (simplified - no live prices)
  const activeTrades = userTrades.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <User className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">My Trades</h1>
            <p className="text-sm text-muted-foreground">
              Manual positions you&apos;re tracking
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={fetchData} disabled={loading} variant="outline">
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                New Trade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Manual Trade</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Long Asset</label>
                    <Input
                      placeholder="BNB"
                      value={newTrade.symbol1}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, symbol1: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Short Asset</label>
                    <Input
                      placeholder="BANANA"
                      value={newTrade.symbol2}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, symbol2: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Entry Price 1</label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="876.65"
                      value={newTrade.entryPrice1}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, entryPrice1: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Entry Price 2</label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="10.03"
                      value={newTrade.entryPrice2}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, entryPrice2: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Weight 1 (%)</label>
                    <Input
                      type="number"
                      value={newTrade.weight1}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, weight1: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Weight 2 (%)</label>
                    <Input
                      type="number"
                      value={newTrade.weight2}
                      onChange={(e) =>
                        setNewTrade({ ...newTrade, weight2: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">Entry Date/Time</label>
                  <Input
                    type="datetime-local"
                    value={newTrade.entryDate}
                    onChange={(e) =>
                      setNewTrade({ ...newTrade, entryDate: e.target.value })
                    }
                  />
                </div>
                <Button onClick={handleAddTrade} className="w-full">
                  Add Trade
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          title="Active Trades"
          value={activeTrades}
          icon={<TrendingUp className="w-5 h-5" />}
        />
        <StatCard
          title="Status"
          value="Manual"
          subtitle="Not auto-managed"
        />
      </div>

      {/* Trades Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">My Positions</CardTitle>
        </CardHeader>
        <CardContent>
          {userTrades.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No manual trades. Click &quot;New Trade&quot; to add one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead className="text-right">Entry Prices</TableHead>
                  <TableHead className="text-right">Weights</TableHead>
                  <TableHead className="text-right">Entry Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userTrades.map((trade) => (
                  <TableRow key={trade.pair}>
                    <TableCell className="font-medium">{trade.pair}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "px-2 py-1 rounded text-xs font-medium",
                          trade.direction === "long"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        )}
                      >
                        {trade.direction.toUpperCase()}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      ${trade.entryPrice1?.toFixed(2)} / ${trade.entryPrice2?.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {((trade.weight1 || 0) * 100).toFixed(0)}% /{" "}
                      {((trade.weight2 || 0) * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {trade.entryDate
                        ? new Date(trade.entryDate).toLocaleDateString()
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


