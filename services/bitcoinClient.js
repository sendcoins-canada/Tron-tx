/**
 * Bitcoin client — UTXO management, transaction building, signing, broadcasting.
 *
 * Uses bitcoinjs-lib for transaction construction and Blockstream API for
 * chain queries. Supports mainnet, testnet, and signet via BTC_NETWORK env var.
 *
 * Key differences from EVM/TRC20 tokens:
 *   - UTXO model (not account-based)
 *   - BTC itself pays mining fees (no separate gas token)
 *   - Dynamic fee rates based on mempool congestion (sat/vByte)
 *   - ~10 min confirmation time per block
 */

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const ECPair = ECPairFactory(ecc);

// ─── Network Selection ─────────────────────────────────────

function getBtcNetwork() {
  const net = (config.BTC_NETWORK || 'testnet').toLowerCase();
  switch (net) {
    case 'mainnet':  return bitcoin.networks.bitcoin;
    case 'signet':   // Signet uses testnet address format
    case 'testnet':  return bitcoin.networks.testnet;
    default:         return bitcoin.networks.testnet;
  }
}

function getApiBase() {
  const net = (config.BTC_NETWORK || 'testnet').toLowerCase();
  const bases = {
    mainnet: 'https://blockstream.info/api',
    testnet: 'https://blockstream.info/testnet/api',
    signet:  'https://blockstream.info/signet/api',
  };
  return bases[net] || bases.testnet;
}

function getExplorerBase() {
  const net = (config.BTC_NETWORK || 'testnet').toLowerCase();
  const bases = {
    mainnet: 'https://blockstream.info/tx/',
    testnet: 'https://blockstream.info/testnet/tx/',
    signet:  'https://blockstream.info/signet/tx/',
  };
  return bases[net] || bases.testnet;
}

// ─── Key Utilities ──────────────────────────────────────────

/**
 * Derive a key pair from a private key hex string.
 */
function keyPairFromHex(privateKeyHex) {
  const network = getBtcNetwork();
  const buf = Buffer.from(privateKeyHex, 'hex');
  return ECPair.fromPrivateKey(buf, { network });
}

/**
 * Get the P2WPKH (native SegWit / bc1) address from a private key hex.
 * Uses SegWit for lower fees.
 */
function getAddressFromPrivateKey(privateKeyHex) {
  const keyPair = keyPairFromHex(privateKeyHex);
  const network = getBtcNetwork();
  const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
  return address;
}

// ─── Balance & UTXO Queries ─────────────────────────────────

/**
 * Get confirmed + unconfirmed balance for an address.
 */
async function getBalance(address, retries = 3) {
  const api = getApiBase();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(`${api}/address/${address}`, { timeout: 15000 });
      const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
      const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
      return {
        balance: confirmed / 1e8,
        satoshis: confirmed,
        unconfirmedBalance: unconfirmed / 1e8,
        unconfirmedSatoshis: unconfirmed,
        address,
      };
    } catch (err) {
      logger.warn(`[BTC] Balance check attempt ${attempt}/${retries} failed for ${address}: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
      } else {
        logger.error(`[BTC] Balance check failed after ${retries} attempts for ${address}`);
        return { balance: 0, satoshis: 0, unconfirmedBalance: 0, unconfirmedSatoshis: 0, address, error: err.message };
      }
    }
  }
}

/**
 * Fetch unspent transaction outputs (UTXOs) for an address.
 * By default includes unconfirmed UTXOs (safe for self-change spending).
 * Set confirmedOnly=true to restrict to confirmed UTXOs only.
 */
async function getUtxos(address, confirmedOnly = false) {
  const api = getApiBase();
  const { data } = await axios.get(`${api}/address/${address}/utxo`, { timeout: 15000 });
  if (confirmedOnly) {
    const confirmed = data.filter(u => u.status && u.status.confirmed);
    logger.info(`[BTC] Found ${confirmed.length} confirmed UTXOs for ${address} (${data.length} total)`);
    return confirmed;
  }
  logger.info(`[BTC] Found ${data.length} UTXOs for ${address} (${data.filter(u => u.status?.confirmed).length} confirmed)`);
  return data;
}

/**
 * Fetch raw transaction hex (needed for non-SegWit input signing).
 */
async function getRawTx(txid) {
  const api = getApiBase();
  const { data } = await axios.get(`${api}/tx/${txid}/hex`, { timeout: 15000 });
  return data;
}

// ─── Fee Estimation ─────────────────────────────────────────

/**
 * Get recommended fee rates from mempool.space (sat/vByte).
 * Falls back to blockstream or a conservative default.
 */
async function getRecommendedFeeRate() {
  // If user set a fixed override, use that
  if (config.BTC_FEE_RATE) {
    logger.info(`[BTC] Using configured fee rate: ${config.BTC_FEE_RATE} sat/vB`);
    return { fast: config.BTC_FEE_RATE, medium: config.BTC_FEE_RATE, slow: config.BTC_FEE_RATE, source: 'config' };
  }

  try {
    const net = (config.BTC_NETWORK || 'testnet').toLowerCase();
    const base = net === 'mainnet'
      ? 'https://mempool.space/api'
      : `https://mempool.space/${net}/api`;
    const { data } = await axios.get(`${base}/v1/fees/recommended`, { timeout: 10000 });
    logger.info(`[BTC] Fee rates — fast: ${data.fastestFee}, medium: ${data.halfHourFee}, slow: ${data.hourFee} sat/vB`);
    return {
      fast: data.fastestFee,
      medium: data.halfHourFee,
      slow: data.hourFee,
      source: 'mempool.space',
    };
  } catch (err) {
    logger.warn(`[BTC] mempool.space fee API failed: ${err.message}, using default 10 sat/vB`);
    return { fast: 20, medium: 10, slow: 5, source: 'fallback' };
  }
}

