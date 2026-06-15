/**
 * HTTP API server for the crypto-tx-engine.
 *
 * Endpoints:
 *   POST /api/send              — Send crypto
 *   GET  /api/health            — Health check
 *   GET  /api/balance           — User balance (DB + on-chain + gas)
 *   GET  /api/transfer/:ref     — Transfer status lookup
 *   GET  /api/transfers          — List transfers (sends + receives)
 *   GET  /api/master/health     — Master wallet balances
 *
 * Usage:
 *   node server.js              # starts on PORT (default 4100)
 *   PORT=5000 node server.js    # custom port
 */

const express = require('express');
const { waitUntil } = require('@vercel/functions');
const config = require('./config');
const queries = require('./db/queries');
const { sendCrypto } = require('./services/walletService');
const { getTokenBalance, getNativeBalance } = require('./services/balanceService');
const { SUPPORTED_COINS, SUPPORTED_NETWORKS, NETWORKS } = require('./config/networks');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4100;
const API_SECRET = process.env.API_SECRET;

// ─── Auth middleware for mutating endpoints ─────────────────

function requireApiSecret(req, res, next) {
  if (!API_SECRET) return next();
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers ────────────────────────────────────────────────

function buildExplorerUrl(network, txHash) {
  if (!txHash) return null;
  const net = (network || '').toLowerCase();
  if (net === 'btc') {
    const btcClient = require('./services/bitcoinClient');
    return `${btcClient.getExplorerBase()}${txHash}`;
  }
  if (net === 'trc20') {
    const tronNet = config.TRON_NETWORK || 'mainnet';
    const base = tronNet === 'mainnet' ? 'https://tronscan.org' : `https://${tronNet}.tronscan.org`;
    return `${base}/#/transaction/${txHash}`;
  }
  if (net === 'bep20') return `https://bscscan.com/tx/${txHash}`;
  if (net === 'erc20') return `https://etherscan.io/tx/${txHash}`;
  return null;
}

function createTronWebIfNeeded(network) {
  if (network === 'trc20') {
    const { createTronWeb } = require('./services/tronClient');
    return createTronWeb(config.TRON_NETWORK, config.MASTER_WALLET_TRON_PRIVATE_KEY, config.TRON_PRO_API_KEY);
  }
  return null;
}

// ─── GET /api/health ────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'crypto-tx-engine',
    timestamp: new Date().toISOString(),
    supportedCoins: SUPPORTED_COINS,
    supportedNetworks: SUPPORTED_NETWORKS,
  });
});

// ─── GET /api/balance ───────────────────────────────────────

