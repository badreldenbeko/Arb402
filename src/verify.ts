import {
  networkConfig,
  normalizeNetworkId,
  FACILITATOR_ADDRESS,
  SERVICE_FEE_BPS,
  GAS_FEE_USDC,
  MAX_SETTLEMENT_AMOUNT,
} from "./config.js";
import { verifyTransferAuthorization } from "./eip3009.js";
import { registerNonce } from "./nonceStore.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  FeeBreakdown,
} from "./types.js";
import type { Logger } from "./logging.js";

// fee-inclusive model: the user pays totalAmount, and the facilitator extracts
// its cut before forwarding the rest to the merchant.
//   merchantAmount = (totalAmount - gasFee) * 10000 / (10000 + feeBps)
//   serviceFee     = (totalAmount - gasFee) - merchantAmount
// this means the merchant receives slightly less than totalAmount * (1 - feeBps/10000)
// because the fee is computed on the post-gas remainder, not on the gross.
export function calculateFees(totalAmount: bigint): FeeBreakdown {
  const gasFee = GAS_FEE_USDC;
  const afterGas = totalAmount - gasFee;
  const multiplier = BigInt(10_000 + SERVICE_FEE_BPS);
  const merchantAmount = (afterGas * 10_000n) / multiplier;
  const serviceFee = afterGas - merchantAmount;

  return {
    totalAmount: totalAmount.toString(),
    merchantAmount: merchantAmount.toString(),
    serviceFee: serviceFee.toString(),
    gasFee: gasFee.toString(),
  };
}

export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  merchantAddress: string | undefined,
  log: Logger,
  opts: { registerNonce?: boolean } = {}
): Promise<VerifyResponse> {
  const shouldRegisterNonce = opts.registerNonce ?? true;
  // scheme
  if (payload.scheme !== "exact") {
    return { valid: false, invalidReason: `unsupported scheme: ${payload.scheme}` };
  }

  // network
  try {
    const payloadNet = normalizeNetworkId(payload.network);
    if (payloadNet !== networkConfig.network) {
      return {
        valid: false,
        invalidReason: `network mismatch: got ${payload.network}, expected ${networkConfig.network}`,
      };
    }
  } catch {
    return { valid: false, invalidReason: `unknown network: ${payload.network}` };
  }

  // token
  const reqToken = requirements.token.toLowerCase();
  const cfgToken = networkConfig.usdcAddress.toLowerCase();
  if (reqToken !== cfgToken) {
    return { valid: false, invalidReason: "token mismatch" };
  }

  // recipient must be the facilitator
  const payloadTo = payload.payload.to.toLowerCase();
  const facilitator = FACILITATOR_ADDRESS.toLowerCase();
  if (payloadTo !== facilitator) {
    return {
      valid: false,
      invalidReason: `recipient must be facilitator (${FACILITATOR_ADDRESS})`,
    };
  }

  // amount
  const amount = BigInt(payload.payload.value);
  const requiredAmount = BigInt(requirements.amount);
  if (amount <= 0n) {
    return { valid: false, invalidReason: "amount must be positive" };
  }
  if (amount < requiredAmount) {
    return {
      valid: false,
      invalidReason: `insufficient amount: ${amount} < ${requiredAmount}`,
    };
  }

  // amount must exceed the gas fee — equal would leave the merchant with 0 and
  // waste an on-chain transfer
  if (amount <= GAS_FEE_USDC) {
    return { valid: false, invalidReason: "amount must exceed the gas fee" };
  }

  // time window
  const now = Math.floor(Date.now() / 1000);
  if (payload.payload.validAfter > now) {
    return { valid: false, invalidReason: "authorization not yet valid" };
  }
  if (payload.payload.validBefore <= now) {
    return { valid: false, invalidReason: "authorization expired" };
  }

  // signature verification — done BEFORE claiming the nonce so that a bad
  // signature (or wrong signer) can never permanently burn a legitimate
  // payer's authorization in the DB.
  try {
    const recovered = await verifyTransferAuthorization(
      {
        from: payload.payload.from,
        to: payload.payload.to,
        value: payload.payload.value,
        validAfter: payload.payload.validAfter,
        validBefore: payload.payload.validBefore,
        nonce: payload.payload.nonce,
      },
      { v: payload.payload.v, r: payload.payload.r, s: payload.payload.s },
      networkConfig.usdcAddress,
      // per-chain EIP-712 domain: Orbit tokens and non-Circle deployments do
      // not all use ("USD Coin", "2"), and a wrong domain recovers a wrong
      // signer with no on-chain error to explain it
      networkConfig.tokenName,
      networkConfig.tokenVersion,
      networkConfig.chainId
    );

    if (recovered.toLowerCase() !== payload.payload.from.toLowerCase()) {
      return {
        valid: false,
        invalidReason: `signer mismatch: recovered ${recovered}, expected ${payload.payload.from}`,
      };
    }
  } catch (err: any) {
    log.error("signature verification failed", { error: err.message });
    return { valid: false, invalidReason: `bad signature: ${err.message}` };
  }

  // settlement cap — also checked before claiming the nonce, so an over-cap
  // request doesn't burn the nonce with no on-chain action taken.
  if (amount > MAX_SETTLEMENT_AMOUNT) {
    return {
      valid: false,
      invalidReason: `exceeds max settlement (${MAX_SETTLEMENT_AMOUNT})`,
    };
  }

  // nonce uniqueness — claimed only after signature + cap pass; verify-only
  // calls (registerNonce:false) never claim it.
  if (shouldRegisterNonce) {
    const isNew = await registerNonce(
      payload.payload.nonce,
      payload.payload.from,
      merchantAddress || requirements.merchantAddress || "",
      requirements.token,
      payload.network,
      payload.payload.value
    );
    if (!isNew) {
      return { valid: false, invalidReason: "nonce already used" };
    }
  }

  const fees = calculateFees(amount);
  log.info("payment verified", {
    payer: payload.payload.from,
    amount: amount.toString(),
    fees,
  });

  return {
    valid: true,
    payer: payload.payload.from as `0x${string}`,
    feeBreakdown: fees,
  };
}
