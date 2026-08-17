# Configuration reference

All configuration is environment variables, read from `.env` in the working
directory (via dotenv) or from the real environment. `arb402 init` writes a
starting `.env`; `arb402 config` prints what actually resolved.

## Network and token

| Variable | Default | Description |
|---|---|---|
| `NETWORK` | `arbitrum-sepolia` | Active chain: a legacy name (`arbitrum`, `arbitrum-nova`), an alias (`nova`, `arb1`), a CAIP-2 id (`eip155:42161`), or an Orbit slug. Defaults to testnet, never mainnet. |
| `ARBITRUM_RPC_URL` | `https://arb1.arbitrum.io/rpc` | RPC for Arbitrum One |
| `ARBITRUM_NOVA_RPC_URL` | `https://nova.arbitrum.io/rpc` | RPC for Arbitrum Nova |
| `ARBITRUM_SEPOLIA_RPC_URL` | `https://sepolia-rollup.arbitrum.io/rpc` | RPC for Arbitrum Sepolia |
| `ORBIT_<chainId>_RPC_URL` | from chains file | RPC override for an Orbit chain, e.g. `ORBIT_412346_RPC_URL` |
| `ARB402_CHAINS_FILE` | `./arb402.chains.json` | Orbit chain registry. An explicitly set path that does not exist is an error; the default simply being absent is not. |
| `USDC_ADDRESS` | per chain | Settlement token for the **active** chain. Required on chains with no default (Arbitrum Nova). Must implement EIP-3009. |
| `USDC_NAME` | `USD Coin` | EIP-712 domain name of that token. Set only if it differs. |
| `USDC_VERSION` | `2` | EIP-712 domain version of that token. Set only if it differs. |

`USDC_NAME` / `USDC_VERSION` are **not cosmetic**: a mismatch makes every
signature recover to the wrong address, with no on-chain error explaining why.
`arb402 doctor` verifies both against the contract's own `DOMAIN_SEPARATOR`.

See [chains.md](./chains.md) for the full chain model.

## Wallet

| Variable | Default | Description |
|---|---|---|
| `EVM_PRIVATE_KEY` | — | Facilitator wallet key, `0x` + 64 hex. Also accepted as `FACILITATOR_PRIVATE_KEY` or `PRIVATE_KEY`. |

Without it the process still starts so read-only commands work, but settlement
is disabled and a warning is logged. Invalid formats throw immediately.

This wallet pays gas in the chain's native token and accumulates service fees in
USDC. Check both with `arb402 wallet`.

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | HTTP listen port |
| `TRUST_PROXY` | unset | Set behind a proxy/LB (`1`, `loopback`, …) so rate limits key on the real client IP. Leave unset when directly exposed — naively trusting `X-Forwarded-For` lets clients spoof their IP. |
| `NODE_ENV` | — | `production` makes `DATABASE_URL` mandatory |

Request bodies are capped at 100 kB (not configurable).

## Logging

| Variable | Default | Description |
|---|---|---|
| `DEBUG` | unset | Enables `DEBUG`-level log lines. `INFO`, `WARN`, and `ERROR` always print regardless. |

The check is presence, not value — **any** non-empty string enables debug
logging, including `DEBUG=false` and `DEBUG=0`. To turn it off, unset the
variable or set it empty (`DEBUG=`).

Today this gates a single line (the recovery worker reporting that it skipped a
cycle because the previous one was still running). It is a hook for future
diagnostics, not a verbose mode — expect near-silence, not a firehose.

Logs are line-oriented text on stdout/stderr, not JSON:

```
[2026-08-14T09:12:44.031Z] [DEBUG] {"correlationId":"..."} recovery: previous cycle still running, skipping
```

## Fees

| Variable | Default | Description |
|---|---|---|
| `SERVICE_FEE_BPS` | `50` (0.5%) | Service fee in basis points. **Capped at 500** (5%); higher values are clamped. |
| `GAS_FEE_USDC` | `100000` (0.10 USDC) | Flat gas buffer in token base units. **Max 1000000** (1.00 USDC); exceeding it throws at startup. |
| `MAX_SETTLEMENT_AMOUNT` | `1000000000` (1000 USDC) | Largest single settlement accepted |

The model is fee-inclusive — the payer pays a total and the facilitator extracts
its cut before forwarding:

```
afterGas       = totalAmount - gasFee
merchantAmount = afterGas * 10000 / (10000 + feeBps)
serviceFee     = afterGas - merchantAmount
```

The fee is computed on the post-gas remainder, so the merchant receives slightly
less than `totalAmount × (1 − feeBps/10000)`.

## Settlement safety

| Variable | Default | Description |
|---|---|---|
| `REQUIRE_ISSUED_REQUIREMENTS` | `true` | Bind settlement to a requirement this facilitator actually issued: the nonce must be one it handed out, and the signed amount, deadline, and merchant must match. Anti-replay and anti-tamper. Set `false` for the advisory x402 model where the resource server alone enforces price. |
| `MIN_FACILITATOR_ETH_WEI` | `500000000000000` (0.0005 ETH) | Minimum wallet balance required to attempt a settlement. Gas is paid in ETH while fees accrue in USDC, so without this preflight the wallet can run dry mid-settlement. |
| `RECOVERY_INTERVAL_MS` | `300000` (5 min) | How often the recovery worker scans for stuck outgoing transfers |
| `STUCK_PAYMENT_ALERT_MS` | `3600000` (1 h) | A payment still incomplete this long is almost certainly a zombie. Raises a `WARN` and appears in `GET /admin/stuck`. |

