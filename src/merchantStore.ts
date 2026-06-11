import { query, isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

export interface Merchant {
  address: string;
  name: string;
  keyId?: string;
  apiKeyHash: string;
  enabled: boolean;
  rateLimit: number;
}

function toMerchant(r: any): Merchant {
  return {
    address: r.address,
    name: r.name,
    keyId: r.key_id ?? undefined,
    apiKeyHash: r.api_key_hash,
    enabled: r.enabled,
    rateLimit: r.rate_limit ?? 50,
  };
}

export async function getMerchantByAddress(
  address: string
): Promise<Merchant | null> {
  if (!isDatabaseConfigured()) return null;

  const res = await query(
    "SELECT * FROM merchants WHERE LOWER(address) = LOWER($1)",
    [address]
  );
  if (res.rows.length === 0) return null;
  return toMerchant(res.rows[0]);
}

// Single-row lookup by the API key's public prefix — keeps auth O(1).
export async function getMerchantByKeyId(
  keyId: string
): Promise<Merchant | null> {
  if (!isDatabaseConfigured()) return null;

  const res = await query("SELECT * FROM merchants WHERE key_id = $1", [keyId]);
  if (res.rows.length === 0) return null;
  return toMerchant(res.rows[0]);
}

export async function getAllMerchants(): Promise<Merchant[]> {
  if (!isDatabaseConfigured()) return [];

  const res = await query("SELECT * FROM merchants ORDER BY created_at DESC");
  return res.rows.map(toMerchant);
}

export async function addMerchant(
  address: string,
  name: string,
  apiKeyHash: string,
  keyId: string,
  rateLimit = 50
): Promise<void> {
  await query(
    `INSERT INTO merchants (address, name, api_key_hash, key_id, rate_limit)
     VALUES ($1, $2, $3, $4, $5)`,
    [address, name, apiKeyHash, keyId, rateLimit]
  );
  logger.info("merchant added", { address, name, keyId });
}

export async function setMerchantEnabled(
  address: string,
  enabled: boolean
): Promise<void> {
  await query(
    "UPDATE merchants SET enabled = $2, updated_at = NOW() WHERE LOWER(address) = LOWER($1)",
    [address, enabled]
  );
}

export async function deleteMerchant(address: string): Promise<void> {
  await query("DELETE FROM merchants WHERE LOWER(address) = LOWER($1)", [
    address,
  ]);
}
