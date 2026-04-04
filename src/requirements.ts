import {
  networkConfig,
  FACILITATOR_ADDRESS,
  SERVICE_FEE_BPS,
  GAS_FEE_USDC,
  toLegacyName,
} from "./config.js";
import { generateNonce } from "./eip3009.js";
import type {
  RequirementsRequest,
  PaymentRequirementsResponse,
} from "./types.js";

function deadline(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

export function generateRequirements(
  req: RequirementsRequest
): PaymentRequirementsResponse {
  const version = req.x402Version ?? 2;
  const network =
    version === 1
      ? toLegacyName(networkConfig.network)
      : networkConfig.network;

  const merchantAddress = req.extra?.merchantAddress as string | undefined;

  return {
    x402Version: version,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: req.amount,
        asset: networkConfig.usdcAddress,
        payTo: FACILITATOR_ADDRESS,
        resource: (req.extra?.resource as string) || "/",
        description: req.memo || "arb402 payment",
        mimeType: "application/json",
        maxTimeoutSeconds: 3600,
        extra: {
          feeMode: "facilitator_split",
          feeBps: SERVICE_FEE_BPS,
          gasFee: GAS_FEE_USDC.toString(),
          nonce: generateNonce(),
          deadline: deadline(),
          ...(merchantAddress ? { merchantAddress } : {}),
        },
      },
    ],
  };
}
