/**
 * Crypto price service with in-memory caching.
 * Primary: CoinGecko free API. Fallback: Blockchain.info ticker.
 * Cache TTL: 5 minutes — avoids API rate limits while staying reasonably fresh.
 */
const axios = require('axios');
const logger = require('./logger');

const cache = { btcUsd: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get current BTC/USD price.
 * @returns {Promise<number>} BTC price in USD
 */
async function getBtcUsdPrice() {
  const now = Date.now();
  if (cache.btcUsd && now - cache.ts < CACHE_TTL) {
    return cache.btcUsd;
  }

  // Primary: CoinGecko simple price (no API key needed)
  try {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { timeout: 10000 }
    );
    const price = data.bitcoin.usd;
    cache.btcUsd = price;
    cache.ts = now;
    logger.info(`[PRICE] BTC/USD: $${price} (CoinGecko)`);
    return price;
  } catch (err) {
    logger.warn(`[PRICE] CoinGecko failed: ${err.message}`);
  }

  // Fallback: Blockchain.info ticker
  try {
    const { data } = await axios.get('https://blockchain.info/ticker', { timeout: 10000 });
    const price = data.USD.last;
    cache.btcUsd = price;
    cache.ts = now;
    logger.info(`[PRICE] BTC/USD: $${price} (Blockchain.info fallback)`);
    return price;
  } catch (err) {
    logger.warn(`[PRICE] Blockchain.info also failed: ${err.message}`);
  }

  // Use stale cache if available
  if (cache.btcUsd) {
    logger.warn(`[PRICE] Using stale cache: $${cache.btcUsd}`);
    return cache.btcUsd;
  }

  // Absolute fallback — conservative estimate
  logger.error(`[PRICE] All sources failed, using $100,000 fallback`);
  return 100000;
}

module.exports = { getBtcUsdPrice };
