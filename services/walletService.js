/**
 * Core orchestrator — the main send flow for multi-network crypto transfers.
 *
 * sendCrypto({ userApiKey, recipientAddress, amount, coin, network, ip, device })
 *
 * Strategies:
 *   DIRECT_SEND  — user's on-chain wallet has enough, sends directly to recipient
 *   HYBRID_SEND  — on-chain + DB cover it: reclaim on-chain to master, master sends full amount
 *   MASTER_SEND  — user has 0 on-chain, DB covers it: master sends directly to recipient
 */
const config = require('../config');
const queries = require('../db/queries');
const { validateAddress } = require('../utils/addressValidator');
const { getTokenBalance } = require('./balanceService');
const { ensureGas } = require('./fundingService');
const { sendToken } = require('./transferService');
const { lockBalance, unlockBalance, deductBalance } = require('./lockService');
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
  idempotencyKey,
}) {
  const normalizedCoin = coin.toUpperCase();
  const normalizedNetwork = network.toLowerCase();
  logger.info(`═══ sendCrypto START — ${amount} ${normalizedCoin} (${normalizedNetwork}) → ${recipientAddress} ═══`);
  let transferRef = null;
  let strategy = null;
  let reclaimTxid = null;
  let dbLocked = false;
  let dbLockAmount = 0;

  // ─── 0. IDEMPOTENCY CHECK ─────────────────────────────────
  if (idempotencyKey) {
    const existing = await queries.findByIdempotencyKey(idempotencyKey, userApiKey);
    if (existing) {
      logger.info(`Idempotency hit: key=${idempotencyKey}, ref=${existing.reference}, status=${existing.status}`);
      const meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});

      if (existing.status === 'completed') {
        return {
          success: true,
          txid: existing.tx_hash,
          reference: existing.reference,
          strategy: meta.strategy,
          network: existing.network,
          coin: existing.asset,
          amount: parseFloat(existing.amount),
          recipientAddress: existing.recipient_wallet_address,
          idempotent: true,
        };
      }
      if (existing.status === 'failed') {
        return {
          success: false,
          error: meta.error || 'Transfer previously failed',
          code: meta.code,
          reference: existing.reference,
          idempotent: true,
        };
      }
      return {
        success: false,
        error: 'Transfer is already in progress',
        code: 'TRANSFER_IN_PROGRESS',
        reference: existing.reference,
        idempotent: true,
      };
    }
  }

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
    if (!targetWallet) {
      logger.error(`No ${normalizedCoin} wallet on ${normalizedNetwork} — cannot proceed`);
      return { success: false, error: `No ${normalizedCoin} wallet found on ${normalizedNetwork} network.` };
    }
    logger.info(`Target wallet: ${targetWallet.wallet_address} (wallet_id=${targetWallet.wallet_id})`);

    // ─── 5. GET BOTH BALANCES ─────────────────────────────────
    // DB balance (from naira conversions — ledger entry, not on-chain)
    const dbTotal = parseFloat(targetWallet.total_balance) || 0;
    const dbLockd = parseFloat(targetWallet.locked_amount) || 0;
    const dbAvailable = dbTotal - dbLockd;
    logger.info(`DB balance: total=${dbTotal}, locked=${dbLockd}, available=${dbAvailable}`);

    // On-chain balance (actual USDT in blockchain wallet)
    let onChainBalance = 0;
    let tronWeb = null;
    if (normalizedNetwork === 'trc20') {
      const { createTronWeb } = require('./tronClient');
      tronWeb = createTronWeb(config.TRON_NETWORK, config.MASTER_WALLET_TRON_PRIVATE_KEY, config.TRON_PRO_API_KEY);
    }
    const balResult = await getTokenBalance(normalizedNetwork, normalizedCoin, targetWallet.wallet_address, tronWeb);
    onChainBalance = balResult.balance;
    logger.info(`On-chain balance: ${onChainBalance} ${normalizedCoin}`);

    // ─── 6. DETERMINE STRATEGY ────────────────────────────────
    const totalAvailable = dbAvailable + onChainBalance;
    logger.info(`Total available: ${totalAvailable} (DB=${dbAvailable} + onChain=${onChainBalance}), need=${amount}`);

    if (totalAvailable < amount) {
      logger.error(`Insufficient balance — total=${totalAvailable}, required=${amount}`);
      return {
        success: false,
        error: `Insufficient ${normalizedCoin} balance. Available: ${totalAvailable.toFixed(2)}, Required: ${amount}`,
      };
    }

    if (onChainBalance >= amount) {
      strategy = 'DIRECT_SEND';
    } else if (onChainBalance > 0) {
      strategy = 'HYBRID_SEND';
    } else {
      strategy = 'MASTER_SEND';
    }
    logger.info(`Strategy: ${strategy} (DB=${dbAvailable}, onChain=${onChainBalance}, amount=${amount})`);

    // ─── 7. CREATE TRANSFER RECORD ────────────────────────────
    const transfer = await queries.createTransfer({
      userApiKey,
      userEmail: email,
      asset: normalizedCoin,
      network: normalizedNetwork,
      amount,
      walletAddress: recipientAddress,
      recipientName: recipientName || 'External recipient',
      note: note || null,
      metadata: { strategy, origin: 'crypto-engine', dbAvailable, onChainBalance, ...(idempotencyKey && { idempotencyKey }) },
      ip,
      device,
    });
    transferRef = transfer.reference;
    logger.info(`Transfer record created: ref=${transferRef}`);

    // ─── 8. EXECUTE ───────────────────────────────────────────
    let txid;

    if (strategy === 'DIRECT_SEND') {
      // ──────────────────────────────────────────────────────────
      // DIRECT_SEND: on-chain covers full amount
      // User wallet → recipient. No DB involvement.
      // ──────────────────────────────────────────────────────────
      logger.info(`[DIRECT_SEND] Sending ${amount} ${normalizedCoin} from user wallet → ${recipientAddress}`);

      const privateKey = await queries.getPrivateKeyByHash(targetWallet.hash);
      if (!privateKey) throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });

      // Fund gas
      const gasResult = await ensureGas(normalizedNetwork, targetWallet.wallet_address);
      if (gasResult.funded) {
        logger.info(`[DIRECT_SEND] Gas funded: ${gasResult.amount} TRX → ${targetWallet.wallet_address}`);
        await queries.updateTransferStatus(transferRef, 'pending', { gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid });
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        logger.info(`[DIRECT_SEND] Gas sufficient (${gasResult.balance} TRX)`);
      }

      // Send from user wallet → recipient
      const result = await sendToken(normalizedNetwork, normalizedCoin, privateKey, recipientAddress, amount);
      txid = result.txid;
      logger.info(`[DIRECT_SEND] Sent! TXID: ${txid}`);

    } else if (strategy === 'HYBRID_SEND') {
      // ──────────────────────────────────────────────────────────
      // HYBRID_SEND: on-chain has some, DB covers the rest
      // 1. Lock DB portion
      // 2. Reclaim user's on-chain → master
      // 3. Master sends full amount → recipient
      // 4. Deduct DB portion
      // ──────────────────────────────────────────────────────────
      dbLockAmount = amount - onChainBalance;
      logger.info(`[HYBRID_SEND] Starting — onChain=${onChainBalance}, dbNeeded=${dbLockAmount}, total=${amount}`);

      // Lock DB portion
      const lockResult = await lockBalance(userApiKey, normalizedCoin, normalizedNetwork, dbLockAmount);
      if (!lockResult.success) {
        throw Object.assign(new Error(lockResult.response.message), { code: 'LOCK_FAILED' });
      }
      dbLocked = true;
      logger.info(`[HYBRID_SEND] Locked ${dbLockAmount} ${normalizedCoin} in DB`);

      // Get user private key for reclaim
      const privateKey = await queries.getPrivateKeyByHash(targetWallet.hash);
      if (!privateKey) throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });

      // Fund gas for reclaim tx
      const gasResult = await ensureGas(normalizedNetwork, targetWallet.wallet_address);
      if (gasResult.funded) {
        logger.info(`[HYBRID_SEND] Gas funded: ${gasResult.amount} TRX → ${targetWallet.wallet_address}`);
        await queries.updateTransferStatus(transferRef, 'pending', { gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid });
        await new Promise((r) => setTimeout(r, 3000));
      }

      // Reclaim: send user's on-chain balance → master wallet
      const masterAddress = config.MASTER_WALLET_TRON_ADDRESS;
      logger.info(`[HYBRID_SEND] Reclaiming ${onChainBalance} ${normalizedCoin}: user wallet → master (${masterAddress})`);
      const reclaimResult = await sendToken(normalizedNetwork, normalizedCoin, privateKey, masterAddress, onChainBalance);
      reclaimTxid = reclaimResult.txid;
      logger.info(`[HYBRID_SEND] Reclaim sent! TXID: ${reclaimTxid}`);
      await queries.updateTransferStatus(transferRef, 'pending', { reclaimTxid, reclaimAmount: onChainBalance, strategy });

      // Wait for reclaim confirmation (safety — must land before master sends)
      logger.info(`[HYBRID_SEND] Waiting 3s for reclaim confirmation...`);
      await new Promise((r) => setTimeout(r, 3000));

      // Master sends full amount → recipient
      const masterKey = getMasterKey(normalizedNetwork);
      logger.info(`[HYBRID_SEND] Master sending ${amount} ${normalizedCoin} → ${recipientAddress}`);
      const sendResult = await sendToken(normalizedNetwork, normalizedCoin, masterKey, recipientAddress, amount);
      txid = sendResult.txid;
      logger.info(`[HYBRID_SEND] Sent! TXID: ${txid}`);

      // Deduct DB portion
      logger.info(`[HYBRID_SEND] Deducting ${dbLockAmount} ${normalizedCoin} from DB`);
      await deductBalance(userApiKey, normalizedCoin, dbLockAmount, normalizedNetwork);
      dbLocked = false;
      logger.info(`[HYBRID_SEND] DB deduction complete`);

    } else {
      // ──────────────────────────────────────────────────────────
      // MASTER_SEND: on-chain = 0, DB covers full amount
      // Master sends directly to recipient. No user wallet involvement.
      // ──────────────────────────────────────────────────────────
      dbLockAmount = amount;
      logger.info(`[MASTER_SEND] Starting — dbAvailable=${dbAvailable}, amount=${amount}`);

      // Lock full amount in DB
      const lockResult = await lockBalance(userApiKey, normalizedCoin, normalizedNetwork, dbLockAmount);
      if (!lockResult.success) {
        throw Object.assign(new Error(lockResult.response.message), { code: 'LOCK_FAILED' });
      }
      dbLocked = true;
      logger.info(`[MASTER_SEND] Locked ${dbLockAmount} ${normalizedCoin} in DB`);

      // Check master has enough
      const masterKey = getMasterKey(normalizedNetwork);
      const masterAddress = config.MASTER_WALLET_TRON_ADDRESS;
      let masterTronWeb = null;
      if (normalizedNetwork === 'trc20') {
        const { createTronWeb } = require('./tronClient');
        masterTronWeb = createTronWeb(config.TRON_NETWORK, masterKey, config.TRON_PRO_API_KEY);
      }
      const masterBal = await getTokenBalance(normalizedNetwork, normalizedCoin, masterAddress, masterTronWeb);
      logger.info(`[MASTER_SEND] Master balance: ${masterBal.balance} ${normalizedCoin}`);

      if (masterBal.balance < amount) {
        throw Object.assign(
          new Error(`Master wallet has ${masterBal.balance} ${normalizedCoin} but needs ${amount}`),
          { code: 'MASTER_INSUFFICIENT_BALANCE' }
        );
      }

      // Master sends directly to recipient
      logger.info(`[MASTER_SEND] Sending ${amount} ${normalizedCoin} → ${recipientAddress}`);
      const result = await sendToken(normalizedNetwork, normalizedCoin, masterKey, recipientAddress, amount);
      txid = result.txid;
      logger.info(`[MASTER_SEND] Sent! TXID: ${txid}`);

      // Deduct from DB
      logger.info(`[MASTER_SEND] Deducting ${dbLockAmount} ${normalizedCoin} from DB`);
      await deductBalance(userApiKey, normalizedCoin, dbLockAmount, normalizedNetwork);
      dbLocked = false;
      logger.info(`[MASTER_SEND] DB deduction complete`);
    }

    // ─── 9. UPDATE TRANSFER STATUS & BUILD RESPONSE ────────────
    const net = config.TRON_NETWORK || 'mainnet';
    const explorerBase = net === 'mainnet' ? 'https://tronscan.org' : `https://${net}.tronscan.org`;
    const txUrl = (id) => `${explorerBase}/#/transaction/${id}`;

    const response = {
      success: true,
      txid,
      explorerUrl: txUrl(txid),
      reference: transferRef,
      strategy,
      network: normalizedNetwork,
      coin: normalizedCoin,
      amount,
      recipientAddress,
    };

    if (reclaimTxid) {
      response.reclaimTxid = reclaimTxid;
      response.reclaimExplorerUrl = txUrl(reclaimTxid);
    }

    await queries.updateTransferStatus(transferRef, 'completed', {
      txid,
      explorerUrl: txUrl(txid),
      strategy,
      reclaimTxid: reclaimTxid || undefined,
      reclaimExplorerUrl: reclaimTxid ? txUrl(reclaimTxid) : undefined,
    });

    logger.success(`═══ sendCrypto COMPLETE — strategy=${strategy}, TXID=${txid}, ref=${transferRef}${reclaimTxid ? ', reclaimTxid=' + reclaimTxid : ''} ═══`);
    logger.info(`Explorer: ${txUrl(txid)}`);
    if (reclaimTxid) logger.info(`Reclaim Explorer: ${txUrl(reclaimTxid)}`);

    // ─── 10. CHECK IF RECIPIENT IS INTERNAL ──────────────────────
    let recipientWallet = null;
    try {
      recipientWallet = await queries.findWalletOwnerByAddress(normalizedCoin, recipientAddress, normalizedNetwork);
      if (recipientWallet && recipientWallet.user_api_key === userApiKey) {
        recipientWallet = null; // self-send, treat as external
      }
    } catch (_) {}

    if (recipientWallet) {
      response.isInternal = true;
    }

    // Fire-and-forget: record receive for internal recipients
    if (recipientWallet) {
      recordInternalReceive({
        recipientAddress,
        senderApiKey: userApiKey,
        senderAddress: strategy === 'DIRECT_SEND' ? targetWallet.wallet_address : getMasterAddress(normalizedNetwork),
        coin: normalizedCoin,
        network: normalizedNetwork,
        amount,
        txid,
        sendReference: transferRef,
        recipientWallet,
      }).catch(() => {});
    }

    return response;

  } catch (err) {
    // ─── 10. HANDLE ERROR + ROLLBACK ────────────────────────────
    logger.error(`═══ sendCrypto FAILED — ${err.message} (code: ${err.code || 'N/A'}) ═══`);

    // Unlock DB if we locked it
    if (dbLocked && dbLockAmount > 0) {
      try {
        await unlockBalance(userApiKey, normalizedCoin, dbLockAmount, normalizedNetwork);
        logger.info(`[ROLLBACK] Unlocked ${dbLockAmount} ${normalizedCoin} in DB`);
      } catch (unlockErr) {
        logger.error(`[ROLLBACK] Failed to unlock: ${unlockErr.message}`);
      }
    }

    if (transferRef) {
      await queries.updateTransferStatus(transferRef, 'failed', {
        error: err.message,
        code: err.code,
        reclaimTxid: reclaimTxid || undefined,
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
 * Record a receive transaction for an internal (platform-to-platform) transfer.
 * Fire-and-forget — errors are logged but never thrown.
 */
async function recordInternalReceive({
  recipientAddress, senderApiKey, senderAddress,
  coin, network, amount, txid, sendReference,
  recipientWallet: prefetched,
}) {
  try {
    const recipientWallet = prefetched || await queries.findWalletOwnerByAddress(coin, recipientAddress, network);
    if (!recipientWallet) return;
    if (recipientWallet.user_api_key === senderApiKey) return;

    const existing = await queries.findReceiveBySendReference(sendReference, recipientWallet.user_api_key);
    if (existing) {
      logger.info(`[RECEIVE] Already recorded ref=${existing.reference} for sendRef=${sendReference}`);
      return;
    }

    const receive = await queries.createTransfer({
      userApiKey: recipientWallet.user_api_key,
      walletAddress: recipientAddress,
      recipientName: null,
      asset: coin,
      network,
      amount,
      status: 'completed',
      txHash: txid,
      metadata: {
        type: 'receive',
        senderAddress,
        senderApiKeyPrefix: senderApiKey.substring(0, 8),
        sendReference,
      },
    });
    logger.info(`[RECEIVE] ref=${receive.reference} for user ${recipientWallet.user_api_key.substring(0, 8)}...`);
  } catch (err) {
    logger.error(`[RECEIVE] Failed: ${err.message}`);
  }
}

/**
 * Get master wallet address for a network.
 */
function getMasterAddress(network) {
  const addresses = {
    trc20: config.MASTER_WALLET_TRON_ADDRESS,
    bep20: config.MASTER_WALLET_BSC_ADDRESS,
    erc20: config.MASTER_WALLET_ETH_ADDRESS,
  };
  return addresses[network.toLowerCase()] || null;
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
