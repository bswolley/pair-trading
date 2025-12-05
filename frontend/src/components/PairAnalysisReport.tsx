"use client";

import { useEffect, useState } from "react";
import { Loader2, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

interface PairAnalysisReportProps {
  asset1: string;
  asset2: string;
  direction?: string;
  cachedData?: api.AnalysisResponse | null;
  onDataLoaded?: (data: api.AnalysisResponse) => void;
}

export function PairAnalysisReport({ 
  asset1, 
  asset2, 
  direction, 
  cachedData,
  onDataLoaded 
}: PairAnalysisReportProps) {
  const [loading, setLoading] = useState(!cachedData);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<api.AnalysisResponse | null>(cachedData || null);

  useEffect(() => {
    // If we have cached data, use it
    if (cachedData) {
      setData(cachedData);
      setLoading(false);
      return;
    }
    
    async function fetchAnalysis() {
      setLoading(true);
      setError(null);
      try {
        const response = await api.getPairAnalysis(asset1, asset2, direction);
        setData(response);
        // Store in cache via callback
        onDataLoaded?.(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch analysis");
      } finally {
        setLoading(false);
      }
    }
    fetchAnalysis();
  }, [asset1, asset2, direction, cachedData, onDataLoaded]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Generating analysis...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400">
        <AlertTriangle className="w-6 h-6 mr-2" />
        {error}
      </div>
    );
  }

  if (!data) return null;

  const { advanced, standardized, timeframes, divergence, expectedROI, percentageReversion, funding, obv, signal, currentPrices } = data;

  return (
    <div className="space-y-6 text-sm max-w-full">
      {/* Current Prices */}
      <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
        <div className="flex items-center gap-6">
          <div>
            <span className="text-muted-foreground text-xs">Current Prices</span>
            <div className="flex items-center gap-4 mt-1">
              <span className="font-mono font-medium">
                {asset1}: ${currentPrices[asset1]?.toFixed(4) ?? "—"}
              </span>
              <span className="font-mono font-medium">
                {asset2}: ${currentPrices[asset2]?.toFixed(4) ?? "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Signal Status */}
      <div className={cn(
        "p-4 rounded-lg border",
        signal.isReady ? "bg-emerald-500/10 border-emerald-500/30" : "bg-muted/50 border-border"
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {signal.isReady ? (
              <CheckCircle className="w-5 h-5 text-emerald-400" />
            ) : (
              <XCircle className="w-5 h-5 text-muted-foreground" />
            )}
            <span className="font-semibold text-lg">
              {signal.isReady ? "TRADE READY" : "WAITING FOR SIGNAL"}
            </span>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">30d Z-Score</div>
            <div className={cn(
              "font-bold text-lg",
              signal.zScore30d < 0 ? "text-emerald-400" : "text-red-400"
            )}>
              {signal.zScore30d.toFixed(2)}
            </div>
          </div>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Direction: <span className="font-medium text-foreground">
            {signal.direction === "long" ? `LONG ${asset1} / SHORT ${asset2}` : `SHORT ${asset1} / LONG ${asset2}`}
          </span>
        </div>
      </div>

      {/* Advanced Analytics */}
      <Section title="Advanced Analytics">
        <div className="grid grid-cols-2 gap-4">
          {/* Regime */}
          <Card title="Regime Detection">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current</span>
                <span className={cn("font-semibold", getRegimeColor(advanced.regime.regime))}>
                  {advanced.regime.regime.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confidence</span>
                <span>{(advanced.regime.confidence * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Action</span>
                <span className={cn(
                  "font-medium",
                  advanced.regime.action === "ENTER" && "text-emerald-400",
                  advanced.regime.action === "WAIT" && "text-yellow-400",
                  advanced.regime.action === "CAUTION" && "text-red-400"
                )}>
                  {advanced.regime.action}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Risk Level</span>
                <span>{advanced.regime.riskLevel}</span>
              </div>
            </div>
          </Card>

          {/* Hurst */}
          <Card title="Hurst Exponent">
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">H Value</span>
                <span className={cn(
                  "font-bold text-lg",
                  getHurstColor(advanced.hurst.hurst)
                )}>
                  {advanced.hurst.hurst?.toFixed(3) ?? "N/A"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Classification</span>
                <span className={cn("font-medium", getHurstColor(advanced.hurst.hurst))}>
                  {advanced.hurst.classification.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mean-Reverting?</span>
                <span>
                  {advanced.hurst.hurst !== null && advanced.hurst.hurst < 0.5 ? (
                    <CheckCircle className="w-4 h-4 text-emerald-400 inline" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400 inline" />
                  )}
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              H &lt; 0.5 = mean-reverting, H = 0.5 = random walk, H &gt; 0.5 = trending
            </p>
          </Card>

          {/* Dual Beta */}
          {advanced.dualBeta && advanced.dualBeta.structural && advanced.dualBeta.dynamic && (
            <Card title="Dual Beta Analysis">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left py-1">Type</th>
                    <th className="text-right">Beta</th>
                    <th className="text-right">R²</th>
                    <th className="text-right">Std Err</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-1">Structural (90d)</td>
                    <td className="text-right font-mono">{advanced.dualBeta.structural.beta?.toFixed(3) ?? '—'}</td>
                    <td className="text-right font-mono">{advanced.dualBeta.structural.r2?.toFixed(3) ?? '—'}</td>
                    <td className="text-right font-mono">{advanced.dualBeta.structural.stdErr?.toFixed(3) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1">Dynamic</td>
                    <td className="text-right font-mono">{advanced.dualBeta.dynamic.beta?.toFixed(3) ?? '—'}</td>
                    <td className="text-right font-mono">{advanced.dualBeta.dynamic.r2?.toFixed(3) ?? '—'}</td>
                    <td className="text-right font-mono">{advanced.dualBeta.dynamic.stdErr?.toFixed(3) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
              <div className="flex justify-between mt-2 pt-2 border-t border-border">
                <span className="text-muted-foreground">Beta Drift</span>
                <span className={cn(
                  "font-medium",
                  advanced.dualBeta.drift != null && Math.abs(advanced.dualBeta.drift) < 0.1 ? "text-emerald-400" :
                  advanced.dualBeta.drift != null && Math.abs(advanced.dualBeta.drift) < 0.15 ? "text-yellow-400" : "text-red-400"
                )}>
                  {advanced.dualBeta.drift != null ? `${(advanced.dualBeta.drift * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            </Card>
          )}

          {/* Conviction */}
          <Card title={`Conviction Score: ${advanced.conviction.score}/100`}>
            <div className="space-y-1">
              {Object.entries(advanced.conviction.breakdown).map(([factor, value]) => (
                <div key={factor} className="flex justify-between text-xs">
                  <span className="text-muted-foreground capitalize">
                    {factor.replace(/([A-Z])/g, ' $1').trim()}
                  </span>
                  <span className={cn(
                    "font-mono",
                    value >= 0 ? "text-emerald-400" : "text-red-400"
                  )}>
                    {value >= 0 ? "+" : ""}{value.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-border">
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className={cn(
                    "h-2 rounded-full",
                    advanced.conviction.score >= 70 ? "bg-emerald-500" :
                    advanced.conviction.score >= 50 ? "bg-yellow-500" : "bg-red-500"
                  )}
                  style={{ width: `${advanced.conviction.score}%` }}
                />
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* Standardized Metrics */}
      <Section title="Standardized Metrics (30d/90d)">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-4">
          <MetricBox label="Beta" value={standardized.beta.toFixed(3)} />
          <MetricBox label="Correlation" value={(standardized.correlation * 100).toFixed(1) + "%"} />
          <MetricBox 
            label="Z-Score" 
            value={standardized.zScore.toFixed(2)}
            color={standardized.zScore < 0 ? "text-emerald-400" : "text-red-400"}
          />
          <MetricBox 
            label="Half-Life" 
            value={standardized.halfLife ? standardized.halfLife.toFixed(1) + "d" : "∞"}
          />
          <MetricBox 
            label="Cointegrated" 
            value={standardized.isCointegrated ? "Yes" : "No"}
            color={standardized.isCointegrated ? "text-emerald-400" : "text-muted-foreground"}
          />
          <MetricBox 
            label="Weights"
            value={`${standardized.positionSizing.weight1}% / ${standardized.positionSizing.weight2}%`}
          />
        </div>
      </Section>

      {/* Multi-Timeframe Table */}
      <Section title="Multi-Timeframe Analysis">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 px-2">Period</th>
                <th className="text-right px-2">Corr</th>
                <th className="text-right px-2">Beta</th>
                <th className="text-right px-2">Z-Score</th>
                <th className="text-right px-2">Half-Life</th>
                <th className="text-right px-2">CoInt</th>
                <th className="text-right px-2">Gamma</th>
                <th className="text-right px-2">Theta</th>
              </tr>
            </thead>
            <tbody>
              {[7, 30, 90, 180].map(days => {
                const tf = timeframes[days];
                if (!tf || tf.error) return null;
                return (
                  <tr key={days} className="border-b border-border/50">
                    <td className="py-2 px-2 font-medium">{days}d</td>
                    <td className="text-right px-2 font-mono">{tf.correlation?.toFixed(3) ?? "—"}</td>
                    <td className="text-right px-2 font-mono">{tf.beta?.toFixed(3) ?? "—"}</td>
                    <td className={cn(
                      "text-right px-2 font-mono",
                      (tf.zScore ?? 0) < 0 ? "text-emerald-400" : "text-red-400"
                    )}>
                      {tf.zScore?.toFixed(2) ?? "—"}
                    </td>
                    <td className="text-right px-2 font-mono">
                      {tf.halfLife ? tf.halfLife.toFixed(1) + "d" : "∞"}
                    </td>
                    <td className="text-right px-2">
                      {tf.isCointegrated ? (
                        <CheckCircle className="w-3 h-3 text-emerald-400 inline" />
                      ) : (
                        <XCircle className="w-3 h-3 text-muted-foreground inline" />
                      )}
                    </td>
                    <td className="text-right px-2 font-mono">{tf.gamma?.toFixed(3) ?? "—"}</td>
                    <td className="text-right px-2 font-mono">{tf.theta?.toFixed(3) ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Divergence Analysis */}
      {divergence && (
        <Section title="Historical Divergence Analysis">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <MetricBox 
              label="Optimal Entry" 
              value={`|Z| ≥ ${divergence.optimalEntry.toFixed(1)}`}
            />
            <MetricBox 
              label="Max Historical |Z|" 
              value={divergence.maxHistoricalZ.toFixed(2)}
            />
            <MetricBox 
              label="Current Z" 
              value={divergence.currentZ.toFixed(2)}
              color={Math.abs(divergence.currentZ) >= divergence.optimalEntry ? "text-emerald-400" : "text-yellow-400"}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">Threshold</th>
                  <th className="text-right px-2">Events</th>
                  <th className="text-right px-2">Reverted</th>
                  <th className="text-right px-2">Success Rate</th>
                  <th className="text-right px-2">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(divergence.thresholds)
                  .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
                  .map(([threshold, stats]) => (
                    <tr key={threshold} className="border-b border-border/50">
                      <td className="py-2 px-2 font-medium">
                        {threshold}
                        {parseFloat(threshold) === divergence.optimalEntry && (
                          <span className="ml-1 text-emerald-400">✓</span>
                        )}
                      </td>
                      <td className="text-right px-2">{stats.totalEvents}</td>
                      <td className="text-right px-2">{stats.revertedEvents}</td>
                      <td className={cn(
                        "text-right px-2 font-medium",
                        stats.reversionRate !== null && stats.reversionRate >= 0.7 ? "text-emerald-400" :
                        stats.reversionRate !== null && stats.reversionRate >= 0.5 ? "text-yellow-400" : ""
                      )}>
                        {stats.reversionRate !== null ? (stats.reversionRate * 100).toFixed(0) + "%" : "—"}
                      </td>
                      <td className="text-right px-2">
                        {stats.avgDuration !== null && typeof stats.avgDuration === 'number' 
                          ? stats.avgDuration.toFixed(1) + "d" 
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Expected ROI */}
      {expectedROI && (
        <Section title="Expected ROI from Current Position">
          <p className="text-xs text-muted-foreground mb-3">
            Based on current |Z| = {expectedROI.currentZ}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">Exit Strategy</th>
                  <th className="text-right px-2">Exit Z-Score</th>
                  <th className="text-right px-2">Expected ROI</th>
                  <th className="text-right px-2">Time to Reversion</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="py-2 px-2 font-medium">Fixed Reversion</td>
                  <td className="text-right px-2 font-mono">{expectedROI.fixedExitZ}</td>
                  <td className="text-right px-2 font-mono text-emerald-400">{expectedROI.roiFixed}</td>
                  <td className="text-right px-2">{expectedROI.timeToFixed} days</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-2 px-2 font-medium">Percentage-Based (50%)</td>
                  <td className="text-right px-2 font-mono">{expectedROI.percentExitZ}</td>
                  <td className="text-right px-2 font-mono text-emerald-400">{expectedROI.roiPercent}</td>
                  <td className="text-right px-2">{expectedROI.timeToPercent} days</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Percentage-Based Reversion */}
      {percentageReversion && Object.keys(percentageReversion).length > 0 && (
        <Section title="Percentage-Based Reversion (to 50% of threshold)">
          <p className="text-xs text-muted-foreground mb-3">
            Example: Threshold 2.0 reverts to &lt; 1.0, Threshold 3.0 reverts to &lt; 1.5
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">Threshold</th>
                  <th className="text-right px-2">Reversion To</th>
                  <th className="text-right px-2">Events</th>
                  <th className="text-right px-2">Reverted</th>
                  <th className="text-right px-2">Success Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(percentageReversion)
                  .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
                  .map(([threshold, stats]) => (
                    <tr key={threshold} className="border-b border-border/50">
                      <td className="py-2 px-2 font-medium">{threshold}</td>
                      <td className="text-right px-2">&lt; {stats.exitZ.toFixed(2)}</td>
                      <td className="text-right px-2">{stats.totalEvents}</td>
                      <td className="text-right px-2">{stats.revertedEvents}</td>
                      <td className={cn(
                        "text-right px-2 font-medium",
                        stats.reversionRate !== null && stats.reversionRate >= 0.7 ? "text-emerald-400" :
                        stats.reversionRate !== null && stats.reversionRate >= 0.5 ? "text-yellow-400" : ""
                      )}>
                        {stats.reversionRate !== null ? (stats.reversionRate * 100).toFixed(0) + "%" : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Price Movement */}
      <Section title="Price Movement">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 px-2">Period</th>
                <th className="text-left px-2">{asset1}</th>
                <th className="text-left px-2">{asset2}</th>
              </tr>
            </thead>
            <tbody>
              {[7, 30, 90, 180].map(days => {
                const tf = timeframes[days];
                if (!tf || tf.error) return null;
                const change1 = tf.price1Start && tf.price1End 
                  ? ((tf.price1End - tf.price1Start) / tf.price1Start * 100)
                  : null;
                const change2 = tf.price2Start && tf.price2End
                  ? ((tf.price2End - tf.price2Start) / tf.price2Start * 100)
                  : null;
                return (
                  <tr key={days} className="border-b border-border/50">
                    <td className="py-2 px-2 font-medium">{days}d</td>
                    <td className="px-2">
                      <span className="font-mono">${tf.price1Start?.toFixed(2)}</span>
                      <span className="text-muted-foreground mx-1">→</span>
                      <span className="font-mono">${tf.price1End?.toFixed(2)}</span>
                      <span className={cn(
                        "ml-2",
                        change1 && change1 >= 0 ? "text-emerald-400" : "text-red-400"
                      )}>
                        ({change1 !== null ? (change1 >= 0 ? "+" : "") + change1.toFixed(1) : "—"}%)
                      </span>
                    </td>
                    <td className="px-2">
                      <span className="font-mono">${tf.price2Start?.toFixed(2)}</span>
                      <span className="text-muted-foreground mx-1">→</span>
                      <span className="font-mono">${tf.price2End?.toFixed(2)}</span>
                      <span className={cn(
                        "ml-2",
                        change2 && change2 >= 0 ? "text-emerald-400" : "text-red-400"
                      )}>
                        ({change2 !== null ? (change2 >= 0 ? "+" : "") + change2.toFixed(1) : "—"}%)
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Funding */}
      {funding && (
        <Section title="Funding Analysis">
          <div className={cn(
            "p-3 rounded-lg",
            funding.favorable ? "bg-emerald-500/10" : "bg-red-500/10"
          )}>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-muted-foreground mb-1">Long {funding.longAsset}</div>
                <div className="font-mono">{(funding.longRate * 100).toFixed(4)}%/8h</div>
                <div className="text-muted-foreground text-xs mt-0.5">
                  {funding.longRate >= 0 ? "You pay" : "You receive"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Short {funding.shortAsset}</div>
                <div className="font-mono">{(funding.shortRate * 100).toFixed(4)}%/8h</div>
                <div className="text-muted-foreground text-xs mt-0.5">
                  {funding.shortRate >= 0 ? "You receive" : "You pay"}
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Net Funding</span>
                <span className={cn("font-bold", funding.favorable ? "text-emerald-400" : "text-red-400")}>
                  {funding.net8h >= 0 ? "+" : ""}{(funding.net8h * 100).toFixed(4)}%/8h = {(funding.netMonthly * 100).toFixed(2)}%/month
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {funding.favorable 
                  ? "Favorable carry - You earn funding while holding"
                  : "Negative carry - You pay funding while holding"}
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* OBV */}
      {Object.keys(obv).length > 0 && (
        <Section title="On-Balance Volume (OBV)">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2">Period</th>
                  <th className="text-right px-2">{asset1} OBV</th>
                  <th className="text-right px-2">{asset2} OBV</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(obv).map(([days, values]) => (
                  <tr key={days} className="border-b border-border/50">
                    <td className="py-2 px-2 font-medium">{days}d</td>
                    <td className={cn(
                      "text-right px-2 font-mono",
                      values[asset1] >= 0 ? "text-emerald-400" : "text-red-400"
                    )}>
                      {values[asset1] >= 0 ? "+" : ""}{values[asset1].toLocaleString()}
                    </td>
                    <td className={cn(
                      "text-right px-2 font-mono",
                      values[asset2] >= 0 ? "text-emerald-400" : "text-red-400"
                    )}>
                      {values[asset2] >= 0 ? "+" : ""}{values[asset2].toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground text-center pt-4 border-t border-border">
        Generated at {new Date(data.generatedAt).toLocaleString()} • {data.processingTimeMs}ms
      </div>
    </div>
  );
}

// Helper components
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg bg-muted/30 border border-border">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">{title}</h4>
      {children}
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center p-2 rounded bg-muted/30">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("font-semibold", color)}>{value}</div>
    </div>
  );
}

// Helper functions
function getRegimeColor(regime: string): string {
  switch (regime) {
    case "STRONG_REVERSION": return "text-emerald-400";
    case "MILD_REVERSION": return "text-emerald-300";
    case "PEAK_DIVERGENCE": return "text-yellow-400";
    case "TRENDING": return "text-red-400";
    case "IDLE": return "text-muted-foreground";
    default: return "";
  }
}

function getHurstColor(hurst: number | null): string {
  if (hurst === null) return "text-muted-foreground";
  if (hurst < 0.4) return "text-emerald-400";
  if (hurst < 0.5) return "text-emerald-300";
  if (hurst < 0.6) return "text-yellow-400";
  return "text-red-400";
}

