const Web3 = require('web3');
const config = require('../config');

const RPC_URLS = {
  bep20: config.BSC_RPC_URL,
  erc20: config.ETH_RPC_URL,
};

// Cache Web3 instances per network
const instances = {};

/**
 * Get or create a Web3 instance for the given EVM network.
 * @param {string} network - bep20 | erc20
 * @returns {Web3}
 */
function createWeb3(network) {
  const key = network.toLowerCase();
  if (instances[key]) return instances[key];

  const rpcUrl = RPC_URLS[key];
  if (!rpcUrl) throw new Error(`No RPC URL for network: ${network}`);

  instances[key] = new Web3(new Web3.providers.HttpProvider(rpcUrl));
  return instances[key];
}

module.exports = { createWeb3 };
