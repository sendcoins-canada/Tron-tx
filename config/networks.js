/**
 * Network registry — gas thresholds, decimals, and RPC config.
 */
const NETWORKS = {
  trc20: {
    chain: 'tron',
    nativeToken: 'TRX',
    gasThreshold: 35,
    rpcEnvKey: null, // Uses TronWeb, not Web3
    decimals: { USDT: 6, USDC: 6 },
  },
  bep20: {
    chain: 'bsc',
    nativeToken: 'BNB',
    gasThreshold: 0.005,
    rpcEnvKey: 'BSC_RPC_URL',
    rpcDefault: 'https://bsc-dataseed1.binance.org',
    decimals: { USDT: 18, USDC: 18 },
  },
  erc20: {
    chain: 'eth',
    nativeToken: 'ETH',
    gasThreshold: 0.01,
    rpcEnvKey: 'ETH_RPC_URL',
    rpcDefault: null, // Must be set via ETH_RPC_URL env var
    decimals: { USDT: 6, USDC: 6 },
  },
};

const SUPPORTED_NETWORKS = Object.keys(NETWORKS);
const SUPPORTED_COINS = ['USDT', 'USDC'];

function getNetwork(network) {
  const net = NETWORKS[network.toLowerCase()];
  if (!net) throw new Error(`Unsupported network: ${network}`);
  return net;
}

module.exports = { NETWORKS, SUPPORTED_NETWORKS, SUPPORTED_COINS, getNetwork };
