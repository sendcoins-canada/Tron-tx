/**
 * BTC confirmation checker — polls Blockstream for pending_confirmation
 * BTC transfers and marks them completed once confirmed on-chain.
 *
 * Called by /api/cron/check-btc-confirmations endpoint.
 */

const axios = require('axios');
const config = require('../config');
const queries = require('../db/queries');
const logger = require('./logger');
const { getExplorerBase, getApiBase } = require('../services/bitcoinClient');

/**
 * Check all pending_confirmation BTC transfers and update their status.
 */
async function checkBtcConfirmations() {
  const results = { checked: 0, confirmed: 0, failed: 0, errors: [] };

  try {
    // Find all BTC transfers with pending_confirmation status
    const pending = await queries.query(
      `SELECT transfer_id, reference, tx_hash, metadata, created_at
       FROM wallet_transfers
       WHERE asset = 'BTC' AND network = 'btc' AND status = 'pending_confirmation'
         AND tx_hash IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 50`
    );

    if (pending.rows.length === 0) {
      logger.info('[BTC_CONFIRM] No pending_confirmation BTC transfers to check');
      return results;
    }

    logger.info(`[BTC_CONFIRM] Checking ${pending.rows.length} pending BTC transfer(s)...`);
    const apiBase = getApiBase();

    for (const transfer of pending.rows) {
      results.checked++;
      const txHash = transfer.tx_hash;

      try {
        const { data: txData } = await axios.get(`${apiBase}/tx/${txHash}`, { timeout: 15000 });

        if (txData.status && txData.status.confirmed) {
          // Confirmed on-chain
          await queries.updateTransferStatus(transfer.reference, 'completed', {
            confirmedAt: new Date().toISOString(),
            blockHeight: txData.status.block_height,
            blockHash: txData.status.block_hash,
            confirmationSource: 'cron',
          });

          results.confirmed++;
          logger.info(`[BTC_CONFIRM] ${transfer.reference} confirmed at block ${txData.status.block_height}`);
        } else {
          // Still unconfirmed — check if it's been too long (>24 hours = likely dropped)
          const createdAt = typeof transfer.created_at === 'bigint'
            ? Number(transfer.created_at)
            : new Date(transfer.created_at).getTime();
          const ageMs = Date.now() - createdAt;
          const ageHours = ageMs / (1000 * 60 * 60);

          if (ageHours > 24) {
            // TX has been unconfirmed for over 24 hours — mark as failed
            await queries.updateTransferStatus(transfer.reference, 'failed', {
              error: 'BTC transaction not confirmed after 24 hours — likely dropped from mempool',
              failedAt: new Date().toISOString(),
            });
            results.failed++;
            logger.warn(`[BTC_CONFIRM] ${transfer.reference} failed — unconfirmed for ${ageHours.toFixed(1)}h`);
          } else {
            logger.info(`[BTC_CONFIRM] ${transfer.reference} still unconfirmed (${ageHours.toFixed(1)}h old)`);
          }
        }

        // Small delay between API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        results.errors.push({ reference: transfer.reference, error: err.message });
        logger.warn(`[BTC_CONFIRM] Error checking ${transfer.reference}: ${err.message}`);
      }
    }

    logger.info(`[BTC_CONFIRM] Done — checked: ${results.checked}, confirmed: ${results.confirmed}, failed: ${results.failed}, errors: ${results.errors.length}`);
    return results;

  } catch (err) {
    logger.error(`[BTC_CONFIRM] Fatal error: ${err.message}`);
    results.errors.push({ error: err.message });
    return results;
  }
}

module.exports = { checkBtcConfirmations };
