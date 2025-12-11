-- Add volatility metrics for beta neutralization analysis
-- Based on paper: "Systemic Beta Neutralization" - spread volatility vs directional volatility
-- 
-- volRatio < 0.3 = Excellent beta neutralization (spread 70%+ less volatile than assets)
-- volRatio 0.3-0.5 = Good
-- volRatio > 0.5 = Poor (spread nearly as volatile as holding assets directionally)

ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS spread_vol DECIMAL(10,2);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS vol_ratio DECIMAL(5,3);

COMMENT ON COLUMN watchlist.spread_vol IS 'Annualized spread volatility (%)';
COMMENT ON COLUMN watchlist.vol_ratio IS 'Spread vol / avg directional vol - lower = better beta neutralization';

