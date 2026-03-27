/**
 * Dry-Run E2E Test: Fake Balance + Detailed Logging
 *
 * 1. Picks a yopmail test user from prod DB
 * 2. Sets fake total_balance = 50 on their USDT TRC20 wallet
 * 3. Calls sendCrypto() — expects MASTER_SEND strategy
 * 4. Blockchain call WILL fail (no TRX in master) — that's expected
 * 5. Restores original balance in finally block
 *
 * Usage: node test-e2e.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const pool = require('./db');
const queries = require('./db/queries');
const { sendCrypto } = require('./services/walletService');
const logger = require('./utils/logger');
const chalk = require('chalk');

const RECIPIENT_ADDRESS = 'TSX6tFiduWZtZX5cqG489v7VPKyczvxnfm';
const SEND_AMOUNT = 1;
const FAKE_BALANCE = 50;
const COIN = 'USDT';
const NETWORK = 'trc20';

async function findTestUser() {
  const result = await pool.query(`
    SELECT u.user_email, u.api_key, u.account_ban,
           w.wallet_id, w.network, w.total_balance, w.locked_amount, w.wallet_address
    FROM send_coin_user u
    JOIN azer_usdt_wallet w ON w.user_api_key = u.api_key
    WHERE u.user_email LIKE '%@yopmail.com'
      AND w.network = 'trc20'
    ORDER BY u.azer_id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    throw new Error('No yopmail test user found with a USDT TRC20 wallet');
  }
  return result.rows[0];
}

async function setBalance(apiKey, amount) {
  await pool.query(
    `UPDATE azer_usdt_wallet SET total_balance = $1 WHERE user_api_key = $2 AND network = $3`,
    [amount, apiKey, NETWORK]
  );
}

async function getBalance(apiKey) {
  const result = await queries.getWalletByNetwork(COIN, apiKey, NETWORK);
  return result ? { total_balance: result.total_balance, locked_amount: result.locked_amount } : null;
}

(async () => {
  let testUser = null;
  let originalBalance = null;

  try {
    console.log(chalk.bold.cyan('\n  DRY-RUN E2E TEST'));
    console.log(chalk.cyan('══════════════════════════════════════════════════\n'));

    // 1. Find test user
    logger.step(1, 'FIND TEST USER');
    testUser = await findTestUser();
    originalBalance = testUser.total_balance;

    logger.table('Email', testUser.user_email);
    logger.table('API Key', testUser.api_key.substring(0, 8) + '...');
    logger.table('Current Balance', String(originalBalance));
    logger.table('Wallet Address', testUser.wallet_address || 'N/A');

    // 2. Set fake balance
    logger.step(2, 'SET FAKE BALANCE');
    await setBalance(testUser.api_key, FAKE_BALANCE);
    const verified = await getBalance(testUser.api_key);
    logger.info(`Balance set to: ${verified?.total_balance}`);

    // 3. Run sendCrypto
    logger.step(3, 'EXECUTE sendCrypto()');
    logger.table('Recipient', RECIPIENT_ADDRESS);
    logger.table('Amount', String(SEND_AMOUNT));
    console.log(chalk.yellow('\n  ── sendCrypto() output below ──\n'));

    const result = await sendCrypto({
      userApiKey: testUser.api_key,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: SEND_AMOUNT,
      coin: COIN,
      network: NETWORK,
    });

    console.log(chalk.yellow('\n  ── sendCrypto() returned ──\n'));

    if (result.success) {
      logger.success(`sendCrypto SUCCEEDED`);
      logger.table('TXID', result.txid);
      logger.table('Reference', result.reference);
      logger.table('Strategy', result.strategy);
    } else {
      logger.warn(`sendCrypto returned failure (expected in dry-run)`);
      logger.table('Error', result.error);
      logger.table('Reference', result.reference || 'N/A');
    }

    // 4. Check transfer record
    logger.step(4, 'CHECK TRANSFER RECORD');
    const transfers = await pool.query(
      `SELECT reference, status, amount, tx_hash, metadata FROM wallet_transfers
       WHERE user_api_key = $1 ORDER BY transfer_id DESC LIMIT 1`,
      [testUser.api_key]
    );
    const transfer = transfers.rows[0];
    if (transfer) {
      logger.table('Reference', transfer.reference);
      logger.table('Status', transfer.status);
      logger.table('Amount', String(transfer.amount));
      logger.table('Metadata', JSON.stringify(transfer.metadata));
    }

    console.log(chalk.bold.green('\n  E2E DRY-RUN COMPLETE'));
    console.log(chalk.green('══════════════════════════════════════════════════\n'));

  } catch (err) {
    logger.error(`FATAL: ${err.message}`);
    logger.error(err.stack);
  } finally {
    // Always restore balance
    if (testUser) {
      try {
        await setBalance(testUser.api_key, originalBalance);
        await pool.query(
          `UPDATE azer_usdt_wallet SET locked_amount = 0 WHERE user_api_key = $1 AND network = $2`,
          [testUser.api_key, NETWORK]
        );
        logger.info(`Balance restored to ${originalBalance}, locked_amount reset to 0`);
      } catch (cleanupErr) {
        logger.error(`CLEANUP FAILED: ${cleanupErr.message}`);
      }
    }
    await pool.end();
    logger.info('DB pool closed. Done.');
  }
})();
