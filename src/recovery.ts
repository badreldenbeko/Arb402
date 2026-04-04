import { getIncompletePayments, setStatus, logEvent } from "./nonceStore.js";
import { transferUsdc } from "./settle.js";
import { RECOVERY_INTERVAL_MS } from "./config.js";
import { isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

async function retryOutgoing(
  nonce: string,
  merchantAddress: string,
  amount: bigint,
  attempt: number
): Promise<boolean> {
  const log = logger.child({ nonce, attempt });
  const backoff = Math.min(Math.pow(2, attempt) * 1000, 30_000);

  log.info("retrying outgoing transfer", { backoff });
  await new Promise((r) => setTimeout(r, backoff));

  try {
    const hash = await transferUsdc(
      merchantAddress as `0x${string}`,
      amount,
      log
    );
    await setStatus(nonce, "complete", { outgoingTxHash: hash });
    await logEvent(nonce, "recovery_complete", { hash, attempt });
    log.info("recovery succeeded", { hash });
    return true;
  } catch (err: any) {
    await logEvent(nonce, "recovery_attempt_failed", {
      error: err.message,
      attempt,
    });
    log.warn("recovery attempt failed", { error: err.message });
    return false;
  }
}

async function processIncomplete(): Promise<void> {
  const payments = await getIncompletePayments();
  if (payments.length === 0) return;

  logger.info(`recovery: ${payments.length} incomplete payment(s) found`);

  for (const p of payments) {
    const merchantAmount = BigInt(p.merchantAmount || "0");
    if (merchantAmount === 0n) {
      logger.warn("recovery: skipping payment with zero merchant amount", {
        nonce: p.nonce,
      });
      continue;
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const ok = await retryOutgoing(
        p.nonce,
        p.merchantAddress,
        merchantAmount,
        attempt
      );
      if (ok) break;

      if (attempt === maxRetries - 1) {
        await setStatus(p.nonce, "failed");
        await logEvent(p.nonce, "recovery_exhausted", { attempts: maxRetries });
        logger.error("recovery exhausted, marked as failed", {
          nonce: p.nonce,
        });
      }
    }
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
