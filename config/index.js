const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Only required for programmatic (DB-backed) mode
const DB_VARS = ['DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD'];

// Only required for CLI mode with direct private keys
const CLI_VARS = ['SENDER_WALLET_PRIVATE_KEY', 'SENDER_WALLET_ADDRESS'];

// Always required
const CORE_VARS = ['TRON_NETWORK', 'TRON_PRO_API_KEY'];

// Validate based on mode — warn but don't exit for optional groups
const missingCore = CORE_VARS.filter((v) => !process.env[v]);
if (missingCore.length > 0) {
  console.error(`Missing required environment variables:\n  ${missingCore.join('\n  ')}`);
  console.error('\nCopy .env.example to .env and fill in all values.');
  process.exit(1);
}

const config = {
  // Tron
  TRON_NETWORK: process.env.TRON_NETWORK,
  TRON_PRO_API_KEY: process.env.TRON_PRO_API_KEY,
  MASTER_WALLET_TRON_PRIVATE_KEY: process.env.MASTER_WALLET_TRON_PRIVATE_KEY || process.env.MASTER_WALLET_PRIVATE_KEY,
  MASTER_WALLET_TRON_ADDRESS: process.env.MASTER_WALLET_TRON_ADDRESS || process.env.MASTER_WALLET_ADDRESS,
  MIN_TRX_FOR_GAS: Number(process.env.MIN_TRX_FOR_GAS) || 35,
  FEE_LIMIT: Number(process.env.FEE_LIMIT) || 10_000_000,

  // BSC
  BSC_RPC_URL: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
  MASTER_WALLET_BSC_PRIVATE_KEY: process.env.MASTER_WALLET_BSC_PRIVATE_KEY,
  MASTER_WALLET_BSC_ADDRESS: process.env.MASTER_WALLET_BSC_ADDRESS,
  MIN_BNB_FOR_GAS: Number(process.env.MIN_BNB_FOR_GAS) || 0.005,

  // Ethereum
  ETH_RPC_URL: process.env.ETH_RPC_URL,
  MASTER_WALLET_ETH_PRIVATE_KEY: process.env.MASTER_WALLET_ETH_PRIVATE_KEY,
  MASTER_WALLET_ETH_ADDRESS: process.env.MASTER_WALLET_ETH_ADDRESS,
  MIN_ETH_FOR_GAS: Number(process.env.MIN_ETH_FOR_GAS) || 0.01,

  // Database (same as sendcoins)
  DB_USER: process.env.DB_USER,
  DB_HOST: process.env.DB_HOST,
  DB_NAME: process.env.DB_NAME,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_PORT: Number(process.env.DB_PORT) || 5432,

  // CLI-only (optional)
  SENDER_WALLET_PRIVATE_KEY: process.env.SENDER_WALLET_PRIVATE_KEY,
  SENDER_WALLET_ADDRESS: process.env.SENDER_WALLET_ADDRESS,

  /**
   * Check if DB config is present (needed for programmatic mode).
   */
  hasDbConfig() {
    return DB_VARS.every((v) => process.env[v]);
  },

  /**
   * Check if CLI sender config is present.
   */
  hasCliConfig() {
    return CLI_VARS.every((v) => process.env[v]);
  },

  // Legacy aliases for backward compat with existing CLI code
  get MASTER_WALLET_PRIVATE_KEY() { return this.MASTER_WALLET_TRON_PRIVATE_KEY; },
  get MASTER_WALLET_ADDRESS() { return this.MASTER_WALLET_TRON_ADDRESS; },
};

Object.freeze(config);

module.exports = config;
