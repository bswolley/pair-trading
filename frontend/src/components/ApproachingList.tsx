import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ApproachingPair {
  pair: string;
  sector?: string;
  zScore: number;
  entryThreshold: number;
  halfLife?: number;
  signalStrength: number;
}

interface ApproachingListProps {
  pairs: ApproachingPair[];
}

export function ApproachingList({ pairs }: ApproachingListProps) {
  // Sort by signal strength descending
  const sortedPairs = [...pairs]
    .filter((p) => p.signalStrength >= 0.5) // Only show pairs at 50%+
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, 5);

  if (sortedPairs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Approaching Entry</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No pairs approaching entry threshold
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Approaching Entry</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedPairs.map((pair) => {
          const pct = (pair.signalStrength * 100).toFixed(0);
          const isReady = pair.signalStrength >= 1;

          return (
            <div
              key={pair.pair}
              className={cn(
                "flex items-center justify-between p-3 rounded-lg",
                isReady ? "bg-green-50 dark:bg-green-950" : "bg-muted/50"
              )}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{pair.pair}</span>
                  {pair.sector && (
                    <Badge variant="secondary" className="text-xs">
                      {pair.sector}
                    </Badge>
                  )}
                  {isReady && (
                    <Badge className="bg-green-600 text-xs">Ready</Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  Z: {pair.zScore.toFixed(2)} → entry@{pair.entryThreshold}
                  {pair.halfLife && ` | HL: ${pair.halfLife.toFixed(1)}d`}
                </div>
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    "text-lg font-bold",
                    isReady ? "text-green-600" : "text-muted-foreground"
                  )}
                >
                  {pct}%
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}


