import { query, isDatabaseConfigured } from "./db.js";

export interface IssuedRequirement {
  nonce: string;
  amount: string;
  merchantAddress?: string;
  deadline: number;
  network: string;
}

// in-memory fallback (dev/no-DB); pruned by deadline so it can't grow unbounded
const memory = new Map<string, IssuedRequirement>();

function pruneMemory(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of memory) {
    if (v.deadline < now) memory.delete(k);
  }
}

export async function recordIssued(r: IssuedRequirement): Promise<void> {
  if (!isDatabaseConfigured()) {
    pruneMemory();
    memory.set(r.nonce, r);
    return;
  }
  await query(
    `INSERT INTO issued_requirements (nonce, amount, merchant_address, deadline, network)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (nonce) DO NOTHING`,
    [r.nonce, r.amount, r.merchantAddress ?? null, r.deadline, r.network]
  );
}

export async function getIssued(nonce: string): Promise<IssuedRequirement | null> {
  if (!isDatabaseConfigured()) {
    pruneMemory();
    return memory.get(nonce) ?? null;
  }
  const res = await query("SELECT * FROM issued_requirements WHERE nonce = $1", [
    nonce,
  ]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    nonce: row.nonce,
    amount: row.amount,
    merchantAddress: row.merchant_address ?? undefined,
    deadline: Number(row.deadline),
    network: row.network,
  };
}

// Delete expired issued requirements so the table can't grow without bound
// (every unauthenticated /requirements call inserts a row). Called by the
// recovery worker each cycle.
export async function pruneExpiredIssued(): Promise<void> {
  if (!isDatabaseConfigured()) {
    pruneMemory();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await query("DELETE FROM issued_requirements WHERE deadline < $1", [now]);
}
