import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "..", "config");
const BLACKLIST_PATH = path.join(CONFIG_PATH, "blacklist.json");

// GET /api/blacklist - Get blacklist
export async function GET() {
  try {
    if (!fs.existsSync(BLACKLIST_PATH)) {
      return NextResponse.json({ assets: [] });
    }

    const blacklist = JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf-8"));
    return NextResponse.json(blacklist);
  } catch (error) {
    console.error("Error reading blacklist:", error);
    return NextResponse.json({ error: "Failed to read blacklist" }, { status: 500 });
  }
}

// POST /api/blacklist - Add asset to blacklist
export async function POST(request: Request) {
  try {
    const { asset } = await request.json();
    
    let blacklist = { description: "Assets to exclude from pair scanning and trading", assets: [] as string[] };
    if (fs.existsSync(BLACKLIST_PATH)) {
      blacklist = JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf-8"));
    }

    if (!blacklist.assets.includes(asset)) {
      blacklist.assets.push(asset);
      fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(blacklist, null, 2));
    }

    return NextResponse.json({ success: true, assets: blacklist.assets });
  } catch (error) {
    console.error("Error adding to blacklist:", error);
    return NextResponse.json({ error: "Failed to add to blacklist" }, { status: 500 });
  }
}

// DELETE /api/blacklist - Remove asset from blacklist
export async function DELETE(request: Request) {
  try {
    const { asset } = await request.json();
    
    if (!fs.existsSync(BLACKLIST_PATH)) {
      return NextResponse.json({ success: true, assets: [] });
    }

    const blacklist = JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf-8"));
    blacklist.assets = blacklist.assets.filter((a: string) => a !== asset);
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(blacklist, null, 2));

    return NextResponse.json({ success: true, assets: blacklist.assets });
  } catch (error) {
    console.error("Error removing from blacklist:", error);
    return NextResponse.json({ error: "Failed to remove from blacklist" }, { status: 500 });
  }
}


