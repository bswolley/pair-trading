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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  hurst?: number;
  currentHurst?: number;
  entryTime?: string;
  partialExitTaken?: boolean;
  longAsset?: string;
  shortAsset?: string;
  longWeight?: number;
  shortWeight?: number;
  correlation?: number;
  currentCorrelation?: number;
  beta?: number;
  currentBeta?: number;
  betaDrift?: number;
  maxBetaDrift?: number;
  entryThreshold?: number;
  healthScore?: number;
  healthStatus?: string;
  healthSignals?: string[];
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
        if (Math.abs(currentZ) > zTarget && currentHL > 0 && isFinite(currentHL)) {
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
                    {trade.healthScore !== undefined && trade.healthStatus && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge 
                              variant="outline"
                              className={cn(
                                "text-xs cursor-help",
                                trade.healthStatus === 'STRONG' ? "border-emerald-500 text-emerald-400 bg-emerald-500/10" :
                                trade.healthStatus === 'OK' ? "border-yellow-500 text-yellow-400 bg-yellow-500/10" :
                                trade.healthStatus === 'WEAK' ? "border-orange-500 text-orange-400 bg-orange-500/10" :
                                "border-red-500 text-red-400 bg-red-500/10"
                              )}
                            >
                              {trade.healthStatus === 'STRONG' ? '🟢' :
                               trade.healthStatus === 'OK' ? '🟡' :
                               trade.healthStatus === 'WEAK' ? '🟠' : '🔴'} {trade.healthScore}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent 
                            side="bottom" 
                            className="bg-popover border border-border text-popover-foreground max-w-xs"
                          >
                            <div className="space-y-1">
                              <div className="font-semibold text-xs border-b border-border pb-1 mb-1">
                                Health Signals
                              </div>
                              {trade.healthSignals && trade.healthSignals.length > 0 ? (
                                <ul className="text-xs space-y-0.5">
                                  {trade.healthSignals.map((signal, idx) => (
                                    <li key={idx} className="flex items-start gap-1">
                                      <span className="text-muted-foreground">•</span>
                                      <span>{signal}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-xs text-muted-foreground">No signals available</span>
                              )}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                  <span className="text-muted-foreground">
                    {entryHL === 0 || entryHL === null || !isFinite(entryHL) ? '∞' : `${entryHL.toFixed(1)}d`}
                  </span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                  <span className={cn(
                    "font-semibold",
                    currentHL === 0 || currentHL === null || !isFinite(currentHL) ? "text-yellow-400" : ""
                  )}>
                    {currentHL === 0 || currentHL === null || !isFinite(currentHL) ? '∞' : `${currentHL.toFixed(1)}d`}
                  </span>
                </div>
                {(currentHL === 0 || currentHL === null || !isFinite(currentHL)) && (
                  <div className="text-xs text-yellow-400">No mean-reversion</div>
                )}
              </div>

              {/* Hurst */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Hurst</div>
                <div className="flex items-center gap-1 font-mono">
                  {trade.hurst !== undefined && trade.hurst !== null ? (
                    <span className="text-muted-foreground">{trade.hurst.toFixed(2)}</span>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                  {trade.currentHurst !== undefined && trade.currentHurst !== null && (
                    <>
                      <ArrowRight className={cn(
                        "w-3 h-3",
                        trade.currentHurst < 0.5 ? "text-emerald-400" : "text-red-400"
                      )} />
                      <span className={cn(
                        "font-semibold",
                        trade.currentHurst < 0.4 ? "text-emerald-400" :
                        trade.currentHurst < 0.5 ? "text-emerald-400/70" :
                        trade.currentHurst < 0.55 ? "text-yellow-400" : "text-red-400"
                      )}>
                        {trade.currentHurst.toFixed(2)}
                      </span>
                    </>
                  )}
                </div>
                {trade.currentHurst !== undefined && trade.currentHurst !== null && trade.currentHurst >= 0.5 && (
                  <div className="text-xs text-red-400">⚠️ Trending</div>
                )}
              </div>

              {/* ETA */}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Target className="w-3 h-3" />
                  ETA to Exit
                </div>
                <div className="font-mono font-semibold">
                  {currentHL === 0 || currentHL === null || !isFinite(currentHL) ? (
                    <span className="text-yellow-400">∞</span>
                  ) : eta !== null ? (
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
                <span className="flex items-center gap-1">
                  Beta: 
                  <span className="font-mono">{trade.beta.toFixed(3)}</span>
                  {trade.currentBeta && (
                    <>
                      <ArrowRight className="w-3 h-3" />
                      <span className="font-mono">{trade.currentBeta.toFixed(3)}</span>
                    </>
                  )}
                  {trade.betaDrift !== undefined && trade.betaDrift !== null && (
                    <Badge 
                      variant="outline" 
                      className={cn(
                        "ml-1 text-[10px] px-1.5 py-0",
                        trade.betaDrift > 0.30 ? "border-red-500 text-red-400 bg-red-500/10" :
                        trade.betaDrift > 0.15 ? "border-yellow-500 text-yellow-400 bg-yellow-500/10" :
                        "border-emerald-500/50 text-emerald-400/70"
                      )}
                    >
                      {trade.betaDrift > 0.30 ? "⚠️" : ""} {(trade.betaDrift * 100).toFixed(0)}% since entry
                    </Badge>
                  )}
                </span>
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
