/**
 * Balance locking service — replicates the exact pattern from
 * sendcoins/functions/conversionService.js (lines 750-922).
 *
 * Uses BEGIN -> SELECT FOR UPDATE -> validate -> UPDATE -> COMMIT
 * with a dedicated pool client per transaction to prevent interleaving.
 */
const pool = require('../db');
const { validateCoin } = require('../db/queries');
const logger = require('../utils/logger');

/**
 * Build WHERE clause and params for multi-network assets.
 */
function buildWhere(coin, userApiKey, network) {
  if ((coin === 'usdt' || coin === 'usdc') && network) {
    return {
      clause: 'user_api_key = $1 AND network = $2',
      params: [userApiKey, network.toLowerCase()],
    };
  }
  return { clause: 'user_api_key = $1', params: [userApiKey] };
}

/**
 * Lock balance on a user's wallet (BEGIN -> FOR UPDATE -> UPDATE -> COMMIT).
 */
async function lockBalance(userApiKey, asset, network, amount) {
  const coin = validateCoin(asset);
  const tableName = `azer_${coin}_wallet`;
  const { clause, params } = buildWhere(coin, userApiKey, network);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT total_balance, locked_amount FROM ${tableName} WHERE ${clause} FOR UPDATE`,
      params
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        success: false,
        statusCode: 404,
        response: {
          title: 'Wallet Not Found',
          message: `No ${asset.toUpperCase()} wallet found for this user on ${network}`,
          isSuccess: false,
          icon: 'error',
        },
      };
    }

    const wallet = result.rows[0];
    const totalBalance = parseFloat(wallet.total_balance) || 0;
    const lockedAmount = parseFloat(wallet.locked_amount) || 0;
    const availableBalance = totalBalance - lockedAmount;

    if (amount > availableBalance) {
      await client.query('ROLLBACK');
      return {
        success: false,
        statusCode: 400,
        response: {
          title: 'Insufficient Balance',
          message: `Insufficient ${asset.toUpperCase()} balance. Available: ${availableBalance.toFixed(8)}, Required: ${amount.toFixed(8)}`,
          isSuccess: false,
          icon: 'error',
        },
      };
    }

    await client.query(
      `UPDATE ${tableName} SET locked_amount = locked_amount + $${params.length + 1} WHERE ${clause}`,
      [...params, amount]
    );

    await client.query('COMMIT');

    logger.info(`Locked ${amount} ${asset.toUpperCase()} for user ${userApiKey.substring(0, 8)}...`);
    return { success: true, statusCode: 200, response: { message: 'Balance locked successfully' } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`Lock balance error: ${err.message}`);
    return {
      success: false,
      statusCode: 500,
      response: { title: 'Lock Error', message: 'Failed to lock balance', isSuccess: false, icon: 'error' },
    };
  } finally {
    client.release();
  }
}

/**
 * Unlock balance (rollback lock).
 */
async function unlockBalance(userApiKey, asset, amount, network) {
  const coin = validateCoin(asset);
  const tableName = `azer_${coin}_wallet`;
  const { clause, params } = buildWhere(coin, userApiKey, network);

  const result = await pool.query(
    `UPDATE ${tableName} SET locked_amount = GREATEST(locked_amount - $${params.length + 1}, 0) WHERE ${clause}`,
    [...params, amount]
  );
  logger.info(`Unlocked ${amount} ${asset.toUpperCase()} (rows: ${result.rowCount})`);
}

/**
 * Deduct balance (from both total and locked).
 */
async function deductBalance(userApiKey, asset, amount, network) {
  const coin = validateCoin(asset);
  const tableName = `azer_${coin}_wallet`;
  const { clause, params } = buildWhere(coin, userApiKey, network);

  logger.info(`[DEDUCT] ════════════════════════════════════════`);
  logger.info(`[DEDUCT] Table:   ${tableName}`);
  logger.info(`[DEDUCT] WHERE:   ${clause}`);
  logger.info(`[DEDUCT] Amount:  ${amount} ${asset.toUpperCase()}`);
  logger.info(`[DEDUCT] Network: ${network || 'all'}`);
  logger.info(`[DEDUCT] User:    ${userApiKey.substring(0, 8)}...`);

  const result = await pool.query(
    `UPDATE ${tableName}
     SET total_balance = total_balance - $${params.length + 1},
         locked_amount = GREATEST(locked_amount - $${params.length + 1}, 0)
     WHERE ${clause}`,
    [...params, amount]
  );
  logger.info(`[DEDUCT] Rows affected: ${result.rowCount}`);
  if (result.rowCount === 0) {
    logger.warn(`[DEDUCT] WARNING — 0 rows affected! Check if wallet exists for this user/network`);
  }
  logger.info(`[DEDUCT] ════════════════════════════════════════`);
}

module.exports = { lockBalance, unlockBalance, deductBalance };
