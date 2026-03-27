# Crypto TX Engine

Multi-network crypto sending engine for sendcoins. Supports TRC20, BEP20, and ERC20 token transfers (USDT, USDC) with automatic gas funding and on-chain confirmation.

## Architecture

```
server.js          → HTTP API (Express)
index.js           → Module export (for require() from sendcoins backend)
services/
  walletService.js → Core orchestrator (sendCrypto)
  transferService.js → Blockchain send (TRC20/ERC20/BEP20) + on-chain confirmation
  fundingService.js  → Auto gas funding (TRX/BNB/ETH)
  balanceService.js  → On-chain balance checks
  lockService.js     → DB balance locking/deduction (PostgreSQL FOR UPDATE)
  tronClient.js      → TronWeb factory
  evmClient.js       → Web3 factory
config/
  index.js         → Environment config
  contracts.js     → Token contract addresses + ABI loader
  networks.js      → Network definitions
db/
  index.js         → PostgreSQL connection pool
  queries.js       → DB queries (users, wallets, transfers)
```

## Send Strategies

- **DIRECT_SEND** — User has on-chain balance. Engine sends from user's wallet, auto-funds gas if needed.
- **MASTER_SEND** — User has DB balance but no on-chain tokens. Engine sends from master wallet, deducts user's DB balance.

## Setup

```bash
# Install dependencies
npm install

# Copy env and fill in values
cp .env.example .env
```

### Required `.env` variables

```env
# Database (same credentials as sendcoins)
DB_USER=
DB_HOST=
DB_NAME=
DB_PASSWORD=

# Tron
TRON_NETWORK=mainnet          # mainnet | nile | shasta
TRON_PRO_API_KEY=             # TronGrid API key
MASTER_WALLET_TRON_PRIVATE_KEY=
MASTER_WALLET_TRON_ADDRESS=

# Optional: BSC / Ethereum (for BEP20/ERC20 support)
MASTER_WALLET_BSC_PRIVATE_KEY=
MASTER_WALLET_BSC_ADDRESS=
MASTER_WALLET_ETH_PRIVATE_KEY=
MASTER_WALLET_ETH_ADDRESS=
```

## Running

### As HTTP API server

```bash
npm start
# or
node server.js
```

Server starts on port 4100 (configurable via `PORT` env var).

### Endpoints

**Health check:**
```bash
curl http://localhost:4100/api/health
```

**Send crypto:**
```bash
curl -X POST http://localhost:4100/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "userApiKey": "user-api-key-from-send_coin_user",
    "recipientAddress": "Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "amount": 10,
    "coin": "USDT",
    "network": "trc20",
    "recipientName": "John",
    "note": "Payment"
  }'
```

**Response (success):**
```json
{
  "success": true,
  "txid": "abc123...",
  "reference": "ref123...",
  "strategy": "MASTER_SEND",
  "elapsed": "4200ms"
}
```

**Response (failure):**
```json
{
  "success": false,
  "error": "Insufficient USDT balance. Available: 0.000000, Required: 10",
  "reference": "ref123...",
  "elapsed": "1200ms"
}
```

### As a module (from sendcoins backend)

```js
const engine = require('../tron-tx-simulator');

const result = await engine.sendCrypto({
  userApiKey: 'abc123...',
  recipientAddress: 'Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  amount: 10,
  coin: 'USDT',
  network: 'trc20',
});
```

### CLI simulator

```bash
# Dry run (check balances only)
npm run dry-run

# Send with user API key (DB-backed mode)
node simulator/index.js --api-key <key> --to <address> --amount 10

# Send with explicit private key (legacy CLI mode)
node simulator/index.js --sender-key <key> --to <address> --amount 10
```

## E2E Test (dry-run)

Tests the full flow with a fake balance on a yopmail test user. Expects the blockchain call to fail if the master wallet has no TRX.

```bash
node test-e2e.js
```

The test:
1. Finds a yopmail test user with a USDT TRC20 wallet
2. Sets `total_balance = 50` temporarily
3. Calls `sendCrypto()` — picks MASTER_SEND strategy
4. Logs every step of the flow
5. **Always** restores original balance in a `finally` block

## Important: On-chain Confirmation

The engine waits for on-chain confirmation after broadcasting TRC20 transactions. On TRON, a successful broadcast does **not** mean the transaction executed successfully — it can fail on-chain due to insufficient energy/bandwidth. The engine polls `getTransactionInfo` until confirmation and throws `ON_CHAIN_FAILED` if the execution failed.

## Master Wallet Requirements

The master wallet needs:
- **TRX** for bandwidth/energy fees (~50 TRX minimum for TRC20 transfers)
- **USDT/USDC** tokens to send (for MASTER_SEND strategy)

Without TRX, broadcasts may be accepted but fail on-chain with `OUT_OF_ENERGY`.
