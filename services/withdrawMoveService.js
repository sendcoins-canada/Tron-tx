'use strict';

/**
 * withdrawMoveService.js
 *
 * Handles the crypto leg of a crypto-to-NGN withdrawal:
 * moves the user's crypto to the platform master wallet.
 *
 * Called exclusively by POST /api/withdraw-move (server.js).
 * All NGN credit logic lives in the sendcoins backend — never here.
 *
 * Strategies (mirror of walletService.sendCrypto):
 *   ON_CHAIN_WITHDRAW — user has enough on-chain; send directly to master wallet
 *   HYBRID_WITHDRAW   — on-chain has some, DB covers the rest; reclaim on-chain + deduct DB
 *   DB_WITHDRAW       — user has 0 on-chain; pure DB debit, no blockchain TX
 *
 * Export: executeWithdrawMove({ userApiKey, coin, network, amount, withdrawalReference, idempotencyKey })
 */

const config  = require('../config');
const queries = require('../db/queries');
const { getTokenBalance }                  = require('./balanceService');
const { ensureGas }                        = require('./fundingService');
const { sendToken }                        = require('./transferService');
const { lockBalance, unlockBalance, deductBalance } = require('./lockService');
const { SUPPORTED_COINS }                  = require('../config/networks');
const logger                               = require('../utils/logger');

// ─── Master wallet helpers ────────────────────────────────────────────────────
// getMasterAddress / getMasterKey are not exported from walletService, so we
// replicate the same ternary maps here rather than changing walletService's API.

function getMasterAddress(network) {
  const addresses = {
    trc20: config.MASTER_WALLET_TRON_ADDRESS,
    bep20: config.MASTER_WALLET_BSC_ADDRESS,
    erc20: config.MASTER_WALLET_ETH_ADDRESS,
  };
  return addresses[network] || null;
}

function getMasterKey(network) {
  const keys = {
    trc20: config.MASTER_WALLET_TRON_PRIVATE_KEY,
    bep20: config.MASTER_WALLET_BSC_PRIVATE_KEY,
    erc20: config.MASTER_WALLET_ETH_PRIVATE_KEY,
  };
  const key = keys[network];
  if (!key) throw Object.assign(new Error(`No master wallet key configured for ${network}`), { code: 'MASTER_WALLET_NOT_CONFIGURED' });
  return key;
}

// ─── sendToken result normalisation ──────────────────────────────────────────
// TRC20 returns { txid, result: true, fee }
// EVM    returns { txid, result: 1|0 }

