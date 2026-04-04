import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  networkConfig,
  PRIVATE_KEY,
  FACILITATOR_ADDRESS,
  MAX_SETTLEMENT_AMOUNT,
} from "./config.js";
import { verifyPayment, calculateFees } from "./verify.js";
import { setStatus, logEvent } from "./nonceStore.js";
import { getMerchantByAddress } from "./merchantStore.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "./types.js";
import type { Logger } from "./logging.js";

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

let wallet: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let walletAccount: ReturnType<typeof privateKeyToAccount> | null = null;

function ensureKeyConfigured(): void {
  if (PRIVATE_KEY === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error("no private key configured — set EVM_PRIVATE_KEY to settle payments");
  }
}

function getAccount() {
  if (!walletAccount) {
    ensureKeyConfigured();
    walletAccount = privateKeyToAccount(PRIVATE_KEY);
  }
  return walletAccount;
}

function getWallet(): WalletClient {
  if (!wallet) {
    wallet = createWalletClient({
      account: getAccount(),
      chain: networkConfig.chain,
      transport: http(networkConfig.rpcUrl),
    });
  }
  return wallet;
}

export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: networkConfig.chain,
      transport: http(networkConfig.rpcUrl),
    });
  }
  return publicClient;
}

export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  merchantAddress: string,
  log: Logger
): Promise<SettleResponse> {
  const verification = await verifyPayment(
    payload,
    requirements,
    merchantAddress,
    log
  );
  if (!verification.valid) {
    return { success: false, errorReason: verification.invalidReason };
  }

  const merchant = await getMerchantByAddress(merchantAddress);
  if (merchant && !merchant.enabled) {
    return { success: false, errorReason: "merchant is disabled" };
  }

  const totalAmount = BigInt(payload.payload.value);
  if (totalAmount > MAX_SETTLEMENT_AMOUNT) {
    return {
      success: false,
      errorReason: `exceeds max settlement (${MAX_SETTLEMENT_AMOUNT})`,
    };
  }

  const fees = calculateFees(totalAmount);
  const merchantNet = BigInt(fees.merchantAmount);
  const nonce = payload.payload.nonce;

  const w = getWallet();
  const pub = getPublicClient();

  // incoming: user -> facilitator via transferWithAuthorization
  log.info("submitting incoming transfer", { nonce });
  await setStatus(nonce, "incoming_submitted", {
    merchantAmount: fees.merchantAmount,
    feeAmount: fees.serviceFee,
  });
  await logEvent(nonce, "incoming_submitted");

  let incomingHash: string;
  try {
    const hash = await w.writeContract({
      account: getAccount(),
      address: networkConfig.usdcAddress,
      abi: USDC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        payload.payload.from as `0x${string}`,
        payload.payload.to as `0x${string}`,
        totalAmount,
        BigInt(payload.payload.validAfter),
        BigInt(payload.payload.validBefore),
        payload.payload.nonce as `0x${string}`,
        payload.payload.v,
        payload.payload.r as `0x${string}`,
        payload.payload.s as `0x${string}`,
      ],
      chain: networkConfig.chain,
    });

    const receipt = await pub.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    if (receipt.status === "reverted") {
      await setStatus(nonce, "failed");
      await logEvent(nonce, "incoming_reverted", { hash });
      return { success: false, errorReason: "incoming transfer reverted" };
    }

    incomingHash = hash;
    await setStatus(nonce, "incoming_complete", { incomingTxHash: hash });
    await logEvent(nonce, "incoming_complete", { hash });
    log.info("incoming transfer confirmed", { hash });
  } catch (err: any) {
    await setStatus(nonce, "failed");
    await logEvent(nonce, "incoming_failed", { error: err.message });
    log.error("incoming transfer failed", { error: err.message });
    return { success: false, errorReason: `incoming failed: ${err.message}` };
  }

  // outgoing: facilitator -> merchant via standard transfer
  log.info("submitting outgoing transfer", {
    merchant: merchantAddress,
    amount: merchantNet.toString(),
  });
  await setStatus(nonce, "outgoing_submitted");
  await logEvent(nonce, "outgoing_submitted");

  let outgoingHash: string;
  let blockNumber: number | undefined;
  try {
    const hash = await w.writeContract({
      account: getAccount(),
      address: networkConfig.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [merchantAddress as `0x${string}`, merchantNet],
      chain: networkConfig.chain,
    });

    const receipt = await pub.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    if (receipt.status === "reverted") {
      await logEvent(nonce, "outgoing_reverted", { hash });
      log.error("outgoing transfer reverted, will retry via recovery", {
        hash,
      });
      return {
        success: false,
        errorReason: "outgoing transfer reverted (funds safe, will retry)",
        incomingTxHash: incomingHash,
      };
    }

    outgoingHash = hash;
    blockNumber = Number(receipt.blockNumber);
    await setStatus(nonce, "complete", { outgoingTxHash: hash });
    await logEvent(nonce, "complete", { hash, blockNumber });
    log.info("settlement complete", {
      incomingHash,
      outgoingHash,
      blockNumber,
    });
  } catch (err: any) {
    await logEvent(nonce, "outgoing_failed", { error: err.message });
    log.error("outgoing transfer failed, will retry via recovery", {
      error: err.message,
    });
    return {
      success: false,
      errorReason: `outgoing failed (funds safe, will retry): ${err.message}`,
      incomingTxHash: incomingHash,
    };
  }

  return {
    success: true,
    incomingTxHash: incomingHash,
    outgoingTxHash: outgoingHash,
    blockNumber,
    feeBreakdown: fees,
  };
}

// used by recovery and refund
export async function transferUsdc(
  to: `0x${string}`,
  amount: bigint,
  log: Logger
): Promise<string> {
  const w = getWallet();
  const pub = getPublicClient();

  const hash = await w.writeContract({
    account: getAccount(),
    address: networkConfig.usdcAddress,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [to, amount],
    chain: networkConfig.chain,
  });

  const receipt = await pub.waitForTransactionReceipt({
    hash,
    confirmations: 1,
  });
  if (receipt.status === "reverted") {
    throw new Error(`transfer reverted: ${hash}`);
  }

  log.info("transfer complete", { to, amount: amount.toString(), hash });
  return hash;
}

export async function getFacilitatorBalance(): Promise<{
  usdc: string;
  eth: string;
}> {
  const pub = getPublicClient();

  const [usdc, eth] = await Promise.all([
    pub.readContract({
      address: networkConfig.usdcAddress,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [FACILITATOR_ADDRESS as `0x${string}`],
    }),
    pub.getBalance({ address: FACILITATOR_ADDRESS as `0x${string}` }),
  ]);

  return {
    usdc: (usdc as bigint).toString(),
    eth: eth.toString(),
  };
}
