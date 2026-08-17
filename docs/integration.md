# Integration guide

How to put arb402 in front of something you charge for. Three roles appear
throughout:

- **Client** — the payer. An AI agent, a script, another service. Signs an
  EIP-3009 authorisation. Never sends a transaction and never pre-approves an
  allowance.
- **Merchant** — the resource server. Holds an arb402 API key and calls
  `/settle`. Receives the net amount.
- **Facilitator** — this software. Issues requirements, verifies signatures,
  executes both on-chain transfers, keeps the fee.

The client's key never leaves the client; the merchant's key never leaves the
server.

## The flow

```
Client                       Facilitator                   Merchant
  |  GET /requirements            |                            |
  |  <-- 402 + amount, nonce,     |                            |
  |      deadline, token          |                            |
  |                               |                            |
  |  sign EIP-3009 off-chain      |                            |
  |                               |                            |
  |  request + X-PAYMENT  ------------------------------------>|
  |                               |   POST /settle (X-API-Key) |
  |                               |<---------------------------|
  |                        transferWithAuthorization           |
  |                        (token: client -> facilitator)      |
  |                        transfer                            |
  |                        (token: facilitator -> merchant)    |
  |                               |---> receipt -------------->|
  |  <-- 200 + the resource ----------------------------------- |
```

Two on-chain transactions per settlement. The client signs once, off-chain.

## Before you start

```bash
arb402 doctor
```

Everything below assumes this passes. In particular it confirms the settlement
token implements EIP-3009 and that its EIP-712 domain matches your config —
the two failures that otherwise surface as unexplainable signature mismatches.
See [chains.md](./chains.md).

---

## 1. Run a facilitator

```bash
arb402 init --network arbitrum-sepolia
# set EVM_PRIVATE_KEY in .env
arb402 doctor
arb402 dev
```

Fund the wallet with the chain's gas token — `arb402 wallet` shows both
balances, and warns at zero ETH.

For production also set `DATABASE_URL` and `ADMIN_API_KEY_HASH`; see
[deployment.md](./deployment.md).

## 2. Register the merchant

```bash
arb402 merchant create 0xMerchantAddress "Acme API"
```

Prints the API key **once**. It is the `X-API-Key` for `/settle`, and the
address is where the merchant's share is sent.

## 3. Start from a template

Four working templates live in [`templates/`](../templates), all built on one
dependency-free client, [`shared/x402-client.ts`](../templates/shared/x402-client.ts):

| Template | Pattern | Fits |
|---|---|---|
| [`pay-per-call-api/`](../templates/pay-per-call-api) | Express paywall — client signs, server settles | Pay-per-API-call; the Web2.5 case |
| [`metered-ai-inference/`](../templates/metered-ai-inference) | Meter usage, batch-settle every N calls | Inference billed per call, gas amortised |
| [`agent-to-agent/`](../templates/agent-to-agent) | Two autonomous agents, client pays within a budget | Machine-to-machine micropayments |
| [`paid-mcp-tool/`](../templates/paid-mcp-tool) | MCP tool with quote → pay → result | Paid tools for AI agents |

Copy the closest one and edit. The rest of this guide explains what they do.

---

## The client side: signing a payment

```ts
import { getRequirements, buildSignedPayment } from "./shared/x402-client.js";

const FACILITATOR = "http://localhost:3002";

// 1. ask what this costs — the endpoint always answers 402, that's the protocol
const requirement = await getRequirements(FACILITATOR, {
  amount: "1000000",                  // 1.00 USDC, base units
  merchantAddress: MERCHANT,
  resource: "/api/premium",
});

// 2. sign the authorisation off-chain
const payment = await buildSignedPayment({
  payer: wallet,                      // any EIP-712 signer; ethers.Wallet works
  chainId: 421614,
  requirement,
  merchantAddress: MERCHANT,
});

// 3. send it with the request
const res = await fetch("https://merchant.example/api/premium", {
  headers: { "X-PAYMENT": JSON.stringify(payment) },
});
```

`getRequirements` flattens the 402 document down to what signing needs:
`network`, `asset`, `payTo`, `maxAmountRequired`, `nonce`, `deadline`.

`buildSignedPayment` returns the `SignedPayment` that goes in `X-PAYMENT`. It
never touches the chain, so it works in a browser, an agent loop, or a Lambda.

`payer` needs only EIP-712 typed-data signing (the `TypedDataSigner` interface).
An ethers `Wallet` satisfies it directly; a viem account needs a thin adapter.

## The merchant side: settling

