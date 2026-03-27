/**
 * HTTP API server for the crypto-tx-engine.
 *
 * Endpoints:
 *   POST /api/send   — Send crypto
 *   GET  /api/health — Health check
 *
 * Usage:
 *   node server.js              # starts on PORT (default 4100)
 *   PORT=5000 node server.js    # custom port
 */

const express = require('express');
const { sendCrypto } = require('./services/walletService');
const { SUPPORTED_COINS, SUPPORTED_NETWORKS } = require('./config/networks');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4100;

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'crypto-tx-engine',
    timestamp: new Date().toISOString(),
    supportedCoins: SUPPORTED_COINS,
    supportedNetworks: SUPPORTED_NETWORKS,
  });
});

/**
 * POST /api/send
 *
 * Body: { userApiKey, recipientAddress, amount, coin, network, recipientName?, note? }
 * Response: { success, txid?, reference?, strategy?, error?, elapsed }
 */
app.post('/api/send', async (req, res) => {
  const startTime = Date.now();

  try {
    const { userApiKey, recipientAddress, amount, coin, network, recipientName, note } = req.body;

    // Validate required fields are present and correct type
    const errors = [];
    if (!userApiKey || typeof userApiKey !== 'string') errors.push('userApiKey is required');
    if (!recipientAddress || typeof recipientAddress !== 'string') errors.push('recipientAddress is required');
    if (!amount || typeof amount !== 'number' || amount <= 0) errors.push('amount must be a positive number');
    if (!coin || typeof coin !== 'string') errors.push('coin is required (e.g. USDT, USDC)');
    if (!network || typeof network !== 'string') errors.push('network is required (e.g. trc20, bep20, erc20)');

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    logger.info(`POST /api/send — ${coin} ${network} ${amount} → ${recipientAddress.substring(0, 10)}...`);

    // sendCrypto handles all business validation (coin, network, address, balance)
    const result = await sendCrypto({
      userApiKey,
      recipientAddress,
      amount: parseFloat(amount),
      coin,
      network,
      recipientName,
      note,
      ip: req.ip,
      device: req.headers['user-agent'],
    });

    const elapsed = Date.now() - startTime;

    if (result.success) {
      return res.json({
        success: true,
        txid: result.txid,
        reference: result.reference,
        strategy: result.strategy,
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

app.listen(PORT, () => {
  logger.info(`Crypto TX Engine listening on port ${PORT}`);
  logger.info(`Health: http://localhost:${PORT}/api/health`);
  logger.info(`Send:   POST http://localhost:${PORT}/api/send`);
});
