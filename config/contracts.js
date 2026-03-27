/**
 * Token contract addresses across all supported networks.
 * Sources: walletQ.js (sendcoins) for BEP20/ERC20, existing contracts.js for TRC20.
 */

const CONTRACTS = {
  // ─── TRC20 (Tron) ──────────────────────────────────────────
  trc20: {
    USDT: {
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      decimals: 6,
      web3Unit: null, // Tron uses raw ×1e6
    },
    USDC: {
      address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
      decimals: 6,
      web3Unit: null,
    },
  },

  // ─── BEP20 (BSC) ───────────────────────────────────────────
  bep20: {
    USDT: {
      address: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      web3Unit: 'ether',
    },
    USDC: {
      address: '0x8965349fb649A33a30cbFDa057D8eC2C48AbE2A2',
      decimals: 18,
      web3Unit: 'ether',
    },
  },

  // ─── ERC20 (Ethereum) ──────────────────────────────────────
  erc20: {
    USDT: {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6,
      web3Unit: 'mwei',
    },
    USDC: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      web3Unit: 'mwei',
    },
  },
};

// TRC20 testnet overrides
const TRC20_TESTNET = {
  shasta: {
    USDT: process.env.USDT_CONTRACT || CONTRACTS.trc20.USDT.address,
    USDC: process.env.USDC_CONTRACT || CONTRACTS.trc20.USDC.address,
  },
  nile: {
    USDT: process.env.USDT_CONTRACT || CONTRACTS.trc20.USDT.address,
    USDC: process.env.USDC_CONTRACT || CONTRACTS.trc20.USDC.address,
  },
};

/**
 * Get contract info for a token on a given network.
 * @param {string} network - trc20 | bep20 | erc20
 * @param {string} token   - USDT | USDC
 * @returns {{ address: string, decimals: number, web3Unit: string|null }}
 */
function getContract(network, token) {
  const net = CONTRACTS[network.toLowerCase()];
  if (!net) throw new Error(`Unknown network: ${network}`);
  const contract = net[token.toUpperCase()];
  if (!contract) throw new Error(`Unknown token: ${token} on ${network}`);
  return contract;
}

/**
 * Legacy helper — returns just the contract address.
 * Used by existing TRC20 simulator code.
 */
function getContractAddress(tronNetwork, token) {
  // For testnet overrides
  if (tronNetwork === 'shasta' || tronNetwork === 'nile') {
    const addr = TRC20_TESTNET[tronNetwork]?.[token.toUpperCase()];
    if (addr) return addr;
  }
  // mainnet or fallback
  const contract = CONTRACTS.trc20[token.toUpperCase()];
  if (!contract) throw new Error(`Unknown token: ${token}`);
  return contract.address;
}

/**
 * Load the correct ABI for a token/network combo.
 * ERC20 USDC proxy ABI lacks balanceOf/transfer, so we use USDT's ABI.
 */
function loadAbi(network, token) {
  const t = token.toUpperCase();
  const n = network.toLowerCase();
  if (n === 'erc20' && t === 'USDC') {
    return require('../ABI/UsdtErc20.json');
  }
  const tokenTitle = t.charAt(0) + t.slice(1).toLowerCase();
  const suffix = n === 'bep20' ? 'Bep20' : 'Erc20';
  return require(`../ABI/${tokenTitle}${suffix}.json`);
}

module.exports = { CONTRACTS, getContract, getContractAddress, loadAbi };