```ts
import { settle } from "./shared/x402-client.js";

app.get("/api/premium", async (req, res) => {
  const header = req.header("X-PAYMENT");
  if (!header) {
    // no payment yet — quote one
    const quote = await getRequirements(FACILITATOR, {
      amount: PRICE,
      merchantAddress: MERCHANT,
      resource: "/api/premium",
    });
    return res.status(402).json(quote);
  }

  const result = await settle(FACILITATOR, MERCHANT_API_KEY, JSON.parse(header));
  if (!result.body.success) {
    return res.status(402).json({ error: result.body.errorReason });
  }

  res.json({
    data: "the thing they paid for",
    receipt: result.body.incomingTxHash,
  });
});
```

`settle` returns `{ status, body }` — the HTTP status alongside the parsed
response — so a merchant can distinguish a rejected payment (`400`) from an auth
problem (`401`/`403`) or a rate limit (`429`).

The merchant API key is used only here, server-side. Returning `402` with a
fresh quote when payment is missing is what lets a client retry automatically.

### Callers that are also the merchant

An agent paying with its own key can collapse all three steps:

```ts
const result = await payForResource({
  facilitatorUrl: FACILITATOR,
  apiKey: MERCHANT_API_KEY,
  payer: wallet,
  chainId: 421614,
  merchantAddress: MERCHANT,
  amount: "1000000",
  resource: "/agent/task",
});
// result.body.success, result.body.incomingTxHash, result.body.feeBreakdown
```

Use this for agents and tests, not for a paywall — it requires the caller to
hold the merchant key.

---

## Pricing and fees

Quote in **base units**: `1000000` is 1.00 USDC at 6 decimals.

The payer pays the total; the facilitator extracts its cut before forwarding.
At the defaults (0.5% + 0.10 USDC gas buffer), a 1.00 USDC payment splits:

| | Amount |
|---|---|
| Payer pays | 1.000000 USDC |
| Merchant receives | 0.895522 USDC |
| Service fee | 0.004478 USDC |
| Gas buffer | 0.100000 USDC |

So price your resource at what you want to **receive**, plus the fee — or read
`feeBreakdown` from `/verify` and quote accordingly.

The flat gas buffer dominates small payments. Below roughly 0.20 USDC most of
the payment is the buffer, which is why the metered template batches: accumulate
N calls, settle once. Tune with `GAS_FEE_USDC`.

## Checking before charging

`POST /verify` runs every validation `/settle` would, without touching the chain
and without claiming the nonce:

```ts
const check = await fetch(`${FACILITATOR}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payment),
});
const { valid, invalidReason, feeBreakdown } = await check.json();
```

Useful to reject a bad payment early, or to show the payer a breakdown before
committing. It needs no auth.

## Handling failures

| Situation | What you get | What to do |
|---|---|---|
| Payment invalid | `400` with `errorReason` | Return `402` with a fresh quote |
| Amount too low | `insufficient amount: X < Y` | Re-quote; the client may be using a stale price |
| Expired | `authorization expired` | Re-quote; deadlines default to 1 hour |
| Nonce reused | rejected | Each payment needs a fresh `/requirements` call |
| Outgoing transfer failed | `success: false`, incoming already on-chain | Nothing — the recovery worker retries automatically |

That last row matters: if the incoming transfer succeeds and the outgoing one
fails, funds are not lost. The payment persists at `incoming_complete` and the
recovery worker retries with exponential backoff. If recovery is exhausted, an
admin can refund with `POST /admin/refund`. See
[deployment.md](./deployment.md#recovery-worker).

## x402 versions

| Version | Network field | Example |
|---|---|---|
| 1 | legacy name | `arbitrum`, `arbitrum-nova` |
| 2 (default) | CAIP-2 id | `eip155:42161`, `eip155:42170` |

Request v1 with `x402Version: 1` if your client expects legacy names.
`GET /supported` advertises both forms for every registered chain.

---

## Testing without a testnet

The [harness](../harness) runs the whole flow against a local chain — no faucet,
no funded wallet, no external RPC:

```bash
cd harness && npm install && npm run harness
```

It compiles an EIP-3009 `TestUSDC`, starts a Hardhat node at chain id 421614,
boots a real facilitator against it, and settles one payment per template while
asserting on-chain that the payer was debited, the merchant credited, the
facilitator kept exactly `serviceFee + gas`, and funds are conserved. It also
runs concurrent settlements as a wallet-nonce regression test.

Point your own client at it by copying the env block in
[`harness/README.md`](../harness/README.md).

## Going to production

Read [deployment.md](./deployment.md). The short version: set `DATABASE_URL`,
run **one settlement process per wallet**, set `TRUST_PROXY` behind a load
balancer, keep the wallet funded, and monitor `GET /admin/stuck`.
