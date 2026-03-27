# TRON TRC20 Flow (line-by-line, plain English)

This document explains (in plain English) what each line does across the TRON simulator flow in `tron-tx-simulator/`.

Included files:
- `package.json`
- `.env.example`
- `config/index.js`
- `config/contracts.js`
- `services/tronClient.js`
- `services/balanceService.js`
- `services/fundingService.js`
- `services/transferService.js`
- `utils/logger.js`
- `simulator/index.js`

Excluded from line-by-line printing:
- `package-lock.json` (auto-generated, extremely large)
- `node_modules/` and `.git/` (artifacts)
- `.env` and `.env.uat` (contain secrets; this doc only covers `.env.example`)

---

## `tron-tx-simulator/README.md`

```text
L1: Title/heading for the project.
L2: Blank line.
```

---

## `tron-tx-simulator/package.json`

```text
L1: Opens the JSON object.
L2: Project/package name.
L3: Version number.
L4: Human description of what the simulator does.
L5: Declares the main entry file.
L6: Opens `scripts`.
L7: Script name `simulate` -> runs `node simulator/index.js`.
L8: Script name `dry-run` -> runs `node simulator/index.js --dry-run`.
L9: Closes `scripts`.
L10: Opens `dependencies`.
L11: Adds `chalk`.
L12: Adds `dotenv`.
L13: Adds `tronweb`.
L14: Closes `dependencies`.
L15: Opens `engines`.
L16: Minimum Node.js version required.
L17: Closes `engines`.
L18: Closes the JSON object.
L19: Blank line at end of file.
```

---

## `tron-tx-simulator/.env.example`

```text
L1: Sets the default TRON network name.
L2: Placeholder for TronGrid Pro API key.
L3: Placeholder for the master wallet private key.
L4: Placeholder for the master wallet address.
L5: Placeholder for the sender/user wallet private key.
L6: Placeholder for the sender/user wallet address.
L7: Minimum TRX to consider "gas is sufficient".
L8: Fee limit (in SUN) used when triggering the TRC20 transfer.
L9: USDT contract address (TRC20).
L10: USDC contract address (TRC20).
L11: End of file.
```

---

## `tron-tx-simulator/config/index.js`

```text
L1: Imports Node's `path` utilities.
L2: Loads environment variables from `../.env` using dotenv.
L3: Blank line.
L4: Starts the list of required environment variable names.
L5: Requires `TRON_NETWORK`.
L6: Requires `TRON_PRO_API_KEY`.
L7: Requires `MASTER_WALLET_PRIVATE_KEY`.
L8: Requires `MASTER_WALLET_ADDRESS`.
L9: Requires `SENDER_WALLET_PRIVATE_KEY`.
L10: Requires `SENDER_WALLET_ADDRESS`.
L11: Ends the required-vars array.
L12: Blank line.
L13: Builds `missing` = required vars that are not present in `process.env`.
L14: If any required vars are missing...
L15: Logs an error listing which vars are missing.
L16: Logs guidance to copy `.env.example` and fill values.
L17: Exits the program with failure.
L18: Ends the missing-envs check.
L19: Blank line.
L20: Creates the exported config object and freezes it (immutable).
L21: Reads `TRON_NETWORK` into config.
L22: Reads `TRON_PRO_API_KEY` into config.
L23: Reads master private key into config.
L24: Reads master address into config.
L25: Reads sender private key into config.
L26: Reads sender address into config.
L27: Reads `MIN_TRX_FOR_GAS` as a number, defaulting to 35.
L28: Reads `FEE_LIMIT` as a number, defaulting to 10,000,000.
L29: Ends the frozen config object literal.
L30: Blank line.
L31: Exports the config.
L32: End of file.
```

---

## `tron-tx-simulator/config/contracts.js`

