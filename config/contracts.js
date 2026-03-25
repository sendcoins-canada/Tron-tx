const CONTRACTS = {
  mainnet: {
    USDT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    USDC: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  },
  shasta: {
    USDT: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    USDC: process.env.USDC_CONTRACT || 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  },
  nile: {
    USDT: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    USDC: process.env.USDC_CONTRACT || 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  },
};

/**
 * Get the contract address for a token on the given network.
 * @param {string} network - mainnet | shasta | nile
 * @param {string} token   - USDT | USDC
 * @returns {string} Contract address
 */
function getContractAddress(network, token) {
  const net = CONTRACTS[network];
  if (!net) throw new Error(`Unknown network: ${network}`);
  const addr = net[token.toUpperCase()];
  if (!addr) throw new Error(`Unknown token: ${token} on ${network}`);
  return addr;
}

module.exports = { getContractAddress };
