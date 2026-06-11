/**
 * arb402 x402 client — dependency-free.
 *
 * Talks to an arb402 facilitator over HTTP and signs EIP-3009 authorizations.
 * It has NO npm dependencies: it uses global `fetch` and accepts any EIP-712
 * signer through the `TypedDataSigner` interface, so it works with an ethers
 * `Wallet`, a viem account adapter, a hardware wallet bridge, etc.
 *
 * This is the shared core that all arb402 templates build on. Copy this file
 * into your project (or publish it as a package) and wrap it with your own
 * resource/business logic.
 */

/** Any signer that can produce an EIP-712 signature (ethers Wallet satisfies this). */
export interface TypedDataSigner {
  readonly address: string;
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>
  ): Promise<string>;
}

export interface Requirement {
  network: string;
  asset: string; // token (USDC) address
  payTo: string; // facilitator address — the EIP-3009 `to`
  maxAmountRequired: string;
  nonce: string;
  deadline: number;
}

export interface FeeBreakdown {
  totalAmount: string;
  merchantAmount: string;
  serviceFee: string;
  gasFee: string;
}

export interface SettleResult {
  status: number;
  body: {
    success?: boolean;
    errorReason?: string;
    incomingTxHash?: string;
    outgoingTxHash?: string;
    blockNumber?: number;
    feeBreakdown?: FeeBreakdown;
    [k: string]: unknown;
  };
}

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export interface RequirementsInput {
  amount?: string;
  memo?: string;
  merchantAddress: string;
  resource?: string;
}

/** Fetch the HTTP 402 payment requirements from the facilitator. */
export async function getRequirements(
  facilitatorUrl: string,
  input: RequirementsInput
): Promise<Requirement> {
  const res = await fetch(`${facilitatorUrl}/requirements`, {
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

/** Submit a signed payment to the facilitator's /settle endpoint (merchant-authenticated). */
export async function settle(
  facilitatorUrl: string,
  apiKey: string,
  payload: unknown
): Promise<SettleResult> {
  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/** The signed SDK payload a client puts in the `X-PAYMENT` header (server then settles it). */
export interface SignedPayment {
  x402Version: number;
  network: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: string;
  deadline: number;
  memo?: string;
  extra: { merchantAddress: string };
  permit: {
    owner: string;
    spender: string;
    value: string;
    deadline: number;
    sig: string;
  };
}

export interface BuildPaymentOptions {
  payer: TypedDataSigner;
  chainId: number;
  requirement: Requirement;
  merchantAddress: string;
  memo?: string;
}

/**
 * Sign an EIP-3009 authorization for a given requirement and return the SDK
 * payload. The CLIENT calls this; the SERVER (merchant) then passes it to
 * `settle()` with its API key. Splitting sign from settle is what lets the
 * facilitator's merchant auth stay server-side.
 */
export async function buildSignedPayment(opts: BuildPaymentOptions): Promise<SignedPayment> {
  const req = opts.requirement;
  const sig = await opts.payer.signTypedData(
    { name: "USD Coin", version: "2", chainId: opts.chainId, verifyingContract: req.asset },
    TRANSFER_TYPES,
    {
      from: opts.payer.address,
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: 0,
      validBefore: req.deadline,
      nonce: req.nonce,
    }
  );

  return {
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
  };
}

export interface PayOptions {
  facilitatorUrl: string;
  apiKey: string; // merchant API key
  payer: TypedDataSigner;
  chainId: number;
  merchantAddress: string;
  amount?: string;
  memo?: string;
  resource?: string;
}

/**
 * Convenience flow for a caller that is ALSO the merchant (it holds the API
 * key): fetch requirements → sign → settle. Used by agents that pay for their
 * own services and by the test harness. For a paywall where the server is the
 * merchant, use `getRequirements` + `buildSignedPayment` (client) and `settle`
 * (server) instead.
 */
export async function payForResource(opts: PayOptions): Promise<SettleResult> {
  const requirement = await getRequirements(opts.facilitatorUrl, {
    amount: opts.amount,
    memo: opts.memo,
    merchantAddress: opts.merchantAddress,
    resource: opts.resource,
  });
  const payment = await buildSignedPayment({
    payer: opts.payer,
    chainId: opts.chainId,
    requirement,
    merchantAddress: opts.merchantAddress,
    memo: opts.memo,
  });
  return settle(opts.facilitatorUrl, opts.apiKey, payment);
}
