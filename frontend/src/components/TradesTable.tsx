"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, ArrowRight, Clock, Target } from "lucide-react";

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
  correlation?: number;
  currentCorrelation?: number;
  beta?: number;
  entryThreshold?: number;
}

interface TradesTableProps {
  trades: Trade[];
  showActions?: boolean;
  onClose?: (pair: string) => void;
}

export function TradesTable({ trades, showActions, onClose }: TradesTableProps) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No active trades
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {trades.map((trade) => {
        const pnl = trade.currentPnL || 0;
        const entryZ = trade.entryZScore || 0;
        const currentZ = trade.currentZ ?? entryZ;
        const zDelta = Math.abs(currentZ) - Math.abs(entryZ);
        const zImproving = zDelta < 0; // Z moving toward 0 is good
        
        const entryHL = trade.halfLife || 0;
        const currentHL = trade.currentHalfLife ?? entryHL;
        
        const entryCorr = trade.correlation || 0;
        const currentCorr = trade.currentCorrelation ?? entryCorr;
        const corrDelta = currentCorr - entryCorr;
        
        const daysInTrade = trade.entryTime
          ? (Date.now() - new Date(trade.entryTime).getTime()) / (1000 * 60 * 60 * 24)
          : 0;
        
        // ETA calculation: halfLife * log(|z_current| / |z_target|) / log(2)
        const zTarget = 0.5;
        let eta = null;
        if (Math.abs(currentZ) > zTarget && currentHL > 0) {
          const halfLivesToExit = Math.log(Math.abs(currentZ) / zTarget) / Math.log(2);
          eta = currentHL * halfLivesToExit;
        }

        return (
          <div
            key={trade.pair}
            className={cn(
              "rounded-lg border p-4 space-y-3",
              pnl >= 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
            )}
          >
            {/* Header Row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-lg flex items-center justify-center",
                  pnl >= 0 ? "bg-emerald-500/20" : "bg-red-500/20"
                )}>
                  {pnl >= 0 ? (
                    <TrendingUp className="w-5 h-5 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-5 h-5 text-red-400" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-lg">{trade.pair}</span>
                    {trade.sector && (
                      <Badge variant="outline" className="text-xs">
                        {trade.sector}
                      </Badge>
                    )}
                    {trade.partialExitTaken && (
                      <Badge className="bg-yellow-500/20 text-yellow-400 text-xs">
                        50% Closed
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <span className="text-emerald-400">Long</span> {trade.longAsset} {trade.longWeight?.toFixed(0)}%
                    <span className="mx-2">•</span>
                    <span className="text-red-400">Short</span> {trade.shortAsset} {trade.shortWeight?.toFixed(0)}%
                  </div>
                </div>
              </div>
              
              {/* P&L */}
              <div className="text-right">
                <div className={cn(
                  "text-2xl font-bold",
                  pnl >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}%
                </div>
                <div className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                  <Clock className="w-3 h-3" />
                  {daysInTrade.toFixed(1)}d in trade
                </div>
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-border/50">
              {/* Z-Score */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Z-Score</div>
                <div className="flex items-center gap-1 font-mono">
                  <span className="text-muted-foreground">{entryZ.toFixed(2)}</span>
                  <ArrowRight className={cn(
                    "w-3 h-3",
                    zImproving ? "text-emerald-400" : "text-red-400"
                  )} />
                  <span className={cn(
                    "font-semibold",
                    zImproving ? "text-emerald-400" : "text-red-400"
                  )}>
                    {currentZ.toFixed(2)}
                  </span>
                </div>
                <div className={cn(
                  "text-xs",
                  zImproving ? "text-emerald-400" : "text-red-400"
                )}>
                  {zImproving ? "↓" : "↑"} {Math.abs(zDelta).toFixed(2)}
                </div>
              </div>

              {/* Half-Life */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Half-Life</div>
                <div className="flex items-center gap-1 font-mono">
                  <span className="text-muted-foreground">{entryHL.toFixed(1)}d</span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                  <span className="font-semibold">{currentHL.toFixed(1)}d</span>
                </div>
              </div>

              {/* Correlation */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Correlation</div>
                <div className="flex items-center gap-1 font-mono">
                  <span className="text-muted-foreground">{entryCorr.toFixed(2)}</span>
                  <ArrowRight className={cn(
                    "w-3 h-3",
                    corrDelta >= 0 ? "text-emerald-400" : "text-red-400"
                  )} />
                  <span className={cn(
                    "font-semibold",
                    corrDelta >= 0 ? "text-emerald-400" : currentCorr < 0.5 ? "text-red-400" : ""
                  )}>
                    {currentCorr.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* ETA */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Target className="w-3 h-3" />
                  ETA to Exit
                </div>
                <div className="font-mono font-semibold">
                  {eta !== null ? (
                    <span className={eta <= currentHL ? "text-emerald-400" : ""}>
                      {eta.toFixed(1)}d
                    </span>
                  ) : (
                    <span className="text-emerald-400">At target</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Target: |Z| &lt; 0.5
                </div>
              </div>
            </div>

            {/* Beta & Entry Threshold */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t border-border/50">
              {trade.beta && (
                <span>Beta: <span className="font-mono">{trade.beta.toFixed(3)}</span></span>
              )}
              {trade.entryThreshold && (
                <span>Entry @: <span className="font-mono">{trade.entryThreshold}</span></span>
              )}
              {trade.entryTime && (
                <span>Entered: {new Date(trade.entryTime).toLocaleDateString()}</span>
              )}
            </div>

            {/* Actions */}
            {showActions && onClose && (
              <div className="pt-2 border-t border-border/50">
                <button
                  onClick={() => onClose(trade.pair)}
                  className="text-sm text-red-400 hover:text-red-300 font-medium"
                >
                  Close Position
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
