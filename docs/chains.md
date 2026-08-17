# Chains: Arbitrum One, Nova, and Orbit

arb402 treats chains as **data**. A built-in table covers Arbitrum One, Nova,
and Sepolia; any Orbit (L3) chain is added by writing a JSON file. No fork, no
rebuild, no code change.

## The requirement every chain must meet

The facilitator settles with **EIP-3009** `transferWithAuthorization`. That is
what makes the flow gasless for the payer: they sign an authorisation off-chain
and never send a transaction or pre-approve an allowance.

So a chain is usable by arb402 only if it has a token that implements EIP-3009.
This is a real constraint, not a formality:

- **Native Circle USDC implements it.** Arbitrum One and Arbitrum Sepolia both
  have native USDC deployments, verified to expose `authorizationState` and to
  use the EIP-712 domain `name="USD Coin"`, `version="2"`.
- **Bridged USDC.e does not.** The Arbitrum gateway's bridged token is a plain
  ERC-20. It has 6 decimals, the symbol `USDC`, and even a `DOMAIN_SEPARATOR` —
  so it looks right — but `authorizationState` reverts and
  `transferWithAuthorization` does not exist. It cannot settle a single payment.

This is why **Arbitrum Nova ships with no default settlement token**: its
canonical stablecoin (`0x750ba8…273b`) is bridged USDC.e without EIP-3009.
Shipping it as a default would produce valid-looking signatures that revert
on-chain. See [Nova](#arbitrum-nova) below for how to enable Nova.

## The second requirement: the EIP-712 domain

Every signature is bound to an EIP-712 domain built from the token's `name`,
`version`, `chainId`, and address. If the configured name/version disagree with
what the contract uses, **every signature recovers to the wrong address**. There
is no revert reason for this — it reads as an endless "signer mismatch".

arb402 carries the domain per chain and verifies it against the contract's own
`DOMAIN_SEPARATOR`:

```bash
arb402 chains --verify
```

```
  Arbitrum One
  token      0xaf88d065e77c8cC2239327C5EDb3A432268e5831
  domain     name="USD Coin" version="2"
  verify     EIP-3009 ok, domain ok
```

The same probe runs in `arb402 doctor` and at server startup, so a bad token can
never reach production silently.

---

## Built-in chains

| Chain | CAIP-2 | Chain id | Aliases | Settlement token |
|---|---|---|---|---|
| Arbitrum One | `eip155:42161` | 42161 | `arbitrum`, `arbitrum-one`, `arb1` | Native USDC `0xaf88d0…5831` |
| Arbitrum Nova | `eip155:42170` | 42170 | `nova`, `arbitrum-nova`, `arb-nova` | **none — see below** |
| Arbitrum Sepolia | `eip155:421614` | 421614 | `arbitrum-sepolia`, `sepolia`, `arb-sepolia` | Test USDC `0x75faf1…AA4d` |

Select one with `NETWORK` in `.env`, using any alias or the CAIP-2 id:

```bash
NETWORK=arbitrum
NETWORK=eip155:42161
```

RPC endpoints default to the public ones and are overridden per chain:

| Chain | Env var |
|---|---|
| Arbitrum One | `ARBITRUM_RPC_URL` |
| Arbitrum Nova | `ARBITRUM_NOVA_RPC_URL` |
| Arbitrum Sepolia | `ARBITRUM_SEPOLIA_RPC_URL` |
| Orbit chain | `ORBIT_<chainId>_RPC_URL` |

---

## Arbitrum Nova

Everything except the token works out of the box — chain id, RPC, fees, CLI,
settlement engine. To enable settlement, supply a token that implements EIP-3009
and, if its domain differs from Circle's, its EIP-712 values:

```bash
NETWORK=arbitrum-nova
USDC_ADDRESS=0xYourEip3009TokenOnNova
# only if the token's domain is not ("USD Coin", "2"):
USDC_NAME=My Stablecoin
USDC_VERSION=1
```

Then verify before you rely on it:

```bash
arb402 doctor
```

If you point Nova at the bridged USDC.e, the probe tells you exactly what is
wrong rather than letting you discover it at settlement time:

```
✗ token implements EIP-3009 (transferWithAuthorization)
    → token does not implement EIP-3009 (authorizationState reverted) —
      arb402 settles via transferWithAuthorization and cannot use this token
```

Alternatively, register the token in your chains file so it is part of the
configuration rather than the environment — see [overriding a
built-in](#overriding-a-built-in).

---

## Orbit chains

Create `arb402.chains.json` next to your `.env` (or point `ARB402_CHAINS_FILE`
anywhere):

```json
{
  "chains": [
    {
      "name": "My Orbit Chain",
      "slug": "my-orbit",
      "chainId": 412346,
      "rpcUrl": "https://rpc.my-orbit-chain.example",
      "blockExplorer": "https://explorer.my-orbit-chain.example",
      "testnet": true,
      "aliases": ["orbit-dev"],
      "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
      "token": {
        "address": "0xYourEip3009Usdc",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6
      }
    }
  ]
}
```

Then use it like any built-in:

```bash
NETWORK=my-orbit        # or eip155:412346
arb402 chains --verify
arb402 doctor
arb402 dev
```

A copy-ready template ships as
[`arb402.chains.example.json`](../arb402.chains.example.json).

### Field reference

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | Display name |
| `chainId` | yes | — | Positive integer; accepts a number or a numeric string |
| `rpcUrl` | yes | — | Overridable at runtime with `ORBIT_<chainId>_RPC_URL` |
| `slug` | no | slugified `name` | Used as the `NETWORK` value and the x402 v1 network name |
| `aliases` | no | `[]` | Extra accepted spellings |
| `testnet` | no | `false` | Marks the chain as a testnet |
| `blockExplorer` | no | — | Explorer base URL |
| `nativeCurrency` | no | ETH/18 | Gas token metadata |
| `token.address` | yes (within `token`) | — | Must be a valid `0x` address and implement EIP-3009 |
| `token.name` | no | `"USD Coin"` | **EIP-712 domain name** — not cosmetic |
| `token.version` | no | `"2"` | **EIP-712 domain version** — not cosmetic |
| `token.decimals` | no | `6` | Must match the contract |

The whole `token` object may be omitted, which registers the chain without
enabling settlement — useful for staging a chain before its token exists.

The file is validated strictly at load time. A missing `chainId`, an
unparseable address, or malformed JSON fails immediately with the offending
entry named, because each of those is otherwise a silent settlement failure:

```
orbit chain #2.token: "address" is not a valid 0x address
```

### Overriding a built-in

Entries are merged over the built-ins by CAIP-2 id, so the same file can amend a
known chain. This is the cleanest way to give Nova a token:

```json
{
  "chains": [{
    "name": "Arbitrum Nova",
    "slug": "arbitrum-nova",
    "chainId": 42170,
    "rpcUrl": "https://nova.arbitrum.io/rpc",
    "token": { "address": "0xYourEip3009TokenOnNova" }
  }]
}
```

An override contributes only what it sets: the chain keeps its built-in family,
aliases, RPC env var, and testnet flag. Nova stays Nova rather than being
reclassified as an L3.

For safety, an Orbit entry cannot hijack a built-in alias — declaring
`"aliases": ["arbitrum"]` will not redirect `NETWORK=arbitrum` to your chain.

---

## Multi-chain behaviour

One process serves **one** active chain, set by `NETWORK`. That is deliberate:
the facilitator holds a single wallet whose account nonce must be serialised,
and settlement is bound to one chain id.

`GET /supported` advertises every registered chain so clients can discover what
this deployment knows about, and `arb402 chains` lists them all. To serve
several chains, run one process per chain — each with its own `NETWORK`, port,
and wallet.

`USDC_ADDRESS`, `USDC_NAME`, and `USDC_VERSION` apply to the **active chain
only**. Applying them to every chain would be meaningless, and dangerous given
that `/supported` advertises the inactive ones.

---

## Adding a chain: checklist

1. Confirm the chain has a token implementing EIP-3009. Without one, stop here.
2. Add it to `arb402.chains.json` (or set `USDC_ADDRESS` for a built-in).
3. Run `arb402 chains --verify` — expect `EIP-3009 ok, domain ok`.
4. If the domain mismatches, set `token.name` / `token.version` to the values
   the probe reports from the contract.
5. Set `NETWORK` and run `arb402 doctor`.
6. Fund the facilitator wallet with the chain's gas token; check with
   `arb402 wallet`.
