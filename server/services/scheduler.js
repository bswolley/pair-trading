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

let isMonitorRunning = false;
let isScanRunning = false;
let lastMonitorRun = null;
let lastScanRun = null;

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
 */
async function runScanNow() {
    if (isScanRunning) {
        console.log('[SCHEDULER] Scan already running, skipping');
        return { skipped: true, reason: 'already_running' };
    }

    isScanRunning = true;
    const startTime = Date.now();
    console.log(`[SCHEDULER] Running scan at ${new Date().toISOString()}`);

    try {
        const result = await runScan();
        lastScanRun = new Date().toISOString();
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
            schedule: '0 */12 * * *' // Every 12 hours
        }
    };
}

/**
 * Start all scheduled jobs
 */
function startScheduler() {
    console.log('[SCHEDULER] Starting cron jobs...');

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

    // Run initial monitor on startup (after 10 second delay to let server settle)
    setTimeout(async () => {
        console.log('[SCHEDULER] Running initial monitor...');
        await runMonitorNow();
    }, 10000);
}

module.exports = {
    startScheduler,
    runMonitorNow,
    runScanNow,
    getSchedulerStatus
};

