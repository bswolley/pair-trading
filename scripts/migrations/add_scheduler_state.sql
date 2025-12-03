-- Migration: Add scheduler state columns to stats table
-- Run this in Supabase SQL Editor

-- Add new columns for scheduler state persistence
ALTER TABLE stats 
ADD COLUMN IF NOT EXISTS last_scan_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_monitor_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS cross_sector_enabled BOOLEAN DEFAULT FALSE;

-- Add beta drift columns to trades table
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS current_beta DECIMAL(10,6),
ADD COLUMN IF NOT EXISTS beta_drift DECIMAL(10,6),
ADD COLUMN IF NOT EXISTS max_beta_drift DECIMAL(10,6);

-- Add beta tracking columns to watchlist table
ALTER TABLE watchlist
ADD COLUMN IF NOT EXISTS initial_beta DECIMAL(10,6),
ADD COLUMN IF NOT EXISTS beta_drift DECIMAL(10,6);

-- Add beta drift columns to trade_history table
ALTER TABLE trade_history
ADD COLUMN IF NOT EXISTS beta_drift DECIMAL(10,6),
ADD COLUMN IF NOT EXISTS max_beta_drift DECIMAL(10,6);

-- Verify the changes
SELECT 'stats' as table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'stats' AND column_name IN ('last_scan_time', 'last_monitor_time', 'cross_sector_enabled')
UNION ALL
SELECT 'trades' as table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'trades' AND column_name IN ('current_beta', 'beta_drift', 'max_beta_drift')
UNION ALL
SELECT 'watchlist' as table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'watchlist' AND column_name IN ('initial_beta', 'beta_drift');

