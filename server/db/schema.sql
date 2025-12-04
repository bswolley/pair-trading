-- Pair Trading Database Schema
-- Run this in Supabase SQL Editor to create tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- WATCHLIST TABLE
-- Stores discovered pairs for monitoring
-- ============================================
CREATE TABLE IF NOT EXISTS watchlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) UNIQUE NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  sector VARCHAR(50),
  
  -- Quality metrics (stable)
  quality_score DECIMAL(10,2),
  conviction DECIMAL(5,1),                -- 0-100 score combining all factors
  hurst DECIMAL(5,3),                     -- Hurst exponent (H < 0.5 = mean-reverting)
  hurst_classification VARCHAR(30),       -- STRONG_MEAN_REVERSION, MEAN_REVERTING, etc.
  correlation DECIMAL(5,4),
  beta DECIMAL(10,6),
  initial_beta DECIMAL(10,6),
  beta_drift DECIMAL(10,6),
  half_life DECIMAL(10,2),
  mean_reversion_rate DECIMAL(10,6),
  
  -- Signal metrics (changes frequently)
  z_score DECIMAL(10,4),
  signal_strength DECIMAL(5,4),
  direction VARCHAR(10), -- 'long' or 'short'
  is_ready BOOLEAN DEFAULT FALSE,
  
  -- Dynamic thresholds
  entry_threshold DECIMAL(5,2) DEFAULT 2.0,
  exit_threshold DECIMAL(5,2) DEFAULT 0.5,
  max_historical_z DECIMAL(10,2),
  
  -- Funding data
  funding_spread DECIMAL(10,4),
  
  -- Metadata
  added_manually BOOLEAN DEFAULT FALSE,
  last_scan TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- ACTIVE TRADES TABLE
-- Stores currently open positions
-- ============================================
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  sector VARCHAR(50),
  
  -- Entry data
  entry_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  entry_z_score DECIMAL(10,4),
  entry_price1 DECIMAL(20,8),
  entry_price2 DECIMAL(20,8),
  entry_threshold DECIMAL(5,2),
  
  -- Position details
  direction VARCHAR(10) NOT NULL, -- 'long' or 'short' (for asset1)
  long_asset VARCHAR(20) NOT NULL,
  short_asset VARCHAR(20) NOT NULL,
  long_weight DECIMAL(5,2) NOT NULL,
  short_weight DECIMAL(5,2) NOT NULL,
  long_entry_price DECIMAL(20,8),
  short_entry_price DECIMAL(20,8),
  
  -- Stats at entry
  correlation DECIMAL(5,4),
  beta DECIMAL(10,6),
  half_life DECIMAL(10,2),
  hurst DECIMAL(5,3),              -- Hurst exponent at entry (H < 0.5 = mean-reverting)
  max_historical_z DECIMAL(10,2),  -- For dynamic stop-loss
  
  -- Current state (updated by monitor)
  current_z DECIMAL(10,4),
  current_pnl DECIMAL(10,4),
  current_correlation DECIMAL(5,4),
  current_half_life DECIMAL(10,2),
  current_beta DECIMAL(10,6),
  current_hurst DECIMAL(5,3),      -- Current Hurst (updated by monitor)
  beta_drift DECIMAL(10,6),
  max_beta_drift DECIMAL(10,6),
  
  -- Partial exit tracking
  partial_exit_taken BOOLEAN DEFAULT FALSE,
  partial_exit_pnl DECIMAL(10,4),
  partial_exit_time TIMESTAMP WITH TIME ZONE,
  
  -- Source and notes
  source VARCHAR(20) DEFAULT 'bot', -- 'bot', 'manual', 'telegram'
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- TRADE HISTORY TABLE
-- Stores completed trades
-- ============================================
CREATE TABLE IF NOT EXISTS trade_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair VARCHAR(50) NOT NULL,
  asset1 VARCHAR(20) NOT NULL,
  asset2 VARCHAR(20) NOT NULL,
  sector VARCHAR(50),
  
  -- Entry data
  entry_time TIMESTAMP WITH TIME ZONE,
  entry_z_score DECIMAL(10,4),
  entry_price1 DECIMAL(20,8),
  entry_price2 DECIMAL(20,8),
  
  -- Position details
  direction VARCHAR(10),
  long_asset VARCHAR(20),
  short_asset VARCHAR(20),
  long_weight DECIMAL(5,2),
  short_weight DECIMAL(5,2),
  long_entry_price DECIMAL(20,8),
  short_entry_price DECIMAL(20,8),
  
  -- Stats
  correlation DECIMAL(5,4),
  beta DECIMAL(10,6),
  half_life DECIMAL(10,2),
  hurst DECIMAL(5,3),              -- Hurst at entry
  beta_drift DECIMAL(10,6),
  max_beta_drift DECIMAL(10,6),
  
  -- Exit data
  exit_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  exit_z_score DECIMAL(10,4),
  exit_hurst DECIMAL(5,3),         -- Hurst at exit
  exit_reason VARCHAR(50), -- 'TARGET', 'STOP_LOSS', 'TIME_STOP', 'BREAKDOWN', 'MANUAL', etc.
  total_pnl DECIMAL(10,4),
  days_in_trade DECIMAL(10,2),
  
  -- Partial exit info
  partial_exit_taken BOOLEAN DEFAULT FALSE,
  partial_exit_pnl DECIMAL(10,4),
  
  -- Source
  source VARCHAR(20),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- PARTIAL EXITS TABLE