```text
L1: Defines the `CONTRACTS` lookup object.
L2: Begins the `mainnet` token mapping.
L3: USDT contract address for mainnet.
L4: USDC contract address for mainnet.
L5: Ends `mainnet` token mapping.
L6: Begins the `shasta` token mapping.
L7: USDT contract for shasta; allows override via `process.env.USDT_CONTRACT`.
L8: USDC contract for shasta; allows override via `process.env.USDC_CONTRACT`.
L9: Ends `shasta` token mapping.
L10: Begins the `nile` token mapping.
L11: USDT contract for nile; allows override via `process.env.USDT_CONTRACT`.
L12: USDC contract for nile; allows override via `process.env.USDC_CONTRACT`.
L13: Ends `nile` token mapping.
L14: Ends the `CONTRACTS` object.
L15: Blank line.
L16: Starts documentation comment for `getContractAddress`.
L17: Explains the function retrieves a contract address for a token.
L18: Documents `network` allowed values.
L19: Documents `token` allowed values.
L20: Documents return type.
L21: End of comment header area.
L22: Declares `getContractAddress(network, token)`.
L23: Picks the mapping for the given network key.
L24: Throws error if the network key is unknown.
L25: Selects the contract address for the token (uppercasing token name).
L26: Throws error if token is not known for that network.
L27: Returns the found contract address.
L28: Ends function.
L29: Blank line.
L30: Exports `getContractAddress`.
L31: End of file.
```

---

## `tron-tx-simulator/services/tronClient.js`

```text
L1: Imports `TronWeb`.
L2: Blank line.
L3: Defines `NETWORK_URLS` mapping network names to full node URLs.
L4: Mainnet URL.
L5: Shasta URL.
L6: Nile URL.
L7: Ends `NETWORK_URLS`.
L8: Blank line.
L9: Starts documentation comment.
L10: Explains the purpose: create a TronWeb instance for a network.
L11: Documents `network` parameter.
L12: Documents `privateKey` parameter.
L13: Documents `apiKey` parameter.
L14: Documents return type.
L15: End of comment header.
L16: Declares `createTronWeb(network, privateKey, apiKey)`.
L17: Looks up `fullHost` from `NETWORK_URLS`.
L18: Throws if network is not recognized.
L19: Blank line.
L20: Starts empty `headers` object.
L21: If `apiKey` is provided...
L22: Sets TronGrid Pro API key header.
L23: Ends apiKey conditional.
L24: Blank line.
L25: Creates and returns a new TronWeb instance using host, headers, and privateKey.
L26: Ends function.
L27: Blank line.
L28: Exports `createTronWeb`.
L29: End of file.
```

---

## `tron-tx-simulator/services/balanceService.js`

```text
L1: Imports the shared logger.
L2: Blank line.
L3: Starts documentation comment for TRX balance.
L4: States TRX balance meaning (native coin).
L5: Notes the implementation was ported from another module.
L6: Ends comment header for TRX section.
L7: Declares `getTrxBalance(tronWeb, address)`.
L8: Fetches balance in SUN (smallest unit).
L9: Converts SUN to TRX.
L10: Returns numeric TRX balance plus raw SUN value and the address.
L11: Ends function.
L12: Blank line.
L13: Starts documentation comment for TRC20 balance.
L14: States this fetches token balance for a contract.
L15: Notes port origin.
L16: Ends comment header for TRC20 section.
L17: Declares `getTrc20Balance(tronWeb, contractAddress, address)`.
L18: Begins try block for safe querying.
L19: Loads contract instance at `contractAddress`.
L20: Calls `balanceOf(address).call()` to read token balance.
L21: Returns normalized token balance (dividing by 1e6), plus raw and address.
L22: Starts catch block.
L23: Logs warning with address and error message.
L24: Returns a zero-balance object including error info.
L25: Ends return for error case.
L26: Ends catch.
L27: Ends function.
L28: Blank line.
L29: Exports both helper functions.
```

---

## `tron-tx-simulator/services/fundingService.js`