Leaving `REQUIRE_ISSUED_REQUIREMENTS=true` is strongly recommended. It is an
integrity control, not merchant-authoritative pricing.

## Persistence

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. **Required when `NODE_ENV=production`.** |
| `PGSSL` | unset | Set to exactly `true` to force **unverified** TLS, overriding whatever `PGSSLMODE` / `sslmode` would have negotiated. Unset is usually what you want. |

Without it, nonce tracking is in-memory: it grows unbounded and is lost on
restart, which means replay protection is lost too. Fine for local development
and the test harness; the server refuses to boot without it in production. The
schema is created automatically on first connect.

### TLS to the database

`PGSSL` is a **downgrade switch, not an on switch.** `src/db.ts` passes
`ssl: { rejectUnauthorized: false }` when it is exactly `true`, and `ssl:
undefined` otherwise — and `undefined` does not mean "off". It hands the
decision to `pg`, which resolves TLS from `PGSSLMODE` and from `sslmode` in the
connection string:

| `PGSSL` | Resulting TLS |
|---|---|
| unset (or any value ≠ `true`) | Whatever `PGSSLMODE` / `?sslmode=` specifies — including **verified** TLS under `verify-full` |
| `true` | Encrypted, certificate **not** verified — and this **overrides** `sslmode` |

So the safe configuration is to leave `PGSSL` unset and ask for verified TLS
explicitly:

```bash
DATABASE_URL='postgresql://user:pass@host:5432/arb402?sslmode=verify-full'
# or: PGSSLMODE=verify-full, plus PGSSLROOTCERT=/path/to/ca.pem if the
# provider uses a private CA
```

Both are read by `pg` itself, so `PGSSLROOTCERT` **does** work on this path —
the hard-coded pool options in `src/db.ts` only take effect when `PGSSL=true`.

> **Do not set `PGSSL=true` to "turn SSL on."** If `PGSSLMODE=verify-full` is
> already in effect, setting `PGSSL=true` silently downgrades a
> certificate-verified connection to an unverified one, which restores exposure
> to an active machine-in-the-middle.
>
> Reach for it only when a provider's certificate cannot be verified any other
> way — a self-signed cert with no published CA — and prefer fixing that with
> `PGSSLROOTCERT`, or with an SSH/WireGuard tunnel whose local end is loopback.
>
> A private network address is not an alternative to TLS here. `10.0.0.5` is
> not globally routable, which is not the same as trusted: shared VPCs,
> multi-tenant container networks, and peering misconfigurations all live in
> private ranges. `doctor` treats only loopback and unix sockets as exempt.

`PGSSL` is only consulted when `DATABASE_URL` is set. Its matching is strict
(`=== "true"`) while `DEBUG`'s is loose, so `PGSSL=1` is ignored entirely.

### Confirming what was negotiated

Client-side options say what was *requested*. For what was *agreed*, ask the
server:

```sql
SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid();
```

`arb402 doctor` runs exactly this and prints a `database TLS` line with the
version and cipher, warning when the connection is unencrypted or when
`PGSSL=true` disabled certificate verification. Under `NODE_ENV=production` an
unencrypted connection to a non-loopback host is a **hard failure**, so `doctor`
exits non-zero and holds the deploy; loopback and unix-socket connections stay a
warning, since a database on the same host is a legitimate topology.

> **Behind a connection pooler this reports the wrong hop.** `pg_stat_ssl`
> describes the connection Postgres itself terminated — pooler-to-Postgres, not
> app-to-pooler. With pgbouncer terminating TLS and reaching Postgres over a
> unix socket, `doctor` will report "NOT encrypted" for an app connection that
> was encrypted; the reverse is equally possible. When a pooler is in the path,
> treat this check as describing the back end only and verify the app-facing leg
> from the pooler's own configuration.

## Authentication

| Variable | Default | Description |
|---|---|---|
| `ADMIN_API_KEY_HASH` | — | bcrypt hash of the admin key, from `arb402 keygen --admin`. Without it, `/admin/*` is unusable. |
| `DEV_MERCHANT_API_KEY_HASH` | — | **Dev/test only.** Single-merchant fallback so the facilitator can settle without a database. |
| `DEV_MERCHANT_ADDRESS` | — | Address paired with the above. Both must be set for the fallback to activate. |

> Never set `DEV_MERCHANT_*` in production. They bypass the merchant database
> entirely. They exist so the local Hardhat harness can settle without Postgres.

Production merchants are registered with `arb402 merchant create` and stored in
Postgres. Keys are `<keyId>.<secret>`; only the bcrypt hash is stored.

## Precedence

1. Real environment variables
2. `.env` in the working directory
3. Orbit chains file (`arb402.chains.json`)
4. Built-in chain defaults

`.env` does not override variables already exported in your shell.

## Verifying

```bash
arb402 config    # what resolved
arb402 chains    # every registered chain (--verify to probe on-chain)
arb402 doctor    # readiness checks; non-zero exit if anything blocking fails
```

`doctor` exits non-zero on failure, so it works as a pre-deploy gate in CI.