app.get('/api/balance', async (req, res) => {
  const startTime = Date.now();

  try {
    const { userApiKey, coin, network } = req.query;

    const errors = [];
    if (!userApiKey || typeof userApiKey !== 'string') errors.push('userApiKey is required');
    if (!coin || typeof coin !== 'string') errors.push('coin is required (e.g. USDT, USDC)');
    if (!network || typeof network !== 'string') errors.push('network is required (e.g. trc20, bep20, erc20)');

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const normalizedCoin = coin.toUpperCase();
    const normalizedNetwork = network.toLowerCase();

    if (!SUPPORTED_COINS.includes(normalizedCoin)) {
      return res.status(400).json({ success: false, error: `Unsupported coin: ${normalizedCoin}` });
    }
    if (!SUPPORTED_NETWORKS.includes(normalizedNetwork)) {
      return res.status(400).json({ success: false, error: `Unsupported network: ${normalizedNetwork}` });
    }

    const user = await queries.getUserByApiKey(userApiKey);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const wallet = await queries.getWalletByNetwork(normalizedCoin, userApiKey, normalizedNetwork);
    if (!wallet) {
      return res.status(404).json({ success: false, error: `No ${normalizedCoin} wallet on ${normalizedNetwork}` });
    }

    const tronWeb = createTronWebIfNeeded(normalizedNetwork);
    const isBtc = normalizedNetwork === 'btc';

    // BTC is its own native token — no separate gas check needed
    const tokenResult = await getTokenBalance(normalizedNetwork, normalizedCoin, wallet.wallet_address, tronWeb);
    let nativeResult = { balance: 0 };
    if (!isBtc) {
      nativeResult = await getNativeBalance(normalizedNetwork, wallet.wallet_address, tronWeb);
    }

    const dbTotal = parseFloat(wallet.total_balance) || 0;
    const dbLocked = parseFloat(wallet.locked_amount) || 0;
    const dbAvailable = dbTotal - dbLocked;

    const networkInfo = NETWORKS[normalizedNetwork];
    const totalAvailable = dbAvailable + tokenResult.balance;

    logger.info(`[BALANCE QUERY] ─────────────────────────────────`);
    logger.info(`[BALANCE QUERY] User: ${userApiKey.substring(0, 8)}... | ${normalizedCoin} on ${normalizedNetwork}`);
    logger.info(`[BALANCE QUERY] Wallet: ${wallet.wallet_address}`);
    logger.info(`[BALANCE QUERY] Raw DB total_balance: "${wallet.total_balance}" → parsed: ${dbTotal}`);
    logger.info(`[BALANCE QUERY] Raw DB locked_amount: "${wallet.locked_amount}" → parsed: ${dbLocked}`);
    logger.info(`[BALANCE QUERY] DB available = total - locked = ${dbTotal} - ${dbLocked} = ${dbAvailable}`);
    logger.info(`[BALANCE QUERY] On-chain ${normalizedCoin}: ${tokenResult.balance}`);
    if (!isBtc) {
      logger.info(`[BALANCE QUERY] Gas (${networkInfo.nativeToken}): ${nativeResult.balance} (threshold: ${networkInfo.gasThreshold}, sufficient: ${nativeResult.balance >= networkInfo.gasThreshold})`);
    } else {
      logger.info(`[BALANCE QUERY] BTC — no separate gas token (fees paid from BTC)`);
    }
    logger.info(`[BALANCE QUERY] Total available = DB + onChain = ${dbAvailable} + ${tokenResult.balance} = ${totalAvailable}`);
    logger.info(`[BALANCE QUERY] ─────────────────────────────────`);

    const elapsed = Date.now() - startTime;
    const response = {
      success: true,
      coin: normalizedCoin,
      network: normalizedNetwork,
      walletAddress: wallet.wallet_address,
      dbBalance: { total: dbTotal, locked: dbLocked, available: dbAvailable },
      onChainBalance: tokenResult.balance,
      totalAvailable,
      elapsed: `${elapsed}ms`,
    };

    if (isBtc) {
      // BTC pays its own fees — no gas balance needed
      response.gasBalance = { balance: null, token: 'BTC', sufficient: true, note: 'BTC pays mining fees from transaction inputs' };
    } else {
      response.gasBalance = {
        balance: nativeResult.balance,
        token: networkInfo.nativeToken,
        sufficient: nativeResult.balance >= networkInfo.gasThreshold,
      };
    }

    return res.json(response);

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`GET /api/balance error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Internal server error', elapsed: `${elapsed}ms` });
  }
});

// ─── GET /api/transfer/:reference ───────────────────────────

app.get('/api/transfer/:reference', async (req, res) => {
  const startTime = Date.now();

  try {
    const { reference } = req.params;

    if (!reference || reference.length !== 24) {
      return res.status(400).json({ success: false, error: 'reference must be a 24-character string' });
    }

    const transfer = await queries.getTransferByReference(reference);
    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found' });
    }

    const meta = typeof transfer.metadata === 'string'
      ? JSON.parse(transfer.metadata)
      : (transfer.metadata || {});

    const transferResponse = {
      reference: transfer.reference,
      status: transfer.status,
      amount: parseFloat(transfer.amount),
      coin: transfer.asset,
      network: transfer.network,
      recipientAddress: transfer.recipient_wallet_address,
      txid: transfer.tx_hash || null,
      explorerUrl: buildExplorerUrl(transfer.network, transfer.tx_hash),
      type: meta.type || 'send',
      strategy: meta.strategy || null,
      senderAddress: meta.senderAddress || null,
      sendReference: meta.sendReference || null,
      createdAt: transfer.created_at,
      updatedAt: transfer.updated_at || null,
    };

    // BTC: check real-time on-chain confirmation status
    if (transfer.network === 'btc' && transfer.tx_hash) {
      try {
        const btcClient = require('./services/bitcoinClient');
        const axios = require('axios');
        const api = btcClient.getApiBase();
        const { data: txData } = await axios.get(`${api}/tx/${transfer.tx_hash}`, { timeout: 10000 });

        if (txData.status && txData.status.confirmed) {
          // Get current block height to calculate confirmations
          const { data: tipHeight } = await axios.get(`${api}/blocks/tip/height`, { timeout: 5000 });
          const confirmations = tipHeight - txData.status.block_height + 1;

          transferResponse.confirmation = {
            status: 'confirmed',
            blockHeight: txData.status.block_height,
            blockHash: txData.status.block_hash,
            confirmations,
            // Bitcoin convention: 1 = seen in block, 3 = fairly safe, 6 = fully confirmed
            confidence: confirmations >= 6 ? 'final' : confirmations >= 3 ? 'high' : 'low',
          };
        } else {
          transferResponse.confirmation = {
            status: 'unconfirmed',
            confirmations: 0,
            confidence: 'pending',
            note: 'Transaction is in the mempool, waiting to be included in a block (~10 min)',
          };
        }
      } catch (err) {
        transferResponse.confirmation = {
          status: 'unknown',
          error: 'Could not check on-chain status',
        };
      }
    }

    const elapsed = Date.now() - startTime;
    return res.json({
      success: true,
      transfer: transferResponse,
      elapsed: `${elapsed}ms`,
    });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`GET /api/transfer error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Internal server error', elapsed: `${elapsed}ms` });
  }
});

