#!/usr/bin/env node

/**
 * Pair Trading Backend Server
 * 
 * Single long-running process that:
 * - Exposes REST API for frontend
 * - Runs scheduled jobs (scan every 12h, monitor every 15min)
 * - Listens to Telegram commands
 * 
 * Database: Uses Supabase when configured, falls back to JSON files
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { isSupabaseConfigured, testConnection } = require('./db/supabase');

// Routes
const tradesRoutes = require('./routes/trades');
const watchlistRoutes = require('./routes/watchlist');
const historyRoutes = require('./routes/history');
const blacklistRoutes = require('./routes/blacklist');
const statusRoutes = require('./routes/status');
const zscoreRoutes = require('./routes/zscore');
const analyzeRoutes = require('./routes/analyze');

// Services
const { startScheduler, runScanNow, runMonitorNow } = require('./services/scheduler');
const { startTelegramBot } = require('./services/telegram');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : ['*'];

console.log('[CORS] Allowed origins:', allowedOrigins);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc)
        if (!origin) {
            console.log('[CORS] No origin header, allowing');
            return callback(null, true);
        }

        console.log(`[CORS] Request from origin: ${origin}`);

        // If wildcard is set, allow all
        if (allowedOrigins.includes('*')) {
            console.log('[CORS] Wildcard enabled, allowing');
            return callback(null, true);
        }

        // Check if origin is in allowed list (exact match or remove trailing slash)
        const originNormalized = origin.replace(/\/$/, '');
        const isAllowed = allowedOrigins.some(allowed => {
            const allowedNormalized = allowed.replace(/\/$/, '');
            return originNormalized === allowedNormalized;
        });

        if (isAllowed) {
            console.log('[CORS] Origin allowed');
            callback(null, true);
        } else {
            console.log(`[CORS] Origin rejected. Allowed: ${allowedOrigins.join(', ')}, Got: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: require('../package.json').version
    });
});

// API Routes
app.use('/api/trades', tradesRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/blacklist', blacklistRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/zscore', zscoreRoutes);
app.use('/api/analyze', analyzeRoutes);

// Manual trigger endpoints
app.post('/api/scan', async (req, res) => {
    console.log('[API] Manual scan triggered');
    try {
        const result = await runScanNow();
        res.json({ success: true, message: 'Scan completed', result });
    } catch (err) {
        console.error('[API] Scan error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/monitor', async (req, res) => {
    console.log('[API] Manual monitor triggered');
    try {
        const result = await runMonitorNow();
        res.json({ success: true, message: 'Monitor completed', result });
    } catch (err) {
        console.error('[API] Monitor error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
});

// Start server
async function start() {
    console.log('🚀 Pair Trading Backend Server\n');
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Port: ${PORT}`);
    console.log(`Frontend URL: ${process.env.FRONTEND_URL || '*'}`);

    // Check database mode
    if (isSupabaseConfigured()) {
        console.log(`Database: Supabase`);
        const connected = await testConnection();
        if (!connected) {
            console.log('⚠️ Supabase connection failed, falling back to JSON files');
        }
    } else {
        console.log(`Database: JSON files (local mode)`);
    }
    console.log('');

    // Start Express server
    app.listen(PORT, () => {
        console.log(`✅ REST API listening on port ${PORT}`);
    });

    // Start Telegram bot
    try {
        await startTelegramBot();
        console.log('✅ Telegram bot started');
    } catch (err) {
        console.warn('⚠️ Telegram bot failed to start:', err.message);
    }

    // Start scheduler (cron jobs)
    startScheduler();
    console.log('✅ Scheduler started (12h scan, 15min monitor)');

    console.log('\n📡 Server ready!\n');
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

