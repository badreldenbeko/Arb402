# arb402

HTTP 402 payment facilitator for Arbitrum. Sits between clients and merchants to handle USDC payments using EIP-3009 (TransferWithAuthorization).

A client signs a transfer authorization off-chain. The facilitator verifies the signature, pulls the USDC from the client, takes a fee, and forwards the rest to the merchant. Two on-chain transactions per settlement — no approvals needed from the client beforehand.

## How it works

```
Client                    Facilitator                  Merchant
  |                           |                           |
  |  GET /requirements        |                           |
  |  <-- 402 + payment info   |                           |
  |                           |                           |
  |  sign EIP-3009 auth       |                           |
  |                           |                           |
  |  POST /settle             |                           |
  |  (signed authorization)   |                           |
  |                           |                           |
  |                    transferWithAuthorization()         |
  |                    (USDC: client -> facilitator)       |
  |                           |                           |
  |                           |  transfer()               |
  |                           |  (USDC: facilitator -> merchant)
  |                           |                           |
  |  <-- settlement receipt   |                           |
```

1. Client requests payment requirements from the facilitator
2. Client signs an EIP-3009 `TransferWithAuthorization` off-chain (no on-chain approval tx needed)
3. Client sends the signed payload to `/settle`
4. Facilitator verifies the signature, amount, nonce, and time window
5. Facilitator calls `transferWithAuthorization` on USDC to pull funds from the client
6. Facilitator calls `transfer` on USDC to forward the merchant's share
7. Facilitator keeps the service fee + gas fee

If the outgoing transfer fails after the incoming succeeds, a background recovery worker retries it automatically. If recovery is exhausted, an admin can issue a refund.

## Architecture

```
src/
  server.ts          express app, routes, middleware
  chains.ts          chain registry — One, Nova, and Orbit chains as data
  config.ts          env parsing, active-network resolution, fee constants
  types.ts           shared interfaces + zod schemas
  eip3009.ts         EIP-712 digest construction, signature verification
  tokenProbe.ts      on-chain EIP-3009 + EIP-712 domain verification
  requirements.ts    402 payment requirement generation
  verify.ts          payment validation logic, fee calculation
  settle.ts          on-chain settlement (incoming + outgoing transfers)
  refund.ts          admin refund for failed payments
  recovery.ts        background worker that retries stuck outgoing transfers
  startup.ts         boot-time checks (DB, chain ID, settlement token)
  auth.ts            merchant + admin API key authentication (bcrypt)
  nonceStore.ts      nonce tracking, payment state machine, DB operations
  issuedStore.ts     records issued requirements so /settle can bind to a quote
  merchantStore.ts   merchant CRUD
  logging.ts         structured logger with correlation IDs
  db.ts              postgres pool, schema, transactions

  cli/               the arb402 binary
    index.ts         command registration
    commands/        init, config, chains, doctor, wallet, keygen, serve, merchant

scripts/
  generate-api-key.ts    generate a merchant API key + bcrypt hash
  manage-merchants.ts    add/list/enable/disable/delete merchants
```

## CLI

```bash
npx arb402 <command>      # installed
npm run cli -- <command>  # from a clone
```

| Command | Description |
|---|---|
| `init [--network <id>] [--force]` | Scaffold a `.env` for a chain |
| `config` | Print the resolved configuration |
| `chains [--verify]` | List registered chains; `--verify` probes each token on-chain |
| `doctor` | Deployment-readiness checks; non-zero exit on failure |
| `wallet` | Facilitator address and on-chain balances |
| `keygen [--admin]` | Generate an API key + bcrypt hash |
| `dev` / `start` | Run the facilitator from source / from `dist` |
| `merchant create <address> <name>` | Generate a key, register the merchant, print the key once |
| `merchant add <address> <name> <keyId> <hash>` | Register with a pre-generated key |
| `merchant list` | List merchants |
| `merchant enable\|disable <address>` | Toggle a merchant |
| `merchant delete <address>` | Remove a merchant |

Full options and output in the [CLI reference](./docs/cli.md).

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Server status, network, DB connectivity |
| GET | `/supported` | none | Payment kinds (v1 legacy names + v2 CAIP-2) |
| GET/POST | `/requirements` | none | Generate 402 payment requirements |
| POST | `/verify` | none | Validate a payment without settling |
| POST | `/settle` | merchant | Verify + execute on-chain settlement |
| GET | `/admin/wallet` | admin | Facilitator USDC + ETH balances |
| GET | `/admin/stuck` | admin | Payments incomplete past the alert threshold |
| POST | `/admin/refund` | admin | Refund a failed payment to the user |

Request and response schemas in the [API reference](./docs/api.md).

## Fee model

The facilitator uses a fee-inclusive model. The client pays a total amount, and the facilitator extracts its cut before forwarding:

```
afterGas       = totalAmount - gasFee
merchantAmount = afterGas * 10000 / (10000 + feeBps)
serviceFee     = afterGas - merchantAmount
```

Default: 0.5% service fee (`SERVICE_FEE_BPS=50`) + 0.10 USDC gas buffer (`GAS_FEE_USDC=100000`).

## Payment states

```
pending -> incoming_submitted -> incoming_complete -> outgoing_submitted -> complete
                |                      |                     |
                v                      v                     v
              failed                failed               failed -> refunded
```

The recovery worker picks up payments stuck at `incoming_complete` or `outgoing_submitted` and retries the outgoing transfer with exponential backoff.

## Setup

