import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  encodeFunctionData,
  type WalletClient,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  networkConfig,
  PRIVATE_KEY,
  FACILITATOR_ADDRESS,
  MAX_SETTLEMENT_AMOUNT,
  MIN_FACILITATOR_ETH_WEI,
  REQUIRE_ISSUED_REQUIREMENTS,
} from "./config.js";
import { verifyPayment, calculateFees } from "./verify.js";
import {
  setStatus,
  logEvent,
  recordIncomingIntent,
  recordOutgoingIntent,
} from "./nonceStore.js";
import { getMerchantByAddress } from "./merchantStore.js";
import { getIssued } from "./issuedStore.js";
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

export interface SignedTransfer {
  hash: `0x${string}`;
  accountNonce: number;
  rawTx: `0x${string}`;
}

// --- single-wallet serialization ---------------------------------------------
// Every tx is signed by ONE facilitator wallet, so submissions must draw unique
// account nonces in strict order. `runExclusive` serializes the
// [allocate nonce → sign → broadcast] critical section. Without it, two
// concurrent settlements would sign different txs against the same nonce; only
// one could ever mine, leaving the other permanently stuck (user debited,
// merchant unpaid). The incoming leg goes through here too, since it draws from
// the same nonce sequence.
let walletLock: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = walletLock.then(fn, fn);
  walletLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// local high-water mark, so we never reuse a nonce even if the node's pending
// count hasn't yet reflected a just-broadcast tx
let nextNonce = -1;
async function allocateNonce(pub: PublicClient): Promise<number> {
  const pending = await pub.getTransactionCount({
    address: FACILITATOR_ADDRESS as `0x${string}`,
    blockTag: "pending",
  });
  const n = nextNonce < 0 ? pending : Math.max(pending, nextNonce);
  nextNonce = n + 1;
  return n;
}

// Sign a call to `to` with `data` using the next account nonce, then broadcast,
// all under the wallet lock. `onSigned` runs after signing but BEFORE broadcast
// — persist crash-recovery intent there. The caller waits for the receipt
// outside the lock so submissions can pipeline.
async function submitTx(
  to: `0x${string}`,
  data: `0x${string}`,
  onSigned?: (tx: SignedTransfer) => Promise<void>
): Promise<SignedTransfer> {
  return runExclusive(async () => {
    const w = getWallet();
    const pub = getPublicClient();
    const account = getAccount();
    const accountNonce = await allocateNonce(pub);

    try {
      const request = await w.prepareTransactionRequest({
        account,
        to,
        data,
        nonce: accountNonce,
        chain: networkConfig.chain,
      } as any);
      const rawTx = (await w.signTransaction(request as any)) as `0x${string}`;
      const tx: SignedTransfer = { hash: keccak256(rawTx), accountNonce, rawTx };

      if (onSigned) await onSigned(tx);

      try {
        await pub.sendRawTransaction({ serializedTransaction: rawTx });
      } catch (err: any) {
        const msg = String(err?.message ?? "");
        // "nonce too low"/"already known" mean nonce N was consumed — keep our
        // counter; any other error means the tx never landed, so re-sync below.
        if (!/already known|nonce too low|already imported|known transaction/i.test(msg)) {
          throw err;
        }
      }
      return tx;
    } catch (err) {
      // We allocated nonce N but the tx didn't make it on-chain. Leaving nextNonce
      // incremented would create a permanent gap (N never mines, N+1.. wait
      // forever) and wedge the whole pipeline. Force a re-sync from the node.
      nextNonce = -1;
      throw err;
    }
  });
}

// Sign + persist + broadcast the facilitator->merchant transfer. Persisting the
// signed tx before broadcast (status 'outgoing_submitted') lets recovery
// re-broadcast THIS exact tx rather than building a new one — idempotent.
export async function submitOutgoing(
  paymentNonce: string,
  to: `0x${string}`,
  amount: bigint
): Promise<SignedTransfer> {
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return submitTx(networkConfig.usdcAddress, data, (tx) =>
    recordOutgoingIntent(paymentNonce, tx.hash, tx.accountNonce, tx.rawTx)
  );
}

