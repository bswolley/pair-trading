/**
 * Supabase Client
 * 
 * Database client for cloud deployment.
 * Falls back to JSON files if Supabase is not configured.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;

/**
 * Check if Supabase is configured
 */
function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Get Supabase client (singleton)
 */
function getClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }
  
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: false
      }
    });
    console.log('[SUPABASE] Client initialized');
  }
  
  return supabase;
}

/**
 * Test database connection
 */
async function testConnection() {
  const client = getClient();
  if (!client) {
    console.log('[SUPABASE] Not configured, using JSON files');
    return false;
  }
  
  try {
    const { data, error } = await client.from('stats').select('id').limit(1);
    if (error) throw error;
    console.log('[SUPABASE] Connection successful');
    return true;
  } catch (err) {
    console.error('[SUPABASE] Connection failed:', err.message);
    return false;
  }
}

module.exports = {
  getClient,
  isSupabaseConfigured,
  testConnection
};

