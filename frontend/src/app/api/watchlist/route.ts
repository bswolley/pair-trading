import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "..", "config");

// GET /api/watchlist - Get watchlist
export async function GET() {
  try {
    const watchlistPath = path.join(CONFIG_PATH, "watchlist.json");
    
    if (!fs.existsSync(watchlistPath)) {
      return NextResponse.json({ pairs: [], timestamp: null });
    }

    const watchlist = JSON.parse(fs.readFileSync(watchlistPath, "utf-8"));

    return NextResponse.json(watchlist);
  } catch (error) {
    console.error("Error reading watchlist:", error);
    return NextResponse.json({ error: "Failed to read watchlist" }, { status: 500 });
  }
}