// Sign + broadcast the incoming user->facilitator transferWithAuthorization.
// EIP-3009 makes the pull itself idempotent (its authorization nonce can't be
// reused on-chain), so re-broadcasting the same signed tx is safe.
export async function submitIncoming(
  payload: PaymentPayload,
  onSigned: (tx: SignedTransfer) => Promise<void>
): Promise<SignedTransfer> {
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transferWithAuthorization",
    args: [
      payload.payload.from as `0x${string}`,
      payload.payload.to as `0x${string}`,
      BigInt(payload.payload.value),
      BigInt(payload.payload.validAfter),
      BigInt(payload.payload.validBefore),
      payload.payload.nonce as `0x${string}`,
      payload.payload.v,
      payload.payload.r as `0x${string}`,
      payload.payload.s as `0x${string}`,
    ],
  });
  return submitTx(networkConfig.usdcAddress, data, onSigned);
}

// Re-broadcast a previously-signed raw tx and wait for its receipt. Idempotent
// and does NOT allocate a nonce (the tx already has one), so it needs no lock.
export async function broadcastRaw(
  rawTx: `0x${string}`,
  expectedHash: `0x${string}`
): Promise<TransactionReceipt> {
  const pub = getPublicClient();
  try {
    await pub.sendRawTransaction({ serializedTransaction: rawTx });
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    if (!/already known|nonce too low|already imported|known transaction/i.test(msg)) {
      throw err;
    }
  }
  return waitReceipt(expectedHash);
}

const RECEIPT_TIMEOUT_MS = 60_000;

// bounded wait so a single stuck tx can't block a settlement (or a recovery
// batch) indefinitely
export async function waitReceipt(
  hash: `0x${string}`
): Promise<TransactionReceipt> {
  return getPublicClient().waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: RECEIPT_TIMEOUT_MS,
  });
}

export async function getReceiptOrNull(
  hash: `0x${string}`
): Promise<TransactionReceipt | null> {
  return getPublicClient()
    .getTransactionReceipt({ hash })
    .catch(() => null);
}

// Preflight: the facilitator pays gas in ETH while collecting fees in USDC, so
// guard against a silently-drained wallet before starting a settlement.
export async function hasEnoughGas(): Promise<boolean> {
  const pub = getPublicClient();
  const balance = await pub.getBalance({
    address: FACILITATOR_ADDRESS as `0x${string}`,
  });
  return balance >= MIN_FACILITATOR_ETH_WEI;
}

// Bind settlement to a requirement the facilitator actually issued: the nonce
// must be one we handed out, and the signed amount/deadline/merchant must match
// it. This is INTEGRITY / anti-replay (the facilitator won't settle an
// authorization it never quoted, and a quote can't be tampered with), NOT a
// merchant-authoritative price — the amount originates from the caller's
// unauthenticated /requirements call. Checked BEFORE verifyPayment so an unbound
// request never claims a nonce. Returns an error string, or null if it holds.
async function checkIssuedBinding(
  payload: PaymentPayload,
  merchantAddress: string
): Promise<string | null> {
  if (!REQUIRE_ISSUED_REQUIREMENTS) return null;

  const issued = await getIssued(payload.payload.nonce);
  if (!issued) {
    return "unknown or expired payment requirement — call /requirements first";
  }
  if (BigInt(payload.payload.value) !== BigInt(issued.amount)) {
    return `amount does not match issued requirement (expected ${issued.amount})`;
  }
  if (payload.payload.validBefore !== issued.deadline) {
    return "deadline does not match issued requirement";
  }
  if (
    issued.merchantAddress &&
    issued.merchantAddress.toLowerCase() !== merchantAddress.toLowerCase()
  ) {
    return "merchant does not match issued requirement";
  }
  return null;
}