-- Tracks partial profit-taking events
-- ============================================
CREATE TABLE IF NOT EXISTS partial_exits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_id UUID REFERENCES trades(id),
  pair VARCHAR(50) NOT NULL,
  
  exit_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  exit_size DECIMAL(5,2), -- e.g., 0.5 for 50%
  exit_z_score DECIMAL(10,4),
  partial_pnl DECIMAL(10,4),
  total_pnl_at_exit DECIMAL(10,4),
  days_in_trade DECIMAL(10,2),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- BLACKLIST TABLE
-- Assets to exclude from scanning
-- ============================================
CREATE TABLE IF NOT EXISTS blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset VARCHAR(20) UNIQUE NOT NULL,
  reason TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- AGGREGATE STATS TABLE
-- Running totals for quick access
-- ============================================
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY DEFAULT 1,
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl DECIMAL(10,4) DEFAULT 0,
  win_rate DECIMAL(5,2) DEFAULT 0,
  last_scan_time TIMESTAMP WITH TIME ZONE,
  last_monitor_time TIMESTAMP WITH TIME ZONE,
  cross_sector_enabled BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert initial stats row
INSERT INTO stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_watchlist_pair ON watchlist(pair);
CREATE INDEX IF NOT EXISTS idx_watchlist_sector ON watchlist(sector);
CREATE INDEX IF NOT EXISTS idx_watchlist_signal ON watchlist(signal_strength DESC);

CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
CREATE INDEX IF NOT EXISTS idx_trades_entry ON trades(entry_time DESC);

CREATE INDEX IF NOT EXISTS idx_history_pair ON trade_history(pair);
CREATE INDEX IF NOT EXISTS idx_history_exit ON trade_history(exit_time DESC);
CREATE INDEX IF NOT EXISTS idx_history_reason ON trade_history(exit_reason);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables
DROP TRIGGER IF EXISTS watchlist_updated_at ON watchlist;
CREATE TRIGGER watchlist_updated_at
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trades_updated_at ON trades;
CREATE TRIGGER trades_updated_at
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS stats_updated_at ON stats;
CREATE TRIGGER stats_updated_at
  BEFORE UPDATE ON stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- VIEWS
-- ============================================

-- Active trades with calculated days
CREATE OR REPLACE VIEW active_trades_view AS
SELECT 
  *,
  EXTRACT(EPOCH FROM (NOW() - entry_time)) / 86400 AS days_in_trade
FROM trades;

-- Trade history summary by sector
CREATE OR REPLACE VIEW history_by_sector AS
SELECT 
  sector,
  COUNT(*) as total_trades,
  SUM(CASE WHEN total_pnl >= 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN total_pnl < 0 THEN 1 ELSE 0 END) as losses,
  SUM(total_pnl) as total_pnl,
  AVG(total_pnl) as avg_pnl,
  AVG(days_in_trade) as avg_duration
FROM trade_history
GROUP BY sector;

-- Trade history summary by exit reason
CREATE OR REPLACE VIEW history_by_reason AS
SELECT 
  exit_reason,
  COUNT(*) as count,
  SUM(total_pnl) as total_pnl,
  AVG(total_pnl) as avg_pnl
FROM trade_history
GROUP BY exit_reason;

