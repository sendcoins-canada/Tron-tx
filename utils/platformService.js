/**
 * Platform fee recording and admin notifications.
 * Direct DB operations — same tables as sendcoins backend.
 */
const pool = require('../db');
const logger = require('./logger');

/**
 * Record a platform fee in the ledger and update the platform account balance.
 */
async function recordFee({ transactionType, source, sourceReference, currency, amount, usdEquivalent, description, userApiKey }) {
  try {
    logger.info(`[PLATFORM] Recording fee: ${amount} ${currency} — ${transactionType}`);

    const accountResult = await pool.query(
      `SELECT * FROM platform_accounts WHERE currency = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [currency]
    );

    const account = accountResult.rows[0] || null;
    const balanceBefore = account ? parseFloat(account.current_balance) : 0;
    const balanceAfter = balanceBefore + parseFloat(amount);

    await pool.query(
      `INSERT INTO platform_ledger
       (transaction_type, source, source_reference, platform_account_id, currency, amount, usd_equivalent,
        balance_before, balance_after, status, description, related_user_api_key, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'collected', $10, $11, 'system')`,
      [transactionType, source, sourceReference, account ? account.id : null, currency,
       parseFloat(amount), usdEquivalent ? parseFloat(usdEquivalent) : null,
       balanceBefore, balanceAfter, description, userApiKey || null]
    );

    if (account) {
      await pool.query(
        `UPDATE platform_accounts SET current_balance = current_balance + $1, total_fees_collected = total_fees_collected + $1, last_updated = NOW() WHERE id = $2`,
        [parseFloat(amount), account.id]
      );
    }

    logger.info(`[PLATFORM] Fee recorded: ${balanceBefore.toFixed(2)} → ${balanceAfter.toFixed(2)}`);
  } catch (err) {
    logger.error(`[PLATFORM] Fee recording failed: ${err.message}`);
  }
}

/**
 * Notify all super admins via AdminNotification table.
 */
async function notifySuperAdmin({ title, message, metadata }) {
  try {
    const admins = await pool.query(
      `SELECT id FROM "AdminUser" WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'`
    );

    for (const admin of admins.rows) {
      await pool.query(
        `INSERT INTO "AdminNotification" ("adminId", "type", "category", "priority", "title", "message", "metadata", "isRead", "emailSent", "createdAt")
         VALUES ($1, 'HIGH_VALUE_TRANSACTION', 'TRANSACTION', 'NORMAL', $2, $3, $4, false, false, NOW())`,
        [admin.id, title, message, JSON.stringify(metadata || {})]
      );
    }

    logger.info(`[PLATFORM] Notified ${admins.rows.length} super admin(s)`);
  } catch (err) {
    logger.error(`[PLATFORM] Admin notification failed: ${err.message}`);
  }
}

module.exports = { recordFee, notifySuperAdmin };
