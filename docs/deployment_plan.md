# Deployment Plan: Pair Trading System

## Overview

Deploy the pair trading system to cloud infrastructure:
- **Backend**: Railway (Node.js server)
- **Database**: Supabase (PostgreSQL)
- **Frontend**: Vercel (Next.js)

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Vercel       │────▶│    Railway      │────▶│   Supabase      │
│   (Frontend)    │     │   (Backend)     │     │  (PostgreSQL)   │
│                 │     │                 │     │                 │
│  Next.js App    │     │  Express API    │     │  Tables:        │
│  - Dashboard    │     │  - REST routes  │     │  - watchlist    │
│  - Watchlist    │     │  - Schedulers   │     │  - trades       │
│  - History      │     │  - Telegram Bot │     │  - history      │
│  - Settings     │     │                 │     │  - blacklist    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   Hyperliquid   │
                        │   (Exchange)    │
                        └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │    Telegram     │
                        │   (Alerts)      │
                        └─────────────────┘
```

---

## Phase 1: Backend Server

### 1.1 Server Structure

```
server/
├── index.js              # Main entry point
├── routes/
│   ├── trades.js         # GET/POST/PUT/DELETE trades
│   ├── watchlist.js      # GET/POST watchlist
│   ├── history.js        # GET trade history
│   ├── blacklist.js      # GET/POST blacklist
│   └── health.js         # Health check endpoint
├── services/
│   ├── scheduler.js      # node-cron job definitions
│   ├── telegram.js       # Telegram bot with commands
│   ├── scanner.js        # Pair scanning logic (from scanPairs.js)
│   └── monitor.js        # Watchlist monitoring (from monitorWatchlist.js)
├── db/
│   ├── supabase.js       # Supabase client
│   └── queries.js        # Database queries
└── utils/
    └── (existing lib files)
```

### 1.2 REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/trades` | List active trades |
| POST | `/api/trades` | Create new trade |
| PUT | `/api/trades/:id` | Update trade (partial exit, etc.) |
| DELETE | `/api/trades/:id` | Close/delete trade |
| GET | `/api/watchlist` | Get watchlist pairs |
| POST | `/api/watchlist` | Add pair to watchlist |
| DELETE | `/api/watchlist/:pair` | Remove from watchlist |
| GET | `/api/history` | Get trade history |
| GET | `/api/blacklist` | Get blacklisted assets |
| POST | `/api/blacklist` | Add to blacklist |
| DELETE | `/api/blacklist/:asset` | Remove from blacklist |
| POST | `/api/scan` | Trigger manual scan |
| GET | `/api/status` | Get current bot status |

### 1.3 Scheduled Jobs (node-cron)

```javascript
// scheduler.js
const cron = require('node-cron');

// Every 12 hours - Scan for new pairs
cron.schedule('0 */12 * * *', async () => {
  console.log('[CRON] Running pair scan...');
  await runPairScan();
});

// Every 15 minutes - Monitor watchlist & active trades
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Running watchlist monitor...');
  await runMonitor();
});
```

### 1.4 Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/status` | Get current positions & P&L |
| `/watchlist` | Show approaching entries |
| `/history` | Recent trade history |
| `/open <PAIR> <direction>` | Open a new trade manually |
| `/close <PAIR>` | Close an active trade |
| `/partial <PAIR> <percent>` | Take partial profit |
| `/blacklist <asset>` | Add asset to blacklist |
| `/scan` | Trigger manual pair scan |
| `/help` | List available commands |

```javascript
// telegram.js - Command handler structure
bot.onText(/\/open (.+)/, async (msg, match) => {
  // Parse: /open BNB_BANANA long
  const [pair, direction] = match[1].split(' ');
  // Validate pair exists in watchlist
  // Execute trade via Hyperliquid
  // Save to database
  // Confirm via Telegram
});

bot.onText(/\/close (.+)/, async (msg, match) => {
  const pair = match[1];
  // Find active trade
  // Close positions on Hyperliquid
  // Move to history
  // Confirm via Telegram
});
```

---

## Phase 2: Railway Configuration

### 2.1 railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node server/index.js",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### 2.2 Environment Variables (Railway)

```env
# Database
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789

# Hyperliquid
HYPERLIQUID_PRIVATE_KEY=0x...
HYPERLIQUID_WALLET_ADDRESS=0x...

# Server
PORT=3000
NODE_ENV=production

# Gemini (for LLM features)
GEMINI_API_KEY=...
```

