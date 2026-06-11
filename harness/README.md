# arb402 reproducible on-chain harness (M5)

A self-contained, **deterministic** on-chain test harness that proves the
arb402 facilitator settles real payments for every sample application — the M5
KPI: *"TXs working and reproducible for all applications."*

No faucet, no funded wallet, no external RPC: it spins up a local Hardhat node
at **chainId 421614** (so the facilitator's Arbitrum-Sepolia checks pass),
deploys its own **EIP-3009 TestUSDC**, and runs the full payment flow against a
real facilitator instance.

## Run it

```bash
cd harness
npm install
npm run harness
```

That single command:

1. compiles `contracts/TestUSDC.sol`
2. starts a local Hardhat node (chainId 421614)
3. deploys TestUSDC and mints 1000 USDC to the payer
4. starts the arb402 facilitator (in-memory; `USDC_ADDRESS` → the deployed token; dev-merchant auth)
5. for each application, signs an EIP-3009 authorization and settles it via
   `/requirements` → `/settle`, then **asserts on-chain** that:
   - the payer was debited the full amount,
   - the merchant received the net amount,
   - the facilitator retained `serviceFee + gas`,
   - funds are conserved.

Set `VERBOSE=1` to stream the node and facilitator logs.

## What each piece is

| Path | Role |
|---|---|
| `contracts/TestUSDC.sol` | 6-decimal ERC-20 + EIP-3009 `transferWithAuthorization`, domain `name="USD Coin", version="2"` (matches the facilitator) |
| `hardhat.config.cjs` | local node at chainId 421614 (no fork needed) |
| `lib/sign.ts` | EIP-3009 typed-data signing (ethers) |
| `lib/facilitator.ts` | HTTP client + high-level `payForResource` |
| `lib/accounts.ts` | deterministic dev accounts + fixed dev-merchant key/hash |
| `scripts/deploy.ts` | deploy + mint, writes `addresses.json` |
| `scripts/settle-once.ts` | `runPayment(scenario)` — one payment + on-chain assertions |
| `scenarios.ts` | one scenario per application (pay-per-call, metered batch, a2a, MCP) |
| `run.ts` | orchestrator that ties it all together |

## How it connects to the facilitator

The harness starts the real facilitator (`src/server.ts`) with:

```
NETWORK=arbitrum-sepolia
ARBITRUM_SEPOLIA_RPC_URL=http://127.0.0.1:8545
USDC_ADDRESS=<deployed TestUSDC>
EVM_PRIVATE_KEY=<hardhat account #0>
DEV_MERCHANT_API_KEY_HASH=<bcrypt of the fixed dev key>
DEV_MERCHANT_ADDRESS=<hardhat account #2>
```

`DEV_MERCHANT_*` activates the facilitator's dev-merchant fallback
(`src/auth.ts`), letting settlement work without Postgres. These are **dev/test
only** — never set them in production.

## Running against live Arbitrum Sepolia

The same `scripts/settle-once.ts` flow works against the public testnet: point
`RPC_URL`/`FACILITATOR_URL` at real endpoints, fund a payer with Sepolia ETH +
test USDC, and use real merchant credentials. The local harness is the
default because it's deterministic and CI-friendly.
