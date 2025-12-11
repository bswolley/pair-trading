-- Add volume fields to watchlist for volume-informed trading signals
-- Volume at divergence can indicate reversion probability:
-- Low volume divergence = liquidity noise = higher reversion chance
-- High volume divergence = fundamental repricing = lower reversion chance

ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS volume1 DECIMAL(20,2);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS volume2 DECIMAL(20,2);

-- Add comment for documentation
COMMENT ON COLUMN watchlist.volume1 IS '24h trading volume for asset1 in USD';
COMMENT ON COLUMN watchlist.volume2 IS '24h trading volume for asset2 in USD';

