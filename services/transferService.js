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

  logger.info(`TRC20 send: ${amount} (${tokenAmount} raw) from ${fromAddress} → ${toAddress}, contract: ${contractAddress}`);

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

    logger.error(`Broadcast failed: ${errMsg}`);
    if (errMsg.toLowerCase().includes('account resource insufficient')) {
      throw Object.assign(new Error(errMsg), { code: 'RESOURCE_INSUFFICIENT' });
    }
    throw Object.assign(new Error(`Broadcast failed: ${errMsg}`), { code: 'BROADCAST_FAILED' });
  }

  logger.info(`Broadcast accepted: ${receipt.txid}. Waiting for on-chain confirmation...`);

  // Broadcast success != execution success on TRON — must verify on-chain
  const txInfo = await waitForConfirmation(tronWeb, receipt.txid);

  if (txInfo.receipt && txInfo.receipt.result !== 'SUCCESS') {
    const reason = txInfo.receipt.result || 'UNKNOWN';
    logger.error(`On-chain execution failed: ${reason} (energy: ${txInfo.receipt.energy_usage_total || 0})`);
    throw Object.assign(
      new Error(`Transaction confirmed but failed on-chain: ${reason}`),
      { code: 'ON_CHAIN_FAILED', txid: receipt.txid, onChainResult: reason }
    );
  }

  logger.success(`Transfer confirmed on-chain! TXID: ${receipt.txid}`);
  return { txid: receipt.txid, result: true };
}

/**
 * Poll getTransactionInfo until the tx is confirmed on-chain.
 * TRON blocks are ~3s, so we check immediately then poll every 2s up to 30s.
 */
async function waitForConfirmation(tronWeb, txid, maxAttempts = 15, intervalMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const info = await tronWeb.trx.getTransactionInfo(txid);
    if (info && info.id) {
      logger.info(`Confirmed on attempt ${attempt} (block: ${info.blockNumber})`);
      return info;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  throw Object.assign(
    new Error(`Transaction ${txid} not confirmed after ${maxAttempts * intervalMs / 1000}s`),
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

  if (net === 'trc20') {
    const tronWeb = opts.tronWeb || createTronWeb(
      config.TRON_NETWORK,
      privateKey,
      config.TRON_PRO_API_KEY
    );
    const contractAddr = getContractAddress(config.TRON_NETWORK, token);
    return sendTrc20(tronWeb, toAddress, amount, contractAddr, opts.feeLimit || config.FEE_LIMIT);
  }

  return sendErc20({ network: net, privateKey, toAddress, amount, token });
}

module.exports = { sendTrc20, sendErc20, sendToken };