```text
L1: Imports `createTronWeb`.
L2: Imports `getTrxBalance`.
L3: Imports the shared logger.
L4: Blank line.
L5: Starts documentation comment describing the gas funding behavior.
L6: Explains it funds user wallet TRX if gas is insufficient.
L7: Notes port origin from `sendTron.js`.
L8: Blank line within comment.
L9: Opens parameter documentation for the `opts` object.
L10: Documents `opts.network`.
L11: Documents `opts.apiKey`.
L12: Documents `opts.masterPrivateKey`.
L13: Documents `opts.masterAddress`.
L14: Documents `opts.userAddress`.
L15: Documents `opts.minTrx` with default 35.
L16: Ends comment block.
L17: Declares `checkAndFundGas(...)` async function.
L18: Step 1 comment: checking user's current TRX balance.
L19: Creates TronWeb instance for the master wallet.
L20: Fetches the user's TRX balance.
L21: Blank line.
L22: Logs user TRX balance.
L23: Blank line.
L24: If user balance is already enough (>= minTrx)...
L25: Logs success and returns "not funded".
L26: Returns `{ funded:false, reason:'sufficient', balance: ... }`.
L27: Ends "sufficient" branch.
L28: Blank line.
L29: Step 2 comment: calculate deficit (with buffer).
L30: Calculates deficit: `minTrx - current + 2`.
L31: Logs warning with deficit and buffer details.
L32: Blank line.
L33: Step 3 comment: ensure master wallet has enough.
L34: Fetches master wallet TRX balance.
L35: If master is below `deficit + 1`...
L36: Throws an error with extra fields via `Object.assign`.
L37: Error message includes master balance and required amount.
L38: Adds `code: 'MASTER_WALLET_LOW'`.
L39: Ends `Object.assign` call.
L40: Ends if.
L41: Blank line.
L42: Step 4 comment: send TRX from master to user.
L43: Converts TRX deficit to SUN and rounds up with `Math.ceil`.
L44: Logs "Funding ... from master -> user".
L45: Blank line.
L46: Builds a `sendTrx` transaction.
L47: Recipient/destination address is `userAddress`.
L48: Amount in SUN is `sunAmount`.
L49: Sender address is `masterAddress`.
L50: Ends transactionBuilder call.
L51: Signs the tx using the master private key.
L52: Broadcasts the signed transaction.
L53: Blank line.
L54: If broadcast result indicates failure...
L55: Throws a structured funding failed error.
L56: Includes serialized receipt in error message.
L57: Adds `code: 'FUNDING_FAILED'`.
L58: Ends throw block.
L59: Ends failure conditional.
L60: Blank line.
L61: Logs success and TXID.
L62: Blank line.
L63: Returns an object describing the funding outcome.
L64: Sets `funded: true`.
L65: Includes `txid` from the receipt.
L66: Records token amount of TRX funded as `deficit`.
L67: Records user's previous balance before funding.
L68: Ends return object.
L69: Ends function.
L70: Blank line.
L71: Exports `checkAndFundGas`.
L72: End of file.
```

---

## `tron-tx-simulator/services/transferService.js`

```text
L1: Imports logger.
L2: Blank line.
L3: Starts documentation comment for token transfer.
L4: Explains token transfers use `triggerSmartContract`.
L5: Notes port origin from `sendTrc20.js`.
L6: Blank line.
L7: Documents `tronWeb` parameter (already configured with private key).
L8: Documents `toAddress`.
L9: Documents human token `amount`.
L10: Documents `contractAddress`.
L11: Documents `feeLimit` default 10_000_000.
L12: Documents return type shape.
L13: Ends comment block.
L14: Declares async `sendTrc20(...)` with feeLimit default.
L15: Reads sender/base58 address from TronWeb default address.
L16: Converts sender base58 address to hex form.
L17: Blank line.
L18: Logs sending amount and recipient.
L19: Logs TRC20 contract address.
L20: Logs fee limit in both SUN and TRX.
L21: Blank line.
L22: Converts human token amount to integer units (1e6 scale).
L23: Blank line.
L24: Builds triggerSmartContract call for TRC20 transfer.
L25: Specifies contract address to call.
L26: Specifies ABI signature: `transfer(address,uint256)`.
L27: Sets call options: feeLimit + callValue 0.
L28: Starts arguments array.
L29: First argument: destination address (typed as address).
L30: Second argument: token amount (typed as uint256).
L31: Ends arguments array.
L32: Uses `fromHex` as sender parameter.
L33: Ends triggerSmartContract build call.
L34: Blank line.
L35: Validates that triggerSmartContract produced an expected `tx.result`.
L36: If invalid, throws a structured error via `Object.assign`.
L37: Error message includes JSON for debugging.
L38: Adds `code: 'CONTRACT_CALL_FAILED'`.
L39: Ends `Object.assign`.
L40: Ends the if guard.
L41: Blank line.
L42: Signs the inner transaction (`tx.transaction`) with TronWeb.
L43: Broadcasts the signed transaction.
L44: Blank line.
L45: If receipt indicates failure...
L46: Extracts an error message (either decoded from hex or JSON string).
L47: If `receipt.message` exists, decode from hex to string.
L48: Otherwise stringify the full receipt.
L49: Blank line.
L50: Comment: detect "account resource insufficient" so we can auto-retry.
L51: Checks if message includes the resource insufficiency text (case-insensitive).
L52: Throws an error with code `RESOURCE_INSUFFICIENT`.
L53: Ends resource-insufficient branch.
L54: Throws a generic broadcast failure error with code `BROADCAST_FAILED`.
L55: Ends broadcast failure throw.
L56: Ends `if (!receipt.result)`.
L57: Logs success with the returned TXID.
L58: Returns `{ txid, result:true }`.
L59: Ends function.
L60: Blank line.
L61: Exports `sendTrc20`.
L62: End of file.
```

