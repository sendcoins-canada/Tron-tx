const { TronWeb } = require('tronweb');

const NETWORK_URLS = {
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
};

/**
 * Create a TronWeb instance for the given network.
 * @param {string} network    - mainnet | shasta | nile
 * @param {string} privateKey - Hex private key (from env)
 * @param {string} apiKey     - TronGrid Pro API key
 * @returns {TronWeb}
 */
function createTronWeb(network, privateKey, apiKey) {
  const fullHost = NETWORK_URLS[network];
  if (!fullHost) throw new Error(`Unknown network: ${network}`);

  const headers = {};
  if (apiKey) {
    headers['TRON-PRO-API-KEY'] = apiKey;
  }

  return new TronWeb({ fullHost, headers, privateKey });
}

module.exports = { createTronWeb };