export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  merchantAddress: string,
  log: Logger
): Promise<SettleResponse> {
  const bindingError = await checkIssuedBinding(payload, merchantAddress);
  if (bindingError) {
    return { success: false, errorReason: bindingError };
  }

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

  // gas preflight — don't pull the user's funds in if we can't pay to forward them
  if (!(await hasEnoughGas())) {
    return {
      success: false,
      errorReason: "facilitator ETH balance too low to settle",
    };
  }

  const fees = calculateFees(totalAmount);
  const merchantNet = BigInt(fees.merchantAmount);
  const nonce = payload.payload.nonce;

  // incoming: user -> facilitator via transferWithAuthorization.
  // The tx hash is recorded BEFORE broadcast and we confirm on-chain before
  // declaring failure, so an RPC timeout on a tx that actually mined can't
  // strand the user's funds with a null hash.
  log.info("submitting incoming transfer", { nonce });

  let incomingHash: string;
  try {
    const signed = await submitIncoming(payload, async (tx) => {
      await recordIncomingIntent(
        nonce,
        tx.hash,
        tx.accountNonce,
        tx.rawTx,
        fees.merchantAmount,
        fees.serviceFee
      );
      await logEvent(nonce, "incoming_submitted", { hash: tx.hash });
    });
    incomingHash = signed.hash;

    let receipt = await waitReceipt(signed.hash).catch(() => null);
    if (!receipt) receipt = await getReceiptOrNull(signed.hash);

    if (!receipt) {
      // not mined yet — leave the row at incoming_submitted (hash recorded) for
      // recovery to confirm; do NOT mark failed (funds may already be moving).
      log.warn("incoming transfer unconfirmed, will confirm via recovery", {
        hash: signed.hash,
      });
      return {
        success: false,
        errorReason: "incoming transfer pending confirmation (will retry)",
        incomingTxHash: signed.hash,
      };
    }
    if (receipt.status === "reverted") {
      await setStatus(nonce, "failed", { incomingTxHash: signed.hash });
      await logEvent(nonce, "incoming_reverted", { hash: signed.hash });
      return { success: false, errorReason: "incoming transfer reverted" };
    }

    await setStatus(nonce, "incoming_complete", { incomingTxHash: signed.hash });
    await logEvent(nonce, "incoming_complete", { hash: signed.hash });
    log.info("incoming transfer confirmed", { hash: signed.hash });
  } catch (err: any) {
    // submission failed at/after signing; if a hash was recorded the row is at
    // incoming_submitted and recovery will reconcile it.
    await logEvent(nonce, "incoming_failed", { error: err.message });
    log.error("incoming transfer failed", { error: err.message });
    return { success: false, errorReason: `incoming failed: ${err.message}` };
  }

  // outgoing: facilitator -> merchant. Idempotent via record-before-broadcast
  // (submitOutgoing persists the signed tx before sending it).
  log.info("submitting outgoing transfer", {
    merchant: merchantAddress,
    amount: merchantNet.toString(),
  });

  let outgoingHash: string;
  let blockNumber: number | undefined;
  try {
    const signed = await submitOutgoing(
      nonce,
      merchantAddress as `0x${string}`,
      merchantNet
    );
    await logEvent(nonce, "outgoing_submitted", {
      hash: signed.hash,
      accountNonce: signed.accountNonce,
    });

    const receipt = await waitReceipt(signed.hash);
    if (receipt.status === "reverted") {
      await logEvent(nonce, "outgoing_reverted", { hash: signed.hash });
      log.error("outgoing transfer reverted, will retry via recovery", {
        hash: signed.hash,
      });
      return {
        success: false,
        errorReason: "outgoing transfer reverted (funds safe, will retry)",
        incomingTxHash: incomingHash,
      };
    }

    outgoingHash = signed.hash;
    blockNumber = Number(receipt.blockNumber);
    await setStatus(nonce, "complete", { outgoingTxHash: signed.hash });
    await logEvent(nonce, "complete", { hash: signed.hash, blockNumber });
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

// used by refund — goes through the same serialized submitter so it shares the
// wallet's nonce sequence with settlements
export async function transferUsdc(
  to: `0x${string}`,
  amount: bigint,
  log: Logger
): Promise<string> {
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  const signed = await submitTx(networkConfig.usdcAddress, data);
  const receipt = await waitReceipt(signed.hash);
  if (receipt.status === "reverted") {
    throw new Error(`transfer reverted: ${signed.hash}`);
  }
  log.info("transfer complete", { to, amount: amount.toString(), hash: signed.hash });
  return signed.hash;
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
