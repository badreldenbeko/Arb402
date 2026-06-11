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
  config.ts          network config, env parsing, fee constants
  provider.ts        viem public client singleton
  types.ts           shared interfaces + zod schemas
  eip3009.ts         EIP-712 digest construction, signature verification
  verify.ts          payment validation logic, fee calculation
  settle.ts          on-chain settlement (incoming + outgoing transfers)
  refund.ts          admin refund for failed payments
  recovery.ts        background worker that retries stuck outgoing transfers
  startup.ts         boot-time checks (DB, chain ID, USDC decimals)
  auth.ts            merchant + admin API key authentication (bcrypt)
  nonceStore.ts      nonce tracking, payment state machine, DB operations
  merchantStore.ts   merchant CRUD
  logging.ts         structured logger with correlation IDs
  db.ts              postgres pool, schema, transactions

scripts/
  generate-api-key.ts    generate a merchant API key + bcrypt hash
  manage-merchants.ts    CLI to add/list/enable/disable/delete merchants
```

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Server status, network, DB connectivity |
| GET | `/supported` | none | Payment kinds (v1 legacy names + v2 CAIP-2) |
| GET/POST | `/requirements` | none | Generate 402 payment requirements |
| POST | `/verify` | none | Validate a payment without settling |
| POST | `/settle` | merchant | Verify + execute on-chain settlement |
| GET | `/admin/wallet` | admin | Facilitator USDC + ETH balances |
| POST | `/admin/refund` | admin | Refund a failed payment to the user |

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
cp .env.example .env
# fill in EVM_PRIVATE_KEY and optionally DATABASE_URL

npm install
npm run dev
```

Without `DATABASE_URL`, the server runs with in-memory nonce tracking (fine for dev, unsafe for production — nonces are lost on restart).

### Merchant registration

```bash
# generate a key pair
npm run generate-api-key
# output: API key (give to merchant) + hash (store in DB)

# register the merchant
npm run merchants -- add 0xMerchantAddress "MerchantName" '<hash>'

# list, enable, disable, delete
npm run merchants -- list
npm run merchants -- disable 0xMerchantAddress
```

### Production

```bash
npm run build
npm start
```

Requires PostgreSQL with `DATABASE_URL` set. Schema is created automatically on first boot.

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

| Network | CAIP-2 | Chain ID | USDC |
|---------|--------|----------|------|
| Arbitrum One | eip155:42161 | 42161 | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 |
| Arbitrum Sepolia | eip155:421614 | 421614 | 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d |

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
