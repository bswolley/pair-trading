"use client";

import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ZScoreChart } from "./ZScoreChart";
import { PairAnalysisReport } from "./PairAnalysisReport";
import { WatchlistPair, AnalysisResponse, ZScoreResponse } from "@/lib/api";
import { LineChart, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PairAnalysisModalProps {
  pair: WatchlistPair | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Cache for analysis and chart results - persists across modal opens
const analysisCache = new Map<string, { data: AnalysisResponse; timestamp: number }>();
const chartCache = new Map<string, { data: ZScoreResponse; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function PairAnalysisModal({ pair, open, onOpenChange }: PairAnalysisModalProps) {
  const [activeTab, setActiveTab] = useState<string>("chart");
  const [refreshKey, setRefreshKey] = useState(0);
  
  // Get cache key for current pair
  const getCacheKey = useCallback(() => {
    if (!pair) return null;
    return `${pair.asset1}_${pair.asset2}_${pair.direction || 'auto'}`;
  }, [pair]);
  
  // Check if we have valid cached analysis data
  const getCachedAnalysis = useCallback(() => {
    const key = getCacheKey();
    if (!key) return null;
    
    const cached = analysisCache.get(key);
    if (!cached) return null;
    
    // Check if cache is still valid
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      analysisCache.delete(key);
      return null;
    }
    
    return cached.data;
  }, [getCacheKey]);
  
  // Check if we have valid cached chart data
  const getCachedChart = useCallback(() => {
    const key = getCacheKey();
    if (!key) return null;
    
    const cached = chartCache.get(key);
    if (!cached) return null;
    
    // Check if cache is still valid
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      chartCache.delete(key);
      return null;
    }
    
    return cached.data;
  }, [getCacheKey]);
  
  // Store analysis data in cache
  const setCachedAnalysis = useCallback((data: AnalysisResponse) => {
    const key = getCacheKey();
    if (!key) return;
    analysisCache.set(key, { data, timestamp: Date.now() });
  }, [getCacheKey]);
  
  // Store chart data in cache
  const setCachedChart = useCallback((data: ZScoreResponse) => {
    const key = getCacheKey();
    if (!key) return;
    chartCache.set(key, { data, timestamp: Date.now() });
  }, [getCacheKey]);
  
  // Force refresh
  const handleRefresh = () => {
    const key = getCacheKey();
    if (key) {
      analysisCache.delete(key);
      chartCache.delete(key);
    }
    setRefreshKey(prev => prev + 1);
  };
  
  const hasCachedAnalysis = !!getCachedAnalysis();
  const hasCachedChart = !!getCachedChart();

  if (!pair) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="!max-w-[90vw] max-h-[95vh] w-[90vw] h-[95vh] overflow-hidden flex flex-col sm:!max-w-[90vw]"
        aria-describedby={undefined}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-3">
            <span className="text-xl font-bold">{pair.pair}</span>
            {pair.sector && (
              <span className="text-sm font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded">
                {pair.sector}
              </span>
            )}
            {pair.isReady && (
              <span className="text-sm font-medium text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">
                READY
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between gap-3 flex-shrink-0 pb-2 border-b border-border">
            <TabsList className="grid grid-cols-2">
              <TabsTrigger value="chart" className="flex items-center gap-2">
                <LineChart className="w-4 h-4" />
                Z-Score Chart
                {hasCachedChart && (
                  <span className="ml-1 text-[10px] text-muted-foreground">(cached)</span>
                )}
              </TabsTrigger>
              <TabsTrigger value="analysis" className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Full Analysis
                {hasCachedAnalysis && (
                  <span className="ml-1 text-[10px] text-muted-foreground">(cached)</span>
                )}
              </TabsTrigger>
            </TabsList>
            {(hasCachedChart || hasCachedAnalysis) && (
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleRefresh}
                className="flex-shrink-0"
                title="Refresh data"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-auto mt-4 px-6 pb-6">
            <TabsContent value="chart" className="m-0 h-full px-4">
              <ZScoreChart
                key={`chart-${refreshKey}`}
                pair={pair.pair}
                entryThreshold={pair.entryThreshold || 2.0}
                days={30}
                cachedData={getCachedChart()}
                onDataLoaded={setCachedChart}
              />
            </TabsContent>

            <TabsContent value="analysis" className="m-0 h-full px-4">
              <PairAnalysisReport
                key={`analysis-${refreshKey}`}
                asset1={pair.asset1}
                asset2={pair.asset2}
                direction={pair.direction}
                cachedData={getCachedAnalysis()}
                onDataLoaded={setCachedAnalysis}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

