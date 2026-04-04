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
  createdAt: Date;
}

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

  await query(`UPDATE payments SET ${sets.join(", ")} WHERE nonce = $1`, vals);
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
    createdAt: r.created_at,
  };
}

export async function getPayment(nonce: string): Promise<PaymentRecord | null> {
  if (!isDatabaseConfigured()) return null;

  const res = await query("SELECT * FROM payments WHERE nonce = $1", [nonce]);
  if (res.rows.length === 0) return null;
  return toRecord(res.rows[0]);
}

export async function getIncompletePayments(): Promise<PaymentRecord[]> {
  if (!isDatabaseConfigured()) return [];

  const res = await query(
    `SELECT * FROM payments
     WHERE status IN ('incoming_complete', 'outgoing_submitted')
     ORDER BY created_at ASC`
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
