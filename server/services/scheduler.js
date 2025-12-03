/**
 * Scheduler Service - Cron jobs for automated operations
 * 
 * Jobs:
 * - Every 12 hours: Run pair scan to discover new pairs
 * - Every 15 minutes: Monitor watchlist and active trades
 */

const cron = require('node-cron');
const path = require('path');

// Import core logic from existing scripts
const { main: runMonitor } = require('./monitor');
const { main: runScan } = require('./scanner');
const db = require('../db/queries');

let isMonitorRunning = false;
let isScanRunning = false;
let lastMonitorRun = null;
let lastScanRun = null;
let crossSectorEnabled = false; // Toggle for cross-sector scanning

// How long before we consider a scan "stale" and need to re-run (6 hours)
const SCAN_STALE_HOURS = 6;

/**
 * Load scheduler state from database on startup
 */
async function loadStateFromDB() {
    try {
        const state = await db.getSchedulerState();
        if (state) {
            lastScanRun = state.lastScanTime;
            lastMonitorRun = state.lastMonitorTime;
            crossSectorEnabled = state.crossSectorEnabled || false;
            console.log('[SCHEDULER] Loaded state from DB:');
            console.log(`  - Last scan: ${lastScanRun || 'never'}`);
            console.log(`  - Last monitor: ${lastMonitorRun || 'never'}`);
            console.log(`  - Cross-sector: ${crossSectorEnabled}`);
        }
    } catch (err) {
        console.error('[SCHEDULER] Failed to load state from DB:', err.message);
    }
}

/**
 * Check if scan is stale and needs to run
 */
function isScanStale() {
    if (!lastScanRun) return true;
    
    const lastScanTime = new Date(lastScanRun).getTime();
    const hoursSinceLastScan = (Date.now() - lastScanTime) / (1000 * 60 * 60);
    return hoursSinceLastScan > SCAN_STALE_HOURS;
}

/**
 * Run monitor (check watchlist and active trades)
 */
async function runMonitorNow() {
    if (isMonitorRunning) {
        console.log('[SCHEDULER] Monitor already running, skipping');
        return { skipped: true, reason: 'already_running' };
    }

    isMonitorRunning = true;
    const startTime = Date.now();
    console.log(`[SCHEDULER] Running monitor at ${new Date().toISOString()}`);

    try {
        const result = await runMonitor();
        lastMonitorRun = new Date().toISOString();
        
        // Save to DB
        await db.updateSchedulerState({ lastMonitorTime: lastMonitorRun });
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[SCHEDULER] Monitor completed in ${duration}s`);
        return { success: true, duration, timestamp: lastMonitorRun, ...result };
    } catch (err) {
        console.error('[SCHEDULER] Monitor error:', err.message);
        return { success: false, error: err.message };
    } finally {
        isMonitorRunning = false;
    }
}

/**
 * Run pair scan (discover new pairs)
 * @param {Object} options - Scan options
 * @param {boolean} options.crossSector - Override cross-sector setting for this scan
 */
async function runScanNow(options = {}) {
    if (isScanRunning) {
        console.log('[SCHEDULER] Scan already running, skipping');
        return { skipped: true, reason: 'already_running' };
    }

    isScanRunning = true;
    const startTime = Date.now();
    const useCrossSector = options.crossSector ?? crossSectorEnabled;
    console.log(`[SCHEDULER] Running scan at ${new Date().toISOString()} (crossSector: ${useCrossSector})`);

    try {
        const result = await runScan({ crossSector: useCrossSector });
        lastScanRun = new Date().toISOString();
        
        // Save to DB
        await db.updateSchedulerState({ lastScanTime: lastScanRun });
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[SCHEDULER] Scan completed in ${duration}s`);
        return { success: true, duration, timestamp: lastScanRun, ...result };
    } catch (err) {
        console.error('[SCHEDULER] Scan error:', err.message);
        return { success: false, error: err.message };
    } finally {
        isScanRunning = false;
    }
}

/**
 * Set cross-sector scanning enabled/disabled
 */
async function setCrossSectorEnabled(enabled) {
    crossSectorEnabled = enabled;
    
    // Persist to DB
    await db.updateSchedulerState({ crossSectorEnabled: enabled });
    
    console.log(`[SCHEDULER] Cross-sector scanning ${enabled ? 'enabled' : 'disabled'}`);
    return crossSectorEnabled;
}

/**
 * Get cross-sector setting
 */
function getCrossSectorEnabled() {
    return crossSectorEnabled;
}

/**
 * Get scheduler status
 */
function getSchedulerStatus() {
    return {
        monitor: {
            isRunning: isMonitorRunning,
            lastRun: lastMonitorRun,
            schedule: '*/15 * * * *' // Every 15 minutes
        },
        scan: {
            isRunning: isScanRunning,
            lastRun: lastScanRun,
            schedule: '0 */12 * * *', // Every 12 hours
            crossSectorEnabled
        }
    };
}

/**
 * Start all scheduled jobs
 */
async function startScheduler() {
    console.log('[SCHEDULER] Starting cron jobs...');

    // Load persisted state from database
    await loadStateFromDB();

    // Every 15 minutes - Monitor watchlist & active trades
    cron.schedule('*/15 * * * *', async () => {
        console.log('[CRON] 15min monitor triggered');
        await runMonitorNow();
    });

    // Every 12 hours - Scan for new pairs (at 00:00 and 12:00)
    cron.schedule('0 */12 * * *', async () => {
        console.log('[CRON] 12h scan triggered');
        await runScanNow();
    });

    console.log('[SCHEDULER] Cron jobs scheduled:');
    console.log('  - Monitor: every 15 minutes');
    console.log('  - Scan: every 12 hours (00:00, 12:00)');

    // Run initial operations on startup (after 10 second delay to let server settle)
    setTimeout(async () => {
        // Always run monitor first
        console.log('[SCHEDULER] Running initial monitor...');
        await runMonitorNow();
        
        // Run scan if it's been >6 hours since last scan (or never)
        if (isScanStale()) {
            const hoursSince = lastScanRun 
                ? ((Date.now() - new Date(lastScanRun).getTime()) / (1000 * 60 * 60)).toFixed(1)
                : 'never';
            console.log(`[SCHEDULER] Scan is stale (last: ${hoursSince}h ago), running scan...`);
            await runScanNow();
        } else {
            console.log('[SCHEDULER] Scan is fresh, skipping startup scan');
        }
    }, 10000);
}

module.exports = {
    startScheduler,
    runMonitorNow,
    runScanNow,
    getSchedulerStatus,
    setCrossSectorEnabled,
    getCrossSectorEnabled
};