/**
 * Estimate transaction fee in satoshis.
 * P2WPKH input ≈ 68 vBytes, output ≈ 31 vBytes, overhead ≈ 10.5 vBytes.
 */
function estimateTxSize(inputCount, outputCount) {
  const overhead = 10.5;
  const inputSize = 68; // P2WPKH witness input
  const outputSize = 31; // P2WPKH output
  return Math.ceil(overhead + (inputCount * inputSize) + (outputCount * outputSize));
}

function estimateFee(inputCount, outputCount, feeRate) {
  const vBytes = estimateTxSize(inputCount, outputCount);
  return Math.ceil(vBytes * feeRate);
}

// ─── Coin Selection ─────────────────────────────────────────

/**
 * Simple coin selection — sort UTXOs largest first, accumulate until target met.
 * Returns selected UTXOs and total input value.
 */
function selectUtxos(utxos, targetSats, feeRate) {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    // Estimate fee with current inputs + 2 outputs (recipient + change)
    const fee = estimateFee(selected.length, 2, feeRate);
    if (totalInput >= targetSats + fee) {
      return { selected, totalInput, fee };
    }
  }

  // Check if we can do it without change output (1 output)
  const feeNoChange = estimateFee(selected.length, 1, feeRate);
  if (totalInput >= targetSats + feeNoChange) {
    return { selected, totalInput, fee: feeNoChange, noChange: true };
  }

  // Not enough
  return { selected, totalInput, fee: estimateFee(selected.length, 2, feeRate), insufficient: true };
}

// ─── Transaction Building & Signing ─────────────────────────

/**
 * Build, sign, and return a raw Bitcoin transaction hex.
 *
 * @param {string} fromPrivateKeyHex - Sender's private key (hex)
 * @param {string} toAddress         - Recipient's Bitcoin address
 * @param {number} amountBtc         - Amount to send in BTC
 * @param {number} [feeRate]         - Fee rate in sat/vByte (auto if omitted)
 * @returns {{ txHex, txid, fee, feeBtc, vBytes }}
 */
