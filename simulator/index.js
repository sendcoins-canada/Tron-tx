const config = require('../config');
const { getContractAddress } = require('../config/contracts');
const { createTronWeb } = require('../services/tronClient');
const { getTrxBalance, getTrc20Balance } = require('../services/balanceService');
const { checkAndFundGas } = require('../services/fundingService');
const { sendTrc20 } = require('../services/transferService');
const logger = require('../utils/logger');
const chalk = require('chalk');

// ─── Parse CLI args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { dryRun: false, token: 'USDT', amount: null, to: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--to':
        parsed.to = args[++i];
        break;
      case '--amount':
        parsed.amount = Number(args[++i]);
        break;
      case '--token':
        parsed.token = (args[++i] || 'USDT').toUpperCase();
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
    }
  }

  if (!parsed.dryRun && (!parsed.to || !parsed.amount)) {
    console.log(chalk.yellow('Usage: node simulator/index.js --to <address> --amount <n> [--token usdt|usdc] [--dry-run]'));
    console.log(chalk.yellow('       node simulator/index.js --dry-run'));
    process.exit(1);
  }

  return parsed;
}

// ─── TronScan link ───────────────────────────────────────────
function tronscanLink(txid, network) {
  if (network === 'shasta') return `https://shasta.tronscan.org/#/transaction/${txid}`;
  if (network === 'nile') return `https://nile.tronscan.org/#/transaction/${txid}`;
  return `https://tronscan.org/#/transaction/${txid}`;
}

// ─── Main simulator ─────────────────────────────────────────
async function run() {
  const args = parseArgs();
  const { TRON_NETWORK, TRON_PRO_API_KEY, SENDER_WALLET_PRIVATE_KEY, SENDER_WALLET_ADDRESS } = config;

  console.log(chalk.bold.cyan('\n  TRON TRANSACTION SIMULATOR'));
  console.log(chalk.cyan('══════════════════════════════════════════════════\n'));

  // ─── STEP 1: INITIALIZE ──────────────────────────────────
  logger.step(1, 'INITIALIZE');
  const senderTronWeb = createTronWeb(TRON_NETWORK, SENDER_WALLET_PRIVATE_KEY, TRON_PRO_API_KEY);
  logger.table('Network', TRON_NETWORK);
  logger.table('Sender', SENDER_WALLET_ADDRESS);
  if (!args.dryRun) {
    logger.table('Recipient', args.to);
    logger.table('Amount', `${args.amount} ${args.token}`);
  }
  logger.table('Mode', args.dryRun ? 'DRY RUN (no transactions)' : 'LIVE');

  // ─── STEP 2: CHECK BALANCES ───────────────────────────────
  logger.step(2, 'CHECK BALANCES');

  const usdtContract = getContractAddress(TRON_NETWORK, 'USDT');
  const usdcContract = getContractAddress(TRON_NETWORK, 'USDC');

  const [trxBal, usdtBal, usdcBal] = await Promise.all([
    getTrxBalance(senderTronWeb, SENDER_WALLET_ADDRESS),
    getTrc20Balance(senderTronWeb, usdtContract, SENDER_WALLET_ADDRESS),
    getTrc20Balance(senderTronWeb, usdcContract, SENDER_WALLET_ADDRESS),
  ]);

  logger.table('TRX Balance', `${trxBal.balance} TRX`);
  logger.table('USDT Balance', `${usdtBal.balance} USDT`);
  logger.table('USDC Balance', `${usdcBal.balance} USDC`);

  if (args.dryRun) {
    console.log(chalk.green.bold('\n  Dry run complete. No transactions sent.\n'));
    return;
  }

  // ─── Validate token balance ───────────────────────────────
  const tokenBalance = args.token === 'USDT' ? usdtBal.balance : usdcBal.balance;
  if (tokenBalance < args.amount) {
    logger.error(`Insufficient ${args.token} balance: ${tokenBalance} < ${args.amount}`);
    process.exit(1);
  }

  // ─── STEP 3: GAS ASSESSMENT ───────────────────────────────
  logger.step(3, 'GAS ASSESSMENT');

  const fundResult = await checkAndFundGas({
    network: TRON_NETWORK,
    apiKey: TRON_PRO_API_KEY,
    masterPrivateKey: config.MASTER_WALLET_PRIVATE_KEY,
    masterAddress: config.MASTER_WALLET_ADDRESS,
    userAddress: SENDER_WALLET_ADDRESS,
    minTrx: config.MIN_TRX_FOR_GAS,
  });

  if (fundResult.funded) {
    logger.table('Funded Amount', `${fundResult.amount} TRX`);
    logger.table('Funding TXID', fundResult.txid);
    // Wait for funding tx to be confirmed
    logger.info('Waiting 3s for funding confirmation...');
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ─── STEP 4: TRANSFER ────────────────────────────────────
  logger.step(4, 'TRANSFER');
  const contractAddr = getContractAddress(TRON_NETWORK, args.token);

  let transferResult;
  try {
    transferResult = await sendTrc20(senderTronWeb, args.to, args.amount, contractAddr, config.FEE_LIMIT);
  } catch (err) {
    if (err.code === 'RESOURCE_INSUFFICIENT') {
      logger.warn('Resource insufficient — attempting gas top-up and retry...');
      await checkAndFundGas({
        network: TRON_NETWORK,
        apiKey: TRON_PRO_API_KEY,
        masterPrivateKey: config.MASTER_WALLET_PRIVATE_KEY,
        masterAddress: config.MASTER_WALLET_ADDRESS,
        userAddress: SENDER_WALLET_ADDRESS,
        minTrx: config.MIN_TRX_FOR_GAS + 10,
      });
      await new Promise((r) => setTimeout(r, 3000));
      transferResult = await sendTrc20(senderTronWeb, args.to, args.amount, contractAddr, config.FEE_LIMIT);
    } else {
      throw err;
    }
  }

  // ─── STEP 5: VERIFY ──────────────────────────────────────
  logger.step(5, 'VERIFY');

  const [newTrx, newToken] = await Promise.all([
    getTrxBalance(senderTronWeb, SENDER_WALLET_ADDRESS),
    getTrc20Balance(senderTronWeb, contractAddr, SENDER_WALLET_ADDRESS),
  ]);

  logger.table('New TRX Balance', `${newTrx.balance} TRX`);
  logger.table(`New ${args.token} Balance`, `${newToken.balance} ${args.token}`);

  console.log(chalk.bold.green('\n  TRANSACTION COMPLETE'));
  console.log(chalk.green('══════════════════════════════════════════════════'));
  logger.table('TXID', transferResult.txid);
  logger.table('TronScan', tronscanLink(transferResult.txid, TRON_NETWORK));
  console.log();
}

// ─── Entry point ─────────────────────────────────────────────
run().catch((err) => {
  logger.error(err.message || err);
  if (err.code) logger.error(`Error code: ${err.code}`);
  process.exit(1);
});