function assertSendSuccess(result, context) {
  if (result.result === true || result.result === 1) return;
  throw Object.assign(
    new Error(`sendToken returned non-success result during ${context}: ${JSON.stringify(result)}`),
    { code: 'SEND_FAILED' }
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Execute a withdrawal move: debit the user's crypto and deliver it to the
 * platform master wallet via the most appropriate strategy.
 *
 * @param {Object} params
 * @param {string} params.userApiKey
 * @param {string} params.coin               'USDT' | 'USDC' (case-insensitive)
 * @param {string} params.network            'trc20' | 'bep20' | 'erc20' (case-insensitive)
 * @param {number} params.amount             Positive number — net crypto to move (no platform fee here)
 * @param {string} params.withdrawalReference The sendcoins withdrawal.reference — stored in metadata for correlation
 * @param {string} params.idempotencyKey     Caller-supplied dedup key — must be unique per withdrawal attempt
 *
 * @returns {Object} {
 *   success, strategy,
 *   onchainTxHash, onchainAmount, dbDebitAmount,
 *   transferReference,   ← simulator's wallet_transfers.reference
 *   withdrawalReference, ← echoed back for correlation
 *   idempotent?,         ← true if this was a duplicate request
 * }
 */
async function executeWithdrawMove({ userApiKey, coin, network, amount, withdrawalReference, idempotencyKey }) {
  // ─── 1. INPUT VALIDATION ─────────────────────────────────────
  const errors = [];
  if (!userApiKey || typeof userApiKey !== 'string' || !userApiKey.trim())      errors.push('userApiKey is required');
  if (!coin       || typeof coin       !== 'string' || !coin.trim())            errors.push('coin is required');
  if (!network    || typeof network    !== 'string' || !network.trim())         errors.push('network is required');
  if (amount == null || typeof amount !== 'number' || !isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
  if (!withdrawalReference || typeof withdrawalReference !== 'string' || !withdrawalReference.trim()) errors.push('withdrawalReference is required');
  if (!idempotencyKey      || typeof idempotencyKey      !== 'string' || !idempotencyKey.trim())      errors.push('idempotencyKey is required');

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.code = 'VALIDATION_ERROR';
    err.errors = errors;
    throw err;
  }

  const normalizedCoin    = coin.toUpperCase();
  const normalizedNetwork = network.toLowerCase();

  if (!SUPPORTED_COINS.includes(normalizedCoin)) {
    throw Object.assign(new Error(`Unsupported coin: ${normalizedCoin}`), { code: 'UNSUPPORTED_COIN' });
  }
  if (!['trc20', 'bep20', 'erc20'].includes(normalizedNetwork)) {
    throw Object.assign(new Error(`Unsupported network: ${normalizedNetwork}`), { code: 'UNSUPPORTED_NETWORK' });
  }

  logger.info(`═══ withdrawMove START — ${amount} ${normalizedCoin} (${normalizedNetwork}), withdrawalRef=${withdrawalReference} ═══`);

  // ─── 2. IDEMPOTENCY CHECK ────────────────────────────────────
  const existing = await queries.findByIdempotencyKey(idempotencyKey, userApiKey);
  if (existing) {
    logger.info(`[withdrawMove] Idempotency hit: key=${idempotencyKey}, ref=${existing.reference}, status=${existing.status}`);
    const meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});

    if (existing.status === 'completed') {
      return {
        success:             true,
        strategy:            meta.strategy || null,
        onchainTxHash:       existing.tx_hash || null,
        onchainAmount:       meta.onchainAmount ?? 0,
        dbDebitAmount:       meta.dbDebitAmount ?? 0,
        transferReference:   existing.reference,
        withdrawalReference: meta.withdrawalReference || withdrawalReference,
        idempotent:          true,
      };
    }

    if (existing.status === 'failed') {
      return {
        success:             false,
        error:               meta.error || 'Withdrawal move previously failed',
        code:                meta.code  || 'EXECUTION_FAILED',
        transferReference:   existing.reference,
        withdrawalReference: meta.withdrawalReference || withdrawalReference,
        idempotent:          true,
      };
    }

    // status === 'pending' — another request is mid-flight
    return {
      success:             false,
      error:               'Withdrawal move already in progress',
      code:                'IN_FLIGHT',
      transferReference:   existing.reference,
      withdrawalReference,
      idempotent:          true,
    };
  }

  // ─── 3. USER + WALLET LOOKUP ─────────────────────────────────
  const user = await queries.getUserByApiKey(userApiKey);
  if (!user) {
    throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
  }
  if (user.account_ban === 'true' || user.account_ban === true) {
    throw Object.assign(new Error('Account is suspended'), { code: 'ACCOUNT_BANNED' });
  }

  const wallet = await queries.getWalletByNetwork(normalizedCoin, userApiKey, normalizedNetwork);
  if (!wallet) {
    throw Object.assign(
      new Error(`No ${normalizedCoin} wallet found for this user on ${normalizedNetwork}`),
      { code: 'WALLET_NOT_FOUND' }
    );
  }

  // ─── 4. BALANCE CHECK ────────────────────────────────────────
  const dbTotal     = parseFloat(wallet.total_balance) || 0;
  const dbLockd     = parseFloat(wallet.locked_amount) || 0;
  const dbAvailable = dbTotal - dbLockd;
  logger.info(`[withdrawMove] DB balance: total=${dbTotal}, locked=${dbLockd}, available=${dbAvailable}`);

  // On-chain balance (trc20 requires a tronWeb instance for the contract call)
  let tronWeb = null;
  if (normalizedNetwork === 'trc20') {
    const { createTronWeb } = require('./tronClient');
    tronWeb = createTronWeb(config.TRON_NETWORK, config.MASTER_WALLET_TRON_PRIVATE_KEY, config.TRON_PRO_API_KEY);
  }
  const balResult     = await getTokenBalance(normalizedNetwork, normalizedCoin, wallet.wallet_address, tronWeb);
  const onChainBalance = balResult.balance;
  logger.info(`[withdrawMove] On-chain balance: ${onChainBalance} ${normalizedCoin}`);

  const totalAvailable = dbAvailable + onChainBalance;
  logger.info(`[withdrawMove] Total available: ${totalAvailable} (DB=${dbAvailable} + onChain=${onChainBalance}), need=${amount}`);

  if (amount > totalAvailable) {
    throw Object.assign(
      new Error(
        `Insufficient ${normalizedCoin} balance. Available: ${totalAvailable.toFixed(6)}, Required: ${amount}`
      ),
      { code: 'INSUFFICIENT_BALANCE' }
    );
  }

  // ─── 5. STRATEGY DECISION ────────────────────────────────────
  let strategy;
  if (onChainBalance >= amount) {
    strategy = 'ON_CHAIN_WITHDRAW';
  } else if (onChainBalance > 0) {
    strategy = 'HYBRID_WITHDRAW';
  } else {
    strategy = 'DB_WITHDRAW';
  }
  logger.info(`[withdrawMove] Strategy: ${strategy}`);

  // ─── 6. MASTER WALLET VALIDATION ─────────────────────────────
  // DB_WITHDRAW never touches the master wallet, but we still validate it is
  // configured for the ON_CHAIN and HYBRID paths before creating the DB record.
  if (strategy !== 'DB_WITHDRAW') {
    const masterAddress = getMasterAddress(normalizedNetwork);
    if (!masterAddress) {
      throw Object.assign(
        new Error(`Master wallet address not configured for ${normalizedNetwork}`),
        { code: 'MASTER_WALLET_NOT_CONFIGURED' }
      );
    }
  }

  // ─── 7. CREATE wallet_transfers RECORD (pending) ─────────────
  // omit reference — let createTransfer generate it via createRandomString(24)
  // Store withdrawalReference + idempotencyKey inside metadata for correlation + dedup.
  const transfer = await queries.createTransfer({
    userApiKey,
    walletAddress:  wallet.wallet_address,
    recipientName:  'Platform Master Wallet',
    asset:          normalizedCoin,
    network:        normalizedNetwork,
    amount,
    status:         'pending',
    metadata: {
      type:                'withdrawal_move',
      withdrawalReference,
      idempotencyKey,
      strategy,
    },
  });
  const transferReference = transfer.reference;
  logger.info(`[withdrawMove] Transfer record created: ref=${transferReference}`);

  // ─── 8. EXECUTE STRATEGY ─────────────────────────────────────
  let dbLocked    = false;
  let dbLockAmount = 0;

  try {

    // ── DB_WITHDRAW ───────────────────────────────────────────
    if (strategy === 'DB_WITHDRAW') {
      logger.info(`[DB_WITHDRAW] Locking ${amount} ${normalizedCoin} in DB`);
      const lockResult = await lockBalance(userApiKey, normalizedCoin, normalizedNetwork, amount);
      if (!lockResult.success) {
        throw Object.assign(new Error(lockResult.response?.message || 'Lock failed'), { code: 'LOCK_FAILED' });
      }
      dbLocked     = true;
      dbLockAmount = amount;

      await queries.updateTransferStatus(transferReference, 'pending', {
        lockedAt: new Date().toISOString(),
      });

      logger.info(`[DB_WITHDRAW] Deducting ${amount} ${normalizedCoin} from DB`);
      await deductBalance(userApiKey, normalizedCoin, amount, normalizedNetwork);
      dbLocked = false;

      await queries.updateTransferStatus(transferReference, 'completed', {
        strategy,
        dbDebitAmount: amount,
        onchainAmount: 0,
        completedAt:   new Date().toISOString(),
      });

      logger.info(`[DB_WITHDRAW] Complete — ref=${transferReference}`);
      return {
        success:             true,
        strategy:            'DB_WITHDRAW',
        onchainTxHash:       null,
        onchainAmount:       0,
        dbDebitAmount:       amount,
        transferReference,
        withdrawalReference,
      };
    }

    // ── ON_CHAIN_WITHDRAW ─────────────────────────────────────
    if (strategy === 'ON_CHAIN_WITHDRAW') {
      const masterAddress = getMasterAddress(normalizedNetwork);

      logger.info(`[ON_CHAIN_WITHDRAW] Ensuring gas for ${wallet.wallet_address}`);
      const gasResult = await ensureGas(normalizedNetwork, wallet.wallet_address);
      if (gasResult.funded) {
        logger.info(`[ON_CHAIN_WITHDRAW] Gas funded: ${gasResult.amount} → ${wallet.wallet_address}, txid=${gasResult.txid}`);
        await queries.updateTransferStatus(transferReference, 'pending', {
          gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid,
        });
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        logger.info(`[ON_CHAIN_WITHDRAW] Gas sufficient`);
      }

      const privateKey = await queries.getPrivateKeyByHash(wallet.hash);
      if (!privateKey) {
        throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });
      }

      logger.info(`[ON_CHAIN_WITHDRAW] Sending ${amount} ${normalizedCoin} → master (${masterAddress})`);
      const result = await sendToken(normalizedNetwork, normalizedCoin, privateKey, masterAddress, amount);
      assertSendSuccess(result, 'ON_CHAIN_WITHDRAW');

      logger.info(`[ON_CHAIN_WITHDRAW] TX confirmed: ${result.txid}`);
      await queries.updateTransferStatus(transferReference, 'completed', {
        strategy,
        txid:          result.txid,
        onchainAmount: amount,
        dbDebitAmount: 0,
        completedAt:   new Date().toISOString(),
      });

      logger.info(`[ON_CHAIN_WITHDRAW] Complete — ref=${transferReference}, txid=${result.txid}`);
      return {
        success:             true,
        strategy:            'ON_CHAIN_WITHDRAW',
        onchainTxHash:       result.txid,
        onchainAmount:       amount,
        dbDebitAmount:       0,
        transferReference,
        withdrawalReference,
      };
    }

    // ── HYBRID_WITHDRAW ───────────────────────────────────────
    // on-chain has some (< amount), DB covers the rest
    {
      const dbPortion     = amount - onChainBalance;
      const masterAddress = getMasterAddress(normalizedNetwork);

      logger.info(`[HYBRID_WITHDRAW] onChain=${onChainBalance}, dbPortion=${dbPortion}, total=${amount}`);

      // Lock DB portion first
      logger.info(`[HYBRID_WITHDRAW] Locking ${dbPortion} ${normalizedCoin} in DB`);
      const lockResult = await lockBalance(userApiKey, normalizedCoin, normalizedNetwork, dbPortion);
      if (!lockResult.success) {
        throw Object.assign(new Error(lockResult.response?.message || 'Lock failed'), { code: 'LOCK_FAILED' });
      }
      dbLocked     = true;
      dbLockAmount = dbPortion;

      // Ensure gas for reclaim TX
      logger.info(`[HYBRID_WITHDRAW] Ensuring gas for ${wallet.wallet_address}`);
      const gasResult = await ensureGas(normalizedNetwork, wallet.wallet_address);
      if (gasResult.funded) {
        logger.info(`[HYBRID_WITHDRAW] Gas funded: ${gasResult.amount} → ${wallet.wallet_address}`);
        await queries.updateTransferStatus(transferReference, 'pending', {
          gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid,
        });
        await new Promise((r) => setTimeout(r, 3000));
      }

      const privateKey = await queries.getPrivateKeyByHash(wallet.hash);
      if (!privateKey) {
        throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });
      }

      // Move on-chain portion from user wallet → master
      logger.info(`[HYBRID_WITHDRAW] Reclaiming ${onChainBalance} ${normalizedCoin}: user → master (${masterAddress})`);
      const result = await sendToken(normalizedNetwork, normalizedCoin, privateKey, masterAddress, onChainBalance);
      assertSendSuccess(result, 'HYBRID_WITHDRAW reclaim');

      logger.info(`[HYBRID_WITHDRAW] Reclaim TX: ${result.txid}`);
      await queries.updateTransferStatus(transferReference, 'pending', {
        strategy,
        txid:          result.txid,
        onchainAmount: onChainBalance,
        reclaimTxid:   result.txid,
      });

      // Wait for reclaim to land before recording deduct
      await new Promise((r) => setTimeout(r, 3000));

      // Deduct DB portion
      logger.info(`[HYBRID_WITHDRAW] Deducting ${dbPortion} ${normalizedCoin} from DB`);
      await deductBalance(userApiKey, normalizedCoin, dbPortion, normalizedNetwork);
      dbLocked = false;

      await queries.updateTransferStatus(transferReference, 'completed', {
        strategy,
        onchainAmount: onChainBalance,
        dbDebitAmount: dbPortion,
        completedAt:   new Date().toISOString(),
      });

      logger.info(`[HYBRID_WITHDRAW] Complete — ref=${transferReference}, txid=${result.txid}`);
      return {
        success:             true,
        strategy:            'HYBRID_WITHDRAW',
        onchainTxHash:       result.txid,
        onchainAmount:       onChainBalance,
        dbDebitAmount:       dbPortion,
        transferReference,
        withdrawalReference,
      };
    }

  } catch (err) {
    // ─── ERROR ROLLBACK ───────────────────────────────────────
    logger.error(`[withdrawMove] FAILED — ${err.message} (code: ${err.code || 'N/A'})`);

    if (dbLocked && dbLockAmount > 0) {
      try {
        await unlockBalance(userApiKey, normalizedCoin, dbLockAmount, normalizedNetwork);
        logger.info(`[withdrawMove] Unlocked ${dbLockAmount} ${normalizedCoin} from DB`);
      } catch (unlockErr) {
        logger.error(`[withdrawMove] Unlock failed: ${unlockErr.message}`);
      }
    }

    if (transferReference) {
      await queries.updateTransferStatus(transferReference, 'failed', {
        error: err.message,
        code:  err.code,
      }).catch(() => {});
    }

    throw err; // re-throw — handler in server.js builds the HTTP response
  }
}

module.exports = { executeWithdrawMove };