// ─── GET /api/transfers ─────────────────────────────────────

app.get('/api/transfers', async (req, res) => {
  const startTime = Date.now();

  try {
    const { userApiKey, type, limit, offset } = req.query;

    if (!userApiKey || typeof userApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'userApiKey is required' });
    }

    if (type && !['send', 'receive'].includes(type)) {
      return res.status(400).json({ success: false, error: 'type must be "send" or "receive"' });
    }

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedOffset = parseInt(offset) || 0;

    const transfers = await queries.getTransfersByUser(userApiKey, {
      type,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    const items = transfers.map((t) => {
      const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {});
      return {
        reference: t.reference,
        type: meta.type || 'send',
        status: t.status,
        amount: parseFloat(t.amount),
        coin: t.asset,
        network: t.network,
        recipientAddress: t.recipient_wallet_address,
        txid: t.tx_hash || null,
        explorerUrl: buildExplorerUrl(t.network, t.tx_hash),
        senderAddress: meta.senderAddress || null,
        sendReference: meta.sendReference || null,
        createdAt: t.created_at,
      };
    });

    const elapsed = Date.now() - startTime;
    return res.json({
      success: true,
      count: items.length,
      limit: parsedLimit,
      offset: parsedOffset,
      transfers: items,
      elapsed: `${elapsed}ms`,
    });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`GET /api/transfers error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Internal server error', elapsed: `${elapsed}ms` });
  }
});

// ─── GET /api/fees ──────────────────────────────────────────

app.get('/api/fees', async (req, res) => {
  const { amount, coin } = req.query;
  const numAmount = parseFloat(amount);
  const isBtc = (coin || '').toUpperCase() === 'BTC';

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, error: 'amount is required and must be positive' });
  }

  if (isBtc) {
    // BTC: dynamic mining fee + percentage-based platform fee
    const btcClient = require('./services/bitcoinClient');
    const feeRates = await btcClient.getRecommendedFeeRate();
    // Estimate mining fee for a typical 1-input, 2-output tx
    const estimatedMiningFee = btcClient.estimateFee(1, 2, feeRates.medium) / 1e8;
    // Platform fee: 1% with min 0.00005 max 0.005
    const platformFee = Math.max(0.00005, Math.min(0.005, numAmount * 0.01));

    logger.info(`[FEE QUERY:BTC] ─────────────────────────────────`);
    logger.info(`[FEE QUERY:BTC] Amount: ${numAmount} BTC`);
    logger.info(`[FEE QUERY:BTC] Mining fee (medium): ${estimatedMiningFee.toFixed(8)} BTC (${feeRates.medium} sat/vB)`);
    logger.info(`[FEE QUERY:BTC] Platform fee: ${platformFee.toFixed(8)} BTC`);
    logger.info(`[FEE QUERY:BTC] ─────────────────────────────────`);

    return res.json({
      success: true,
      coin: 'BTC',
      amount: numAmount,
      platformFee: parseFloat(platformFee.toFixed(8)),
      miningFee: parseFloat(estimatedMiningFee.toFixed(8)),
      totalFee: parseFloat((platformFee + estimatedMiningFee).toFixed(8)),
      total: parseFloat((numAmount + platformFee).toFixed(8)),
      feeRates: { fast: feeRates.fast, medium: feeRates.medium, slow: feeRates.slow, source: feeRates.source },
      minimum: config.BTC_MIN_SEND || 0.0001,
    });
  }

  // USDT/USDC: fixed tier fees
  let fee = 2;
  if (numAmount > 500) fee = 5;
  else if (numAmount === 500) fee = 4;

  logger.info(`[FEE QUERY] ─────────────────────────────────`);
  logger.info(`[FEE QUERY] Requested amount: ${numAmount}`);
  logger.info(`[FEE QUERY] Fee tier: ${numAmount > 500 ? 'above500 (>500)' : numAmount === 500 ? 'at500 (=500)' : 'below500 (<500)'} → fee = ${fee}`);
  logger.info(`[FEE QUERY] Total with fee:  ${numAmount} + ${fee} = ${numAmount + fee}`);
  logger.info(`[FEE QUERY] Sendable after fee: ${numAmount} - ${fee} = ${numAmount - fee}`);
  logger.info(`[FEE QUERY] ─────────────────────────────────`);

  return res.json({
    success: true,
    amount: numAmount,
    fee,
    total: numAmount + fee,
    sendable: numAmount - fee,
    minimum: 5,
  });
});

// ─── POST /api/send ─────────────────────────────────────────

/**
 * POST /api/send
 *
 * Body: { userApiKey, recipientAddress, amount, coin, network, recipientName?, note?, idempotencyKey? }
 * Response: { success, txid?, reference?, strategy?, error?, elapsed }
 */
app.post('/api/send', requireApiSecret, async (req, res) => {
  const startTime = Date.now();

  try {
    const { userApiKey, recipientAddress, amount, coin, network, recipientName, note, idempotencyKey } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    const errors = [];
    if (!userApiKey || typeof userApiKey !== 'string') errors.push('userApiKey is required');
    if (!recipientAddress || typeof recipientAddress !== 'string') errors.push('recipientAddress is required');
    if (!amount || typeof amount !== 'number' || amount <= 0) errors.push('amount must be a positive number');
    if (!coin || typeof coin !== 'string') errors.push('coin is required (e.g. USDT, USDC)');
    if (!network || typeof network !== 'string') errors.push('network is required (e.g. trc20, bep20, erc20)');

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    logger.info(`POST /api/send — ${coin} ${network} ${amount} → ${recipientAddress.substring(0, 10)}... (async=${asyncMode})`);

    const sendParams = {
      userApiKey,
      recipientAddress,
      amount: parseFloat(amount),
      coin,
      network,
      recipientName,
      note,
      ip: req.ip,
      device: req.headers['user-agent'],
      idempotencyKey,
    };

    if (asyncMode) {
      // Async mode: create record first, return immediately, process in background
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let reference = '';
      for (let i = 0; i < 24; i++) reference += chars.charAt(Math.floor(Math.random() * chars.length));

      // Calculate fee for the response (same logic as walletService)
      let fee;
      const isBtcSend = coin.toUpperCase() === 'BTC' && network.toLowerCase() === 'btc';
      if (isBtcSend) {
        fee = Math.max(0.00005, Math.min(0.005, sendParams.amount * 0.01));
        fee = parseFloat(fee.toFixed(8));
        logger.info(`[ASYNC FEE CALC:BTC] Amount: ${sendParams.amount}, platform fee: ${fee} BTC`);
      } else {
        fee = 2;
        if (sendParams.amount > 500) fee = 5;
        else if (sendParams.amount === 500) fee = 4;
        logger.info(`[ASYNC FEE CALC] Amount: ${sendParams.amount}, tier: ${sendParams.amount > 500 ? 'above500' : sendParams.amount === 500 ? 'at500' : 'below500'} → fee = ${fee}, total = ${sendParams.amount + fee}`);
      }

      // Create transfer record immediately so polling works even if background fails
      await queries.createTransfer({
        reference,
        userApiKey,
        asset: coin.toUpperCase(),
        network: network.toLowerCase(),
        amount: sendParams.amount,
        walletAddress: recipientAddress,
        recipientName: recipientName || 'External recipient',
        note: note || null,
        metadata: { origin: 'crypto-engine-async', platformFee: fee },
        ip: req.ip,
        device: req.headers['user-agent'],
      });

      // Return immediately with reference
      res.json({
        success: true,
        status: 'processing',
        reference,
        fee,
        total: sendParams.amount + fee,
        message: 'Transfer initiated. Poll GET /api/transfer/:reference for status.',
      });

      // Process in background — waitUntil keeps the Vercel function alive after response
      const backgroundTask = sendCrypto({ ...sendParams, preGeneratedReference: reference }).then(async (result) => {
        if (!result.success) {
          logger.error(`[ASYNC] Background send returned failure for ref=${reference}: ${result.error}`);
          await queries.updateTransferStatus(reference, 'failed', {
            error: result.error,
            code: result.code,
          }).catch(() => {});
        }
      }).catch(async (err) => {
        logger.error(`[ASYNC] Background send threw for ref=${reference}: ${err.message}`);
        await queries.updateTransferStatus(reference, 'failed', {
          error: err.message,
          code: err.code,
        }).catch(() => {});
      });
      waitUntil(backgroundTask);
      return;
    }

    // Sync mode: wait for full completion (original behavior)
    const result = await sendCrypto(sendParams);

    const elapsed = Date.now() - startTime;

    if (result.success) {
      return res.json({
        ...result,
        elapsed: `${elapsed}ms`,
      });
    }

    const statusCode = result.code === 'KEY_NOT_FOUND' ? 500 : 400;
    return res.status(statusCode).json({
      success: false,
      error: result.error,
      code: result.code,
      reference: result.reference,
      elapsed: `${elapsed}ms`,
    });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`Unhandled error: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      elapsed: `${elapsed}ms`,
    });
  }
});

