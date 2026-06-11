import crypto from "node:crypto";
import { query, withTx, isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

export type PaymentStatus =
  | "pending"
  | "incoming_submitted"
  | "incoming_complete"
  | "outgoing_submitted"
  | "complete"
  | "failed"
  | "refunded";

export interface PaymentRecord {
  nonce: string;
  userAddress: string;
  merchantAddress: string;
  tokenAddress: string;
  network: string;
  totalAmount: string;
  merchantAmount?: string;
  feeAmount?: string;
  status: PaymentStatus;
  incomingTxHash?: string;
  outgoingTxHash?: string;
  incomingRawTx?: string;
  outgoingAccountNonce?: string;
  outgoingRawTx?: string;
  createdAt: Date;
}

const TERMINAL_STATUSES: PaymentStatus[] = ["complete", "failed", "refunded"];

// advisory lock key from nonce hash
function lockKey(nonce: string): string {
  const hash = crypto.createHash("sha256").update(nonce).digest();
  const num = hash.readBigInt64BE(0) & 0x7fffffffffffffffn;
  return num.toString();
}

// in-memory fallback when no DB
const memoryNonces = new Set<string>();
let memoryWarned = false;

// register nonce, returns true if new
export async function registerNonce(
  nonce: string,
  userAddress: string,
  merchantAddress: string,
  tokenAddress: string,
  network: string,
  totalAmount: string
): Promise<boolean> {
  if (!isDatabaseConfigured()) {
    if (!memoryWarned) {
      logger.warn(
        "no DATABASE_URL — using in-memory nonce tracking (unsafe for production)"
      );
      memoryWarned = true;
    }
    if (memoryNonces.has(nonce)) return false;
    memoryNonces.add(nonce);
    return true;
  }

  return withTx(async (client) => {
    const key = lockKey(nonce);
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);

    const existing = await client.query(
      "SELECT nonce FROM payments WHERE nonce = $1",
      [nonce]
    );
    if (existing.rows.length > 0) return false;

    await client.query(
      `INSERT INTO payments (nonce, user_address, merchant_address, token_address, network, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [nonce, userAddress, merchantAddress, tokenAddress, network, totalAmount]
    );
    return true;
  });
}

export async function setStatus(
  nonce: string,
  status: PaymentStatus,
  extra?: {
    incomingTxHash?: string;
    outgoingTxHash?: string;
    merchantAmount?: string;
    feeAmount?: string;
  }
): Promise<void> {
  if (!isDatabaseConfigured()) return;

  const sets = ["status = $2", "updated_at = NOW()"];
  const vals: unknown[] = [nonce, status];
  let idx = 3;

  if (extra?.incomingTxHash) {
    sets.push(`incoming_tx_hash = $${idx++}`);
    vals.push(extra.incomingTxHash);
  }
  if (extra?.outgoingTxHash) {
    sets.push(`outgoing_tx_hash = $${idx++}`);
    vals.push(extra.outgoingTxHash);
  }
  if (extra?.merchantAmount) {
    sets.push(`merchant_amount = $${idx++}`);
    vals.push(extra.merchantAmount);
  }
  if (extra?.feeAmount) {
    sets.push(`fee_amount = $${idx++}`);
    vals.push(extra.feeAmount);
  }

  // releasing the row when it reaches a terminal state lets recovery move on
  if (TERMINAL_STATUSES.includes(status)) {
    sets.push("recovery_locked_at = NULL");
  }

  await query(`UPDATE payments SET ${sets.join(", ")} WHERE nonce = $1`, vals);
}

// Persist the signed INCOMING transfer BEFORE broadcast, including the raw tx, so
// recovery can re-broadcast the exact same tx if it was signed but never sent
// (rather than polling a hash that will never appear). EIP-3009 keeps the pull
// itself idempotent on-chain.
export async function recordIncomingIntent(
  nonce: string,
  txHash: string,
  accountNonce: number,
  rawTx: string,
  merchantAmount: string,
  feeAmount: string
): Promise<void> {
  if (!isDatabaseConfigured()) return;
  await query(
    `UPDATE payments
     SET status = 'incoming_submitted',
         incoming_tx_hash = $2,
         incoming_account_nonce = $3,
         incoming_raw_tx = $4,
         merchant_amount = $5,
         fee_amount = $6,
         updated_at = NOW()
     WHERE nonce = $1`,
    [nonce, txHash, accountNonce, rawTx, merchantAmount, feeAmount]
  );
}

// Persist the signed outgoing transfer BEFORE it is broadcast. Recovery uses the
// stored raw tx to re-broadcast the EXACT same transaction (same account nonce →
// same hash), which makes the outgoing leg idempotent: a duplicate can never be
// mined because the second send reuses an already-consumed account nonce.
export async function recordOutgoingIntent(
  nonce: string,
  txHash: string,
  accountNonce: number,
  rawTx: string
): Promise<void> {
  if (!isDatabaseConfigured()) return;
  await query(
    `UPDATE payments
     SET status = 'outgoing_submitted',
         outgoing_tx_hash = $2,
         outgoing_account_nonce = $3,
         outgoing_raw_tx = $4,
         updated_at = NOW()
     WHERE nonce = $1`,
    [nonce, txHash, accountNonce, rawTx]
  );
}

function toRecord(r: any): PaymentRecord {
  return {
    nonce: r.nonce,
    userAddress: r.user_address,
    merchantAddress: r.merchant_address,
    tokenAddress: r.token_address,
    network: r.network,
    totalAmount: r.total_amount,
    merchantAmount: r.merchant_amount,
    feeAmount: r.fee_amount,
    status: r.status,
    incomingTxHash: r.incoming_tx_hash,
    outgoingTxHash: r.outgoing_tx_hash,
    incomingRawTx: r.incoming_raw_tx ?? undefined,
    outgoingAccountNonce:
      r.outgoing_account_nonce === null || r.outgoing_account_nonce === undefined
        ? undefined
        : String(r.outgoing_account_nonce),
    outgoingRawTx: r.outgoing_raw_tx ?? undefined,
    createdAt: r.created_at,
  };
}

export async function getPayment(nonce: string): Promise<PaymentRecord | null> {
  if (!isDatabaseConfigured()) return null;

  const res = await query("SELECT * FROM payments WHERE nonce = $1", [nonce]);
  if (res.rows.length === 0) return null;
  return toRecord(res.rows[0]);
}

// Atomically CLAIM incomplete payments for recovery. `FOR UPDATE SKIP LOCKED`
// lets multiple workers/instances run concurrently without ever grabbing the
// same row, and `recovery_locked_at` keeps a claimed row off-limits to other
// cycles until it goes stale (so a crashed worker's rows are eventually retried).
export async function claimIncompletePayments(
  staleMs = 2 * 60_000,
  limit = 50
): Promise<PaymentRecord[]> {
  if (!isDatabaseConfigured()) return [];

  const res = await query(
    `UPDATE payments
       SET recovery_locked_at = NOW(), updated_at = NOW()
     WHERE nonce IN (
       SELECT nonce FROM payments
       WHERE status IN ('incoming_submitted', 'incoming_complete', 'outgoing_submitted')
         AND (recovery_locked_at IS NULL
              OR recovery_locked_at < NOW() - ($1 || ' milliseconds')::interval)
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     RETURNING *`,
    [String(staleMs), limit]
  );
  return res.rows.map(toRecord);
}

// Payments still incomplete well past the point where normal recovery should
// have resolved them — surfaced for operator review/pruning (e.g. a zombie
// incoming whose nonce was reused and can no longer be re-broadcast).
export async function getStuckPayments(
  olderThanMs: number,
  limit = 100
): Promise<PaymentRecord[]> {
  if (!isDatabaseConfigured()) return [];

  const res = await query(
    `SELECT * FROM payments
     WHERE status IN ('incoming_submitted', 'incoming_complete', 'outgoing_submitted')
       AND created_at < NOW() - ($1 || ' milliseconds')::interval
     ORDER BY created_at ASC
     LIMIT $2`,
    [String(olderThanMs), limit]
  );
  return res.rows.map(toRecord);
}

export async function logEvent(
  nonce: string,
  eventType: string,
  data?: Record<string, unknown>
): Promise<void> {
  if (!isDatabaseConfigured()) return;
  await query(
    "INSERT INTO payment_events (nonce, event_type, event_data) VALUES ($1, $2, $3)",
    [nonce, eventType, data ? JSON.stringify(data) : null]
  );
}
