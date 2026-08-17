# HTTP API reference

The facilitator exposes eight endpoints. Base URL is wherever you run it
(`http://localhost:3002` by default).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | [`/health`](#get-health) | none | Liveness, network, DB connectivity |
| GET | [`/supported`](#get-supported) | none | Payment kinds this facilitator accepts |
| GET/POST | [`/requirements`](#getpost-requirements) | none | Issue a 402 payment requirement |
| POST | [`/verify`](#post-verify) | none | Validate a signed payment without settling |
| POST | [`/settle`](#post-settle) | merchant | Verify and execute on-chain settlement |
| GET | [`/admin/wallet`](#get-adminwallet) | admin | Facilitator balances |
| GET | [`/admin/stuck`](#get-adminstuck) | admin | Payments stuck past the alert threshold |
| POST | [`/admin/refund`](#post-adminrefund) | admin | Refund a failed payment |

## Authentication

| Header | Used by | Value |
|---|---|---|
| `X-API-Key` | `/settle` | A merchant key, `<keyId>.<secret>`, from `arb402 merchant create` |
| `X-Admin-Key` | `/admin/*` | The admin key from `arb402 keygen --admin` |

Missing credentials return `401`; wrong or disabled ones return `403`.

## Rate limits

| Scope | Window | Max |
|---|---|---|
| All requests | 15 min | 100 |
| `/requirements` | 1 min | 30 |
| `/settle` | 15 min | 50 |
| `/admin/*` | 15 min | 20 |

`/requirements` is unauthenticated and writes a row per call, so it is capped
tighter than the rest. Behind a proxy or load balancer, set `TRUST_PROXY` so
limits key on the real client IP rather than the proxy's.

Request bodies are capped at 100 kB.

---

## GET `/health`

No auth. Liveness plus enough context to identify which chain the process is on.

```json
{
  "status": "ok",
  "network": "eip155:421614",
  "chainId": 421614,
  "facilitator": "0xFacilitatorAddress",
  "db": "ok",
  "timestamp": 1755081600000
}
```

`db` is `ok`, `disconnected`, or `not_configured`. Note that `not_configured`
means the in-memory nonce store is in use, which is unsafe for production.

---

## GET `/supported`

No auth. Lists the payment kinds this facilitator accepts, for every registered
chain — including Orbit chains from your chains file.

```json
{
  "kinds": [
    { "x402Version": 1, "scheme": "exact", "network": "arbitrum" },
    { "x402Version": 2, "scheme": "exact", "network": "eip155:42161", "payTo": "0xFacilitator" }
  ],
  "signingAddresses": ["0xFacilitator"]
}
```

Each chain appears twice: once as x402 v1 with its legacy name, once as v2 with
its CAIP-2 id.

> Chains are advertised here whether or not they have a settlement token
> configured. Only the **active** chain (`NETWORK`) can actually settle; the
> facilitator refuses to boot if that chain's token is missing or not EIP-3009.

---

## GET/POST `/requirements`

No auth. Issues a payment requirement and **records it**, so `/settle` can be
bound to this exact quote (see `REQUIRE_ISSUED_REQUIREMENTS`).

Always responds **`402 Payment Required`** — that is the point of the protocol,
not an error.

### Request

| Field | Where | Default | Description |
|---|---|---|---|
| `amount` | body or `?amount=` | `1000000` | Total the client pays, in token base units (1000000 = 1.00 USDC) |
| `memo` | body or `?memo=` | — | Human-readable description |
| `x402Version` | body (`version` in query) | `2` | `1` uses legacy network names, `2` uses CAIP-2 |
| `extra.merchantAddress` | body | — | Merchant to pay; binds the quote to that merchant |
| `extra.resource` | body | `/` | Resource identifier echoed back |

```bash
curl -X POST localhost:3002/requirements \
  -H 'content-type: application/json' \
  -d '{"amount":"1000000","memo":"premium call","extra":{"merchantAddress":"0xMerchant"}}'
```

### Response — `402`

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:421614",
    "maxAmountRequired": "1000000",
    "asset": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    "payTo": "0xFacilitator",
    "resource": "/api/premium",
    "description": "premium call",
    "mimeType": "application/json",
    "maxTimeoutSeconds": 3600,
    "extra": {
      "feeMode": "facilitator_split",
      "feeBps": 50,
      "gasFee": "100000",
      "nonce": "0x…32 bytes…",
      "deadline": 1755085200,
      "merchantAddress": "0xMerchant"
    }
  }]
}
```

The same document is also sent in the `PAYMENT-RESPONSE` and
`X-PAYMENT-RESPONSE` headers, so a paywall can return it alongside its own body.

`payTo` is the **facilitator**, not the merchant: the client authorises a
transfer to the facilitator, which then forwards the merchant's share.

---

## POST `/verify`

No auth. Runs every validation `/settle` would run — signature, amount, token,
network, time window, recipient — **without** touching the chain and without
claiming the nonce. Use it to check a payment before committing to it.

The payload can be sent as the JSON body, or as a JSON string in the
`X-PAYMENT` or `PAYMENT-SIGNATURE` header.

### Request

```json
{
  "x402Version": 2,
  "network": "eip155:421614",
  "token": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  "recipient": "0xFacilitator",
  "amount": "1000000",
  "nonce": "0x…32 bytes…",
  "deadline": 1755085200,
  "memo": "premium call",
  "extra": { "merchantAddress": "0xMerchant" },
  "permit": {
    "owner": "0xPayer",
    "spender": "0xFacilitator",
    "value": "1000000",
    "deadline": 1755085200,
    "sig": "0x…65 bytes…"
  }
}
```

`amount` and `permit.value` must be decimal-integer strings; `nonce` must be
32-byte hex. Malformed input returns `400` with the failing fields, never a
crash.

### Response — `200`

```json
{
  "valid": true,
  "payer": "0xPayer",
  "feeBreakdown": {
    "totalAmount": "1000000",
    "merchantAmount": "895522",
    "serviceFee": "4478",
    "gasFee": "100000"
  }
}
```

A rejection is also `200`, with `valid: false` and an `invalidReason`. `400` is
reserved for a malformed or missing payload.

---

## POST `/settle`

**Merchant auth required** (`X-API-Key`). Verifies the payment, then executes
both on-chain transfers: `transferWithAuthorization` to pull funds from the
payer, then `transfer` to forward the merchant's share.

Request body is identical to `/verify`. The merchant address comes from the
authenticated key; `extra.merchantAddress` is only a fallback.

### Response — `200`

```json
{
  "success": true,
  "incomingTxHash": "0x…",
  "outgoingTxHash": "0x…",
  "blockNumber": 4,
  "feeBreakdown": {
    "totalAmount": "1000000",
    "merchantAmount": "895522",
    "serviceFee": "4478",
    "gasFee": "100000"
  }
}
```

### Response — `400`

```json
{ "success": false, "errorReason": "insufficient amount: 500000 < 1000000" }
```

If the incoming transfer succeeds but the outgoing one fails, the payment is
persisted at `incoming_complete` and the [recovery
worker](./deployment.md#recovery-worker) retries it with exponential backoff.
The response reports the failure; the funds are not lost.

> **One settlement process per wallet.** Transaction submission is serialised by
> an in-process mutex and nonce manager. Two replicas sharing one
> `EVM_PRIVATE_KEY` will collide on the wallet's account nonce. See
> [deployment.md](./deployment.md#scaling).

---

## GET `/admin/wallet`

**Admin auth required.** Facilitator balances.

```json
{ "address": "0xFacilitator", "usdc": "1234560", "eth": "500000000000000000" }
```

`usdc` is in base units (6 decimals), `eth` in wei.

---

## GET `/admin/stuck`

**Admin auth required.** Payments still incomplete past
`STUCK_PAYMENT_ALERT_MS` (default 1 hour) — an operator signal to review or
prune zombies, such as an incoming transfer that was signed but never broadcast.

```json
{
  "thresholdMs": 3600000,
  "count": 1,
  "payments": [{
    "nonce": "0x…",
    "status": "incoming_complete",
    "createdAt": "2026-08-13T09:00:00.000Z",
    "ageSeconds": 7200,
    "incomingTxHash": "0x…",
    "outgoingTxHash": null
  }]
}
```

---

## POST `/admin/refund`

**Admin auth required.** Returns a failed payment's funds to the payer. Use
after recovery is exhausted.

```json
{ "nonce": "0x…", "reason": "merchant transfer failed after retries" }
```

`nonce` is required; `400` if missing. The response reports the refund result
including its transaction hash.

---

## Payment states

```
pending -> incoming_submitted -> incoming_complete -> outgoing_submitted -> complete
              |                       |                      |
              v                       v                      v
            failed                  failed               failed -> refunded
```

The recovery worker picks up payments at `incoming_complete` or
`outgoing_submitted`. Only `failed` payments that recovery has given up on
should be refunded.

## Errors

| Status | Meaning |
|---|---|
| `400` | Malformed payload, missing required field, or a failed settlement |
| `401` | Missing `X-API-Key` / `X-Admin-Key` |
| `403` | Invalid or disabled key |
| `404` | Unknown route |
| `429` | Rate limited |
| `500` | Internal error — details are logged with a correlation id, never returned |

Every request is tagged with a correlation id that appears in all log lines for
that request, which is what you search when tracing a settlement.
