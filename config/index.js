const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED_VARS = [
  'TRON_NETWORK',
  'TRON_PRO_API_KEY',
  'MASTER_WALLET_PRIVATE_KEY',
  'MASTER_WALLET_ADDRESS',
  'SENDER_WALLET_PRIVATE_KEY',
  'SENDER_WALLET_ADDRESS',
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  console.error('\nCopy .env.example to .env and fill in all values.');
  process.exit(1);
}

const config = Object.freeze({
  TRON_NETWORK: process.env.TRON_NETWORK,
  TRON_PRO_API_KEY: process.env.TRON_PRO_API_KEY,
  MASTER_WALLET_PRIVATE_KEY: process.env.MASTER_WALLET_PRIVATE_KEY,
  MASTER_WALLET_ADDRESS: process.env.MASTER_WALLET_ADDRESS,
  SENDER_WALLET_PRIVATE_KEY: process.env.SENDER_WALLET_PRIVATE_KEY,
  SENDER_WALLET_ADDRESS: process.env.SENDER_WALLET_ADDRESS,
  MIN_TRX_FOR_GAS: Number(process.env.MIN_TRX_FOR_GAS) || 35,
  FEE_LIMIT: Number(process.env.FEE_LIMIT) || 10_000_000,
});

module.exports = config;
