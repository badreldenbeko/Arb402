import type { Wallet } from "ethers";
import { signTransferAuthorization } from "./sign.js";

// Shape of the single payment requirement we care about, flattened from the
// facilitator's 402 `accepts[0]` response.
export interface Requirement {
  network: string;
  asset: string; // token address
  payTo: string; // facilitator address (the EIP-3009 `to`)
  maxAmountRequired: string;
  nonce: string;
  deadline: number;
}

export interface SettleResult {
  status: number;
  body: {
    success?: boolean;
    errorReason?: string;
    incomingTxHash?: string;
    outgoingTxHash?: string;
    blockNumber?: number;
    feeBreakdown?: {
      totalAmount: string;
      merchantAmount: string;
      serviceFee: string;
      gasFee: string;
    };
    [k: string]: unknown;
  };
}

export interface RequirementsInput {
  amount?: string;
  memo?: string;
  merchantAddress: string;
  resource?: string;
}

/** Ask the facilitator for payment requirements (the HTTP 402 challenge). */
export async function getRequirements(
  baseUrl: string,
  input: RequirementsInput
): Promise<Requirement> {
  const res = await fetch(`${baseUrl}/requirements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      amount: input.amount,
      memo: input.memo,
      extra: { merchantAddress: input.merchantAddress, resource: input.resource },
    }),
  });
  const body: any = await res.json();
  const accept = body?.accepts?.[0];
  if (!accept) throw new Error(`unexpected /requirements response: ${JSON.stringify(body)}`);
  return {
    network: accept.network,
    asset: accept.asset,
    payTo: accept.payTo,
    maxAmountRequired: accept.maxAmountRequired,
    nonce: accept.extra.nonce,
    deadline: accept.extra.deadline,
  };
}

/** Submit a signed payment to the facilitator for on-chain settlement. */
export async function settle(
  baseUrl: string,
  apiKey: string,
  payload: unknown
): Promise<SettleResult> {
  const res = await fetch(`${baseUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

export interface PayOptions {
  facilitatorUrl: string;
  apiKey: string;
  payer: Wallet;
  chainId: number;
  merchantAddress: string;
  amount?: string;
  memo?: string;
  resource?: string;
}

/**
 * High-level client flow: fetch requirements, sign the EIP-3009 authorization,
 * and submit it for settlement. This is the exact sequence every app/template
 * performs; templates wrap it behind their own resource logic.
 */
export async function payForResource(opts: PayOptions): Promise<SettleResult> {
  const req = await getRequirements(opts.facilitatorUrl, {
    amount: opts.amount,
    memo: opts.memo,
    merchantAddress: opts.merchantAddress,
    resource: opts.resource,
  });

  const sig = await signTransferAuthorization(opts.payer, req.asset, opts.chainId, {
    from: opts.payer.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: 0,
    validBefore: req.deadline,
    nonce: req.nonce,
  });

  return settle(opts.facilitatorUrl, opts.apiKey, {
    x402Version: 2,
    network: req.network,
    token: req.asset,
    recipient: req.payTo,
    amount: req.maxAmountRequired,
    nonce: req.nonce,
    deadline: req.deadline,
    memo: opts.memo,
    extra: { merchantAddress: opts.merchantAddress },
    permit: {
      owner: opts.payer.address,
      spender: req.payTo,
      value: req.maxAmountRequired,
      deadline: req.deadline,
      sig,
    },
  });
}

/** Poll the facilitator's /health until it reports ok (or time out). */
export async function waitForFacilitator(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body: any = await res.json();
        if (body.status === "ok") return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`facilitator did not become healthy within ${timeoutMs}ms`);
}