async function buildTransaction(fromPrivateKeyHex, toAddress, amountBtc, feeRate, opts = {}) {
  const network = getBtcNetwork();
  const keyPair = keyPairFromHex(fromPrivateKeyHex);

  // Determine sender address — use stored address if provided (handles P2PKH legacy wallets),
  // otherwise derive P2WPKH (SegWit) address from private key
  const segwitAddress = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }).address;
  const fromAddress = opts.fromAddress || segwitAddress;

  // Detect address type for proper PSBT input construction
  const isSegwit = fromAddress.startsWith('bc1') || fromAddress.startsWith('tb1');
  const isP2PKH = fromAddress.startsWith('1') || fromAddress.startsWith('m') || fromAddress.startsWith('n');

  const amountSats = Math.round(amountBtc * 1e8);
  const DUST_LIMIT = 546; // Bitcoin dust threshold in satoshis

  logger.info(`[BTC] ════════════════════════════════════════════`);
  logger.info(`[BTC] Building transaction`);
  logger.info(`[BTC] From:    ${fromAddress} (${isSegwit ? 'SegWit P2WPKH' : isP2PKH ? 'Legacy P2PKH' : 'unknown'})`);
  logger.info(`[BTC] To:      ${toAddress}`);
  logger.info(`[BTC] Amount:  ${amountBtc} BTC (${amountSats} sats)`);
  logger.info(`[BTC] Network: ${config.BTC_NETWORK}`);

  if (amountSats < DUST_LIMIT) {
    throw Object.assign(new Error(`Amount ${amountBtc} BTC is below dust limit (${DUST_LIMIT} sats)`), { code: 'DUST_AMOUNT' });
  }

  // Fetch UTXOs — try stored address first, fall back to SegWit address
  let utxos = await getUtxos(fromAddress);
  if (utxos.length === 0 && fromAddress !== segwitAddress) {
    logger.info(`[BTC] No UTXOs at ${fromAddress}, trying SegWit address ${segwitAddress}`);
    utxos = await getUtxos(segwitAddress);
  }
  if (utxos.length === 0) {
    throw Object.assign(new Error(`No confirmed UTXOs for ${fromAddress}`), { code: 'NO_UTXOS' });
  }

  const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0);
  logger.info(`[BTC] UTXOs:   ${utxos.length} (total: ${totalAvailable} sats / ${totalAvailable / 1e8} BTC)`);

  // Get fee rate
  if (!feeRate) {
    const rates = await getRecommendedFeeRate();
    feeRate = rates.medium;
  }
  logger.info(`[BTC] FeeRate: ${feeRate} sat/vB`);

  // Select UTXOs
  const { selected, totalInput, fee, insufficient, noChange } = selectUtxos(utxos, amountSats, feeRate);

  if (insufficient) {
    const needed = amountSats + fee;
    throw Object.assign(
      new Error(`Insufficient BTC: have ${totalInput} sats, need ${needed} sats (${amountSats} + ${fee} fee)`),
      { code: 'INSUFFICIENT_BTC', available: totalInput / 1e8, needed: needed / 1e8 }
    );
  }

  logger.info(`[BTC] Selected ${selected.length} UTXOs, total input: ${totalInput} sats`);
  logger.info(`[BTC] Mining fee: ${fee} sats (${(fee / 1e8).toFixed(8)} BTC)`);

  // Build PSBT (Partially Signed Bitcoin Transaction)
  const psbt = new bitcoin.Psbt({ network });

  // Add inputs — handle both SegWit (P2WPKH) and Legacy (P2PKH) address types
  for (const utxo of selected) {
    if (isP2PKH) {
      // Legacy P2PKH: needs full raw transaction (nonWitnessUtxo)
      const rawTxHex = await getRawTx(utxo.txid);
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(rawTxHex, 'hex'),
      });
    } else {
      // SegWit P2WPKH: uses witnessUtxo (smaller, more efficient)
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }).output,
          value: BigInt(utxo.value),
        },
      });
    }
  }

  // Add recipient output
  psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

  // Add change output if needed
  const changeSats = totalInput - amountSats - fee;
  if (!noChange && changeSats > DUST_LIMIT) {
    psbt.addOutput({ address: fromAddress, value: BigInt(changeSats) });
    logger.info(`[BTC] Change:  ${changeSats} sats → ${fromAddress}`);
  } else if (changeSats > 0 && changeSats <= DUST_LIMIT) {
    // Change is dust — add it to the mining fee instead
    logger.info(`[BTC] Change ${changeSats} sats is dust, donating to miners`);
  }

  // Sign all inputs
  for (let i = 0; i < selected.length; i++) {
    psbt.signInput(i, keyPair);
  }

  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();
  const txid = tx.getId();

  const actualFee = totalInput - amountSats - ((!noChange && changeSats > DUST_LIMIT) ? changeSats : 0);
  const vBytes = tx.virtualSize();

  logger.info(`[BTC] TXID:    ${txid}`);
  logger.info(`[BTC] Size:    ${vBytes} vBytes`);
  logger.info(`[BTC] Fee:     ${actualFee} sats (${(actualFee / 1e8).toFixed(8)} BTC)`);
  logger.info(`[BTC] ════════════════════════════════════════════`);

  return { txHex, txid, fee: actualFee, feeBtc: actualFee / 1e8, vBytes };
}

