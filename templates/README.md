# arb402 templates (M6)

Reproducible, extensible base-code templates for building HTTP 402 / x402
payment apps on Arbitrum against an **arb402 facilitator**. Each template is a
small, heavily-commented starting point you copy and customize.

All templates share one dependency-free core: [`shared/x402-client.ts`](./shared/x402-client.ts).

## The shared client

`shared/x402-client.ts` has **no npm dependencies** — it uses global `fetch`
and accepts any EIP-712 signer via the `TypedDataSigner` interface (an ethers
`Wallet` satisfies it directly; a viem account needs a thin adapter). Key
functions:

| Function | Side | Purpose |
|---|---|---|
| `getRequirements(url, input)` | client/server | fetch the 402 payment requirement (amount, token, nonce, deadline) |
| `buildSignedPayment(opts)` | **client** | sign the EIP-3009 authorization → the `X-PAYMENT` payload |
| `settle(url, apiKey, payload)` | **server** | settle a signed payment on-chain (needs the merchant API key) |
| `payForResource(opts)` | caller *is* merchant | requirements → sign → settle in one call (agents/tests) |

The split between `buildSignedPayment` (client signs) and `settle` (server
settles with its API key) is what keeps merchant credentials server-side in a
paywall, while `payForResource` is the convenience path for a caller that holds
its own key.

## The four templates

| Template | Pattern | Use case |
|---|---|---|
| [`pay-per-call-api/`](./pay-per-call-api) | Express paywall; client signs, server settles | Pay-per-API-call (the Web2.5 / Alchemy-style case) |
| [`metered-ai-inference/`](./metered-ai-inference) | Meter usage, **batch-settle every N calls** | AI inference billed per token/call, gas-amortized |
| [`agent-to-agent/`](./agent-to-agent) | Two autonomous agents; client pays within a budget | Machine-to-machine micropayments |
| [`paid-mcp-tool/`](./paid-mcp-tool) | MCP tool, two-step quote → pay → result | Paid tools for AI agents |

Each folder has its own `.env.example` and a header comment with install/run steps.

## Quick start (against the local harness)

1. Start the reproducible local facilitator + chain (see [`../harness`](../harness)):
   ```bash
   cd ../harness && npm install && npm run harness   # leaves a chain + facilitator running if you adapt it,
   ```
   or run the facilitator yourself pointed at any Arbitrum RPC.
2. Configure a template:
   ```bash
   cd pay-per-call-api && cp .env.example .env   # fill MERCHANT_API_KEY / MERCHANT_ADDRESS
   npm i express ethers
   ```
3. Run the server, then the client:
   ```bash
   npx tsx server.ts
   npx tsx client.ts
   ```

## Relationship to M5

The M5 sample apps are the **testable slice** of these templates: the
[`../harness`](../harness) runs one reproducible on-chain settlement per app
(pay-per-call, metered batch, agent-to-agent, paid MCP) and asserts that USDC
moved exactly as the facilitator's fee breakdown claims. The templates here are
the full, runnable versions of those same flows.