### 2.3 Dockerfile (optional, if nixpacks fails)

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "server/index.js"]
```

---

## Phase 3: Supabase Migration

### 3.1 Database Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Watchlist table
CREATE TABLE watchlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) UNIQUE NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  correlation DECIMAL(5,4),
  cointegration DECIMAL(10,6),
  beta DECIMAL(10,6),
  half_life DECIMAL(10,2),
  entry_threshold DECIMAL(5,2) DEFAULT 2.0,
  z_score DECIMAL(10,4),
  signal_strength DECIMAL(5,2),
  last_scan TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Active trades table
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  asset1_direction VARCHAR(10) NOT NULL, -- 'long' or 'short'
  asset1_weight DECIMAL(5,2) NOT NULL,
  asset2_weight DECIMAL(5,2) NOT NULL,
  asset1_entry_price DECIMAL(20,8),
  asset2_entry_price DECIMAL(20,8),
  entry_z_score DECIMAL(10,4),
  entry_beta DECIMAL(10,6),
  entry_half_life DECIMAL(10,2),
  partial_exits JSONB DEFAULT '[]',
  remaining_size DECIMAL(5,2) DEFAULT 1.0,
  source VARCHAR(20) DEFAULT 'bot', -- 'bot' or 'manual'
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'partial', 'closed'
  entered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trade history table
CREATE TABLE trade_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  asset1_direction VARCHAR(10) NOT NULL,
  entry_z_score DECIMAL(10,4),
  exit_z_score DECIMAL(10,4),
  pnl_percent DECIMAL(10,4),
  duration_hours DECIMAL(10,2),
  exit_reason VARCHAR(50),
  source VARCHAR(20),
  entered_at TIMESTAMP WITH TIME ZONE,
  exited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Blacklist table
CREATE TABLE blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset VARCHAR(20) UNIQUE NOT NULL,
  reason TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_watchlist_pair ON watchlist(pair);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_pair ON trades(pair);
CREATE INDEX idx_history_exited ON trade_history(exited_at DESC);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watchlist_updated_at
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trades_updated_at
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 3.2 Supabase Client Setup

```javascript
// db/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = supabase;
```

### 3.3 Migration Script

```javascript
// scripts/migrateToSupabase.js
// One-time script to migrate existing JSON data to Supabase

const supabase = require('../db/supabase');
const fs = require('fs');
const path = require('path');

async function migrate() {
  // 1. Migrate watchlist
  const watchlist = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config/watchlist.json'))
  );
  
  for (const pair of watchlist.pairs) {
    await supabase.from('watchlist').upsert({
      pair: pair.pair,
      asset1: pair.asset1,
      asset2: pair.asset2,
      // ... map all fields
    });
  }
  
  // 2. Migrate active trades
  // 3. Migrate history
  // 4. Migrate blacklist
  
  console.log('Migration complete!');
}

migrate();
```

---

## Phase 4: Frontend Updates

### 4.1 API Client

```typescript
// frontend/src/lib/api.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export async function fetchTrades() {
  const res = await fetch(`${API_URL}/api/trades`);
  if (!res.ok) throw new Error('Failed to fetch trades');
  return res.json();
}

export async function fetchWatchlist() {
  const res = await fetch(`${API_URL}/api/watchlist`);
  if (!res.ok) throw new Error('Failed to fetch watchlist');
  return res.json();
}

export async function closeTrade(tradeId: string) {
  const res = await fetch(`${API_URL}/api/trades/${tradeId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to close trade');
  return res.json();
}

// ... other API calls
```

### 4.2 Update Pages to Use API Client

```typescript
// frontend/src/app/page.tsx
import { fetchTrades, fetchWatchlist } from '@/lib/api';

export default async function Dashboard() {
  const [trades, watchlist] = await Promise.all([
    fetchTrades(),
    fetchWatchlist(),
  ]);
  
  // ... render
}
```

### 4.3 Vercel Environment Variables

```env
NEXT_PUBLIC_API_URL=https://your-app.railway.app
```

---

## Deployment Steps

### Step 1: Set Up Supabase
1. Create new Supabase project
2. Run SQL schema (Phase 3.1)
3. Get connection URL and anon key
4. Run migration script locally

### Step 2: Deploy Backend to Railway
1. Create Railway project
2. Connect GitHub repo
3. Set environment variables
4. Deploy
5. Get Railway URL

### Step 3: Deploy Frontend to Vercel
1. Connect GitHub repo (frontend folder)
2. Set `NEXT_PUBLIC_API_URL` to Railway URL
3. Deploy

### Step 4: Verify
1. Check Railway logs for scheduler running
2. Send `/status` command to Telegram
3. Open Vercel frontend, verify data loads

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `server/index.js` | CREATE | Express server entry |
| `server/routes/*.js` | CREATE | API route handlers |
| `server/services/scheduler.js` | CREATE | Cron job definitions |
| `server/services/telegram.js` | CREATE | Telegram bot with commands |
| `server/db/supabase.js` | CREATE | Database client |
| `railway.json` | CREATE | Railway config |
| `scripts/migrateToSupabase.js` | CREATE | Data migration |
| `frontend/src/lib/api.ts` | CREATE | API client |
| `frontend/src/app/*/page.tsx` | UPDATE | Use API client |
| `.env.example` | UPDATE | Add new env vars |

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Backend Server | 4-6 hours | - |
| Phase 2: Railway Config | 30 min | Phase 1 |
| Phase 3: Supabase Migration | 2-3 hours | - |
| Phase 4: Frontend Updates | 1-2 hours | Phase 1, 2, 3 |
| Testing & Debugging | 2-3 hours | All phases |

**Total: ~10-15 hours**

---

## Notes & Considerations

1. **Downtime**: During migration, the local bot should be stopped to prevent data conflicts

2. **Rollback Plan**: Keep JSON files as backup; can revert if needed

3. **Rate Limits**: 
   - Hyperliquid: ~10 req/s
   - Supabase: Generous free tier
   - Railway: No request limits

4. **Costs**:
   - Railway: ~$5/month (hobby tier, always-on)
   - Supabase: Free tier sufficient
   - Vercel: Free tier sufficient

5. **Security**:
   - Never expose Hyperliquid private key to frontend
   - Use Supabase RLS if needed
   - Railway backend handles all sensitive operations

