import { getPayment, setStatus, logEvent } from "./nonceStore.js";
import { transferUsdc, getPublicClient } from "./settle.js";
import { logger } from "./logging.js";

export async function executeRefund(
  nonce: string,
  reason?: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const log = logger.child({ nonce });

  const payment = await getPayment(nonce);
  if (!payment) {
    return { success: false, error: "payment not found" };
  }

  if (payment.status !== "failed") {
    return {
      success: false,
      error: `can only refund failed payments, current status: ${payment.status}`,
    };
  }

  if (!payment.incomingTxHash) {
    return { success: false, error: "no incoming tx to refund" };
  }

  if (payment.outgoingTxHash) {
    return {
      success: false,
      error: "outgoing tx exists — merchant already received funds",
    };
  }

  // On-chain guard: the `outgoing_tx_hash` flag alone isn't enough — confirm the
  // incoming transfer actually landed (so there are funds to refund) and that no
  // outgoing tx was mined for this payment. This closes the window where a
  // timed-out-but-confirmed outgoing left the row `failed` with a null hash.
  const pub = getPublicClient();
  try {
    const incoming = await pub.getTransactionReceipt({
      hash: payment.incomingTxHash as `0x${string}`,
    });
    if (incoming.status !== "success") {
      return { success: false, error: "incoming tx did not confirm — nothing to refund" };
    }
  } catch {
    return {
      success: false,
      error: "could not confirm incoming tx on-chain — refusing to refund",
    };
  }

  const amount = BigInt(payment.totalAmount);
  log.info("executing refund", {
    user: payment.userAddress,
    amount: amount.toString(),
    reason,
  });

  try {
    const hash = await transferUsdc(
      payment.userAddress as `0x${string}`,
      amount,
      log
    );
    await setStatus(nonce, "refunded");
    await logEvent(nonce, "refunded", { hash, reason });
    return { success: true, txHash: hash };
  } catch (err: any) {
    log.error("refund failed", { error: err.message });
    return { success: false, error: err.message };
  }
}
