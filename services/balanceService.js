const logger = require('../utils/logger');

/**
 * Get native TRX balance for an address.
 * Ported from tronNetwork.js:13-23 (callback → async/await).
 */
async function getTrxBalance(tronWeb, address) {
  const sun = await tronWeb.trx.getBalance(address);
  const balance = tronWeb.fromSun(sun);
  return { balance: Number(balance), sun, address };
}

/**
 * Get TRC20 token balance for an address.
 * Ported from tronNetwork.js:55-93 (callback → async/await).
 */
async function getTrc20Balance(tronWeb, contractAddress, address) {
  try {
    const contract = await tronWeb.contract().at(contractAddress);
    const raw = await contract.balanceOf(address).call();
    return { balance: Number(raw) / 1e6, raw: raw.toString(), address };
  } catch (error) {
    logger.warn(`TRC20 balance check failed for ${address}: ${error.message || error}`);
    return { balance: 0, raw: '0', address, error: error.message || error };
  }
}

module.exports = { getTrxBalance, getTrc20Balance };