---

## `tron-tx-simulator/utils/logger.js`

```text
L1: Imports chalk for colorized output.
L2: Blank line.
L3: Declares helper `timestamp()`.
L4: Builds a human-friendly timestamp string from ISO time.
L5: Ends timestamp helper.
L6: Blank line.
L7: Declares `logger` object literal.
L8: Defines `logger.info(msg)`.
L9: Prints timestamp + "INFO" + message in gray/blue styling.
L10: Ends `info` method.
L11: Defines `logger.success(msg)`.
L12: Prints timestamp + "OK" + message in gray/green styling.
L13: Ends `success` method.
L14: Defines `logger.warn(msg)`.
L15: Prints timestamp + "WARN" + message in gray/yellow styling.
L16: Ends `warn` method.
L17: Defines `logger.error(msg)`.
L18: Prints timestamp + "ERR" + message in gray/red styling.
L19: Ends `error` method.
L20: Defines `logger.step(n, title)` for step headings.
L21: Prints `STEP n: title` in cyan bold, with a leading newline.
L22: Prints a cyan dashed separator.
L23: Ends `step` method.
L24: Defines `logger.table(label, value)` for consistent key/value display.
L25: Pads the label and prints value in yellow.
L26: Ends `table` method.
L27: Ends the `logger` object.
L28: Blank line.
L29: Exports the `logger`.
L30: End of file.
```

---

## `tron-tx-simulator/simulator/index.js` (main simulator flow)

