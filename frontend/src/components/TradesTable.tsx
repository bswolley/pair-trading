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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pair</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead className="text-right">Z-Score</TableHead>
          <TableHead className="text-right">Half-Life</TableHead>
          <TableHead className="text-right">Days</TableHead>
          {showActions && <TableHead className="text-right">Action</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const pnl = trade.currentPnL || 0;
          const zScore = trade.currentZ ?? trade.entryZScore ?? 0;
          const halfLife = trade.currentHalfLife ?? trade.halfLife ?? 0;
          const daysInTrade = trade.entryTime
            ? ((Date.now() - new Date(trade.entryTime).getTime()) / (1000 * 60 * 60 * 24)).toFixed(1)
            : "?";

          return (
            <TableRow key={trade.pair}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{trade.pair}</span>
                  {trade.sector && (
                    <Badge variant="secondary" className="text-xs">
                      {trade.sector}
                    </Badge>
                  )}
                  {trade.partialExitTaken && (
                    <Badge variant="outline" className="text-xs">
                      50% closed
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="text-sm">
                  <span className="text-green-600">L</span> {trade.longAsset}{" "}
                  {trade.longWeight?.toFixed(0)}% /{" "}
                  <span className="text-red-600">S</span> {trade.shortAsset}{" "}
                  {trade.shortWeight?.toFixed(0)}%
                </div>
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={cn(
                    "font-medium",
                    pnl >= 0 ? "text-green-600" : "text-red-600"
                  )}
                >
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toFixed(2)}%
                </span>
              </TableCell>
              <TableCell className="text-right font-mono">
                {zScore.toFixed(2)}
              </TableCell>
              <TableCell className="text-right">
                {halfLife.toFixed(1)}d
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {daysInTrade}d
              </TableCell>
              {showActions && onClose && (
                <TableCell className="text-right">
                  <button
                    onClick={() => onClose(trade.pair)}
                    className="text-sm text-red-600 hover:text-red-700 font-medium"
                  >
                    Close
                  </button>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}


