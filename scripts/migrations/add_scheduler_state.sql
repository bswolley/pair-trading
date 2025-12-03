-- Migration: Add scheduler state columns to stats table
-- Run this in Supabase SQL Editor

-- Add new columns for scheduler state persistence
ALTER TABLE stats 
ADD COLUMN IF NOT EXISTS last_scan_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_monitor_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS cross_sector_enabled BOOLEAN DEFAULT FALSE;

-- Verify the changes
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'stats';