```text
L1: Imports the config module (network, keys, gas settings).
L2: Imports `getContractAddress` helper for token contracts.
L3: Imports `createTronWeb` factory for TronWeb clients.
L4: Imports balance helpers: TRX and TRC20.
L5: Imports gas funding helper: `checkAndFundGas`.
L6: Imports token transfer helper: `sendTrc20`.
L7: Imports logger utilities for colored/structured console output.
L8: Imports chalk directly for extra formatting.
L9: Blank line.
L10: Section comment: parse CLI args.
L11: Declares `parseArgs()` which reads CLI flags.
L12: Takes CLI args after node/script name.
L13: Creates defaults: dryRun false, default token USDT, amount/to unset.
L14: Blank line.
L15: Loops through `args`.
L16: Switches on the current argument name.
L17: If `--to`, reads the next arg as the recipient address.
L18: Sets `parsed.to`.
L19: Breaks out of `--to` case.
L20: If `--amount`, reads the next arg as amount.
L21: Converts amount to number and stores it.
L22: Breaks out of `--amount` case.
L23: If `--token`, reads the next arg as token name.
L24: Stores uppercase token (defaults to USDT if missing).
L25: Breaks out of `--token` case.
L26: If `--dry-run`, sets dryRun=true.
L27: Updates `parsed.dryRun`.
L28: Breaks out of `--dry-run` case.
L29: Ends switch.
L30: Ends for-loop body.
L31: Blank line.
L32: Validates required flags exist for live mode.
L33: If missing and not dry-run...
L34: Prints usage instructions for correct CLI syntax.
L35: Prints second usage variant for dry-run mode.
L36: Exits with code 1 (bad args).
L37: Ends the validation conditional.
L38: Returns parsed args.
L39: Ends `parseArgs`.
L40: Blank line.
L41: Section comment: build a TronScan link for a TXID.
L42: Declares `tronscanLink(txid, network)`.
L43: For `shasta`, returns the Shasta Tronscan URL.
L44: For `nile`, returns the Nile Tronscan URL.
L45: Otherwise returns main Tronscan URL.
L46: Ends `tronscanLink`.
L47: Blank line.
L48: Section comment: main simulator run.
L49: Declares `run()` as async.
L50: Parses args.
L51: Destructures required config variables for this run.
L52: Blank line.
L53: Prints the simulator banner.
L54: Prints the banner separator line.
L55: Blank line.
L56: Step 1 heading for initialize.
L57: Prints STEP 1.
L58: Creates TronWeb client for the sender wallet using sender key.
L59: Prints the selected TRON network in a table row.
L60: Prints the sender wallet address in a table row.
L61: If not dry-run...
L62: Prints recipient address.
L63: Prints transfer amount and token symbol.
L64: Ends the recipient/amount printing condition.
L65: Prints mode ("DRY RUN" or "LIVE") row.
L66: Blank line.
L67: Step 2 heading (CHECK BALANCES).
L68: Prints STEP 2.
L69: Fetches USDT contract for the selected network.
L70: Fetches USDC contract for the selected network.
L71: Runs TRX and both token balance checks concurrently.
L72: Stores TRX balance result in `trxBal`.
L73: Stores USDT balance result in `usdtBal`.
L74: Stores USDC balance result in `usdcBal`.
L75: Prints TRX balance row.
L76: Prints USDT balance row.
L77: Prints USDC balance row.
L78: Blank line.
L79: If dry-run...
L80: Prints a success message saying no txs were sent.
L81: Returns early (stops execution).
L82: Ends dry-run branch.
L83: Blank line.
L84: Chooses which token balance to validate based on `args.token`.
L85: If the chosen token balance is less than requested amount...
L86: Logs an error about insufficient balance.
L87: Exits with code 1.
L88: Ends insufficient-balance conditional.
L89: Blank line.
L90: Step 3 heading (GAS ASSESSMENT).
L91: Prints STEP 3.
L92: Calls `checkAndFundGas` to ensure sender has enough TRX for fees.
L93: Passes `TRON_NETWORK` to funding helper.
L94: Passes `TRON_PRO_API_KEY`.
L95: Passes master private key for funding.
L96: Passes master address for funding.
L97: Passes sender wallet address as the "user" to fund.
L98: Passes minimum TRX threshold for gas.
L99: Ends `checkAndFundGas` call.
L100: Awaits the funding result into `fundResult`.
L101: Blank line.
L102: If funding occurred...
L103: Prints funded amount.
L104: Prints funding TXID.
L105: Comment: wait for confirmation.
L106: Logs that it waits 3 seconds.
L107: Waits 3 seconds using a Promise timeout.
L108: Ends funding conditional.
L109: Blank line.
L110: Step 4 heading (TRANSFER).
L111: Prints STEP 4.
L112: Picks the token contract address for the requested token.
L113: Blank line.
L114: Declares `transferResult` placeholder.
L115: Starts try block to send the TRC20 transfer.
L116: Calls `sendTrc20` and stores TX result.
L117: Starts catch block if `sendTrc20` throws.
L118: If error code is `RESOURCE_INSUFFICIENT`...
L119: Logs warning about resource insufficiency and retry plan.
L120: Runs `checkAndFundGas` again with a slightly higher `minTrx`.
L121: Passes network again.
L122: Passes API key again.
L123: Passes master private key again.
L124: Passes master address again.
L125: Passes sender address again.
L126: Uses `MIN_TRX_FOR_GAS + 10` for more safety.
L127: Ends the `checkAndFundGas` call.
L128: Waits 3 seconds before retrying.
L129: Retries `sendTrc20` and stores `transferResult`.
L130: Ends resource-insufficient branch.
L131: Otherwise rethrow the error.
L132: Ends else.
L133: Ends catch.
L134: Blank line.
L135: Step 5 heading (VERIFY).
L136: Prints STEP 5.
L137: Fetches updated TRX + token balances concurrently.
L138: Reads new TRX into `newTrx`.
L139: Reads new token balance into `newToken`.
L140: Ends Promise.all.
L141: Prints new TRX balance row.
L142: Prints new token balance row.
L143: Prints "TRANSACTION COMPLETE".
L144: Prints separator line again.
L145: Prints the final TXID from `transferResult`.
L146: Prints the TronScan link for the TXID.
L147: Prints a blank line.
L148: Ends `run()`.
L149: Blank line.
L150: Entry point: call `run()` and handle errors with `.catch`.
L151: Logs the error message (or error object).
L152: If error has `err.code`, logs the error code.
L153: Exits with code 1.
L154: Ends catch handler.
```

