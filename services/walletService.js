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
const btcClient = require('./bitcoinClient');
const logger = require('../utils/logger');
const { recordFee, notifySuperAdmin } = require('../utils/platformService');
const { sendCryptoTransferEmail, sendBtcTransferInitiatedEmail, sendAdminInsufficientBalanceEmail } = require('../utils/mailService');
const { getBtcUsdPrice } = require('../utils/priceService');
const { getSetting } = require('../utils/settingsService');

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
  preGeneratedReference,
}) {
  const normalizedCoin = coin.toUpperCase();
  const normalizedNetwork = network.toLowerCase();
  logger.info(`═══ sendCrypto START — ${amount} ${normalizedCoin} (${normalizedNetwork}) → ${recipientAddress} ═══`);
  let transferRef = null;
  let strategy = null;
  let reclaimTxid = null;
  let feeTxid = null;
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

  const isBtc = normalizedCoin === 'BTC' && normalizedNetwork === 'btc';
  let minSend;
  if (isBtc) {
    const btcMinUsd = await getSetting('btc_min_send_usd', 10);
    const btcPrice = await getBtcUsdPrice();
    minSend = parseFloat((btcMinUsd / btcPrice).toFixed(8));
    logger.info(`[BTC MIN] $${btcMinUsd} USD / $${btcPrice} BTC price = ${minSend} BTC minimum`);
  } else {
    minSend = 5;
  }
  if (amount < minSend) {
    return {
      success: false,
      error: isBtc
        ? `Minimum send amount is $10 worth of BTC (currently ${minSend} BTC)`
        : `Minimum send amount is ${minSend} ${normalizedCoin}`,
      code: 'MINIMUM_NOT_MET',
    };
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

    const isVerified = user.verify_user === '1' || user.verify_user === 1;
    // BTC limits are in BTC (not USD like USDT/USDC)
    const maxSendAmount = isBtc
      ? (config.BTC_MAX_SEND || 1.0)   // default 1 BTC max per tx
      : (isVerified ? 10000 : 5000);    // USDT/USDC in token units

    if (amount > maxSendAmount) {
      if (!isVerified && !isBtc) {
        return {
          success: false,
          error: `Unverified accounts can only send up to ${maxSendAmount} ${normalizedCoin}. Please verify your identity to increase your limit to 10,000 ${normalizedCoin}.`,
          code: 'VERIFICATION_REQUIRED',
        };
      }
      return {
        success: false,
        error: `Maximum send amount is ${maxSendAmount} ${normalizedCoin} per transaction`,
        code: 'LIMIT_EXCEEDED',
      };
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
    logger.info(`[BALANCE CONVERSION] ─────────────────────────────────`);
    logger.info(`[BALANCE CONVERSION] Raw DB total_balance:  "${targetWallet.total_balance}" → parsed: ${dbTotal}`);
    logger.info(`[BALANCE CONVERSION] Raw DB locked_amount:  "${targetWallet.locked_amount}" → parsed: ${dbLockd}`);
    logger.info(`[BALANCE CONVERSION] DB available = total - locked = ${dbTotal} - ${dbLockd} = ${dbAvailable}`);
    logger.info(`[BALANCE CONVERSION] ─────────────────────────────────`);

    // On-chain balance (actual crypto in blockchain wallet)
    let onChainBalance = 0;
    let tronWeb = null;
    if (normalizedNetwork === 'trc20') {
      const { createTronWeb } = require('./tronClient');
      tronWeb = createTronWeb(config.TRON_NETWORK, config.MASTER_WALLET_TRON_PRIVATE_KEY, config.TRON_PRO_API_KEY);
    }
    // BTC uses Blockstream API (no TronWeb/Web3 needed)
    const balResult = await getTokenBalance(normalizedNetwork, normalizedCoin, targetWallet.wallet_address, tronWeb);
    onChainBalance = balResult.balance;
    logger.info(`[ON-CHAIN BALANCE] Raw result: ${JSON.stringify(balResult)}`);
    logger.info(`[ON-CHAIN BALANCE] ${onChainBalance} ${normalizedCoin} on ${normalizedNetwork} at ${targetWallet.wallet_address}`);

    // ─── 6. CALCULATE PLATFORM FEE ─────────────────────────────
    let platformFee;
    if (isBtc) {
      // BTC platform fee: last TX mining fee + configurable markup, with min/max guardrails
      const markupPercent = await getSetting('btc_fee_markup_percent', 15);
      const lastMiningFee = await queries.getLastBtcMiningFee();
      const btcFeeConfig = await getSetting('btc_send_fees', { percent: 1, min: 0.00005, max: 0.005 });

      if (lastMiningFee && lastMiningFee.feeBtc > 0) {
        platformFee = lastMiningFee.feeBtc * (1 + markupPercent / 100);
        logger.info(`[FEE CALCULATION] BTC fee source: last TX mining fee ${lastMiningFee.feeBtc} BTC + ${markupPercent}% markup = ${platformFee} BTC`);
      } else {
        // Fallback: estimate from current fee rates
        const feeRates = await btcClient.getRecommendedFeeRate();
        const estimatedSats = btcClient.estimateFee(2, 2, feeRates.medium);
        const estimatedBtc = estimatedSats / 1e8;
        platformFee = estimatedBtc * (1 + markupPercent / 100);
        logger.info(`[FEE CALCULATION] BTC fee source: estimated ${estimatedSats} sats (${estimatedBtc} BTC) + ${markupPercent}% markup = ${platformFee} BTC`);
      }

      // Apply min/max guardrails
      platformFee = Math.max(btcFeeConfig.min, Math.min(btcFeeConfig.max, platformFee));
      platformFee = parseFloat(platformFee.toFixed(8));
    } else {
      const feeConfig = await getSetting('crypto_send_fees', { below500: 2, at500: 4, above500: 5 });
      platformFee = feeConfig.below500;
      if (amount > 500) platformFee = feeConfig.above500;
      else if (amount === 500) platformFee = feeConfig.at500;
    }
    const totalNeeded = isBtc
      ? parseFloat((amount + platformFee).toFixed(8))
      : amount + platformFee;
    logger.info(`[FEE CALCULATION] ─────────────────────────────────`);
    logger.info(`[FEE CALCULATION] Send amount: ${amount} ${normalizedCoin}`);
    logger.info(`[FEE CALCULATION] Fee type: ${isBtc ? 'BTC mining-fee-based' : 'fixed tier'} → fee = ${platformFee} ${normalizedCoin}`);
    logger.info(`[FEE CALCULATION] Total needed = amount + fee = ${amount} + ${platformFee} = ${totalNeeded} ${normalizedCoin}`);
    logger.info(`[FEE CALCULATION] ─────────────────────────────────`);

    // ─── 7. DETERMINE STRATEGY ────────────────────────────────
    const totalAvailable = dbAvailable + onChainBalance;
    logger.info(`[STRATEGY DECISION] ─────────────────────────────────`);
    logger.info(`[STRATEGY DECISION] DB available:     ${dbAvailable} ${normalizedCoin}`);
    logger.info(`[STRATEGY DECISION] On-chain balance:  ${onChainBalance} ${normalizedCoin}`);
    logger.info(`[STRATEGY DECISION] Total available = DB + onChain = ${dbAvailable} + ${onChainBalance} = ${totalAvailable} ${normalizedCoin}`);
    logger.info(`[STRATEGY DECISION] Total needed:      ${totalNeeded} ${normalizedCoin} (amount=${amount} + fee=${platformFee})`);
    logger.info(`[STRATEGY DECISION] Surplus/Deficit:   ${(totalAvailable - totalNeeded).toFixed(6)} ${normalizedCoin}`);

    if (totalAvailable < totalNeeded) {
      logger.error(`[STRATEGY DECISION] INSUFFICIENT — available ${totalAvailable} < needed ${totalNeeded} (shortfall: ${(totalNeeded - totalAvailable).toFixed(6)})`);
      logger.info(`[STRATEGY DECISION] ─────────────────────────────────`);
      return {
        success: false,
        error: `Insufficient ${normalizedCoin} balance. Available: ${totalAvailable.toFixed(2)}, Required: ${totalNeeded} (${amount} + ${platformFee} fee)`,
      };
    }

    if (onChainBalance >= totalNeeded) {
      strategy = 'DIRECT_SEND';
      logger.info(`[STRATEGY DECISION] → DIRECT_SEND (onChain ${onChainBalance} >= totalNeeded ${totalNeeded}, user wallet sends directly)`);
    } else if (onChainBalance > 0) {
      strategy = 'HYBRID_SEND';
      const dbPortion = totalNeeded - onChainBalance;
      logger.info(`[STRATEGY DECISION] → HYBRID_SEND (onChain ${onChainBalance} < totalNeeded ${totalNeeded}, DB covers ${dbPortion})`);
    } else {
      strategy = 'MASTER_SEND';
      logger.info(`[STRATEGY DECISION] → MASTER_SEND (onChain = 0, entire ${totalNeeded} from DB, master wallet sends)`);
    }
    logger.info(`[STRATEGY DECISION] ─────────────────────────────────`);

    // ─── 7. CREATE OR REUSE TRANSFER RECORD ────────────────────
    if (preGeneratedReference) {
      // Async mode: record already created by server.js, just update metadata
      transferRef = preGeneratedReference;
      await queries.updateTransferStatus(transferRef, 'pending', {
        strategy, dbAvailable, onChainBalance, platformFee,
        ...(idempotencyKey && { idempotencyKey }),
      });
      logger.info(`Transfer record reused: ref=${transferRef}`);
    } else {
      const transfer = await queries.createTransfer({
        userApiKey,
        userEmail: email,
        asset: normalizedCoin,
        network: normalizedNetwork,
        amount,
        walletAddress: recipientAddress,
        recipientName: recipientName || 'External recipient',
        note: note || null,
        metadata: { strategy, origin: 'crypto-engine', dbAvailable, onChainBalance, platformFee, ...(idempotencyKey && { idempotencyKey }) },
        ip,
        device,
      });
      transferRef = transfer.reference;
      logger.info(`Transfer record created: ref=${transferRef}`);
    }

    // ─── 8. EXECUTE ───────────────────────────────────────────
    let txid;

    if (strategy === 'DIRECT_SEND') {
      // ──────────────────────────────────────────────────────────
      // DIRECT_SEND: on-chain covers amount + fee
      // ──────────────────────────────────────────────────────────
      logger.info(`[DIRECT_SEND] Sending ${amount} ${normalizedCoin} + ${platformFee} fee from user wallet`);

      const privateKey = await queries.getPrivateKeyByHash(targetWallet.hash);
      if (!privateKey) throw Object.assign(new Error('Unable to retrieve wallet key'), { code: 'KEY_NOT_FOUND' });

      if (isBtc) {
        // ── BTC DIRECT_SEND ─────────────────────────────────────
        // Single TX: user → recipient (amount BTC)
        // Mining fee paid from UTXOs automatically
        // Platform fee deducted from DB balance (not sent on-chain)
        logger.info(`[DIRECT_SEND:BTC] Sending ${amount} BTC → ${recipientAddress}`);
        const result = await sendToken('btc', 'BTC', privateKey, recipientAddress, amount, { fromAddress: targetWallet.wallet_address });
        txid = result.txid;
        logger.info(`[DIRECT_SEND:BTC] Sent! TXID: ${txid}, mining fee: ${result.feeBtc} BTC`);
        await queries.updateTransferStatus(transferRef, 'pending', { miningFee: result.feeBtc, miningFeeSats: result.fee });

        // Deduct platform fee from DB (no on-chain fee TX for BTC)
        if (platformFee > 0) {
          if (dbAvailable >= platformFee) {
            logger.info(`[DIRECT_SEND:BTC] Deducting platform fee ${platformFee} BTC from DB`);
            await deductBalance(userApiKey, normalizedCoin, platformFee, normalizedNetwork);
          } else {
            // DB balance can't cover the fee — log it and record as uncollected
            logger.warn(`[DIRECT_SEND:BTC] Cannot deduct platform fee ${platformFee} BTC — DB available is only ${dbAvailable}. Fee recorded as uncollected.`);
            await queries.updateTransferStatus(transferRef, 'pending', { feeUncollected: true, feeAmount: platformFee, feeShortfall: platformFee - dbAvailable });
          }
        }
      } else {
        // ── TOKEN DIRECT_SEND (USDT/USDC) ───────────────────────
        // TX 1: User wallet → master (platform fee)
        // TX 2: User wallet → recipient (send amount)

        // Fund gas (need enough for two TXs)
        const gasResult = await ensureGas(normalizedNetwork, targetWallet.wallet_address);
        if (gasResult.funded) {
          logger.info(`[DIRECT_SEND] Gas funded: ${gasResult.amount} → ${targetWallet.wallet_address}`);
          await queries.updateTransferStatus(transferRef, 'pending', { gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid });
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          logger.info(`[DIRECT_SEND] Gas sufficient (${gasResult.balance})`);
        }

        // TX 1: Send platform fee from user wallet → master
        const masterAddress = getMasterAddress(normalizedNetwork);
        logger.info(`[DIRECT_SEND] TX1: Sending ${platformFee} ${normalizedCoin} fee → master (${masterAddress})`);
        const feeResult = await sendToken(normalizedNetwork, normalizedCoin, privateKey, masterAddress, platformFee);
        feeTxid = feeResult.txid;
        logger.info(`[DIRECT_SEND] Fee sent! TXID: ${feeTxid}`);
        await queries.updateTransferStatus(transferRef, 'pending', { feeTxid, feeAmount: platformFee });

        // Wait for fee TX to confirm before sending the main amount
        logger.info(`[DIRECT_SEND] Waiting 3s for fee TX confirmation...`);
        await new Promise((r) => setTimeout(r, 3000));

        // TX 2: Send amount from user wallet → recipient
        logger.info(`[DIRECT_SEND] TX2: Sending ${amount} ${normalizedCoin} → ${recipientAddress}`);
        const result = await sendToken(normalizedNetwork, normalizedCoin, privateKey, recipientAddress, amount);
        txid = result.txid;
        logger.info(`[DIRECT_SEND] Sent! TXID: ${txid}`);
      }

    } else if (strategy === 'HYBRID_SEND') {
      // ──────────────────────────────────────────────────────────
      // HYBRID_SEND: on-chain has some, DB covers the rest
      // 1. Lock DB portion
      // 2. Reclaim user's on-chain → master
      // 3. Master sends full amount → recipient
      // 4. Deduct DB portion
      // ──────────────────────────────────────────────────────────
      dbLockAmount = totalNeeded - onChainBalance;
      logger.info(`[HYBRID_SEND] Starting — onChain=${onChainBalance}, dbNeeded=${dbLockAmount}, total=${totalNeeded} (amount=${amount} + fee=${platformFee})`);

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

      const masterAddress = getMasterAddress(normalizedNetwork);
      const masterKey = getMasterKey(normalizedNetwork);

      if (isBtc) {
        // ── BTC HYBRID_SEND ───────────────────────────────────
        // TX 1: Reclaim user's on-chain BTC → master (user pays mining fee)
        // TX 2: Master sends full amount → recipient (master pays mining fee)
        // Estimate mining fee and subtract from reclaim amount (fee comes from UTXOs)
        const userUtxos = await btcClient.getUtxos(targetWallet.wallet_address);
        const feeRates = await btcClient.getRecommendedFeeRate();
        const estimatedFee = btcClient.estimateFee(userUtxos.length || 1, 1, feeRates.medium); // 1 output (no change — send all to master)
        const reclaimAmount = parseFloat((onChainBalance - (estimatedFee / 1e8)).toFixed(8));
        logger.info(`[HYBRID_SEND:BTC] Reclaiming ${reclaimAmount} BTC (on-chain ${onChainBalance} - ${estimatedFee} sats fee): user → master (${masterAddress})`);
        const reclaimResult = await sendToken('btc', 'BTC', privateKey, masterAddress, reclaimAmount, { fromAddress: targetWallet.wallet_address });
        reclaimTxid = reclaimResult.txid;
        logger.info(`[HYBRID_SEND:BTC] Reclaim sent! TXID: ${reclaimTxid}, mining fee: ${reclaimResult.feeBtc} BTC`);
        await queries.updateTransferStatus(transferRef, 'pending', { reclaimTxid, reclaimAmount, reclaimMiningFee: reclaimResult.feeBtc, strategy });

        // Wait for reclaim to confirm (BTC is slow — wait longer)
        logger.info(`[HYBRID_SEND:BTC] Waiting for reclaim confirmation...`);
        await btcClient.waitForConfirmation(reclaimTxid, 20, 30000);

        // Check master has enough after reclaim landed
        const masterBalHybridBtc = await getTokenBalance('btc', 'BTC', masterAddress);
        logger.info(`[HYBRID_SEND:BTC] Master balance after reclaim: ${masterBalHybridBtc.balance} BTC`);
        if (masterBalHybridBtc.balance < amount) {
          logger.warn(`[HYBRID_SEND:BTC] Master insufficient after reclaim: has ${masterBalHybridBtc.balance}, needs ${amount}`);
          await queries.updateTransferStatus(transferRef, 'pending_funding', {
            strategy: 'HYBRID_SEND', masterBalance: masterBalHybridBtc.balance,
            amountNeeded: amount, shortfall: amount - masterBalHybridBtc.balance, reclaimTxid,
          });
          notifySuperAdmin({
            title: `Master wallet insufficient: BTC (HYBRID_SEND)`,
            message: `Transfer ${transferRef} needs ${amount} BTC but master has ${masterBalHybridBtc.balance} after reclaim. User: ${email}. Balance locked.`,
            metadata: { reference: transferRef, coin: 'BTC', network: 'btc', amount, masterBalance: masterBalHybridBtc.balance, userEmail: email },
          }).catch(() => {});
          queries.getSuperAdminEmails().then((adminEmails) => {
            sendAdminInsufficientBalanceEmail({ adminEmails, coin: 'BTC', network: 'btc', amount, masterBalance: masterBalHybridBtc.balance, reference: transferRef, userEmail: email });
          }).catch(() => {});
          return { success: false, code: 'MASTER_INSUFFICIENT_BALANCE', status: 'pending_funding', reference: transferRef, message: `Transfer pending. Master wallet needs funding.` };
        }

        // Master sends full amount → recipient
        logger.info(`[HYBRID_SEND:BTC] Master sending ${amount} BTC → ${recipientAddress}`);
        const sendResult = await sendToken('btc', 'BTC', masterKey, recipientAddress, amount);
        txid = sendResult.txid;
        logger.info(`[HYBRID_SEND:BTC] Sent! TXID: ${txid}, mining fee: ${sendResult.feeBtc} BTC`);
      } else {
        // ── TOKEN HYBRID_SEND (USDT/USDC) ─────────────────────

        // Fund gas for reclaim tx
        const gasResult = await ensureGas(normalizedNetwork, targetWallet.wallet_address);
        if (gasResult.funded) {
          logger.info(`[HYBRID_SEND] Gas funded: ${gasResult.amount} → ${targetWallet.wallet_address}`);
          await queries.updateTransferStatus(transferRef, 'pending', { gasFunded: true, gasAmount: gasResult.amount, gasTxid: gasResult.txid });
          await new Promise((r) => setTimeout(r, 3000));
        }

        // Reclaim: send user's on-chain balance → master wallet
        logger.info(`[HYBRID_SEND] Reclaiming ${onChainBalance} ${normalizedCoin}: user wallet → master (${masterAddress})`);
        const reclaimResult = await sendToken(normalizedNetwork, normalizedCoin, privateKey, masterAddress, onChainBalance);
        reclaimTxid = reclaimResult.txid;
        logger.info(`[HYBRID_SEND] Reclaim sent! TXID: ${reclaimTxid}`);
        await queries.updateTransferStatus(transferRef, 'pending', { reclaimTxid, reclaimAmount: onChainBalance, strategy });

        // Wait for reclaim confirmation
        logger.info(`[HYBRID_SEND] Waiting 3s for reclaim confirmation...`);
        await new Promise((r) => setTimeout(r, 3000));

        // Check master has enough after reclaim landed
        let masterTwHybrid = null;
        if (normalizedNetwork === 'trc20') {
          const { createTronWeb } = require('./tronClient');
          masterTwHybrid = createTronWeb(config.TRON_NETWORK, masterKey, config.TRON_PRO_API_KEY);
        }
        const masterBalHybrid = await getTokenBalance(normalizedNetwork, normalizedCoin, masterAddress, masterTwHybrid);
        logger.info(`[HYBRID_SEND] Master balance after reclaim: ${masterBalHybrid.balance} ${normalizedCoin}`);
        if (masterBalHybrid.balance < amount) {
          logger.warn(`[HYBRID_SEND] Master insufficient after reclaim: has ${masterBalHybrid.balance}, needs ${amount}`);
          await queries.updateTransferStatus(transferRef, 'pending_funding', {
            strategy: 'HYBRID_SEND', masterBalance: masterBalHybrid.balance,
            amountNeeded: amount, shortfall: amount - masterBalHybrid.balance, reclaimTxid,
          });
          notifySuperAdmin({
            title: `Master wallet insufficient: ${normalizedCoin} on ${normalizedNetwork} (HYBRID_SEND)`,
            message: `Transfer ${transferRef} needs ${amount} ${normalizedCoin} but master has ${masterBalHybrid.balance} after reclaim. User: ${email}. Balance locked.`,
            metadata: { reference: transferRef, coin: normalizedCoin, network: normalizedNetwork, amount, masterBalance: masterBalHybrid.balance, userEmail: email },
          }).catch(() => {});
          queries.getSuperAdminEmails().then((adminEmails) => {
            sendAdminInsufficientBalanceEmail({ adminEmails, coin: normalizedCoin, network: normalizedNetwork, amount, masterBalance: masterBalHybrid.balance, reference: transferRef, userEmail: email });
          }).catch(() => {});
          return { success: false, code: 'MASTER_INSUFFICIENT_BALANCE', status: 'pending_funding', reference: transferRef, message: `Transfer pending. Master wallet needs funding.` };
        }

        // Master sends full amount → recipient
        logger.info(`[HYBRID_SEND] Master sending ${amount} ${normalizedCoin} → ${recipientAddress}`);
        const sendResult = await sendToken(normalizedNetwork, normalizedCoin, masterKey, recipientAddress, amount);
        txid = sendResult.txid;
        logger.info(`[HYBRID_SEND] Sent! TXID: ${txid}`);
      }

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
      dbLockAmount = totalNeeded;
      logger.info(`[MASTER_SEND] Starting — dbAvailable=${dbAvailable}, totalNeeded=${totalNeeded} (amount=${amount} + fee=${platformFee})`);

      // Lock full amount in DB
      const lockResult = await lockBalance(userApiKey, normalizedCoin, normalizedNetwork, dbLockAmount);
      if (!lockResult.success) {
        throw Object.assign(new Error(lockResult.response.message), { code: 'LOCK_FAILED' });
      }
      dbLocked = true;
      logger.info(`[MASTER_SEND] Locked ${dbLockAmount} ${normalizedCoin} in DB`);

      // Check master has enough
      const masterKey = getMasterKey(normalizedNetwork);
      const masterAddress = getMasterAddress(normalizedNetwork);
      let masterTronWeb = null;
      if (normalizedNetwork === 'trc20') {
        const { createTronWeb } = require('./tronClient');
        masterTronWeb = createTronWeb(config.TRON_NETWORK, masterKey, config.TRON_PRO_API_KEY);
      }
      const masterBal = await getTokenBalance(normalizedNetwork, normalizedCoin, masterAddress, masterTronWeb);
      logger.info(`[MASTER_SEND] Master balance: ${masterBal.balance} ${normalizedCoin}`);

      if (masterBal.balance < amount) {
        // ── INSUFFICIENT: mark pending_funding, email admins, return early ──
        logger.warn(`[MASTER_SEND] Master wallet insufficient: has ${masterBal.balance} ${normalizedCoin}, needs ${amount} (shortfall: ${(amount - masterBal.balance).toFixed(8)})`);
        await queries.updateTransferStatus(transferRef, 'pending_funding', {
          strategy: 'MASTER_SEND',
          masterBalance: masterBal.balance,
          amountNeeded: amount,
          shortfall: amount - masterBal.balance,
        });

        // Notify admins via DB + email
        notifySuperAdmin({
          title: `Master wallet insufficient: ${normalizedCoin} on ${normalizedNetwork}`,
          message: `Transfer ${transferRef} needs ${amount} ${normalizedCoin} but master only has ${masterBal.balance}. User: ${email}. Balance locked, awaiting funding.`,
          metadata: { reference: transferRef, coin: normalizedCoin, network: normalizedNetwork, amount, masterBalance: masterBal.balance, userEmail: email },
        }).catch(() => {});

        queries.getSuperAdminEmails().then((adminEmails) => {
          sendAdminInsufficientBalanceEmail({
            adminEmails, coin: normalizedCoin, network: normalizedNetwork,
            amount, masterBalance: masterBal.balance, reference: transferRef, userEmail: email,
          });
        }).catch(() => {});

        // Return early — balance stays locked, catch block is NOT reached
        return {
          success: false,
          code: 'MASTER_INSUFFICIENT_BALANCE',
          status: 'pending_funding',
          reference: transferRef,
          message: `Transfer is pending. The master wallet needs funding (${(amount - masterBal.balance).toFixed(8)} ${normalizedCoin} shortfall).`,
        };
      }

      // Master sends directly to recipient
      logger.info(`[MASTER_SEND] Sending ${amount} ${normalizedCoin} → ${recipientAddress}`);
      const result = await sendToken(normalizedNetwork, normalizedCoin, masterKey, recipientAddress, amount);
      txid = result.txid;
      logger.info(`[MASTER_SEND] Sent! TXID: ${txid}`);

      if (isBtc) {
        logger.info(`[MASTER_SEND:BTC] Mining fee: ${result.feeBtc} BTC`);
        await queries.updateTransferStatus(transferRef, 'pending', { miningFee: result.feeBtc, miningFeeSats: result.fee });
      }

      // Deduct from DB
      logger.info(`[MASTER_SEND] Deducting ${dbLockAmount} ${normalizedCoin} from DB`);
      await deductBalance(userApiKey, normalizedCoin, dbLockAmount, normalizedNetwork);
      dbLocked = false;
      logger.info(`[MASTER_SEND] DB deduction complete`);
    }

    // ─── 9. UPDATE TRANSFER STATUS & BUILD RESPONSE ────────────
    let txUrl;
    if (isBtc) {
      const explorerBase = btcClient.getExplorerBase();
      txUrl = (id) => `${explorerBase}${id}`;
    } else {
      const net = config.TRON_NETWORK || 'mainnet';
      const explorerBase = net === 'mainnet' ? 'https://tronscan.org' : `https://${net}.tronscan.org`;
      txUrl = (id) => `${explorerBase}/#/transaction/${id}`;
    }

    const response = {
      success: true,
      txid,
      explorerUrl: txUrl(txid),
      reference: transferRef,
      strategy,
      network: normalizedNetwork,
      coin: normalizedCoin,
      amount,
      fee: platformFee,
      total: totalNeeded,
      recipientAddress,
    };

    if (feeTxid) {
      response.feeTxid = feeTxid;
      response.feeExplorerUrl = txUrl(feeTxid);
    }

    if (reclaimTxid) {
      response.reclaimTxid = reclaimTxid;
      response.reclaimExplorerUrl = txUrl(reclaimTxid);
    }

    // BTC: mark as pending_confirmation (needs ~10-30 min on-chain), others: completed immediately
    const finalStatus = isBtc ? 'pending_confirmation' : 'completed';
    await queries.updateTransferStatus(transferRef, finalStatus, {
      txid,
      explorerUrl: txUrl(txid),
      strategy,
      platformFee,
      feeTxid: feeTxid || undefined,
      reclaimTxid: reclaimTxid || undefined,
      reclaimExplorerUrl: reclaimTxid ? txUrl(reclaimTxid) : undefined,
    });
    response.status = finalStatus;

    logger.success(`═══ sendCrypto ${finalStatus.toUpperCase()} — strategy=${strategy}, TXID=${txid}, ref=${transferRef}${reclaimTxid ? ', reclaimTxid=' + reclaimTxid : ''} ═══`);
    logger.info(`Explorer: ${txUrl(txid)}`);
    if (reclaimTxid) logger.info(`Reclaim Explorer: ${txUrl(reclaimTxid)}`);

    // ─── 10. RECORD FEE AS PROFIT ────────────────────────────────
    const maskedAddr = `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`;
    recordFee({
      transactionType: 'crypto_send_fee',
      source: 'crypto_send',
      sourceReference: transferRef,
      currency: 'USD',
      amount: platformFee,
      usdEquivalent: platformFee,
      description: `Platform fee for ${amount} ${normalizedCoin} send to ${maskedAddr}`,
      userApiKey,
    }).catch(() => {});

    // ─── 11. NOTIFY SUPER ADMIN ──────────────────────────────────
    notifySuperAdmin({
      title: `Fee collected: ${platformFee} ${normalizedCoin}`,
      message: `Platform fee of ${platformFee} ${normalizedCoin} collected from ${email} for sending ${amount} ${normalizedCoin} to ${maskedAddr}`,
      metadata: { reference: transferRef, fee: platformFee, amount, asset: normalizedCoin, userEmail: email },
    }).catch(() => {});

    // ─── 12. SEND EMAIL ──────────────────────────────────────────
    if (isBtc) {
      sendBtcTransferInitiatedEmail({
        email,
        firstName: user.first_name,
        amount,
        recipientAddress,
        txid,
        explorerUrl: txUrl(txid),
        fee: platformFee,
        reference: transferRef,
      }).catch(() => {});
    } else {
      sendCryptoTransferEmail({
        email,
        firstName: user.first_name,
        amount,
        asset: normalizedCoin,
        network: normalizedNetwork,
        recipientAddress,
        txid,
        explorerUrl: txUrl(txid),
        fee: platformFee,
        reference: transferRef,
      }).catch(() => {});
    }

    // ─── 13. CHECK IF RECIPIENT IS INTERNAL ──────────────────────
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
        feeTxid: feeTxid || undefined,
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
    btc:   config.MASTER_WALLET_BTC_ADDRESS,
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
    btc:   config.MASTER_WALLET_BTC_PRIVATE_KEY,
  };
  const key = keys[network.toLowerCase()];
  if (!key) throw new Error(`No master wallet key configured for ${network}`);
  return key;
}

module.exports = { sendCrypto };
