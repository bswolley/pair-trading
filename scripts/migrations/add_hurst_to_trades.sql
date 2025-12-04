-- Add Hurst tracking to trades table
-- Run this in Supabase SQL Editor

-- Add hurst columns to active trades
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS hurst DECIMAL(5,3),
ADD COLUMN IF NOT EXISTS current_hurst DECIMAL(5,3);

-- Add hurst columns to trade history
ALTER TABLE trade_history 
ADD COLUMN IF NOT EXISTS hurst DECIMAL(5,3),
ADD COLUMN IF NOT EXISTS exit_hurst DECIMAL(5,3);

-- Add comments
COMMENT ON COLUMN trades.hurst IS 'Hurst exponent at entry (H < 0.5 = mean-reverting)';
COMMENT ON COLUMN trades.current_hurst IS 'Current Hurst exponent (updated by monitor)';
COMMENT ON COLUMN trade_history.hurst IS 'Hurst exponent at entry';
COMMENT ON COLUMN trade_history.exit_hurst IS 'Hurst exponent at exit';

