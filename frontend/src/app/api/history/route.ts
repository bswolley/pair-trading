import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "..", "config");

// GET /api/history - Get trade history
export async function GET() {
  try {
    const historyPath = path.join(CONFIG_PATH, "trade_history.json");
    
    if (!fs.existsSync(historyPath)) {
      return NextResponse.json({ trades: [], stats: {} });
    }

    const history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));

    return NextResponse.json(history);
  } catch (error) {
    console.error("Error reading history:", error);
    return NextResponse.json({ error: "Failed to read history" }, { status: 500 });
  }
}