```bash
npm install
npx arb402 init --network arbitrum-sepolia
# set EVM_PRIVATE_KEY in .env (and DATABASE_URL for anything but local dev)

npx arb402 doctor    # verifies RPC, chain id, and the settlement token
npx arb402 dev
```

Without `DATABASE_URL`, the server runs with in-memory nonce tracking (fine for dev, unsafe for production — nonces are lost on restart).

### Merchant registration

```bash
# generate a key, register the merchant, print the key once
npx arb402 merchant create 0xMerchantAddress "MerchantName"

# list, enable, disable, delete
npx arb402 merchant list
npx arb402 merchant disable 0xMerchantAddress
```

Merchant commands require `DATABASE_URL`. Use `arb402 keygen` + `arb402 merchant add` when the key must be generated somewhere other than the machine holding the database.

### Production

```bash
npm run build
NODE_ENV=production npx arb402 doctor    # gate: non-zero exit on any blocking issue
NODE_ENV=production npx arb402 start
```

Requires PostgreSQL with `DATABASE_URL` set. Schema is created automatically on first boot. See [deployment.md](./docs/deployment.md) for the full checklist.

> **Scaling — one settlement process per facilitator wallet.** Transaction
> submission is serialized by an in-process mutex + nonce manager, which is
> what prevents concurrent settlements from colliding on the wallet's account
> nonce. The **recovery worker** is safe to run on multiple instances (it claims
> rows with `FOR UPDATE SKIP LOCKED`), but **settlement** is not: two replicas
> sharing one `EVM_PRIVATE_KEY` would reintroduce the nonce collision. Run a
> single settlement process per wallet (scale by using separate wallets, or put
> a queue in front), and behind a proxy set `TRUST_PROXY` so rate limits key on
> the real client IP.

## Networks

Chains are data, not code. Three are built in; any Orbit (L3) chain is added by
writing a JSON file — no fork, no rebuild.

| Network | CAIP-2 | Chain ID | Settlement token |
|---------|--------|----------|------------------|
| Arbitrum One | eip155:42161 | 42161 | Native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Arbitrum Nova | eip155:42170 | 42170 | **none by default** — see below |
| Arbitrum Sepolia | eip155:421614 | 421614 | Test USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Any Orbit chain | eip155:&lt;id&gt; | yours | yours, via `arb402.chains.json` |

```bash
arb402 chains --verify     # probe every chain's token on-chain
```

**Why Nova ships without a token.** Settlement is EIP-3009
`transferWithAuthorization` — that is what makes the flow gasless for the payer.
Nova's canonical stablecoin is *bridged* USDC.e (`0x750ba8…273b`), a plain
Arbitrum gateway ERC-20: 6 decimals, the symbol `USDC`, even a
`DOMAIN_SEPARATOR` — but `authorizationState` reverts and
`transferWithAuthorization` does not exist. It cannot settle a single payment.
Shipping it as a default would produce valid-looking signatures that revert
on-chain, so Nova is fully supported *except* for a token you must supply:

```bash
NETWORK=arbitrum-nova
USDC_ADDRESS=0xYourEip3009TokenOnNova
```

`arb402 doctor` then verifies that token really implements EIP-3009 and that its
EIP-712 domain matches, before you rely on it. Same probe, same guarantee, for
any Orbit chain. See [chains.md](./docs/chains.md).

## Documentation

| Guide | Covers |
|---|---|
| [Integration](./docs/integration.md) | Charging for an API, or paying for one |
| [CLI reference](./docs/cli.md) | Every command, option, and exit code |
| [API reference](./docs/api.md) | Every endpoint, schema, and error |
| [Configuration](./docs/configuration.md) | Every environment variable |
| [Chains](./docs/chains.md) | One, Nova, and Orbit onboarding |
| [Deployment](./docs/deployment.md) | Production, scaling, monitoring, key rotation |

Plus [templates](./templates) (four extensible starting points) and the
[harness](./harness) (a deterministic local chain that settles every template
end to end).

## Tests

```bash
npm test                              # unit + integration
cd harness && npm install && npm run harness   # real on-chain settlement, locally
```

## License

MIT — see [LICENSE](./LICENSE).

Both legacy names (`arbitrum`, `arbitrum-sepolia`) and CAIP-2 identifiers are accepted in the `NETWORK` env var and in API payloads.

## Testing

```bash
npm test            # run once
npm run test:watch  # watch mode
```

Tests cover fee math, network normalization, EIP-3009 signature roundtrips, nonce store behavior, and API route validation.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NETWORK` | no | arbitrum-sepolia | Active network |
| `EVM_PRIVATE_KEY` | yes (for settlement) | — | Facilitator wallet private key |
| `ARBITRUM_RPC_URL` | no | public RPC | Arbitrum One RPC endpoint |
| `ARBITRUM_SEPOLIA_RPC_URL` | no | public RPC | Arbitrum Sepolia RPC endpoint |
| `PORT` | no | 3002 | HTTP server port |
| `SERVICE_FEE_BPS` | no | 50 | Service fee in basis points (max 500) |
| `GAS_FEE_USDC` | no | 100000 | Gas fee buffer in USDC micro-units (6 decimals) |
| `DATABASE_URL` | no (dev) / yes (prod) | — | PostgreSQL connection string |
| `USDC_ADDRESS` | no | per-network default | Override USDC contract address |
| `ADMIN_API_KEY_HASH` | no | — | bcrypt hash for admin endpoints |
| `MAX_SETTLEMENT_AMOUNT` | no | 1000000000 (1000 USDC) | Max single settlement |
| `RECOVERY_INTERVAL_MS` | no | 300000 (5 min) | Recovery worker poll interval |
