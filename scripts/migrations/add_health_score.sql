-- Add health score columns to trades table
-- Run this migration in Supabase SQL Editor

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS health_score INTEGER,
ADD COLUMN IF NOT EXISTS health_status VARCHAR(20),
ADD COLUMN IF NOT EXISTS health_signals JSONB;

-- Add comment for documentation
COMMENT ON COLUMN trades.health_score IS 'Trade health score (-5 to +8): >=5 STRONG, 2-4 OK, 0-1 WEAK, <0 BROKEN';
COMMENT ON COLUMN trades.health_status IS 'Health status: STRONG, OK, WEAK, BROKEN';
COMMENT ON COLUMN trades.health_signals IS 'Array of health signals explaining the score, e.g. ["Z reverting 28%", "PnL +0.7%"]';

-- Also add to history table for analysis
ALTER TABLE history
ADD COLUMN IF NOT EXISTS health_score INTEGER,
ADD COLUMN IF NOT EXISTS health_status VARCHAR(20),
ADD COLUMN IF NOT EXISTS health_signals JSONB;

