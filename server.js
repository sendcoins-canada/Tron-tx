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

    const [tokenResult, nativeResult] = await Promise.all([
      getTokenBalance(normalizedNetwork, normalizedCoin, wallet.wallet_address, tronWeb),
      getNativeBalance(normalizedNetwork, wallet.wallet_address, tronWeb),
    ]);

    const dbTotal = parseFloat(wallet.total_balance) || 0;
    const dbLocked = parseFloat(wallet.locked_amount) || 0;
    const dbAvailable = dbTotal - dbLocked;

    const networkInfo = NETWORKS[normalizedNetwork];

    const elapsed = Date.now() - startTime;
    return res.json({
      success: true,
      coin: normalizedCoin,
      network: normalizedNetwork,
      walletAddress: wallet.wallet_address,
      dbBalance: { total: dbTotal, locked: dbLocked, available: dbAvailable },
      onChainBalance: tokenResult.balance,
      gasBalance: {
        balance: nativeResult.balance,
        token: networkInfo.nativeToken,
        sufficient: nativeResult.balance >= networkInfo.gasThreshold,
      },
      totalAvailable: dbAvailable + tokenResult.balance,
      elapsed: `${elapsed}ms`,
    });

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

    const elapsed = Date.now() - startTime;
    return res.json({
      success: true,
      transfer: {
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
      },
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

app.get('/api/fees', (req, res) => {
  const { amount } = req.query;
  const numAmount = parseFloat(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, error: 'amount is required and must be positive' });
  }

  let fee = 2;
  if (numAmount > 500) fee = 5;
  else if (numAmount === 500) fee = 4;

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
      let fee = 2;
      if (sendParams.amount > 500) fee = 5;
      else if (sendParams.amount === 500) fee = 4;

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
    };

    const activeNetworks = Object.entries(masterAddresses)
      .filter(([, addr]) => !!addr)
      .map(([net, addr]) => ({ network: net, address: addr }));

    const tronWeb = masterAddresses.trc20 ? createTronWebIfNeeded('trc20') : null;

    const master = {};

    await Promise.all(activeNetworks.map(async ({ network, address }) => {
      const networkInfo = NETWORKS[network];
      const tw = network === 'trc20' ? tronWeb : null;

      const [nativeResult, ...tokenResults] = await Promise.all([
        getNativeBalance(network, address, tw),
        ...SUPPORTED_COINS.map((coin) =>
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
