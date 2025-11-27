const axios = require('axios');
const { obv } = require('indicatorts');

async function getZECOBV() {
  console.log('=== ZEC OBV - SEPTEMBER/OCTOBER 2025 ===\n');
  
  try {
    // September 1 - October 31, 2025
    const startDate = new Date('2025-09-01');
    const endDate = new Date('2025-10-31');
    
    // Calculate days needed
    const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 5; // Add buffer
    
    console.log(`Fetching ZEC data from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}...`);
    console.log(`Requesting ${days} days of data...\n`);
    
    // Fetch from CryptoCompare (daily candles)
    const limit = Math.min(days, 2000);
    const toTs = Math.floor(endDate.getTime() / 1000);
    
    const response = await axios.get(`https://min-api.cryptocompare.com/data/v2/histoday`, {
      params: {
        fsym: 'ZEC',
        tsym: 'USD',
        limit: limit,
        toTs: toTs
      }
    });
    
    if (response.data.Response === 'Error') {
      throw new Error(`CryptoCompare error: ${response.data.Message}`);
    }
    
    const data = response.data.Data.Data || [];
    
    // Filter to September/October only
    const startTs = Math.floor(startDate.getTime() / 1000);
    const endTs = Math.floor(endDate.getTime() / 1000);
    
    const filteredData = data.filter(candle => candle.time >= startTs && candle.time <= endTs);
    
    if (filteredData.length === 0) {
      console.log('No data found for September/October 2025');
      return;
    }
    
    console.log(`Found ${filteredData.length} days of data\n`);
    
    // Extract prices and volumes
    const prices = filteredData.map(candle => candle.close);
    const volumes = filteredData.map(candle => candle.volumeto || candle.volumefrom || 0);
    const dates = filteredData.map(candle => new Date(candle.time * 1000).toISOString().split('T')[0]);
    
    // Calculate OBV
    const obvValues = obv(prices, volumes);
    
    // Display results
    console.log('ZEC OBV - September/October 2025:');
    console.log('='.repeat(80));
    console.log(`Date       | Close Price | Volume      | OBV`);
    console.log('-'.repeat(80));
    
    for (let i = 0; i < filteredData.length; i++) {
      const date = dates[i];
      const price = prices[i].toFixed(2);
      const volume = volumes[i].toLocaleString('en-US', {maximumFractionDigits: 0});
      const obvVal = obvValues[i].toLocaleString('en-US', {maximumFractionDigits: 0});
      
      console.log(`${date} | $${price.padStart(10)} | ${volume.padStart(11)} | ${obvVal.padStart(15)}`);
    }
    
    console.log('='.repeat(80));
    console.log(`\nSummary:`);
    console.log(`- Start OBV (${dates[0]}): ${obvValues[0].toLocaleString('en-US', {maximumFractionDigits: 0})}`);
    console.log(`- End OBV (${dates[dates.length - 1]}): ${obvValues[obvValues.length - 1].toLocaleString('en-US', {maximumFractionDigits: 0})}`);
    console.log(`- OBV Change: ${(obvValues[obvValues.length - 1] - obvValues[0]).toLocaleString('en-US', {maximumFractionDigits: 0})}`);
    console.log(`- OBV Change %: ${obvValues[0] !== 0 ? (((obvValues[obvValues.length - 1] - obvValues[0]) / Math.abs(obvValues[0])) * 100).toFixed(2) : 'N/A'}%`);
    console.log(`- Average Daily Volume: ${(volumes.reduce((a, b) => a + b, 0) / volumes.length).toLocaleString('en-US', {maximumFractionDigits: 0})}`);
    console.log(`- Total Days: ${filteredData.length}`);
    
    // Trend analysis
    const obvChange = obvValues[obvValues.length - 1] - obvValues[0];
    const trend = obvChange > 0 ? 'ACCUMULATING (bullish)' : obvChange < 0 ? 'DISTRIBUTING (bearish)' : 'NEUTRAL';
    console.log(`- Trend: ${trend}`);
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
  }
}

getZECOBV();


