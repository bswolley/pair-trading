const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildSummary(classification) {
  const summary = {};
  Object.entries(classification).forEach(([bucket, items]) => {
    const totals = {
      total: items.length,
      still_match: 0,
      moved: 0,
      current_breakdown: {},
      missing_tvl: 0
    };

    items.forEach(item => {
      const original = (item.original_tag || bucket).toLowerCase();
      const current = (item.current_tag || '').toLowerCase();

      if (current === original) {
        totals.still_match += 1;
      } else {
        totals.moved += 1;
      }

      totals.current_breakdown[current] = (totals.current_breakdown[current] || 0) + 1;

      const tvlRatio = (item.current_tvl_ratio || '').toString().toLowerCase();
      if (tvlRatio === 'no tvl' || tvlRatio === 'n/a' || tvlRatio === '-') {
        totals.missing_tvl += 1;
      }
    });

    summary[bucket] = totals;
  });

  return summary;
}

function main() {
  const dateTag = new Date().toISOString().slice(0, 10);
  const snapshotDir = path.join('snapshots', dateTag);
  ensureDir(snapshotDir);

  // Step 1: refresh classification data
  run('node refresh_and_validate.js');

  if (!fs.existsSync('fresh_validation_results.json')) {
    throw new Error('fresh_validation_results.json not found after refresh_and_validate');
  }

  // Step 2: fetch price history (optional but keeps data fresh)
  try {
    run('node fetch_hybrid_history.js');
  } catch (error) {
    console.error('Warning: fetch_hybrid_history.js failed. Continuing with existing OHLC data.');
  }

  // Copy raw files into snapshot directory
  const classificationPath = path.join(snapshotDir, 'classification.json');
  fs.copyFileSync('fresh_validation_results.json', classificationPath);

  if (fs.existsSync('hybrid_ohlc_data.json')) {
    fs.copyFileSync('hybrid_ohlc_data.json', path.join(snapshotDir, 'ohlc.json'));
  }

  if (fs.existsSync('updated_defi_returns.pdf')) {
    fs.copyFileSync('updated_defi_returns.pdf', path.join(snapshotDir, 'report.pdf'));
  }

  if (fs.existsSync('analytical_report.md')) {
    fs.copyFileSync('analytical_report.md', path.join(snapshotDir, 'report.md'));
  }

  // Build summary stats
  const classification = JSON.parse(fs.readFileSync('fresh_validation_results.json', 'utf8'));
  const summary = {
    date: dateTag,
    created_at: new Date().toISOString(),
    counts: buildSummary(classification)
  };

  fs.writeFileSync(path.join(snapshotDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Maintain snapshot index
  const indexPath = path.join('snapshots', 'index.json');
  let index = [];
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (error) {
      console.error('Warning: snapshots/index.json is invalid JSON. Overwriting.');
    }
  }

  // Remove existing entry for this date if present
  index = index.filter(entry => entry.date !== dateTag);
  index.push({
    date: dateTag,
    summary: path.join(snapshotDir, 'summary.json'),
    classification: classificationPath,
    report: path.join(snapshotDir, 'report.pdf')
  });
  index.sort((a, b) => (a.date < b.date ? -1 : 1));

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log(`\nSnapshot saved to ${snapshotDir}`);
}

main();
