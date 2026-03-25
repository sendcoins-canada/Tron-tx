const { createTronWeb } = require('./tronClient');
const { getTrxBalance } = require('./balanceService');
const logger = require('../utils/logger');

/**
 * Check if a user wallet has enough TRX for gas, and fund it from the master wallet if not.
 * Ported from sendTron.js:18-25 (transactionBuilder.sendTrx pattern).
 *
 * @param {object} opts
 * @param {string} opts.network          - mainnet | shasta | nile
 * @param {string} opts.apiKey           - TronGrid API key
 * @param {string} opts.masterPrivateKey - Master wallet private key
 * @param {string} opts.masterAddress    - Master wallet address
 * @param {string} opts.userAddress      - User wallet to fund
 * @param {number} opts.minTrx           - Minimum TRX required (default 35)
 */
async function checkAndFundGas({ network, apiKey, masterPrivateKey, masterAddress, userAddress, minTrx = 35 }) {
  // 1. Check user's current TRX balance
  const masterTronWeb = createTronWeb(network, masterPrivateKey, apiKey);
  const userBalance = await getTrxBalance(masterTronWeb, userAddress);

  logger.info(`User TRX balance: ${userBalance.balance} TRX`);

  if (userBalance.balance >= minTrx) {
    logger.success(`Sufficient gas — ${userBalance.balance} TRX >= ${minTrx} TRX minimum`);
    return { funded: false, reason: 'sufficient', balance: userBalance.balance };
  }

  // 2. Calculate deficit with 2 TRX buffer
  const deficit = minTrx - userBalance.balance + 2;
  logger.warn(`Gas insufficient. Need ${deficit} TRX (deficit + 2 TRX buffer)`);

  // 3. Check master wallet has enough
  const masterBalance = await getTrxBalance(masterTronWeb, masterAddress);
  if (masterBalance.balance < deficit + 1) {
    throw Object.assign(
      new Error(`Master wallet too low: ${masterBalance.balance} TRX, need ${deficit + 1} TRX`),
      { code: 'MASTER_WALLET_LOW' }
    );
  }

  // 4. Send TRX from master → user
  const sunAmount = Math.ceil(deficit * 1e6);
  logger.info(`Funding ${deficit} TRX from master → ${userAddress}...`);

  const tx = await masterTronWeb.transactionBuilder.sendTrx(
    userAddress,
    sunAmount,
    masterAddress
  );
  const signedTx = await masterTronWeb.trx.sign(tx, masterPrivateKey);
  const receipt = await masterTronWeb.trx.sendRawTransaction(signedTx);

  if (!receipt.result) {
    throw Object.assign(
      new Error(`Funding transaction failed: ${JSON.stringify(receipt)}`),
      { code: 'FUNDING_FAILED' }
    );
  }

  logger.success(`Funded! TXID: ${receipt.txid}`);

  return {
    funded: true,
    txid: receipt.txid,
    amount: deficit,
    previousBalance: userBalance.balance,
  };
}

module.exports = { checkAndFundGas };
