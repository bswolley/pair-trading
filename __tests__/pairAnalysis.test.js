const { analyzePair } = require('../lib/pairAnalysis');
const axios = require('axios');
const { Hyperliquid } = require('hyperliquid');

// Mock external dependencies
jest.mock('axios');
jest.mock('hyperliquid');

describe('Pair Analysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock CryptoCompare API
    axios.get.mockImplementation((url) => {
      if (url.includes('pricemultifull')) {
        return Promise.resolve({
          data: {
            RAW: {
              'SOL': { USD: { MKTCAP: 87000000000 } },
              'ETH': { USD: { MKTCAP: 365000000000 } },
              'HYPE': { USD: { MKTCAP: 34600000000 } },
              'ZEC': { USD: { MKTCAP: 8370000000 } }
            }
          }
        });
      }
      if (url.includes('histoday')) {
        // Return mock historical data
        const data = [];
        for (let i = 180; i >= 0; i--) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          data.push({
            time: Math.floor(date.getTime() / 1000),
            close: 100 + Math.random() * 20,
            volumeto: 1000000 + Math.random() * 500000,
            volumefrom: 1000000 + Math.random() * 500000
          });
        }
        return Promise.resolve({
          data: {
            Response: 'Success',
            Data: { Data: data }
          }
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    // Mock Hyperliquid SDK
    const mockSdk = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      info: {
        getCandleSnapshot: jest.fn().mockImplementation((symbol, interval, startTime, endTime) => {
          const candles = [];
          const days = Math.floor((endTime - startTime) / (24 * 60 * 60 * 1000));
          for (let i = 0; i < days; i++) {
            candles.push({
              t: startTime + (i * 24 * 60 * 60 * 1000),
              o: (100 + Math.random() * 20).toFixed(2),
              h: (100 + Math.random() * 20).toFixed(2),
              l: (100 + Math.random() * 20).toFixed(2),
              c: (100 + Math.random() * 20).toFixed(2),
              v: (1000000 + Math.random() * 500000).toFixed(0)
            });
          }
          return Promise.resolve(candles);
        })
      }
    };
    
    Hyperliquid.mockImplementation(() => mockSdk);
  });

  describe('Statistical Calculations', () => {
    test('should calculate correlation between -1 and 1', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      const correlation = result.timeframes[7].correlation;
      expect(correlation).toBeGreaterThanOrEqual(-1);
      expect(correlation).toBeLessThanOrEqual(1);
      expect(typeof correlation).toBe('number');
    });

    test('should calculate beta as a number', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      const beta = result.timeframes[7].beta;
      expect(typeof beta).toBe('number');
      expect(isNaN(beta)).toBe(false);
    });

    test('should calculate z-score as a number', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      const zScore = result.timeframes[7].zScore;
      expect(typeof zScore).toBe('number');
      expect(isNaN(zScore)).toBe(false);
    });

    test('should calculate gamma and theta', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      expect(typeof result.timeframes[7].gamma).toBe('number');
      expect(typeof result.timeframes[7].theta).toBe('number');
    }, 30000);
  });

  describe('Input Validation', () => {
    test('should handle valid pair configuration', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      expect(result.pair).toBe('SOL/ETH');
      expect(result.symbol1).toBe('SOL');
      expect(result.symbol2).toBe('ETH');
      expect(result.direction).toBe('long');
    });

    test('should default to long direction', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        timeframes: [7]
      });

      expect(result.direction).toBe('long');
    });

    test('should handle short direction', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'short',
        timeframes: [7]
      });

      expect(result.direction).toBe('short');
    });
  });

  describe('Trade Signals', () => {
    test('should identify undervalued signal for long strategy', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      const tf = result.timeframes[7];
      if (tf.zScore < -1) {
        expect(tf.leftSideUndervalued).toBe(true);
        expect(tf.tradeReady).toBe(true);
      }
    });

    test('should identify overvalued signal for short strategy', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'short',
        timeframes: [7]
      });

      const tf = result.timeframes[7];
      if (tf.zScore > 1) {
        expect(tf.leftSideOvervalued).toBe(true);
        expect(tf.tradeReady).toBe(true);
      }
    });
  });

  describe('Data Structure', () => {
    test('should return correct structure', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7, 30]
      });

      expect(result).toHaveProperty('pair');
      expect(result).toHaveProperty('symbol1');
      expect(result).toHaveProperty('symbol2');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('timeframes');
      expect(result.timeframes).toHaveProperty('7');
      expect(result.timeframes).toHaveProperty('30');
    });

    test('should include all required timeframe metrics', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      });

      const tf = result.timeframes[7];
      expect(tf).toHaveProperty('correlation');
      expect(tf).toHaveProperty('beta');
      expect(tf).toHaveProperty('zScore');
      expect(tf).toHaveProperty('isCointegrated');
      expect(tf).toHaveProperty('hedgeRatio');
      expect(tf).toHaveProperty('gamma');
      expect(tf).toHaveProperty('theta');
      expect(tf).toHaveProperty('price1Start');
      expect(tf).toHaveProperty('price1End');
      expect(tf).toHaveProperty('price2Start');
      expect(tf).toHaveProperty('price2End');
    });
  });

  describe('Cointegration', () => {
    test('should calculate cointegration status', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [30]
      });

      const isCointegrated = result.timeframes[30].isCointegrated;
      expect(typeof isCointegrated).toBe('boolean');
    });
  });

  describe('Error Handling', () => {
    test('should handle API failures gracefully', async () => {
      axios.get.mockRejectedValueOnce(new Error('API Error'));

      await expect(analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      })).rejects.toThrow();
    });

    test('should handle insufficient data', async () => {
      const mockSdk = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        info: {
          getCandleSnapshot: jest.fn().mockResolvedValue([]) // Empty data
        }
      };
      Hyperliquid.mockImplementation(() => mockSdk);

      await expect(analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7]
      })).rejects.toThrow('Hyperliquid failed');
    });
  });

  describe('Multiple Timeframes', () => {
    test('should analyze multiple timeframes', async () => {
      const result = await analyzePair({
        symbol1: 'SOL',
        symbol2: 'ETH',
        direction: 'long',
        timeframes: [7, 30]
      }, 30000);

      expect(result.timeframes).toHaveProperty('7');
      expect(result.timeframes).toHaveProperty('30');
    }, 60000);
});

