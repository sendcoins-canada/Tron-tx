const { createTronWeb } = require('./tronClient');
const { getTrxBalance, getEvmNativeBalance } = require('./balanceService');
const { createWeb3 } = require('./evmClient');
const { getNetwork } = require('../config/networks');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Check if a user wallet has enough TRX for gas, and fund from master if not.
 */
async function checkAndFundTrxGas({ network, apiKey, masterPrivateKey, masterAddress, userAddress, minTrx = 35 }) {
  logger.info(`[GAS] ════════════════════════════════════════════`);
  logger.info(`[GAS] Check & Fund TRX Gas`);
  logger.info(`[GAS] Network:       ${network}`);
  logger.info(`[GAS] Master addr:   ${masterAddress}`);
  logger.info(`[GAS] Master key:    ${masterPrivateKey?.substring(0, 8)}...`);
  logger.info(`[GAS] User addr:     ${userAddress}`);
  logger.info(`[GAS] Min TRX:       ${minTrx}`);
  logger.info(`[GAS] API key:       ${apiKey?.substring(0, 8)}...`);
  logger.info(`[GAS] ════════════════════════════════════════════`);

  const masterTronWeb = createTronWeb(network, masterPrivateKey, apiKey);
  logger.info(`[GAS] TronWeb fullNode: ${masterTronWeb.fullNode?.host || 'unknown'}`);

  const [masterBal, userBalance] = await Promise.all([
    getTrxBalance(masterTronWeb, masterAddress),
    getTrxBalance(masterTronWeb, userAddress),
  ]);
  logger.info(`[GAS] Master TRX balance: ${masterBal.balance} TRX`);
  logger.info(`[GAS] User TRX balance:   ${userBalance.balance} TRX`);
  logger.info(`[GAS] Minimum required:   ${minTrx} TRX`);

  if (userBalance.balance >= minTrx) {
    logger.success(`[GAS] Sufficient — ${userBalance.balance} TRX >= ${minTrx} TRX. No funding needed.`);
    return { funded: false, reason: 'sufficient', balance: userBalance.balance };
  }

  const deficit = minTrx - userBalance.balance;
  logger.warn(`[GAS] INSUFFICIENT — user has ${userBalance.balance}, needs ${minTrx}, deficit=${deficit} TRX`);

  if (masterBal.balance < deficit) {
    throw Object.assign(
      new Error(`Master wallet too low: ${masterBal.balance} TRX, need ${deficit} TRX`),
      { code: 'MASTER_WALLET_LOW' }
    );
  }

  const sunAmount = Math.ceil(deficit * 1e6);
  logger.info(`[GAS] Sending ${deficit} TRX (${sunAmount} SUN) from master → ${userAddress}`);

  logger.info(`[GAS] Building sendTrx transaction...`);
  const tx = await masterTronWeb.transactionBuilder.sendTrx(userAddress, sunAmount, masterAddress);
  logger.info(`[GAS] Transaction built. Signing...`);
  const signedTx = await masterTronWeb.trx.sign(tx, masterPrivateKey);
  logger.info(`[GAS] Signed. Broadcasting...`);
  const receipt = await masterTronWeb.trx.sendRawTransaction(signedTx);

  if (!receipt.result) {
    logger.error(`[GAS] Funding broadcast FAILED`);
    logger.error(`[GAS] Receipt: ${JSON.stringify(receipt)}`);
    if (receipt.message) {
      logger.error(`[GAS] Message: ${Buffer.from(receipt.message, 'hex').toString()}`);
    }
    throw Object.assign(
      new Error(`Funding transaction failed: ${JSON.stringify(receipt)}`),
      { code: 'FUNDING_FAILED' }
    );
  }

  logger.success(`[GAS] Funded! TXID: ${receipt.txid}`);
  logger.info(`[GAS] Explorer: https://shasta.tronscan.org/#/transaction/${receipt.txid}`);
  return { funded: true, txid: receipt.txid, amount: deficit, previousBalance: userBalance.balance };
}

/**
 * Check if user has enough native gas (BNB/ETH) and fund from master if not.
 */
async function checkAndFundEvmGas({ network, masterPrivateKey, masterAddress, userAddress, minGas }) {
  const web3 = createWeb3(network);
  const netInfo = getNetwork(network);
  const threshold = minGas || netInfo.gasThreshold;
  const nativeToken = netInfo.nativeToken;

  const userBal = await getEvmNativeBalance(network, userAddress);
  logger.info(`User ${nativeToken} balance: ${userBal.balance}`);

  if (userBal.balance >= threshold) {
    return { funded: false, reason: 'sufficient', balance: userBal.balance };
  }

  const deficit = threshold - userBal.balance;
  logger.warn(`Gas insufficient. Need ${deficit} ${nativeToken}`);

  const masterBal = await getEvmNativeBalance(network, masterAddress);
  if (masterBal.balance < deficit) {
    throw Object.assign(
      new Error(`Master ${nativeToken} wallet too low: ${masterBal.balance}, need ${deficit}`),
      { code: 'MASTER_WALLET_LOW' }
    );
  }

  const weiAmount = web3.utils.toWei(String(deficit), 'ether');

  const account = web3.eth.accounts.privateKeyToAccount(
    masterPrivateKey.startsWith('0x') ? masterPrivateKey : '0x' + masterPrivateKey
  );

  const nonce = await web3.eth.getTransactionCount(masterAddress, 'pending');
  const gasPrice = await web3.eth.getGasPrice();

  const tx = {
    from: masterAddress,
    to: userAddress,
    value: weiAmount,
    gas: 21000,
    gasPrice,
    nonce,
  };

  const signed = await account.signTransaction(tx);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  logger.success(`Funded! TXID: ${receipt.transactionHash}`);
  return {
    funded: true,
    txid: receipt.transactionHash,
    amount: deficit,
    previousBalance: userBal.balance,
  };
}

/**
 * Ensure a user address has enough gas on any supported network.
 */
async function ensureGas(network, userAddress) {
  const net = network.toLowerCase();

  if (net === 'trc20') {
    return checkAndFundTrxGas({
      network: config.TRON_NETWORK,
      apiKey: config.TRON_PRO_API_KEY,
      masterPrivateKey: config.MASTER_WALLET_TRON_PRIVATE_KEY,
      masterAddress: config.MASTER_WALLET_TRON_ADDRESS,
      userAddress,
      minTrx: config.MIN_TRX_FOR_GAS,
    });
  }

  if (net === 'bep20') {
    return checkAndFundEvmGas({
      network: 'bep20',
      masterPrivateKey: config.MASTER_WALLET_BSC_PRIVATE_KEY,
      masterAddress: config.MASTER_WALLET_BSC_ADDRESS,
      userAddress,
      minGas: config.MIN_BNB_FOR_GAS,
    });
  }

  if (net === 'erc20') {
    return checkAndFundEvmGas({
      network: 'erc20',
      masterPrivateKey: config.MASTER_WALLET_ETH_PRIVATE_KEY,
      masterAddress: config.MASTER_WALLET_ETH_ADDRESS,
      userAddress,
      minGas: config.MIN_ETH_FOR_GAS,
    });
  }

  throw new Error(`Unsupported network for gas funding: ${network}`);
}

// Legacy alias — used by simulator/index.js CLI mode
const checkAndFundGas = checkAndFundTrxGas;

module.exports = { checkAndFundGas, checkAndFundTrxGas, checkAndFundEvmGas, ensureGas };
