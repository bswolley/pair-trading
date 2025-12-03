-- Migration: Add Hurst and Conviction columns to watchlist
-- Run this in Supabase SQL Editor

-- Add new columns to watchlist table
ALTER TABLE watchlist 
ADD COLUMN IF NOT EXISTS hurst DECIMAL(5,3),
ADD COLUMN IF NOT EXISTS hurst_classification VARCHAR(30),
ADD COLUMN IF NOT EXISTS conviction DECIMAL(5,1);

-- Add comment explaining columns
COMMENT ON COLUMN watchlist.hurst IS 'Hurst exponent (H < 0.5 = mean-reverting, H > 0.5 = trending)';
COMMENT ON COLUMN watchlist.hurst_classification IS 'STRONG_MEAN_REVERSION, MEAN_REVERTING, RANDOM_WALK, WEAK_TREND, TRENDING';
COMMENT ON COLUMN watchlist.conviction IS 'Conviction score 0-100 combining correlation, R2, half-life, hurst, cointegration';

-- Verify columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'watchlist' 
AND column_name IN ('hurst', 'hurst_classification', 'conviction');

