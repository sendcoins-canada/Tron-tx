/**
 * Address validation per network.
 * Patterns sourced from sendcoins recipientService.js.
 */

const PATTERNS = {
  trc20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  bep20: /^0x[0-9a-fA-F]{40}$/,
  erc20: /^0x[0-9a-fA-F]{40}$/,
};

/**
 * Validate a wallet address for a given network.
 * @param {string} address
 * @param {string} network - trc20 | bep20 | erc20
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAddress(address, network) {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required' };
  }

  const pattern = PATTERNS[network.toLowerCase()];
  if (!pattern) {
    return { valid: false, error: `Unsupported network: ${network}` };
  }

  if (!pattern.test(address.trim())) {
    return { valid: false, error: `Invalid ${network.toUpperCase()} address format` };
  }

  return { valid: true };
}

module.exports = { validateAddress };
