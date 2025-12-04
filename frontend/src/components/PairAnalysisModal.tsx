"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ZScoreChart } from "./ZScoreChart";
import { PairAnalysisReport } from "./PairAnalysisReport";
import { WatchlistPair } from "@/lib/api";
import { LineChart, FileText } from "lucide-react";

interface PairAnalysisModalProps {
  pair: WatchlistPair | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PairAnalysisModal({ pair, open, onOpenChange }: PairAnalysisModalProps) {
  const [activeTab, setActiveTab] = useState<string>("chart");

  if (!pair) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] w-[95vw] overflow-hidden flex flex-col">
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
          <TabsList className="grid w-full grid-cols-2 flex-shrink-0">
            <TabsTrigger value="chart" className="flex items-center gap-2">
              <LineChart className="w-4 h-4" />
              Z-Score Chart
            </TabsTrigger>
            <TabsTrigger value="analysis" className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Full Analysis
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-auto mt-4">
            <TabsContent value="chart" className="m-0 h-full">
              <ZScoreChart
                pair={pair.pair}
                entryThreshold={pair.entryThreshold || 2.0}
                days={30}
              />
            </TabsContent>

            <TabsContent value="analysis" className="m-0 h-full">
              <PairAnalysisReport
                asset1={pair.asset1}
                asset2={pair.asset2}
                direction={pair.direction}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

