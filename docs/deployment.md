# Deployment and operations

Running arb402 in production. The constraints here are real — particularly
[scaling](#scaling), which is not a matter of adding replicas.

## Prerequisites

| Requirement | Why |
|---|---|
| Node >= 20 | Native `fetch`, ESM |
| PostgreSQL | Nonce tracking and payment state. **Mandatory** when `NODE_ENV=production` |
| A funded wallet | Gas for two transactions per settlement |
| An EIP-3009 token | The settlement mechanism. See [chains.md](./chains.md) |

## Deploying

```bash
npm ci
npm run build

# configure
cp .env.example .env
# set NETWORK, EVM_PRIVATE_KEY, DATABASE_URL, ADMIN_API_KEY_HASH

NODE_ENV=production arb402 doctor    # gate: exits non-zero on any blocking issue
NODE_ENV=production arb402 start
```

`doctor` exits non-zero when anything blocking fails, so wire it into CI or your
deploy script before the process starts. It verifies the RPC, the chain id, and
that the settlement token really implements EIP-3009 with a matching EIP-712
domain — checks that would otherwise fail at the first real payment.

The database schema is created automatically on first connect.

## Required production settings

```bash
NODE_ENV=production
DATABASE_URL='postgresql://…?sslmode=verify-full'   # refuses to boot without it
ADMIN_API_KEY_HASH=…             # from: arb402 keygen --admin
TRUST_PROXY=1                    # only if behind a proxy or load balancer
```

For a remote database, request verified TLS through `sslmode` (or `PGSSLMODE`)
and **leave `PGSSL` unset** — `pg` honours those, along with `PGSSLROOTCERT` for
a private CA. Setting `PGSSL=true` forces `rejectUnauthorized: false` and
overrides `sslmode`, downgrading a verified connection to an unverified one. See
[configuration.md](./configuration.md#tls-to-the-database).

Confirm the result rather than assuming it — `arb402 doctor` reports a
`database TLS` line with the negotiated version and cipher, read from
`pg_stat_ssl` on the server. With `NODE_ENV=production` it exits non-zero if
that connection is unencrypted and the host is not loopback. Behind a
connection pooler the reading describes the pooler-to-Postgres hop, not your
app's — see [configuration.md](./configuration.md#confirming-what-was-negotiated).

Do **not** set `DEV_MERCHANT_API_KEY_HASH` or `DEV_MERCHANT_ADDRESS` in
production. They bypass the merchant database entirely and exist only so the
local test harness can settle without Postgres.

Without `DATABASE_URL` the nonce store is in-memory: it grows unbounded and is
lost on restart, which loses replay protection with it. The server refuses to
boot in production rather than run that way.

## Scaling

> **One settlement process per facilitator wallet.**

Transaction submission is serialised by an in-process mutex and nonce manager.
That is what prevents concurrent settlements from colliding on the wallet's
account nonce. Two replicas sharing one `EVM_PRIVATE_KEY` reintroduce exactly
the collision the mutex exists to prevent.

| Component | Safe to replicate? | Why |
|---|---|---|
| Settlement (`/settle`) | **No** | In-process wallet nonce manager |
| Recovery worker | Yes | Claims rows with `FOR UPDATE SKIP LOCKED` |
| Read-only endpoints | Yes | No wallet access |

To scale throughput, either give each process its own wallet (and route between
them), or put a queue in front of a single settlement process. To serve multiple
chains, run one process per chain — each with its own `NETWORK`, port, and
wallet.

Behind a proxy, set `TRUST_PROXY` so rate limiting keys on the real client IP.
Leave it unset when directly exposed: naively trusting `X-Forwarded-For` lets
clients spoof their IP and evade limits.

## Keeping the wallet funded

Gas is paid in the chain's native token while fees accrue in USDC, so the wallet
drains in one currency and fills in another. `MIN_FACILITATOR_ETH_WEI` (default
0.0005 ETH) is a preflight that refuses a settlement rather than letting the
wallet run dry mid-payment — but it is a backstop, not a monitor.

```bash
arb402 wallet            # address, ETH, USDC
curl -H "X-Admin-Key: $KEY" localhost:3002/admin/wallet
```

Alert on the ETH balance approaching `MIN_FACILITATOR_ETH_WEI`. A facilitator
that cannot pay gas rejects every settlement.

## Recovery worker

Settlement is two transactions. If the incoming one lands and the outgoing one
fails, funds sit in the facilitator wallet with the merchant unpaid. The
recovery worker exists for exactly that window.

It scans every `RECOVERY_INTERVAL_MS` (default 5 min) for payments at
`incoming_complete` or `outgoing_submitted` and retries the outgoing transfer
with exponential backoff. Transfers are signed and persisted before broadcast
and recovered idempotently, so a crash or RPC timeout can never pay a merchant
twice or strand a payer's funds.

It claims rows with `FOR UPDATE SKIP LOCKED`, so it is safe to run on multiple
instances.

## Monitoring

### Stuck payments

```bash
curl -H "X-Admin-Key: $KEY" localhost:3002/admin/stuck
```

Payments still incomplete after `STUCK_PAYMENT_ALERT_MS` (default 1 hour). These
are usually zombies — an incoming transfer signed but never broadcast, whose
nonce was reused. A non-zero `count` is an operator signal to review, not
necessarily lost funds. The recovery worker also logs a `WARN` for each.

### Health

```bash
curl localhost:3002/health
```

Returns network, chain id, facilitator address, and DB connectivity. Treat
`"db": "not_configured"` in production as a misconfiguration — it means the
in-memory store is active.

### Logs

Structured JSON with a correlation id on every request, propagated through all
log lines for that request. Search by correlation id to trace a settlement end
to end. Failed settlements log the reason; `500` responses never leak internals
to the caller.

## Refunds

When recovery is exhausted and a payment cannot be completed:

```bash
curl -X POST localhost:3002/admin/refund \
  -H "X-Admin-Key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"nonce":"0x…","reason":"merchant transfer failed after retries"}'
```

Returns funds to the payer and moves the payment to `refunded`. Only refund
payments that recovery has genuinely given up on — refunding one still in flight
risks paying twice.

## Key management

| Key | Storage | Rotation |
|---|---|---|
| `EVM_PRIVATE_KEY` | Secret manager, never in the image | New wallet, drain the old one, redeploy |
| Merchant API keys | bcrypt hash in Postgres | `arb402 merchant create` for a new key, then `disable` the old merchant row |
| `ADMIN_API_KEY_HASH` | bcrypt hash in env | `arb402 keygen --admin`, redeploy |

Merchant keys are `<keyId>.<secret>`; only the hash is stored and the plaintext
is shown exactly once. There is no auth cache, so disabling a merchant takes
effect on the next request.

To suspend a merchant without losing its history:

```bash
arb402 merchant disable 0xMerchantAddress
```

## Fee tuning

| Variable | Default | Notes |
|---|---|---|
| `SERVICE_FEE_BPS` | `50` (0.5%) | Capped at 500 |
| `GAS_FEE_USDC` | `100000` (0.10 USDC) | Max 1000000 |
| `MAX_SETTLEMENT_AMOUNT` | `1000000000` (1000 USDC) | Per-settlement ceiling |

The flat gas buffer dominates small payments — below roughly 0.20 USDC most of
the payment is the buffer. For high-frequency micropayments, either lower
`GAS_FEE_USDC` to match real Arbitrum gas costs or batch on the merchant side,
as the metered-inference template does.

Set `MAX_SETTLEMENT_AMOUNT` to the largest payment you actually expect. It caps
the damage from a client bug or a malicious oversized authorisation.

## Upgrading

1. `arb402 doctor` on the new version, against production config
2. Deploy — the schema migrates forward automatically on connect
3. Watch `/admin/stuck` through the first recovery interval

The process handles `SIGINT`/`SIGTERM` gracefully: it stops the recovery worker,
closes the listener, and drains the connection pool. In-flight settlements
complete first, so a rolling restart does not strand a payment.

## Pre-launch checklist

- [ ] `arb402 doctor` passes with `NODE_ENV=production`
- [ ] `DATABASE_URL` set and reachable; schema created
- [ ] Any non-loopback database uses verified TLS (`sslmode=verify-full`, `PGSSL` unset); confirmed via `arb402 doctor`
- [ ] `ADMIN_API_KEY_HASH` set; `DEV_MERCHANT_*` unset
- [ ] Exactly one settlement process per wallet
- [ ] `TRUST_PROXY` set if behind a load balancer
- [ ] Wallet funded; alerting on the native-token balance
- [ ] `arb402 chains --verify` shows `EIP-3009 ok, domain ok` for the active chain
- [ ] Merchants registered via `arb402 merchant create`
- [ ] `/admin/stuck` monitored
- [ ] Fees and `MAX_SETTLEMENT_AMOUNT` reviewed for your payment sizes