### Source-aligned line-by-line mapping (accurate `L1..L164`)

```text
L1: Imports the main config module.
L2: Imports `getContractAddress` to resolve USDT/USDC contract addresses.
L3: Imports `createTronWeb` to create a TronWeb client.
L4: Imports balance helpers for TRX and TRC20.
L5: Imports gas top-up helper `checkAndFundGas`.
L6: Imports token transfer helper `sendTrc20`.
L7: Imports the custom `logger`.
L8: Imports `chalk` for colored output.
L9: Blank line.
L10: Section comment for CLI parsing.
L11: Defines `parseArgs()` to read CLI flags into a structured object.
L12: Grabs CLI args after the node/script name.
L13: Creates default parsed values (dryRun, token, amount, to).
L14: Blank line.
L15: Loops over each CLI argument.
L16: Uses `switch` to handle different flag names.
L17: When `--to` is found, it prepares to read the next argument.
L18: Stores the recipient address into `parsed.to`.
L19: Breaks out of the `--to` case.
L20: When `--amount` is found, it prepares to read the next argument.
L21: Converts the next argument to a number and stores it in `parsed.amount`.
L22: Breaks out of the `--amount` case.
L23: When `--token` is found, it prepares to read the next argument.
L24: Stores the token symbol uppercased (defaults to `USDT`).
L25: Breaks out of the `--token` case.
L26: When `--dry-run` is found, it enables dry-run mode.
L27: Sets `parsed.dryRun = true`.
L28: Breaks out of the `--dry-run` case.
L29: Closes the `switch`.
L30: Closes the `for` loop.
L31: Blank line.
L32: Validates required inputs for live mode (not dry-run).
L33: Prints usage help for the required CLI arguments.
L34: Prints usage help for the dry-run command.
L35: Exits with code `1` because required inputs are missing.
L36: Closes the validation `if` block.
L37: Blank line.
L38: Returns the fully parsed args object.
L39: Closes `parseArgs()`.
L40: Blank line.
L41: Section comment for building a TronScan link.
L42: Defines `tronscanLink(txid, network)` to choose the right explorer URL.
L43: If the network is `shasta`, returns the Shasta Tronscan transaction URL.
L44: If the network is `nile`, returns the Nile Tronscan transaction URL.
L45: Otherwise returns the main Tronscan transaction URL.
L46: Closes `tronscanLink()`.
L47: Blank line.
L48: Section comment for the main simulator function.
L49: Defines `run()` as the async main entry point.
L50: Parses CLI args by calling `parseArgs()`.
L51: Pulls required configuration values (network, keys, addresses) from `config`.
L52: Blank line.
L53: Prints the simulator banner header.
L54: Prints the banner separator line.
L55: Blank line.
L56: Step 1 header comment (initialize).
L57: Prints “STEP 1: INITIALIZE” via `logger.step`.
L58: Creates a TronWeb instance for the sender using sender private key.
L59: Prints the network in a table row.
L60: Prints the sender address in a table row.
L61: If not in dry-run mode, prints recipient/amount details too.
L62: Prints the recipient address row.
L63: Prints the transfer amount and token row.
L64: Closes the dry-run conditional.
L65: Prints the execution mode (“DRY RUN” or “LIVE”).
L66: Blank line.
L67: Step 2 header comment (check balances).
L68: Prints “STEP 2: CHECK BALANCES”.
L69: Resolves the USDT contract address for the selected network.
L70: Resolves the USDC contract address for the selected network.
L71: Blank line.
L72: Concurrently fetches TRX balance, USDT balance, and USDC balance.
L73: Loads TRX balance for the sender address.
L74: Loads USDT (TRC20) balance for the sender address.
L75: Loads USDC (TRC20) balance for the sender address.
L76: Closes the `Promise.all([...])` array.
L77: Blank line.
L78: Prints the fetched TRX balance.
L79: Prints the fetched USDT balance.
L80: Prints the fetched USDC balance.
L81: Blank line.
L82: If this is a dry-run, stop before any transaction is sent.
L83: Prints a message that dry-run completed with no transactions sent.
L84: Returns early from `run()`.
L85: Closes the dry-run `if`.
L86: Blank line.
L87: Section comment for validating token balance.
L88: Selects which token balance to validate based on `args.token`.
L89: Checks whether the selected token balance covers `args.amount`.
L90: Logs an “insufficient balance” error.
L91: Exits with code `1` because the transfer would fail.
L92: Closes the insufficient-balance `if`.
L93: Blank line.
L94: Step 3 header comment (gas assessment).
L95: Prints “STEP 3: GAS ASSESSMENT”.
L96: Blank line.
L97: Calls `checkAndFundGas(...)` to ensure sender has enough TRX for gas.
L98: Passes `network: TRON_NETWORK`.
L99: Passes `apiKey: TRON_PRO_API_KEY`.
L100: Passes `masterPrivateKey` from config.
L101: Passes `masterAddress` from config.
L102: Passes `userAddress` as the sender wallet address.
L103: Passes `minTrx` threshold from config.
L104: Closes the object passed into `checkAndFundGas`.
L105: Blank line.
L106: If funding actually happened...
L107: Prints the funded TRX amount.
L108: Prints the funding TXID.
L109: Comment about waiting for confirmation.
L110: Logs that it will wait 3 seconds.
L111: Waits 3 seconds using a Promise + `setTimeout`.
L112: Closes the funding `if`.
L113: Blank line.
L114: Step 4 header comment (transfer).
L115: Prints “STEP 4: TRANSFER”.
L116: Resolves the contract address for the specific token argument.
L117: Blank line.
L118: Declares a variable to hold transfer result (TXID).
L119: Begins try block for the transfer call.
L120: Sends the TRC20 transfer using `sendTrc20(...)`.
L121: Starts catch block if the transfer throws.
L122: If the error is specifically `RESOURCE_INSUFFICIENT`...
L123: Logs a warning and intention to top up gas and retry.
L124: Calls `checkAndFundGas(...)` again for a retry.
L125: Passes `network: TRON_NETWORK` again.
L126: Passes `apiKey: TRON_PRO_API_KEY` again.
L127: Passes `masterPrivateKey` again.
L128: Passes `masterAddress` again.
L129: Passes `userAddress` again.
L130: Uses a higher `minTrx` for the retry (`MIN_TRX_FOR_GAS + 10`).
L131: Closes the `checkAndFundGas` options object.
L132: Waits 3 seconds before retrying the transfer.
L133: Retries `sendTrc20(...)` and stores the result.
L134: Closes the resource-insufficient branch.
L135: Otherwise (not resource-insufficient), rethrow the error.
L136: Throws the original error to break out of retry logic.
L137: Closes the `if` and completes catch handling.
L138: Closes the catch block.
L139: Blank line.
L140: Step 5 header comment (verify).
L141: Prints “STEP 5: VERIFY”.
L142: Blank line.
L143: Concurrently fetches updated TRX balance and updated token balance.
L144: Fetches new TRX balance.
L145: Fetches new TRC20 balance for `contractAddr`.
L146: Closes the Promise.all array.
L147: Blank line.
L148: Prints the new TRX balance.
L149: Prints the new token balance for the selected token symbol.
L150: Blank line.
L151: Prints “TRANSACTION COMPLETE”.
L152: Prints a separator line.
L153: Prints the TXID.
L154: Prints the TronScan link for the TXID.
L155: Prints a final blank line.
L156: Closes the `run()` function.
L157: Blank line.
L158: Entry-point comment for error handling.
L159: Calls `run()` and attaches a `.catch` handler.
L160: Logs the error (message or object).
L161: If the error includes `err.code`, logs that code too.
L162: Exits the process with code `1`.
L163: Closes the `.catch` handler call.
L164: End-of-file blank line.
```

---

## End-to-end execution summary (in code order)

1. `simulator/index.js` starts and reads CLI args.
2. It initializes TronWeb for the sender.
3. It checks sender TRX balance and USDT/USDC balances.
4. If TRX is below `MIN_TRX_FOR_GAS`, it calls `checkAndFundGas` (which creates a master TronWeb and sends TRX).
5. It calls `sendTrc20` which triggers the TRC20 `transfer` on the correct token contract and signs/broadcasts the transaction.
6. If the chain responds with `RESOURCE_INSUFFICIENT`, it funds again and retries.
7. Finally, it re-checks balances and prints TXID + TronScan link.

