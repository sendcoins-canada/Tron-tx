const logger = require('../utils/logger');
const { createWeb3 } = require('./evmClient');
const { getContract, loadAbi } = require('../config/contracts');
const { getNetwork } = require('../config/networks');

// ─── TRC20 (Tron) balance functions ─────────────────────────

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

// ─── EVM (ETH/BSC) balance functions ────────────────────────

/**
 * Get native balance (ETH or BNB) for an EVM address.
 * Ported from walletQ.js ethBalance/bnbBalance.
 */
async function getEvmNativeBalance(network, address) {
  const web3 = createWeb3(network);
  const weiBalance = await web3.eth.getBalance(address);
  const balance = Number(web3.utils.fromWei(weiBalance, 'ether'));
  return { balance, wei: weiBalance, address };
}

/**
 * Get ERC20/BEP20 token balance.
 * Ported from walletQ.js usdtBep20Balance/usdtErc20Balance etc.
 */
async function getErc20Balance(network, token, address) {
  const web3 = createWeb3(network);
  const contractInfo = getContract(network, token);

  // Load ABI — UsdcErc20.json is a proxy ABI (no balanceOf), so for ERC20 USDC
  // we use USDT's ABI (same ERC20 interface). This matches sendcoins/walletQ.js behavior.
  const abi = loadAbi(network, token);

  const contract = new web3.eth.Contract(abi, contractInfo.address);
  const rawBalance = await contract.methods.balanceOf(address).call();

  const balance = contractInfo.web3Unit
    ? Number(web3.utils.fromWei(String(rawBalance), contractInfo.web3Unit))
    : Number(rawBalance) / Math.pow(10, contractInfo.decimals);

  return { balance, raw: String(rawBalance), address };
}

// ─── Unified dispatcher ─────────────────────────────────────

/**
 * Get token balance on any supported network.
 * @param {string} network - trc20 | bep20 | erc20
 * @param {string} token   - USDT | USDC
 * @param {string} address - Wallet address
 * @param {TronWeb} [tronWeb] - Required for trc20 network
 * @returns {Promise<{ balance: number, address: string }>}
 */
async function getTokenBalance(network, token, address, tronWeb) {
  const net = network.toLowerCase();

  if (net === 'trc20') {
    if (!tronWeb) throw new Error('tronWeb instance required for TRC20 balance checks');
    const contractInfo = getContract('trc20', token);
    return getTrc20Balance(tronWeb, contractInfo.address, address);
  }

  return getErc20Balance(net, token, address);
}

/**
 * Get native gas token balance on any network.
 * @param {string} network - trc20 | bep20 | erc20
 * @param {string} address
 * @param {TronWeb} [tronWeb] - Required for trc20
 * @returns {Promise<{ balance: number }>}
 */
async function getNativeBalance(network, address, tronWeb) {
  const net = network.toLowerCase();

  if (net === 'trc20') {
    if (!tronWeb) throw new Error('tronWeb instance required for TRC20');
    return getTrxBalance(tronWeb, address);
  }

  return getEvmNativeBalance(net, address);
}

module.exports = {
  getTrxBalance,
  getTrc20Balance,
  getEvmNativeBalance,
  getErc20Balance,
  getTokenBalance,
  getNativeBalance,
};
