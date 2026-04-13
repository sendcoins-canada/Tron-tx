/**
 * System settings reader with in-memory cache.
 * Reads from the system_settings table (shared with sendcoins backend).
 * Cache TTL: 5 minutes — fee changes take effect within 5 min without a redeploy.
 */
const queries = require('../db/queries');
const logger = require('./logger');

const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get a system setting by key, with fallback to defaultValue.
 * Automatically parses based on setting_type (json, number, boolean, string).
 */
async function getSetting(key, defaultValue) {
  const now = Date.now();

  if (cache[key] && now - cache[key].ts < CACHE_TTL) {
    return cache[key].value;
  }

  try {
    const row = await queries.getSystemSetting(key);

    if (!row) {
      cache[key] = { value: defaultValue, ts: now };
      return defaultValue;
    }

    let parsed;
    switch (row.setting_type) {
      case 'json':    parsed = JSON.parse(row.setting_value); break;
      case 'number':  parsed = parseFloat(row.setting_value); break;
      case 'boolean': parsed = row.setting_value === 'true';  break;
      default:        parsed = row.setting_value;
    }

    cache[key] = { value: parsed, ts: now };
    return parsed;
  } catch (err) {
    logger.warn(`[SETTINGS] Failed to read "${key}": ${err.message} — using default`);
    return defaultValue;
  }
}

module.exports = { getSetting };