// ─── GET /api/master/health ─────────────────────────────────

app.get('/api/master/health', async (req, res) => {
  const startTime = Date.now();

  try {
    const masterAddresses = {
      trc20: config.MASTER_WALLET_TRON_ADDRESS,
      bep20: config.MASTER_WALLET_BSC_ADDRESS,
      erc20: config.MASTER_WALLET_ETH_ADDRESS,
      btc:   config.MASTER_WALLET_BTC_ADDRESS,
    };

    const activeNetworks = Object.entries(masterAddresses)
      .filter(([, addr]) => !!addr)
      .map(([net, addr]) => ({ network: net, address: addr }));

    const tronWeb = masterAddresses.trc20 ? createTronWebIfNeeded('trc20') : null;

    const master = {};

    await Promise.all(activeNetworks.map(async ({ network, address }) => {
      const networkInfo = NETWORKS[network];

      if (network === 'btc') {
        // BTC: single balance check (BTC is its own native token)
        const btcClient = require('./services/bitcoinClient');
        const balResult = await btcClient.getBalance(address);
        master[network] = {
          address,
          native: { token: 'BTC', balance: balResult.balance },
          tokens: { BTC: balResult.balance },
        };
        return;
      }

      const tw = network === 'trc20' ? tronWeb : null;

      // Token networks: check native gas + each supported token
      const tokenCoins = SUPPORTED_COINS.filter(c => c !== 'BTC'); // BTC is not a token on other networks
      const [nativeResult, ...tokenResults] = await Promise.all([
        getNativeBalance(network, address, tw),
        ...tokenCoins.map((coin) =>
          getTokenBalance(network, coin, address, tw).then((r) => ({ coin, balance: r.balance }))
        ),
      ]);

      const tokens = {};
      tokenResults.forEach((t) => { tokens[t.coin] = t.balance; });

      master[network] = {
        address,
        native: { token: networkInfo.nativeToken, balance: nativeResult.balance },
        tokens,
      };
    }));

    const elapsed = Date.now() - startTime;
    return res.json({ success: true, master, elapsed: `${elapsed}ms` });

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`GET /api/master/health error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Internal server error', elapsed: `${elapsed}ms` });
  }
});

// ─── Start (only when run directly, not when imported by Vercel) ───

// ─── Deposit tracking cron ───────────────────────────────────────────────────
/**
 * GET /api/cron/check-deposits
 * Called by Vercel cron every 15 minutes (see vercel.json).
 * Also callable manually with Authorization: Bearer $CRON_SECRET.
 */
app.get('/api/cron/check-deposits', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }

  try {
    const { processDeposits } = require('./utils/depositDetector');
    const stats = await processDeposits();
    res.json({ success: true, ...stats });
  } catch (err) {
    logger.error(`[CRON] Deposit check failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/withdraw-move ──────────────────────────────────

/**
 * POST /api/withdraw-move
 *
 * Moves a user's crypto to the platform master wallet as part of a crypto-to-NGN
 * withdrawal. Caller is always the sendcoins backend — not an end user directly.
 *
 * Body:   { userApiKey, coin, network, amount, withdrawalReference, idempotencyKey }
 * Response: { success, strategy, onchainTxHash, onchainAmount, dbDebitAmount,
 *             transferReference, withdrawalReference, elapsed, idempotent? }
 */
app.post('/api/withdraw-move', requireApiSecret, async (req, res) => {
  const { userApiKey, coin, network, amount, withdrawalReference, idempotencyKey } = req.body;

  const errors = [];
  if (!userApiKey        || typeof userApiKey        !== 'string') errors.push('userApiKey is required');
  if (!coin              || typeof coin              !== 'string') errors.push('coin is required (e.g. USDT, USDC)');
  if (!network           || typeof network           !== 'string') errors.push('network is required (e.g. trc20, bep20, erc20)');
  if (amount == null     || typeof amount            !== 'number' || amount <= 0) errors.push('amount must be a positive number');
  if (!withdrawalReference || typeof withdrawalReference !== 'string') errors.push('withdrawalReference is required');
  if (!idempotencyKey    || typeof idempotencyKey    !== 'string') errors.push('idempotencyKey is required');

  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }

  const started = Date.now();
  logger.info(`════════════════════════════════════════════`);
  logger.info(`POST /api/withdraw-move RECEIVED`);
  logger.info(`  User:      ${userApiKey}`);
  logger.info(`  Coin:      ${coin}`);
  logger.info(`  Network:   ${network}`);
  logger.info(`  Amount:    ${amount}`);
  logger.info(`  WdRef:     ${withdrawalReference}`);
  logger.info(`  IdempKey:  ${idempotencyKey}`);
  logger.info(`  API Secret header present: ${!!req.headers['x-api-secret']}`);
  logger.info(`════════════════════════════════════════════`);
  try {
    const withdrawMoveService = require('./services/withdrawMoveService');
    const result = await withdrawMoveService.executeWithdrawMove({
      userApiKey,
      coin,
      network,
      amount: Number(amount),
      withdrawalReference,
      idempotencyKey,
    });
    logger.info(`════════════════════════════════════════════`);
    logger.info(`POST /api/withdraw-move SUCCESS`);
    logger.info(`  Strategy:    ${result.strategy}`);
    logger.info(`  TransferRef: ${result.transferReference}`);
    logger.info(`  OnchainTx:   ${result.onchainTxHash || 'N/A (DB_WITHDRAW)'}`);
    logger.info(`  OnchainAmt:  ${result.onchainAmount}`);
    logger.info(`  DbDebitAmt:  ${result.dbDebitAmount}`);
    logger.info(`  Elapsed:     ${Date.now() - started}ms`);
    logger.info(`════════════════════════════════════════════`);
    return res.json({ ...result, elapsed: Date.now() - started });
  } catch (err) {
    logger.error(`════════════════════════════════════════════`);
    logger.error(`POST /api/withdraw-move FAILED`);
    logger.error(`  Error:   ${err.message}`);
    logger.error(`  Code:    ${err.code || 'N/A'}`);
    logger.error(`  Stack:   ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    logger.error(`  Elapsed: ${Date.now() - started}ms`);
    logger.error(`════════════════════════════════════════════`);
    const status = err.code === 'KEY_NOT_FOUND' ? 500 : 400;
    return res.status(status).json({
      success: false,
      error:   err.message,
      code:    err.code || 'EXECUTION_FAILED',
      elapsed: Date.now() - started,
    });
  }
});

// ─── POST /api/transfer/cancel ──────────────────────────────

/**
 * POST /api/transfer/cancel
 *
 * Cancels a pending_funding transfer — unlocks the user's locked balance
 * and marks the wallet_transfers record as cancelled.
 * Called by admin when cancelling a pending_funding transfer.
 *
 * Body: { reference }
 */
app.post('/api/transfer/cancel', requireApiSecret, async (req, res) => {
  const { reference } = req.body;
  if (!reference) {
    return res.status(400).json({ success: false, error: 'reference is required' });
  }

  try {
    const transfer = await queries.getTransferByReference(reference);
    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found' });
    }

    if (transfer.status !== 'pending_funding') {
      return res.status(400).json({ success: false, error: `Cannot cancel transfer with status "${transfer.status}". Only pending_funding transfers can be cancelled.` });
    }

    const meta = typeof transfer.metadata === 'string' ? JSON.parse(transfer.metadata) : (transfer.metadata || {});
    const coin = transfer.asset;
    const network = transfer.network;
    const userApiKey = transfer.user_api_key;

    // Unlock the locked balance
    const { unlockBalance } = require('./services/lockService');
    const lockAmount = parseFloat(transfer.amount) + (meta.platformFee || 0);

    logger.info(`[CANCEL] Unlocking ${lockAmount} ${coin} for user ${userApiKey.substring(0, 8)}...`);
    await unlockBalance(userApiKey, coin, lockAmount, network);

    // Mark transfer as cancelled
    await queries.updateTransferStatus(reference, 'cancelled', {
      cancelledAt: new Date().toISOString(),
      cancelledBy: 'admin',
    });

    logger.info(`[CANCEL] Transfer ${reference} cancelled, ${lockAmount} ${coin} unlocked`);
    return res.json({ success: true, reference, unlocked: lockAmount, coin });

  } catch (err) {
    logger.error(`[CANCEL] Failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/transfer/resolve ─────────────────────────────

/**
 * POST /api/transfer/resolve
 *
 * Resolves a pending_funding transfer — admin sent crypto manually, provide TX hash.
 * Deducts the locked balance and marks transfer as completed.
 *
 * Body: { reference, txHash }
 */
app.post('/api/transfer/resolve', requireApiSecret, async (req, res) => {
  const { reference, txHash } = req.body;
  if (!reference) return res.status(400).json({ success: false, error: 'reference is required' });
  if (!txHash) return res.status(400).json({ success: false, error: 'txHash is required' });

  try {
    const transfer = await queries.getTransferByReference(reference);
    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found' });
    }

    if (transfer.status !== 'pending_funding') {
      return res.status(400).json({ success: false, error: `Cannot resolve transfer with status "${transfer.status}". Only pending_funding transfers can be resolved.` });
    }

    const meta = typeof transfer.metadata === 'string' ? JSON.parse(transfer.metadata) : (transfer.metadata || {});
    const coin = transfer.asset;
    const network = transfer.network;
    const userApiKey = transfer.user_api_key;

    // Deduct the locked balance (lock → deduct converts the hold into a real deduction)
    const { deductBalance } = require('./services/lockService');
    const deductAmount = parseFloat(transfer.amount) + (meta.platformFee || 0);
    logger.info(`[RESOLVE] Deducting ${deductAmount} ${coin} for user ${userApiKey.substring(0, 8)}...`);
    await deductBalance(userApiKey, coin, deductAmount, network);

    // Mark transfer as completed with the admin-provided TX hash
    await queries.updateTransferStatus(reference, 'completed', {
      txid: txHash,
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'admin',
      resolutionType: 'manual_tx',
    });

    logger.info(`[RESOLVE] Transfer ${reference} resolved with txHash=${txHash}`);
    return res.json({ success: true, reference, txHash, deducted: deductAmount, coin });

  } catch (err) {
    logger.error(`[RESOLVE] Failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    const { getContractAddress } = require('./config/contracts');
    logger.info(`════════════════════════════════════════════════════`);
    logger.info(`Crypto TX Engine listening on port ${PORT}`);
    logger.info(`════════════════════════════════════════════════════`);
    logger.info(`TRON_NETWORK:    ${config.TRON_NETWORK}`);
    logger.info(`Master address:  ${config.MASTER_WALLET_TRON_ADDRESS}`);
    logger.info(`Master key:      ${config.MASTER_WALLET_TRON_PRIVATE_KEY?.substring(0, 8)}...`);
    logger.info(`USDT contract:   ${getContractAddress(config.TRON_NETWORK, 'USDT')}`);
    logger.info(`Fee limit:       ${config.FEE_LIMIT} SUN (${config.FEE_LIMIT / 1e6} TRX)`);
    logger.info(`Min TRX for gas: ${config.MIN_TRX_FOR_GAS}`);
    logger.info(`────────────────────────────────────────────────────`);
    logger.info(`BTC_NETWORK:     ${config.BTC_NETWORK}`);
    logger.info(`BTC master addr: ${config.MASTER_WALLET_BTC_ADDRESS || '(not configured)'}`);
    logger.info(`BTC min send:    ${config.BTC_MIN_SEND} BTC`);
    logger.info(`BTC max send:    ${config.BTC_MAX_SEND} BTC`);
    logger.info(`════════════════════════════════════════════════════`);
    logger.info(`Health:   GET  http://localhost:${PORT}/api/health`);
    logger.info(`Balance:  GET  http://localhost:${PORT}/api/balance`);
    logger.info(`Transfer: GET  http://localhost:${PORT}/api/transfer/:ref`);
    logger.info(`History:  GET  http://localhost:${PORT}/api/transfers`);
    logger.info(`Fees:     GET  http://localhost:${PORT}/api/fees`);
    logger.info(`Send:     POST http://localhost:${PORT}/api/send`);
    logger.info(`Master:   GET  http://localhost:${PORT}/api/master/health`);
  });
}

module.exports = app;
