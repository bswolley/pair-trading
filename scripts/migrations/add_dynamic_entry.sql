-- Add dynamic_entry JSONB column to watchlist table
-- This stores per-pair dynamic entry threshold analysis

ALTER TABLE watchlist 
ADD COLUMN IF NOT EXISTS dynamic_entry JSONB;

-- Add comment for documentation
COMMENT ON COLUMN watchlist.dynamic_entry IS 'Dynamic entry threshold data: {threshold, confidence, score, flags, recommendation, reversionRate, avgReversionTime, zeroCrossFreq, hasRegimeWarning}';

-- Create index for faster lookups on regime warnings
CREATE INDEX IF NOT EXISTS idx_watchlist_dynamic_entry_regime 
ON watchlist ((dynamic_entry->>'hasRegimeWarning'));
