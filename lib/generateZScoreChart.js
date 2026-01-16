/**
 * Generate SVG chart for Z-score visualization
 * Shows Z-score over time with thresholds and divergence events
 */

function generateZScoreChart(zScores, divergenceProfile, width = 800, height = 400) {
  if (!zScores || zScores.length === 0) {
    return null;
  }

  const padding = { top: 40, right: 40, bottom: 60, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Find min/max Z-score for scaling
  const zValues = zScores.map(z => Math.abs(z.zScore));
  const minZ = 0;
  const maxZ = Math.max(3.5, Math.max(...zValues) * 1.1);

  // Thresholds to display
  const thresholds = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  const thresholdColors = {
    0.5: '#888',
    1.0: '#ffa500',
    1.5: '#ff6b6b',
    2.0: '#ee5a6f',
    2.5: '#c44569',
    3.0: '#a55eea'
  };

  // Convert timestamps to x-coordinates
  const timeRange = zScores[zScores.length - 1].timestamp - zScores[0].timestamp;
  const getX = (timestamp) => {
    return padding.left + ((timestamp - zScores[0].timestamp) / timeRange) * chartWidth;
  };

  // Convert Z-score to y-coordinate
  const getY = (zScore) => {
    return padding.top + chartHeight - (Math.abs(zScore) / maxZ) * chartHeight;
  };

  // Generate path for Z-score line
  let pathData = '';
  for (let i = 0; i < zScores.length; i++) {
    const x = getX(zScores[i].timestamp);
    const y = getY(zScores[i].zScore);
    if (i === 0) {
      pathData += `M ${x} ${y}`;
    } else {
      pathData += ` L ${x} ${y}`;
    }
  }

  // Generate threshold lines
  const thresholdLines = thresholds.map(threshold => {
    const y = getY(threshold);
    const color = thresholdColors[threshold] || '#666';
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" 
            stroke="${color}" stroke-width="1" stroke-dasharray="4,4" opacity="0.6"/>
            <text x="${padding.left - 10}" y="${y + 4}" fill="${color}" font-size="10" text-anchor="end">${threshold}</text>`;
  }).join('\n');

  // Generate axis labels
  const days = Math.ceil(timeRange / (24 * 60 * 60 * 1000));
  const numLabels = 5;
  const axisLabels = [];
  for (let i = 0; i <= numLabels; i++) {
    const idx = Math.floor((i / numLabels) * (zScores.length - 1));
    const timestamp = zScores[idx].timestamp;
    const x = getX(timestamp);
    const date = new Date(timestamp);
    const label = `Day ${Math.floor((timestamp - zScores[0].timestamp) / (24 * 60 * 60 * 1000)) + 1}`;
    axisLabels.push(`<text x="${x}" y="${height - padding.bottom + 20}" fill="#888" font-size="10" text-anchor="middle">${label}</text>`);
  }

  // Generate Y-axis labels
  const yAxisLabels = [];
  for (let i = 0; i <= 6; i++) {
    const zValue = (i / 6) * maxZ;
    const y = getY(zValue);
    yAxisLabels.push(`<text x="${padding.left - 10}" y="${y + 4}" fill="#888" font-size="10" text-anchor="end">${zValue.toFixed(1)}</text>`);
  }

  // Find divergence events for annotation
  const events = [];
  if (divergenceProfile) {
    // Track when Z-score crosses thresholds
    let inDivergence = false;
    let divergenceStart = null;
    for (let i = 1; i < zScores.length; i++) {
      const absZ = Math.abs(zScores[i].zScore);
      const prevAbsZ = Math.abs(zScores[i-1].zScore);
      
      if (!inDivergence && absZ >= 1.0 && prevAbsZ < 1.0) {
        inDivergence = true;
        divergenceStart = i;
      }
      
      if (inDivergence && absZ < 0.5) {
        if (divergenceStart !== null) {
          const startX = getX(zScores[divergenceStart].timestamp);
          const endX = getX(zScores[i].timestamp);
          const peakIdx = divergenceStart + zScores.slice(divergenceStart, i)
            .reduce((maxIdx, z, idx) => Math.abs(z.zScore) > Math.abs(zScores[maxIdx].zScore) ? divergenceStart + idx : maxIdx, divergenceStart);
          const peakZ = Math.abs(zScores[peakIdx].zScore);
          const peakY = getY(zScores[peakIdx].zScore);
          const peakX = getX(zScores[peakIdx].timestamp);
          
          events.push({
            startX,
            endX,
            peakX,
            peakY,
            peakZ
          });
        }
        inDivergence = false;
        divergenceStart = null;
      }
    }
  }

  // Generate event annotations
  const eventAnnotations = events.map((event, idx) => {
    return `
      <line x1="${event.startX}" y1="${height - padding.bottom + 10}" x2="${event.endX}" y2="${height - padding.bottom + 10}" 
            stroke="#4ecdc4" stroke-width="2" opacity="0.7"/>
      <line x1="${event.peakX}" y1="${event.peakY}" x2="${event.peakX}" y2="${height - padding.bottom + 10}" 
            stroke="#4ecdc4" stroke-width="1" stroke-dasharray="2,2" opacity="0.5"/>
      <text x="${(event.startX + event.endX) / 2}" y="${height - padding.bottom + 25}" 
            fill="#4ecdc4" font-size="9" text-anchor="middle">Event ${idx + 1}</text>
      <text x="${event.peakX}" y="${event.peakY - 5}" 
            fill="#4ecdc4" font-size="9" text-anchor="middle">Z=${event.peakZ.toFixed(1)}</text>`;
  }).join('\n');

  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .chart-bg { fill: #1a1a1a; }
    .grid-line { stroke: #333; stroke-width: 1; }
  </style>
  
  <!-- Background -->
  <rect class="chart-bg" width="${width}" height="${height}"/>
  
  <!-- Grid lines -->
  ${thresholds.map(threshold => {
    const y = getY(threshold);
    return `<line class="grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" opacity="0.3"/>`;
  }).join('\n')}
  
  <!-- Threshold lines -->
  ${thresholdLines}
  
  <!-- Z-score line -->
  <path d="${pathData}" fill="none" stroke="#4ecdc4" stroke-width="2" opacity="0.9"/>
  
  <!-- Event annotations -->
  ${eventAnnotations}
  
  <!-- Axes -->
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" 
        stroke="#666" stroke-width="2"/>
  <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" 
        stroke="#666" stroke-width="2"/>
  
  <!-- Axis labels -->
  ${axisLabels.join('\n')}
  ${yAxisLabels.join('\n')}
  
  <!-- Title -->
  <text x="${width / 2}" y="20" fill="#fff" font-size="14" font-weight="bold" text-anchor="middle">Z-Score Over 30 Days</text>
  <text x="${width / 2}" y="${height - 10}" fill="#888" font-size="10" text-anchor="middle">Time (Days)</text>
  <text x="20" y="${height / 2}" fill="#888" font-size="10" text-anchor="middle" transform="rotate(-90, 20, ${height / 2})">|Z-Score|</text>
</svg>`;

  return svg;
}

module.exports = { generateZScoreChart };




