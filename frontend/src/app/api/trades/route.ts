import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "..", "config");

// GET /api/trades - Get all trades (bot + user)
export async function GET() {
  try {
    // Bot trades
    const botTradesPath = path.join(CONFIG_PATH, "active_trades_sim.json");
    let botTrades = { trades: [] };
    if (fs.existsSync(botTradesPath)) {
      botTrades = JSON.parse(fs.readFileSync(botTradesPath, "utf-8"));
    }

    // User trades
    const userTradesPath = path.join(CONFIG_PATH, "active_trades.json");
    let userTrades: Record<string, unknown> = {};
    if (fs.existsSync(userTradesPath)) {
      userTrades = JSON.parse(fs.readFileSync(userTradesPath, "utf-8"));
    }

    // Convert user trades object to array format
    const userTradesArray = Object.entries(userTrades).map(([pair, trade]) => ({
      pair,
      ...(trade as object),
      isUserTrade: true,
    }));

    return NextResponse.json({
      botTrades: botTrades.trades || [],
      userTrades: userTradesArray,
    });
  } catch (error) {
    console.error("Error reading trades:", error);
    return NextResponse.json({ error: "Failed to read trades" }, { status: 500 });
  }
}

// POST /api/trades - Add new user trade
export async function POST(request: Request) {
  try {
    const trade = await request.json();
    const userTradesPath = path.join(CONFIG_PATH, "active_trades.json");
    
    let userTrades: Record<string, unknown> = {};
    if (fs.existsSync(userTradesPath)) {
      userTrades = JSON.parse(fs.readFileSync(userTradesPath, "utf-8"));
    }

    const pairKey = `${trade.symbol1}_${trade.symbol2}`;
    userTrades[pairKey] = {
      symbol1: trade.symbol1,
      symbol2: trade.symbol2,
      entryDate: trade.entryDate,
      entryPrice1: trade.entryPrice1,
      entryPrice2: trade.entryPrice2,
      weight1: trade.weight1,
      weight2: trade.weight2,
      direction: trade.direction,
    };

    fs.writeFileSync(userTradesPath, JSON.stringify(userTrades, null, 2));

    return NextResponse.json({ success: true, pair: pairKey });
  } catch (error) {
    console.error("Error adding trade:", error);
    return NextResponse.json({ error: "Failed to add trade" }, { status: 500 });
  }
}


