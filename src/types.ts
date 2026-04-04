import { z } from "zod";


export interface EIP3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: `0x${string}`;
}

export interface EIP3009Signature {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

// internal payment representation
export interface PaymentPayload {
  scheme: string;
  network: string;
  payload: EIP3009Authorization & EIP3009Signature;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  token: `0x${string}`;
  amount: string;
  recipient: `0x${string}`;
  description?: string;
  maxTimeoutSeconds?: number;
  merchantAddress?: `0x${string}`;
}

export interface VerifyResponse {
  valid: boolean;
  invalidReason?: string;
  payer?: `0x${string}`;
  feeBreakdown?: FeeBreakdown;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  incomingTxHash?: string;
  outgoingTxHash?: string;
  blockNumber?: number;
  feeBreakdown?: FeeBreakdown;
}

export interface FeeBreakdown {
  totalAmount: string;
  merchantAmount: string;
  serviceFee: string;
  gasFee: string;
}

export interface SupportedPaymentKind {
  x402Version: number;
  scheme: string;
  network: string;
  payTo?: string;
}


export interface RequirementsRequest {
  amount: string;
  memo?: string;
  x402Version?: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequirementsAccepts {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequirementsResponse {
  x402Version: number;
  error: string;
  accepts: PaymentRequirementsAccepts[];
}

export const SDKVerifyRequestSchema = z.object({
  x402Version: z.number(),
  network: z.string(),
  token: z.string(),
  recipient: z.string(),
  amount: z.string(),
  nonce: z.string(),
  deadline: z.number(),
  memo: z.string().optional(),
  extra: z
    .object({ merchantAddress: z.string().optional() })
    .passthrough()
    .optional(),
  permit: z.object({
    owner: z.string(),
    spender: z.string(),
    value: z.string(),
    deadline: z.number(),
    sig: z.string(),
  }),
});
