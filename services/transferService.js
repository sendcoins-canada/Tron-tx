const { createTronWeb } = require('./tronClient');
const { createWeb3 } = require('./evmClient');
const { getContract, getContractAddress, loadAbi } = require('../config/contracts');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Send TRC20 tokens using triggerSmartContract.
 * Waits for on-chain confirmation before returning success.
 */
async function sendTrc20(tronWeb, toAddress, amount, contractAddress, feeLimit = 10_000_000) {
  const fromAddress = tronWeb.defaultAddress.base58;
  const fromHex = tronWeb.address.toHex(fromAddress);
  const tokenAmount = Math.round(amount * 1e6);

  logger.info(`[sendTrc20] ════════════════════════════════════════════`);
  logger.info(`[sendTrc20] From:     ${fromAddress}`);
  logger.info(`[sendTrc20] FromHex:  ${fromHex}`);
  logger.info(`[sendTrc20] To:       ${toAddress}`);
  logger.info(`[sendTrc20] Contract: ${contractAddress}`);
  logger.info(`[sendTrc20] Amount:   ${amount} (raw: ${tokenAmount})`);
  logger.info(`[sendTrc20] FeeLimit: ${feeLimit} SUN (${feeLimit / 1e6} TRX)`);
  logger.info(`[sendTrc20] TronWeb fullNode: ${tronWeb.fullNode?.host || 'unknown'}`);
  logger.info(`[sendTrc20] ════════════════════════════════════════════`);

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
    logger.error(`[sendTrc20] triggerSmartContract FAILED`);
    logger.error(`[sendTrc20] Response: ${JSON.stringify(tx, null, 2)}`);
    throw Object.assign(
      new Error(`triggerSmartContract failed: ${JSON.stringify(tx)}`),
      { code: 'CONTRACT_CALL_FAILED' }
    );
  }
  logger.info(`[sendTrc20] triggerSmartContract OK — txID: ${tx.transaction?.txID?.substring(0, 16)}...`);

  logger.info(`[sendTrc20] Signing transaction...`);
  const signedTx = await tronWeb.trx.sign(tx.transaction);
  logger.info(`[sendTrc20] Signed. Broadcasting...`);
  const receipt = await tronWeb.trx.sendRawTransaction(signedTx);

  if (!receipt.result) {
    const errMsg = receipt.message
      ? Buffer.from(receipt.message, 'hex').toString()
      : JSON.stringify(receipt);

    logger.error(`[sendTrc20] Broadcast FAILED`);
    logger.error(`[sendTrc20] Error message: ${errMsg}`);
    logger.error(`[sendTrc20] Full receipt: ${JSON.stringify(receipt)}`);
    if (errMsg.toLowerCase().includes('account resource insufficient')) {
      throw Object.assign(new Error(errMsg), { code: 'RESOURCE_INSUFFICIENT' });
    }
    throw Object.assign(new Error(`Broadcast failed: ${errMsg}`), { code: 'BROADCAST_FAILED' });
  }

  logger.info(`[sendTrc20] Broadcast accepted! TXID: ${receipt.txid}`);
  logger.info(`[sendTrc20] Waiting for on-chain confirmation...`);

  // Broadcast success != execution success on TRON — must verify on-chain
  const txInfo = await waitForConfirmation(tronWeb, receipt.txid);

  logger.info(`[sendTrc20] On-chain receipt: ${JSON.stringify(txInfo.receipt || {})}`);
  if (txInfo.receipt && txInfo.receipt.result !== 'SUCCESS') {
    const reason = txInfo.receipt.result || 'UNKNOWN';
    logger.error(`[sendTrc20] ON-CHAIN EXECUTION FAILED`);
    logger.error(`[sendTrc20] Result: ${reason}`);
    logger.error(`[sendTrc20] Energy used: ${txInfo.receipt.energy_usage_total || 0}, Bandwidth: ${txInfo.receipt.net_usage || 0}`);
    logger.error(`[sendTrc20] Energy fee: ${txInfo.receipt.energy_fee || 0} SUN, Net fee: ${txInfo.receipt.net_fee || 0} SUN`);
    throw Object.assign(
      new Error(`Transaction confirmed but failed on-chain: ${reason}`),
      { code: 'ON_CHAIN_FAILED', txid: receipt.txid, onChainResult: reason }
    );
  }

  const energyFee = (txInfo.receipt?.energy_fee || 0) / 1e6;
  const netFee = (txInfo.receipt?.net_fee || 0) / 1e6;
  const totalFeeTrx = energyFee + netFee;
  logger.success(`[sendTrc20] Transfer confirmed on-chain! TXID: ${receipt.txid}`);
  logger.info(`[sendTrc20] Energy used: ${txInfo.receipt?.energy_usage_total || 0}, Bandwidth: ${txInfo.receipt?.net_usage || 0}`);
  logger.info(`[sendTrc20] Fee: ${totalFeeTrx.toFixed(2)} TRX (energy=${energyFee.toFixed(2)}, bandwidth=${netFee.toFixed(2)})`);
  return { txid: receipt.txid, result: true, fee: totalFeeTrx };
}

