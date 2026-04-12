/**
 * External deposit detection via TronGrid polling.
 * Called by the /api/cron/check-deposits endpoint every 15 minutes.
 *
 * Flow:
 *   1. For each active wallet address (USDT + USDC on TRC20)
 *   2. Query TronGrid for incoming transfers in the last 30 minutes
 *   3. Dedup by on-chain transaction_id
 *   4. Record new deposits + credit wallet balance
 */

const axios = require('axios');
const config = require('../config');
const { getContractAddress } = require('../config/contracts');
const queries = require('../db/queries');
const logger = require('./logger');

const TRONGRID_BASE = config.TRON_NETWORK === 'mainnet'
  ? 'https://api.trongrid.io'
  : 'https://api.shasta.trongrid.io';

const LOOKBACK_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch recent incoming TRC20 transfers for a wallet address.
 * @param {string} address - Tron wallet address
 * @param {string} contractAddress - TRC20 token contract
 * @returns {Array} raw TronGrid transfer objects
 */
async function fetchIncomingTransfers(address, contractAddress) {
  const minTimestamp = Date.now() - LOOKBACK_MS;

  const resp = await axios.get(`${TRONGRID_BASE}/v1/accounts/${address}/transactions/trc20`, {
    params: {
      limit: 50,
      contract_address: contractAddress,
      only_confirmed: true,
      min_timestamp: minTimestamp,
    },
    headers: { 'TRON-PRO-API-KEY': config.TRON_PRO_API_KEY },
    timeout: 10000,
  });

  const data = resp.data?.data;
  if (!Array.isArray(data)) return [];

  // Only incoming transfers (to == this wallet address)
  return data.filter((tx) => tx.to === address);
}

/**
 * Process all new incoming deposits for a single wallet.
 * Returns the number of new deposits recorded.
 */
async function processWalletDeposits(wallet, coin, contractAddress) {
  let recorded = 0;

  let incoming;
  try {
    incoming = await fetchIncomingTransfers(wallet.wallet_address, contractAddress);
  } catch (err) {
    logger.warn(`[DEPOSIT] TronGrid fetch failed for ${wallet.wallet_address}: ${err.message}`);
    return 0;
  }

  for (const tx of incoming) {
    const txHash = tx.transaction_id;
    if (!txHash) continue;

    // Dedup — skip if already recorded
    const existing = await queries.findTransferByExternalTxHash(txHash);
    if (existing) continue;

    const decimals = tx.token_info?.decimals ?? 6;
    const amount = parseInt(tx.value, 10) / Math.pow(10, decimals);

    if (!amount || amount <= 0) continue;

    logger.info(`[DEPOSIT] New deposit: ${amount} ${coin} for ${wallet.user_api_key} — txid=${txHash}`);

    // Record in wallet_transfers
    await queries.createTransfer({
      userApiKey: wallet.user_api_key,
      recipientName: wallet.user_email || null,
      walletAddress: wallet.wallet_address,
      asset: coin.toUpperCase(),
      network: 'trc20',
      amount,
      status: 'completed',
      note: 'External deposit detected by cron',
      txHash,
      metadata: {
        type: 'receive',
        externalTxHash: txHash,
        senderAddress: tx.from,
        blockTimestamp: tx.block_timestamp,
        detectedAt: Date.now(),
      },
    });

    // Credit wallet balance
    await queries.creditWalletBalance(coin, wallet.user_api_key, 'trc20', amount);

    recorded++;
  }

  return recorded;
}

/**
 * Main entry point — process deposits for all USDT + USDC TRC20 wallets.
 * Called by the cron endpoint.
 */
async function processDeposits() {
  const coins = ['usdt', 'usdc'];
  const stats = { checked: 0, depositsFound: 0, errors: 0 };

  for (const coin of coins) {
    let wallets;
    try {
      wallets = await queries.getActiveWallets(coin, 'trc20');
    } catch (err) {
      logger.error(`[DEPOSIT] Failed to fetch ${coin} wallets: ${err.message}`);
      stats.errors++;
      continue;
    }

    const contractAddress = getContractAddress(config.TRON_NETWORK, coin.toUpperCase());
    logger.info(`[DEPOSIT] Checking ${wallets.length} ${coin.toUpperCase()} wallets (contract: ${contractAddress})`);

    for (const wallet of wallets) {
      if (!wallet.wallet_address) continue;

      // Small delay to avoid rate limiting on TronGrid free tier
      await new Promise((r) => setTimeout(r, 200));

      const found = await processWalletDeposits(wallet, coin, contractAddress);
      stats.checked++;
      stats.depositsFound += found;
    }
  }

  logger.info(`[DEPOSIT] Cron complete: checked=${stats.checked}, found=${stats.depositsFound}, errors=${stats.errors}`);
  return stats;
}

module.exports = { processDeposits };
