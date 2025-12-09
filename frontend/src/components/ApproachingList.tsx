import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Zap, TrendingUp, TrendingDown } from "lucide-react";

interface ApproachingPair {
  pair: string;
  sector?: string;
  zScore: number;
  entryThreshold: number;
  halfLife?: number;
  signalStrength: number;
  direction?: string;
  reversionWarning?: string | null;
  reversionRate?: number | null;
}

interface ApproachingListProps {
  pairs: ApproachingPair[];
}

export function ApproachingList({ pairs }: ApproachingListProps) {
  const sortedPairs = [...pairs]
    .filter((p) => p.signalStrength >= 0.5 && !p.reversionWarning)
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, 6);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Zap className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Approaching Entry</h2>
      </div>

      {sortedPairs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-lg">
          <Zap className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No pairs near entry</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedPairs.map((pair) => {
            const pct = Math.min(100, Math.round(pair.signalStrength * 100));
            const isReady = pair.signalStrength >= 1;

            return (
              <div
                key={pair.pair}
                className={cn(
                  "relative overflow-hidden rounded-lg border p-3",
                  isReady ? "border-emerald-500/50 bg-emerald-500/10" : "border-border"
                )}
              >
                {/* Progress bar */}
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 opacity-10",
                    isReady ? "bg-emerald-500" : "bg-primary"
                  )}
                  style={{ width: `${pct}%` }}
                />

                <div className="relative flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {pair.zScore > 0 ? (
                        <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                      ) : (
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      <span className="font-medium">{pair.pair}</span>
                      {pair.sector && (
                        <Badge variant="outline" className="text-xs py-0">
                          {pair.sector}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      Z: {pair.zScore.toFixed(2)} → {pair.entryThreshold}
                    </div>
                  </div>
                  <div className={cn(
                    "text-lg font-bold tabular-nums",
                    isReady ? "text-emerald-400" : pct >= 80 ? "text-yellow-400" : "text-muted-foreground"
                  )}>
                    {pct}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
