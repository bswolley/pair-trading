const axios = require('axios');

async function getCurrentZScore() {
  try {
    // Get current prices
    const [ethResp, btcResp] = await Promise.all([
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'),
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')
    ]);
    
    const ethPrice = parseFloat(ethResp.data.price);
    const btcPrice = parseFloat(btcResp.data.price);
    
    console.log(`Current ETH: $${ethPrice}`);
    console.log(`Current BTC: $${btcPrice}`);
    
    // Use the 30-day parameters we calculated earlier
    const beta = 1.400;
    const meanSpread = -7.991533;
    const stdDev = 0.023492;
    
    // Calculate current spread
    const currentSpread = Math.log(ethPrice) - beta * Math.log(btcPrice);
    const zScore = (currentSpread - meanSpread) / stdDev;
    
    console.log(`\nCurrent spread: ${currentSpread.toFixed(6)}`);
    console.log(`Mean spread: ${meanSpread.toFixed(6)}`);
    console.log(`Current Z-Score: ${zScore.toFixed(2)}`);
    
    // Compare to previous
    console.log(`\nPrevious Z-scores:`);
    console.log(`Initial: 1.79`);
    console.log(`Earlier: 2.13`);
    console.log(`Current: ${zScore.toFixed(2)}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getCurrentZScore();
