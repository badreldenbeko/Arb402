# arb402 documentation

HTTP 402 payment facilitator for Arbitrum chains. A client signs an EIP-3009
authorisation off-chain; the facilitator verifies it, pulls the funds, takes a
fee, and forwards the rest to the merchant. Two on-chain transactions, no
approvals, no transaction from the payer.

## Start here

| If you want to… | Read |
|---|---|
| Charge for an API, or pay for one | [Integration guide](./integration.md) |
| Look up a CLI command | [CLI reference](./cli.md) |
| Look up an endpoint | [HTTP API reference](./api.md) |
| Understand an env var | [Configuration reference](./configuration.md) |
| Run on Nova, or an Orbit L3 | [Chains](./chains.md) |
| Ship it | [Deployment and operations](./deployment.md) |

## Quickstart

```bash
npm install
npx arb402 init --network arbitrum-sepolia
# set EVM_PRIVATE_KEY in .env
npx arb402 doctor
npx arb402 dev
```

Then copy a [template](../templates) — pay-per-call API, metered AI inference,
agent-to-agent, or paid MCP tool — and point it at `http://localhost:3002`.

To see real settlements without a faucet or testnet:

```bash
cd harness && npm install && npm run harness
```

## Two things that will bite you

Both are checked automatically by `arb402 doctor`, and both are worth knowing
before you pick a chain or a token:

1. **The token must implement EIP-3009.** The entire gasless flow is
   `transferWithAuthorization`. Bridged tokens usually lack it — Arbitrum Nova's
   USDC.e looks like USDC in every respect and cannot settle a single payment.
2. **The EIP-712 domain must match the contract.** If the configured token
   `name`/`version` disagree with the token's own, every signature recovers to
   the wrong address, and nothing on-chain says why.

[Chains](./chains.md) covers both in full.

## Reference

- [Templates](../templates) — four extensible starting points on one shared client
- [Harness](../harness) — deterministic local chain that settles every template end to end
- [`arb402.chains.example.json`](../arb402.chains.example.json) — Orbit chain registry template
