# CLI reference

The `arb402` binary is the operator-facing entry point to the facilitator. Every
command is listed here with its options, output, and failure modes.

```bash
# from a clone
npm run cli -- <command>

# from an install
npx arb402 <command>
```

All commands read `.env` from the current working directory. Commands that touch
the chain also read the Orbit registry (`arb402.chains.json` or
`ARB402_CHAINS_FILE`) — see [chains.md](./chains.md).

| Command | Needs a key | Needs RPC | Needs Postgres |
|---|---|---|---|
| [`init`](#arb402-init) | no | no | no |
| [`config`](#arb402-config) | no | no | no |
| [`chains`](#arb402-chains) | no | only with `--verify` | no |
| [`doctor`](#arb402-doctor) | checks it | yes | checks it |
| [`wallet`](#arb402-wallet) | yes | yes | no |
| [`keygen`](#arb402-keygen) | no | no | no |
| [`dev`](#arb402-dev) / [`start`](#arb402-start) | yes | yes | production only |
| [`merchant …`](#arb402-merchant) | no | no | yes |

---

## `arb402 init`

Scaffold a `.env` in the current directory from the packaged template.

```bash
arb402 init
arb402 init --network arbitrum
arb402 init --network eip155:42170 --force
```

| Option | Description |
|---|---|
| `--network <id>` | Target network. Accepts a legacy name (`arbitrum`, `arbitrum-nova`, `arbitrum-sepolia`), an alias (`nova`, `arb1`), a CAIP-2 id (`eip155:42161`), or any Orbit chain registered in your chains file. |
| `-f, --force` | Overwrite an existing `.env`. |

Refuses to overwrite an existing `.env` without `--force`, so it is safe to
re-run. A CAIP-2 id is written back as-is; an alias is canonicalised to the
chain's slug.

If the chosen chain has no default settlement token — Arbitrum Nova is the live
example — `init` says so and tells you to set `USDC_ADDRESS`.

**Next steps it prints:** set `EVM_PRIVATE_KEY`, run `doctor`, run `dev`.

---

## `arb402 config`

Print the fully resolved configuration: what the facilitator will actually use
after env vars, defaults, and the chain registry are combined.

```bash
arb402 config
```

Shows the active network (display name, CAIP-2 id, chain id, family), RPC URL,
settlement token and its EIP-712 domain, facilitator address, port, fee
settings, and whether Postgres and an admin key are configured.

Warns when settlement is disabled — either no `EVM_PRIVATE_KEY`, or no
settlement token on the active chain.

---

## `arb402 chains`

List every registered chain: the three built-ins plus anything in your Orbit
chains file.

```bash
arb402 chains
arb402 chains --verify
```

| Option | Description |
|---|---|
| `--verify` | Probe each chain's token over its own RPC: does it implement EIP-3009, does it have the expected decimals, and does its on-chain `DOMAIN_SEPARATOR` match the configured EIP-712 domain. |

Per chain it prints the CAIP-2 id, chain id, family (`Arbitrum One`, `Arbitrum
Nova`, `Orbit (L3)`, `testnet`), primary alias, RPC URL, settlement token and
domain, and — for entries that came from your chains file — `source`.

`--verify` makes live RPC calls and is the fastest way to answer "will this
chain actually work?" before you commit to it. Example output:

```
  Arbitrum One
  caip2      eip155:42161
  chainId    42161
  family     Arbitrum One
  token      0xaf88d065e77c8cC2239327C5EDb3A432268e5831
  domain     name="USD Coin" version="2"
  verify     EIP-3009 ok, domain ok
```

A chain with no token configured is reported as such and skipped rather than
probed against the zero address.

---

## `arb402 doctor`

Deployment-readiness checks. Exits non-zero if anything blocking fails, so it
works as a pre-deploy gate in CI.

```bash
arb402 doctor
```

Checks, in order:

1. Node >= 20
2. `.env` present in the working directory *(warning only)*
3. `EVM_PRIVATE_KEY` configured
4. RPC reachable and its chain id matches the configured chain
5. A settlement token is configured for the active chain
6. The token responds at its address
7. The token implements EIP-3009 (`transferWithAuthorization`)
8. The token has the expected decimals
9. The token's EIP-712 domain matches `USDC_NAME` / `USDC_VERSION`
   *(warning only if the token exposes no `DOMAIN_SEPARATOR` — it cannot be
   proven either way)*
10. Database reachable, if `DATABASE_URL` is set *(warning if running in-memory)*
11. `ADMIN_API_KEY_HASH` set *(warning only)*

Checks 6–9 are one on-chain probe. When something fails, the specific problem is
printed underneath — including, for a domain mismatch, the name and version the
contract itself reports, so the fix is a copy-paste.

---

## `arb402 wallet`

Show the facilitator wallet's address and on-chain balances.

```bash
arb402 wallet
```

Prints address, network, ETH balance, and USDC balance. ETH pays gas; USDC
accrues from service fees. Warns on a zero ETH balance, which means settlement
will fail. Requires `EVM_PRIVATE_KEY`.

---

## `arb402 keygen`

Generate an API key and its bcrypt hash. The key is displayed once and cannot be
recovered.

```bash
arb402 keygen           # merchant key
arb402 keygen --admin   # admin key
```

| Option | Description |
|---|---|
| `--admin` | Generate an admin key for `ADMIN_API_KEY_HASH` instead of a merchant key. |

Merchant keys have the form `<keyId>.<secret>`. The `keyId` is a public prefix
that lets authentication resolve exactly one merchant and run a single
`bcrypt.compare`, instead of scanning every stored hash. `keygen` prints the
key, the key id, and the hash, along with the `merchant add` command to run.

For most workflows [`merchant create`](#arb402-merchant-create) is easier — it
generates, hashes, and persists in one step.

---

## `arb402 dev`

Run the facilitator from TypeScript source via `tsx`. No build step.

```bash
arb402 dev
```

Use for local development. Startup checks still run, so a misconfigured token or
unreachable RPC fails here exactly as it would in production.

---

## `arb402 start`

Run the compiled facilitator from `dist/`.

```bash
npm run build
arb402 start
```

Fails with a clear message if `dist/server.js` is missing.

---

## `arb402 merchant`

Manage the merchants allowed to call `/settle`. **All subcommands require
`DATABASE_URL`** — merchants live in Postgres — and fail with an explicit
message when it is unset.

### `arb402 merchant create <address> <name>`

The one-step path: generates a key, hashes it, registers the merchant, and
prints the key once.

```bash
arb402 merchant create 0xMerchantAddress "Acme API"
```

### `arb402 merchant add <address> <name> <keyId> <apiKeyHash>`

Register a merchant with a key you already generated via `keygen`. Use this when
the key must be produced somewhere other than the machine holding the database.

```bash
arb402 merchant add 0xMerchantAddress "Acme API" a1b2c3d4 '$2b$10$...'
```

Quote the hash — bcrypt hashes contain `$`, which your shell will otherwise
expand.

### `arb402 merchant list`

List every merchant with address, name, and enabled/disabled status.

### `arb402 merchant enable <address>` / `arb402 merchant disable <address>`

Toggle a merchant without deleting it. Takes effect immediately — there is no
auth cache, so a disabled key stops working on the next request.

### `arb402 merchant delete <address>`

Remove a merchant permanently.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Any command failure — invalid arguments, failed checks, unreachable dependency |

Errors print as `✗ <message>` on stderr. Set `NO_COLOR=1` to disable ANSI
colour; output is also plain when stdout is not a TTY.
