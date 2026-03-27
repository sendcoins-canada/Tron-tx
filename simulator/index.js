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
  const parsed = {
    dryRun: false,
    token: 'USDT',
    amount: null,
    to: null,
    network: 'trc20',
    apiKey: null,      // user API key for DB-backed flow
    senderKey: null,   // explicit sender key (legacy CLI mode)
  };

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
      case '--network':
        parsed.network = (args[++i] || 'trc20').toLowerCase();
        break;
      case '--api-key':
        parsed.apiKey = args[++i];
        break;
      case '--sender-key':
        parsed.senderKey = args[++i];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
    }
  }

  if (!parsed.dryRun && (!parsed.to || !parsed.amount)) {
    console.log(chalk.yellow('Usage: node simulator/index.js --to <address> --amount <n> [options]'));
    console.log(chalk.yellow(''));
    console.log(chalk.yellow('Options:'));
    console.log(chalk.yellow('  --token <usdt|usdc>     Token to send (default: USDT)'));
    console.log(chalk.yellow('  --network <trc20|bep20|erc20>  Network (default: trc20)'));
    console.log(chalk.yellow('  --api-key <key>         User API key (DB-backed mode)'));
    console.log(chalk.yellow('  --sender-key <key>      Sender private key (legacy CLI mode)'));
    console.log(chalk.yellow('  --dry-run               Check balances only'));
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

function explorerLink(txid, network) {
  switch (network) {
    case 'bep20': return `https://bscscan.com/tx/${txid}`;
    case 'erc20': return `https://etherscan.io/tx/${txid}`;
    default: return tronscanLink(txid, config.TRON_NETWORK);
  }
}

// ─── DB-backed mode (via walletService) ──────────────────────
async function runDbMode(args) {
  console.log(chalk.bold.cyan('\n  CRYPTO TRANSACTION ENGINE (DB Mode)'));
  console.log(chalk.cyan('══════════════════════════════════════════════════\n'));

  const { sendCrypto } = require('../services/walletService');

  logger.table('Network', args.network);
  logger.table('Token', args.token);
  logger.table('Amount', args.amount);
  logger.table('Recipient', args.to);
  logger.table('User API Key', args.apiKey.substring(0, 8) + '...');

  if (args.dryRun) {
    logger.info('Dry run mode — would call sendCrypto() with above params');
    console.log(chalk.green.bold('\n  Dry run complete. No transactions sent.\n'));
    return;
  }

  const result = await sendCrypto({
    userApiKey: args.apiKey,
    recipientAddress: args.to,
    amount: args.amount,
    coin: args.token,
    network: args.network,
  });

  if (result.success) {
    console.log(chalk.bold.green('\n  TRANSACTION COMPLETE'));
    console.log(chalk.green('══════════════════════════════════════════════════'));
    logger.table('Strategy', result.strategy);
    logger.table('TXID', result.txid);
    logger.table('Reference', result.reference);
    logger.table('Explorer', explorerLink(result.txid, args.network));
  } else {
    logger.error(`Transfer failed: ${result.error}`);
    if (result.reference) logger.table('Reference', result.reference);
    process.exit(1);
  }
  console.log();
}

// ─── Legacy CLI mode (direct private key) ────────────────────
async function runCliMode(args) {
  const senderKey = args.senderKey || config.SENDER_WALLET_PRIVATE_KEY;
  const senderAddr = config.SENDER_WALLET_ADDRESS;

  if (!senderKey || !senderAddr) {
    logger.error('CLI mode requires SENDER_WALLET_PRIVATE_KEY and SENDER_WALLET_ADDRESS in .env (or use --sender-key)');
    process.exit(1);
  }

  const { TRON_NETWORK, TRON_PRO_API_KEY } = config;

  console.log(chalk.bold.cyan('\n  TRON TRANSACTION SIMULATOR'));
  console.log(chalk.cyan('══════════════════════════════════════════════════\n'));

  // ─── STEP 1: INITIALIZE ──────────────────────────────────
  logger.step(1, 'INITIALIZE');
  const senderTronWeb = createTronWeb(TRON_NETWORK, senderKey, TRON_PRO_API_KEY);
  logger.table('Network', TRON_NETWORK);
  logger.table('Sender', senderAddr);
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
    getTrxBalance(senderTronWeb, senderAddr),
    getTrc20Balance(senderTronWeb, usdtContract, senderAddr),
    getTrc20Balance(senderTronWeb, usdcContract, senderAddr),
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
    userAddress: senderAddr,
    minTrx: config.MIN_TRX_FOR_GAS,
  });

  if (fundResult.funded) {
    logger.table('Funded Amount', `${fundResult.amount} TRX`);
    logger.table('Funding TXID', fundResult.txid);
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
        userAddress: senderAddr,
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
    getTrxBalance(senderTronWeb, senderAddr),
    getTrc20Balance(senderTronWeb, contractAddr, senderAddr),
  ]);

  logger.table('New TRX Balance', `${newTrx.balance} TRX`);
  logger.table(`New ${args.token} Balance`, `${newToken.balance} ${args.token}`);

  console.log(chalk.bold.green('\n  TRANSACTION COMPLETE'));
  console.log(chalk.green('══════════════════════════════════════════════════'));
  logger.table('TXID', transferResult.txid);
  logger.table('TronScan', tronscanLink(transferResult.txid, TRON_NETWORK));
  console.log();
}

// ─── Main router ─────────────────────────────────────────────
async function run() {
  const args = parseArgs();

  if (args.apiKey) {
    await runDbMode(args);
  } else {
    await runCliMode(args);
  }
}

// ─── Entry point ─────────────────────────────────────────────
run().catch((err) => {
  logger.error(err.message || err);
  if (err.code) logger.error(`Error code: ${err.code}`);
  process.exit(1);
});
