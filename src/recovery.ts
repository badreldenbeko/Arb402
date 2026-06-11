import {
  claimIncompletePayments,
  getStuckPayments,
  setStatus,
  logEvent,
  type PaymentRecord,
} from "./nonceStore.js";
import {
  submitOutgoing,
  broadcastRaw,
  getReceiptOrNull,
} from "./settle.js";
import { pruneExpiredIssued } from "./issuedStore.js";
import { RECOVERY_INTERVAL_MS, STUCK_PAYMENT_ALERT_MS } from "./config.js";
import { isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

// Surface payments that have been incomplete far longer than recovery should
// take — an alert signal for operators (hook your alerting onto this WARN line).
async function alertOnStuckPayments(): Promise<void> {
  const stuck = await getStuckPayments(STUCK_PAYMENT_ALERT_MS);
  if (stuck.length === 0) return;
  logger.warn("stuck payments need operator review", {
    count: stuck.length,
    thresholdMs: STUCK_PAYMENT_ALERT_MS,
    oldest: { nonce: stuck[0].nonce, status: stuck[0].status, createdAt: stuck[0].createdAt },
  });
}

// Recover one claimed payment WITHOUT ever risking a double-payment:
//   - confirm a pending incoming tx before doing anything else;
//   - if an outgoing tx was already signed/persisted, confirm it or re-broadcast
//     the SAME tx (idempotent) — never build a new one;
//   - if no outgoing tx exists yet, sign+persist one, then broadcast.
// An `outgoing_submitted` row is never marked `failed` (that would make a
// possibly-paid merchant refundable), so the refund guard stays trustworthy.
async function recoverPayment(p: PaymentRecord): Promise<void> {
  const log = logger.child({ nonce: p.nonce });

  // Stage 0 — an incoming tx was signed but never confirmed at settle time.
  if (p.status === "incoming_submitted") {
    if (!p.incomingTxHash) {
      log.warn("recovery: incoming_submitted with no hash, needs manual review");
      return;
    }
    let r = await getReceiptOrNull(p.incomingTxHash as `0x${string}`);
    if (!r && p.incomingRawTx) {
      // signed but maybe never broadcast — re-broadcast the SAME tx (idempotent;
      // EIP-3009 prevents the pull from running twice on-chain).
      try {
        r = await broadcastRaw(p.incomingRawTx as `0x${string}`, p.incomingTxHash as `0x${string}`);
      } catch (err: any) {
        log.warn("recovery: incoming rebroadcast failed, will retry later", { error: err.message });
        return;
      }
    }
    if (!r) {
      log.warn("recovery: incoming still unconfirmed, will retry");
      return;
    }
    if (r.status !== "success") {
      await setStatus(p.nonce, "failed", { incomingTxHash: p.incomingTxHash });
      await logEvent(p.nonce, "recovery_incoming_reverted", { hash: p.incomingTxHash });
      return;
    }
    await setStatus(p.nonce, "incoming_complete", { incomingTxHash: p.incomingTxHash });
    await logEvent(p.nonce, "recovery_incoming_confirmed", { hash: p.incomingTxHash });
    p = { ...p, status: "incoming_complete" }; // fall through to outgoing
  }

  const merchantNet = BigInt(p.merchantAmount || "0");
  if (merchantNet === 0n) {
    await setStatus(p.nonce, "failed");
    await logEvent(p.nonce, "recovery_zero_amount_failed");
    log.warn("recovery: zero merchant amount, marked failed");
    return;
  }

  // Phase 1 — ensure an outgoing tx is signed + persisted.
  let rec = p;
  if (p.status !== "outgoing_submitted" || !p.outgoingTxHash) {
    try {
      const signed = await submitOutgoing(
        p.nonce,
        p.merchantAddress as `0x${string}`,
        merchantNet
      );
      rec = {
        ...p,
        status: "outgoing_submitted",
        outgoingTxHash: signed.hash,
        outgoingRawTx: signed.rawTx,
      };
      await logEvent(p.nonce, "recovery_outgoing_submitted", { hash: signed.hash });
    } catch (err: any) {
      await logEvent(p.nonce, "recovery_sign_failed", { error: err.message });
      log.warn("recovery: could not submit outgoing, will retry later", {
        error: err.message,
      });
      return;
    }
  }

  // Phase 2 — confirm the persisted outgoing tx, or re-broadcast the same one.
  const hash = rec.outgoingTxHash as `0x${string}`;
  try {
    const existing = await getReceiptOrNull(hash);
    if (existing) {
      if (existing.status === "success") {
        await setStatus(p.nonce, "complete", { outgoingTxHash: hash });
        await logEvent(p.nonce, "recovery_confirmed", { hash });
        log.info("recovery: outgoing already confirmed", { hash });
      } else {
        await logEvent(p.nonce, "recovery_outgoing_reverted", { hash });
        log.error("recovery: outgoing reverted on-chain, needs manual review", { hash });
      }
      return;
    }

    if (!rec.outgoingRawTx) {
      log.warn("recovery: outgoing_submitted row has no raw tx to rebroadcast");
      return;
    }

    // KNOWN LIMITATION: we re-broadcast the exact signed tx, which keeps the
    // original (sign-time) gas price. If gas has risen and the tx is underpriced,
    // it can sit unmined. A safe fix is replace-by-fee (re-sign the SAME account
    // nonce — stored in outgoing_account_nonce — with higher fees, update the
    // persisted hash/raw, rebroadcast; still only one can mine). Low risk on
    // Arbitrum's cheap, stable gas; not implemented here.
    const receipt = await broadcastRaw(rec.outgoingRawTx as `0x${string}`, hash);
    if (receipt.status === "success") {
      await setStatus(p.nonce, "complete", { outgoingTxHash: hash });
      await logEvent(p.nonce, "recovery_rebroadcast_complete", { hash });
      log.info("recovery: rebroadcast confirmed", { hash });
    } else {
      await logEvent(p.nonce, "recovery_outgoing_reverted", { hash });
      log.error("recovery: rebroadcast reverted, needs manual review", { hash });
    }
  } catch (err: any) {
    await logEvent(p.nonce, "recovery_rebroadcast_failed", { error: err.message });
    log.warn("recovery: confirm/rebroadcast failed, will retry later", {
      error: err.message,
    });
  }
}

// in-process re-entrancy guard so a long cycle can't overlap the next interval
let running = false;

async function processIncomplete(): Promise<void> {
  if (running) {
    logger.debug("recovery: previous cycle still running, skipping");
    return;
  }
  running = true;
  try {
    await pruneExpiredIssued();
    await alertOnStuckPayments();

    const payments = await claimIncompletePayments();
    if (payments.length === 0) return;

    logger.info(`recovery: claimed ${payments.length} incomplete payment(s)`);
    // process concurrently — tx submission is serialized by the wallet lock, and
    // receipt waits are bounded, so one stuck row can't block the rest.
    await Promise.allSettled(payments.map((p) => recoverPayment(p)));
  } finally {
    running = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startRecoveryWorker(): void {
  if (!isDatabaseConfigured()) {
    logger.info("recovery worker disabled (no database)");
    return;
  }

  logger.info("starting recovery worker", {
    intervalMs: RECOVERY_INTERVAL_MS,
  });

  // run once on startup
  processIncomplete().catch((err) =>
    logger.error("initial recovery failed", { error: err.message })
  );

  intervalHandle = setInterval(() => {
    processIncomplete().catch((err) =>
      logger.error("recovery cycle failed", { error: err.message })
    );
  }, RECOVERY_INTERVAL_MS);
}

export function stopRecoveryWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