/**
 * Poll getTransactionInfo until the tx is confirmed on-chain.
 * TRON blocks are ~3s, so we check immediately then poll every 2s up to 30s.
 */
async function waitForConfirmation(tronWeb, txid, maxAttempts = 30, intervalMs = 2000) {
  // Give the network a moment to process before first check
  await new Promise((r) => setTimeout(r, 3000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const info = await tronWeb.trx.getTransactionInfo(txid);
    if (info && info.id) {
      logger.info(`[confirmation] Confirmed on attempt ${attempt} (block: ${info.blockNumber})`);
      return info;
    }

    logger.info(`[confirmation] Attempt ${attempt}/${maxAttempts} — not yet confirmed, waiting ${intervalMs}ms...`);
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  throw Object.assign(
    new Error(`Transaction ${txid} not confirmed after ${(maxAttempts * intervalMs / 1000) + 3}s`),
    { code: 'CONFIRMATION_TIMEOUT', txid }
  );
}

/**
 * Send ERC20 or BEP20 tokens on an EVM chain.
 */
async function sendErc20({ network, privateKey, toAddress, amount, token }) {
  const web3 = createWeb3(network);
  const contractInfo = getContract(network, token);
  const abi = loadAbi(network, token);
  const contract = new web3.eth.Contract(abi, contractInfo.address);

  const tokenAmount = contractInfo.web3Unit
    ? web3.utils.toWei(String(amount), contractInfo.web3Unit)
    : String(Math.round(amount * Math.pow(10, contractInfo.decimals)));

  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const account = web3.eth.accounts.privateKeyToAccount(pk);
  const fromAddress = account.address;

  logger.info(`EVM send: ${amount} ${token} (${network}) from ${fromAddress} → ${toAddress}`);

  const data = contract.methods.transfer(toAddress, tokenAmount).encodeABI();

  let gasLimit;
  try {
    gasLimit = await web3.eth.estimateGas({ from: fromAddress, to: contractInfo.address, data });
    gasLimit = Math.ceil(gasLimit * 1.2);
  } catch {
    gasLimit = network === 'bep20' ? 100000 : 65000;
  }

  const nonce = await web3.eth.getTransactionCount(fromAddress, 'pending');
  const gasPrice = await web3.eth.getGasPrice();

  const tx = {
    from: fromAddress,
    to: contractInfo.address,
    data,
    gas: gasLimit,
    gasPrice,
    nonce,
  };

  const signed = await account.signTransaction(tx);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  const txid = receipt.transactionHash;
  logger.success(`Transfer sent! TXID: ${txid}`);
  return { txid, result: receipt.status };
}

/**
 * Send tokens on any supported network.
 */
async function sendToken(network, token, privateKey, toAddress, amount, opts = {}) {
  const net = network.toLowerCase();
  logger.info(`[sendToken] network=${net}, token=${token}, to=${toAddress}, amount=${amount}`);
  logger.info(`[sendToken] TRON_NETWORK=${config.TRON_NETWORK}, keyPrefix=${privateKey?.substring(0, 8)}...`);

  if (net === 'trc20') {
    const tronWeb = opts.tronWeb || createTronWeb(
      config.TRON_NETWORK,
      privateKey,
      config.TRON_PRO_API_KEY
    );
    const contractAddr = getContractAddress(config.TRON_NETWORK, token);
    logger.info(`[sendToken] Resolved contract for ${token} on ${config.TRON_NETWORK}: ${contractAddr}`);
    logger.info(`[sendToken] Fee limit: ${opts.feeLimit || config.FEE_LIMIT} SUN (${(opts.feeLimit || config.FEE_LIMIT) / 1e6} TRX)`);
    return sendTrc20(tronWeb, toAddress, amount, contractAddr, opts.feeLimit || config.FEE_LIMIT);
  }

  return sendErc20({ network: net, privateKey, toAddress, amount, token });
}

module.exports = { sendTrc20, sendErc20, sendToken };
