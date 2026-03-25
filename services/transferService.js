const logger = require('../utils/logger');

/**
 * Send TRC20 tokens using triggerSmartContract.
 * Ported from sendTrc20.js:64-76.
 *
 * @param {TronWeb} tronWeb         - TronWeb instance (with sender's private key)
 * @param {string}  toAddress       - Recipient address
 * @param {number}  amount          - Amount in token units (e.g. 10 USDT)
 * @param {string}  contractAddress - TRC20 contract address
 * @param {number}  feeLimit        - Fee limit in SUN (default 10_000_000)
 * @returns {{ txid: string, result: boolean }}
 */
async function sendTrc20(tronWeb, toAddress, amount, contractAddress, feeLimit = 10_000_000) {
  const fromAddress = tronWeb.defaultAddress.base58;
  const fromHex = tronWeb.address.toHex(fromAddress);

  logger.info(`Sending ${amount} tokens → ${toAddress}`);
  logger.info(`Contract: ${contractAddress}`);
  logger.info(`Fee limit: ${feeLimit} SUN (${feeLimit / 1e6} TRX)`);

  const tokenAmount = Math.round(amount * 1e6);

  const tx = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    'transfer(address,uint256)',
    { feeLimit, callValue: 0 },
    [
      { type: 'address', value: toAddress },
      { type: 'uint256', value: tokenAmount },
    ],
    fromHex
  );

  if (!tx.result || !tx.result.result) {
    throw Object.assign(
      new Error(`triggerSmartContract failed: ${JSON.stringify(tx)}`),
      { code: 'CONTRACT_CALL_FAILED' }
    );
  }

  const signedTx = await tronWeb.trx.sign(tx.transaction);
  const receipt = await tronWeb.trx.sendRawTransaction(signedTx);

  if (!receipt.result) {
    const errMsg = receipt.message
      ? Buffer.from(receipt.message, 'hex').toString()
      : JSON.stringify(receipt);

    // Detect resource insufficient error for auto-retry
    if (errMsg.toLowerCase().includes('account resource insufficient')) {
      throw Object.assign(new Error(errMsg), { code: 'RESOURCE_INSUFFICIENT' });
    }
    throw Object.assign(new Error(`Broadcast failed: ${errMsg}`), { code: 'BROADCAST_FAILED' });
  }

  logger.success(`Transfer sent! TXID: ${receipt.txid}`);
  return { txid: receipt.txid, result: true };
}

module.exports = { sendTrc20 };
