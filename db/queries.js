const pool = require('./index');

const ALLOWED_COINS = ['usdt', 'usdc', 'btc', 'eth', 'bnb', 'trx', 'ltc', 'sol', 'pol'];

/**
 * Validate coin symbol to prevent SQL injection in table name interpolation.
 */
function validateCoin(coinSymbol) {
  const coin = coinSymbol.toLowerCase();
  if (!ALLOWED_COINS.includes(coin)) {
    throw new Error(`Invalid coin symbol: ${coinSymbol}`);
  }
  return coin;
}

/**
 * Promisified pool.query wrapper.
 */
function query(sql, params = []) {
  return pool.query(sql, params);
}

// ─── User queries ────────────────────────────────────────────

async function getUserByApiKey(apiKey) {
  const result = await query(
    'SELECT * FROM send_coin_user WHERE api_key = $1 LIMIT 1',
    [apiKey]
  );
  return result.rows[0] || null;
}

async function getUserByEmail(email) {
  const result = await query(
    'SELECT * FROM send_coin_user WHERE user_email = $1 LIMIT 1',
    [email]
  );
  return result.rows[0] || null;
}

// ─── Wallet queries ──────────────────────────────────────────

/**
 * Get all wallet instances for a coin (all networks).
 * Ordered by wallet_id for consistent "first instance" semantics.
 */
async function getWalletInstances(coinSymbol, userApiKey) {
  const coin = validateCoin(coinSymbol);
  const table = `azer_${coin}_wallet`;
  const result = await query(
    `SELECT * FROM ${table} WHERE user_api_key = $1 ORDER BY wallet_id ASC`,
    [userApiKey]
  );
  return result.rows;
}

/**
 * Get wallet by coin + network.
 */
async function getWalletByNetwork(coinSymbol, userApiKey, network) {
  const coin = validateCoin(coinSymbol);
  const table = `azer_${coin}_wallet`;
  const result = await query(
    `SELECT * FROM ${table} WHERE user_api_key = $1 AND network = $2`,
    [userApiKey, network.toLowerCase()]
  );
  return result.rows[0] || null;
}

// ─── Private key lookup ──────────────────────────────────────

async function getPrivateKeyByHash(hash) {
  const result = await query(
    'SELECT token FROM azer_hash WHERE hash = $1 LIMIT 1',
    [hash]
  );
  return result.rows[0]?.token || null;
}

// ─── Transfer records ────────────────────────────────────────

function createRandomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let str = '';
  for (let i = 0; i < length; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return str;
}

/**
 * Create a wallet_transfers record (same schema as sql.walletTransfer.create).
 */
async function createTransfer(transfer) {
  const reference = createRandomString(24);
  const createdAt = Math.floor(Date.now() / 1000);
  const status = transfer.status || 'pending';

  const sql = `
    INSERT INTO wallet_transfers
    (reference, user_api_key, recipient_keychain, recipient_name, recipient_wallet_address,
     asset, network, amount, fee, status, note, metadata, ip_address, device, created_at, tx_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING transfer_id, reference, status, created_at
  `;

  const values = [
    reference,
    transfer.userApiKey,
    transfer.recipientKeychain || null,
    transfer.recipientName || null,
    transfer.walletAddress,
    transfer.asset,
    transfer.network,
    parseFloat(transfer.amount),
    transfer.fee || null,
    status,
    transfer.note || null,
    transfer.metadata ? JSON.stringify(transfer.metadata) : null,
    transfer.ip || null,
    transfer.device || null,
    createdAt,
    transfer.txHash || null,
  ];

  const result = await query(sql, values);
  return { reference, ...result.rows[0] };
}

/**
 * Update transfer status, tx_hash, and metadata.
 */
async function updateTransferStatus(reference, status, metadata = {}) {
  const updatedAt = Math.floor(Date.now() / 1000);
  const txHash = metadata.txid || null;

  const metaJson = Object.keys(metadata).length
    ? JSON.stringify(metadata)
    : null;

  await query(
    `UPDATE wallet_transfers
     SET status = $1,
         tx_hash = COALESCE($2, tx_hash),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb),
         updated_at = $4
     WHERE reference = $5`,
    [status, txHash, metaJson, updatedAt, reference]
  );
}

// ─── Transfer lookups ───────────────────────────────────────

async function getTransferByReference(reference) {
  const result = await query(
    'SELECT * FROM wallet_transfers WHERE reference = $1 LIMIT 1',
    [reference]
  );
  return result.rows[0] || null;
}

async function findWalletOwnerByAddress(coinSymbol, address, network) {
  const coin = validateCoin(coinSymbol);
  const table = `azer_${coin}_wallet`;
  const result = await query(
    `SELECT user_api_key, wallet_address, network FROM ${table}
     WHERE wallet_address = $1 AND network = $2 LIMIT 1`,
    [address, network.toLowerCase()]
  );
  return result.rows[0] || null;
}

async function findReceiveBySendReference(sendReference, recipientApiKey) {
  const result = await query(
    `SELECT reference FROM wallet_transfers
     WHERE metadata->>'sendReference' = $1 AND user_api_key = $2 LIMIT 1`,
    [sendReference, recipientApiKey]
  );
  return result.rows[0] || null;
}

async function getTransfersByUser(userApiKey, { type, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM wallet_transfers WHERE user_api_key = $1';
  const params = [userApiKey];

  if (type === 'receive') {
    sql += ` AND metadata->>'type' = 'receive'`;
  } else if (type === 'send') {
    sql += ` AND (metadata->>'type' IS NULL OR metadata->>'type' != 'receive')`;
  }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return result.rows;
}

async function findByIdempotencyKey(idempotencyKey, userApiKey) {
  const result = await query(
    `SELECT * FROM wallet_transfers WHERE metadata->>'idempotencyKey' = $1 AND user_api_key = $2 LIMIT 1`,
    [idempotencyKey, userApiKey]
  );
  return result.rows[0] || null;
}

module.exports = {
  query,
  validateCoin,
  getUserByApiKey,
  getUserByEmail,
  getWalletInstances,
  getWalletByNetwork,
  getPrivateKeyByHash,
  createTransfer,
  updateTransferStatus,
  getTransferByReference,
  findWalletOwnerByAddress,
  findReceiveBySendReference,
  getTransfersByUser,
  findByIdempotencyKey,
};
