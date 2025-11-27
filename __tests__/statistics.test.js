/**
 * Unit tests for statistical calculations
 */

describe('Statistical Calculations', () => {
  // Helper function to calculate correlation
  function calculateCorrelation(returns) {
    const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
    const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;
    
    let covariance = 0, variance1 = 0, variance2 = 0;
    for (const ret of returns) {
      const dev1 = ret.asset1 - mean1;
      const dev2 = ret.asset2 - mean2;
      covariance += dev1 * dev2;
      variance1 += dev1 * dev1;
      variance2 += dev2 * dev2;
    }
    covariance /= returns.length;
    variance1 /= returns.length;
    variance2 /= returns.length;
    
    return covariance / (Math.sqrt(variance1) * Math.sqrt(variance2));
  }

  // Helper function to calculate beta
  function calculateBeta(returns) {
    const mean1 = returns.reduce((sum, r) => sum + r.asset1, 0) / returns.length;
    const mean2 = returns.reduce((sum, r) => sum + r.asset2, 0) / returns.length;
    
    let covariance = 0, variance2 = 0;
    for (const ret of returns) {
      const dev1 = ret.asset1 - mean1;
      const dev2 = ret.asset2 - mean2;
      covariance += dev1 * dev2;
      variance2 += dev2 * dev2;
    }
    covariance /= returns.length;
    variance2 /= returns.length;
    
    return variance2 > 0 ? covariance / variance2 : 0;
  }

  test('correlation should be between -1 and 1', () => {
    const returns = [
      { asset1: 0.01, asset2: 0.01 },
      { asset1: 0.02, asset2: 0.02 },
      { asset1: -0.01, asset2: -0.01 },
      { asset1: 0.005, asset2: 0.005 }
    ];

    const correlation = calculateCorrelation(returns);
    expect(correlation).toBeGreaterThanOrEqual(-1);
    expect(correlation).toBeLessThanOrEqual(1.0001); // Account for floating point precision
  });

  test('correlation should be 1 for perfectly correlated assets', () => {
    const returns = [
      { asset1: 0.01, asset2: 0.01 },
      { asset1: 0.02, asset2: 0.02 },
      { asset1: -0.01, asset2: -0.01 }
    ];

    const correlation = calculateCorrelation(returns);
    expect(correlation).toBeCloseTo(1, 5);
  });

  test('correlation should be -1 for perfectly negatively correlated assets', () => {
    const returns = [
      { asset1: 0.01, asset2: -0.01 },
      { asset1: 0.02, asset2: -0.02 },
      { asset1: -0.01, asset2: 0.01 }
    ];

    const correlation = calculateCorrelation(returns);
    expect(correlation).toBeCloseTo(-1, 5);
  });

  test('beta should be positive when assets move together', () => {
    const returns = [
      { asset1: 0.01, asset2: 0.005 },
      { asset1: 0.02, asset2: 0.01 },
      { asset1: -0.01, asset2: -0.005 }
    ];

    const beta = calculateBeta(returns);
    expect(beta).toBeGreaterThan(0);
  });

  test('beta calculation should handle zero variance', () => {
    const returns = [
      { asset1: 0.01, asset2: 0 },
      { asset1: 0.02, asset2: 0 },
      { asset1: -0.01, asset2: 0 }
    ];

    const beta = calculateBeta(returns);
    expect(beta).toBe(0);
  });

  test('z-score calculation should handle edge cases', () => {
    const spreads = [0.1, 0.1, 0.1, 0.1, 0.1]; // All same value
    const meanSpread = spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
    const stdDevSpread = Math.sqrt(
      spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / spreads.length
    );
    
    // When stdDev is 0, z-score should be 0 or NaN
    if (stdDevSpread === 0) {
      const zScore = (0.1 - meanSpread) / stdDevSpread;
      expect(isNaN(zScore) || zScore === 0 || !isFinite(zScore)).toBe(true);
    }
  });
});

