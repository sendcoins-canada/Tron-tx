/**
 * Core orchestrator — the main send flow for multi-network crypto transfers.
 *
 * sendCrypto({ userApiKey, recipientAddress, amount, coin, network, ip, device })
 *
 * Strategies:
 *   DIRECT_SEND  — user's on-chain wallet sends directly
 *   MASTER_SEND  — master wallet sends, deduct from user's DB balance
 */
const config = require('../config');
const queries = require('../db/queries');
const { validateAddress } = require('../utils/addressValidator');
const { getTokenBalance } = require('./balanceService');
const { ensureGas } = require('./fundingService');
const { sendToken } = require('./transferService');
const { deductBalance } = require('./lockService');
const { SUPPORTED_COINS } = require('../config/networks');
const logger = require('../utils/logger');

/**
 * Main entry point for sending crypto.
 */
async function sendCrypto({
  userApiKey,
  recipientAddress,
  amount,
  coin,
  network,
  ip,
  device,
  userEmail,
  recipientName,
  note,
}) {
  const normalizedCoin = coin.toUpperCase();
  const normalizedNetwork = network.toLowerCase();
  let transferRef = null;
  let strategy = null;

  if (!SUPPORTED_COINS.includes(normalizedCoin)) {
    return { success: false, error: `Unsupported coin: ${normalizedCoin}` };
  }

  try {
    // ─── 1. VALIDATE USER ─────────────────────────────────────
    const user = await queries.getUserByApiKey(userApiKey);
    if (!user) {
      return { success: false, error: 'User not found' };
    }
    logger.info(`User found: ${user.user_email}, ban=${user.account_ban}`);
    if (user.account_ban === 'true' || user.account_ban === true) {
      return { success: false, error: 'Account is suspended' };
    }

    const email = userEmail || user.user_email;

    // ─── 2. VALIDATE ADDRESS ──────────────────────────────────
    const addrCheck = validateAddress(recipientAddress, normalizedNetwork);
    if (!addrCheck.valid) {
      return { success: false, error: addrCheck.error };
    }

    // ─── 3. GET ALL WALLET INSTANCES ──────────────────────────
    const instances = await queries.getWalletInstances(normalizedCoin, userApiKey);
    if (!instances.length) {
      return { success: false, error: `No ${normalizedCoin} wallet found for this user` };
    }
    logger.info(`Found ${instances.length} ${normalizedCoin} wallet instance(s)`);

    // ─── 4. FIND TARGET NETWORK WALLET ────────────────────────
    const targetWallet = instances.find(
      (w) => w.network && w.network.toLowerCase() === normalizedNetwork
    );

    // ─── 5. DETERMINE STRATEGY ────────────────────────────────
    // Compute DB available first (no I/O) before hitting the chain
    let lockWallet = instances[0];
    let dbAvailable = 0;

    for (const inst of instances) {
      const total = parseFloat(inst.total_balance) || 0;
      const locked = parseFloat(inst.locked_amount) || 0;
      const avail = total - locked;
      if (avail > dbAvailable) {
        dbAvailable = avail;
        lockWallet = inst;
      }
    }

    // Only fetch on-chain balance if DB balance is insufficient
    let onChainBalance = 0;
    if (targetWallet && dbAvailable < amount) {
      let tronWeb = null;
      if (normalizedNetwork === 'trc20') {
        const { createTronWeb } = require('./tronClient');
        tronWeb = createTronWeb(
          config.TRON_NETWORK,
          config.MASTER_WALLET_TRON_PRIVATE_KEY,
          config.TRON_PRO_API_KEY
        );
      }

      const balResult = await getTokenBalance(
        normalizedNetwork,
        normalizedCoin,
        targetWallet.wallet_address,
        tronWeb
      );
      onChainBalance = balResult.balance;
      logger.info(`On-chain ${normalizedCoin} balance (${normalizedNetwork}): ${onChainBalance}`);
    }

    if (targetWallet && onChainBalance >= amount) {
      strategy = 'DIRECT_SEND';
    } else if (dbAvailable >= amount) {
      strategy = 'MASTER_SEND';
    } else {
      return {
        success: false,
        error: `Insufficient ${normalizedCoin} balance. Available: ${Math.max(dbAvailable, onChainBalance).toFixed(6)}, Required: ${amount}`,
      };
    }
    logger.info(`Strategy: ${strategy} (DB=${dbAvailable}, onChain=${onChainBalance}, amount=${amount})`);

    // ─── 6. CREATE TRANSFER RECORD ────────────────────────────
    const transfer = await queries.createTransfer({
      userApiKey,
      userEmail: email,
      asset: normalizedCoin,
      network: normalizedNetwork,
      amount,
      walletAddress: recipientAddress,
      recipientName: recipientName || 'External recipient',
      note: note || null,
      metadata: { strategy, origin: 'crypto-engine' },
      ip,
      device,
    });
    transferRef = transfer.reference;
    logger.info(`Transfer record created: ref=${transferRef}`);

    // ─── 7. EXECUTE ───────────────────────────────────────────

    let txid;

    if (strategy === 'DIRECT_SEND') {
      const privateKey = await queries.getPrivateKeyByHash(targetWallet.hash);
      if (!privateKey) {
        throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });
      }

      const gasResult = await ensureGas(normalizedNetwork, targetWallet.wallet_address);

      if (gasResult.funded) {
        await queries.updateTransferStatus(transferRef, 'pending', {
          gasFunded: true,
          gasAmount: gasResult.amount,
          gasTxid: gasResult.txid,
        });
        logger.info('Waiting 3s for gas funding confirmation...');
        await new Promise((r) => setTimeout(r, 3000));
      }

      const result = await sendToken(normalizedNetwork, normalizedCoin, privateKey, recipientAddress, amount);
      txid = result.txid;

      // Deduct from user's DB balance to keep in sync with on-chain
      await deductBalance(userApiKey, normalizedCoin, amount, lockWallet.network).catch((err) => {
        logger.warn(`DB deduct after DIRECT_SEND failed (non-critical): ${err.message}`);
      });

    } else {
      // MASTER_SEND: Send from master → then deduct user's DB balance
      const masterKey = getMasterKey(normalizedNetwork);
      logger.info(`MASTER_SEND: sending ${amount} ${normalizedCoin} → ${recipientAddress}`);

      const result = await sendToken(normalizedNetwork, normalizedCoin, masterKey, recipientAddress, amount);
      txid = result.txid;

      // Deduct the amount from the wallet that holds the balance
      const lockNetwork = lockWallet.network || normalizedNetwork;
      try {
        await deductBalance(userApiKey, normalizedCoin, amount, lockNetwork);
      } catch (deductErr) {
        // CRITICAL: On-chain transfer succeeded but DB deduction failed
        logger.error(`CRITICAL: Sent ${amount} ${normalizedCoin} but deduct failed. Ref: ${transferRef}. ${deductErr.message}`);
        await queries.updateTransferStatus(transferRef, 'completed_unreconciled', {
          txid,
          strategy,
          deductError: deductErr.message,
        }).catch(() => {});
        return { success: true, txid, reference: transferRef, strategy, warning: 'Balance deduction failed — flagged for reconciliation' };
      }
    }

    // ─── 8. UPDATE TRANSFER STATUS ────────────────────────────
    await queries.updateTransferStatus(transferRef, 'completed', { txid, strategy });

    logger.success(`Transfer complete! TXID: ${txid} | Ref: ${transferRef}`);
    return { success: true, txid, reference: transferRef, strategy };

  } catch (err) {
    // ─── 9. HANDLE ERROR ──────────────────────────────────────
    logger.error(`Transfer failed: ${err.message} (code: ${err.code || 'N/A'})`);

    if (transferRef) {
      await queries.updateTransferStatus(transferRef, 'failed', {
        error: err.message,
        code: err.code,
      }).catch(() => {});
    }

    return {
      success: false,
      error: err.message,
      code: err.code,
      reference: transferRef,
    };
  }
}

/**
 * Get master wallet private key for a network.
 */
function getMasterKey(network) {
  const keys = {
    trc20: config.MASTER_WALLET_TRON_PRIVATE_KEY,
    bep20: config.MASTER_WALLET_BSC_PRIVATE_KEY,
    erc20: config.MASTER_WALLET_ETH_PRIVATE_KEY,
  };
  const key = keys[network.toLowerCase()];
  if (!key) throw new Error(`No master wallet key configured for ${network}`);
  return key;
}

module.exports = { sendCrypto };