// ─── Broadcasting ───────────────────────────────────────────

/**
 * Broadcast a raw transaction hex to the Bitcoin network.
 */
async function broadcastTransaction(txHex) {
  const api = getApiBase();
  logger.info(`[BTC] Broadcasting transaction (${txHex.length / 2} bytes)...`);

  try {
    const { data: txid } = await axios.post(`${api}/tx`, txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 30000,
    });
    logger.success(`[BTC] Broadcast accepted! TXID: ${txid}`);
    return txid;
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    logger.error(`[BTC] Broadcast FAILED: ${errMsg}`);
    throw Object.assign(new Error(`Broadcast failed: ${errMsg}`), { code: 'BROADCAST_FAILED' });
  }
}

// ─── Confirmation Polling ───────────────────────────────────

/**
 * Wait for a Bitcoin transaction to be confirmed.
 * BTC blocks are ~10 min, so we poll every 30s for up to 20 min.
 */
async function waitForConfirmation(txid, maxAttempts = 40, intervalMs = 30000) {
  const api = getApiBase();
  logger.info(`[BTC] Waiting for confirmation of ${txid} (polling every ${intervalMs / 1000}s, max ${maxAttempts} attempts)...`);

  // Initial wait — give the network time to propagate
  await new Promise(r => setTimeout(r, 10000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data: txData } = await axios.get(`${api}/tx/${txid}`, { timeout: 15000 });

      if (txData.status && txData.status.confirmed) {
        logger.success(`[BTC] Confirmed on attempt ${attempt} (block ${txData.status.block_height})`);
        return {
          confirmed: true,
          blockHeight: txData.status.block_height,
          blockHash: txData.status.block_hash,
          fee: txData.fee,
        };
      }

      logger.info(`[BTC] Attempt ${attempt}/${maxAttempts} — not yet confirmed, waiting ${intervalMs / 1000}s...`);
    } catch (err) {
      logger.warn(`[BTC] Confirmation check error on attempt ${attempt}: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  // Don't throw — BTC is slow, the TX is likely still valid
  logger.warn(`[BTC] Transaction ${txid} not confirmed after ${(maxAttempts * intervalMs / 1000 + 10)}s — will be tracked async`);
  return { confirmed: false, txid };
}

// ─── High-Level Send ────────────────────────────────────────

/**
 * Build, sign, broadcast, and optionally wait for a BTC transaction.
 *
 * @param {Object} opts
 * @param {string} opts.fromPrivateKey - Hex private key
 * @param {string} opts.toAddress      - Recipient address
 * @param {number} opts.amount         - BTC amount
 * @param {number} [opts.feeRate]      - sat/vByte (auto if omitted)
 * @param {boolean} [opts.waitConfirm] - Wait for on-chain confirmation (default false for BTC)
 * @returns {{ txid, fee, feeBtc, result, blockHeight? }}
 */
async function sendBtc({ fromPrivateKey, toAddress, amount, feeRate, waitConfirm = false, fromAddress }) {
  // Build & sign — pass fromAddress so buildTransaction knows which address type (P2PKH vs P2WPKH)
  const { txHex, fee, feeBtc, vBytes } = await buildTransaction(fromPrivateKey, toAddress, amount, feeRate, { fromAddress });

  // Broadcast
  const txid = await broadcastTransaction(txHex);

  // Optionally wait for confirmation
  if (waitConfirm) {
    const confirmation = await waitForConfirmation(txid);
    return { txid, fee, feeBtc, vBytes, result: confirmation.confirmed, blockHeight: confirmation.blockHeight };
  }

  return { txid, fee, feeBtc, vBytes, result: true };
}

module.exports = {
  getBtcNetwork,
  getApiBase,
  getExplorerBase,
  keyPairFromHex,
  getAddressFromPrivateKey,
  getBalance,
  getUtxos,
  getRawTx,
  getRecommendedFeeRate,
  estimateTxSize,
  estimateFee,
  selectUtxos,
  buildTransaction,
  broadcastTransaction,
  waitForConfirmation,
  sendBtc,
};
