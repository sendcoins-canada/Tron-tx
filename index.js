/**
 * Programmatic API entry point for the crypto-tx-engine.
 *
 * Usage from sendcoins backend:
 *   const engine = require('../tron-tx-simulator');
 *   const result = await engine.sendCrypto({ userApiKey, recipientAddress, amount, coin, network });
 */
const { sendCrypto } = require('./services/walletService');
const { SUPPORTED_NETWORKS, SUPPORTED_COINS } = require('./config/networks');
const { getTokenBalance, getNativeBalance } = require('./services/balanceService');
const { validateAddress } = require('./utils/addressValidator');

module.exports = {
  sendCrypto,
  getTokenBalance,
  getNativeBalance,
  validateAddress,
  SUPPORTED_NETWORKS,
  SUPPORTED_COINS,
};
