import { query, isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

export interface Merchant {
  address: string;
  name: string;
  apiKeyHash: string;
  enabled: boolean;
  rateLimit: number;
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

  const r = res.rows[0];
  return {
    address: r.address,
    name: r.name,
    apiKeyHash: r.api_key_hash,
    enabled: r.enabled,
    rateLimit: r.rate_limit ?? 50,
  };
}

export async function getAllMerchants(): Promise<Merchant[]> {
  if (!isDatabaseConfigured()) return [];

  const res = await query(
    "SELECT * FROM merchants ORDER BY created_at DESC"
  );
  return res.rows.map((r) => ({
    address: r.address,
    name: r.name,
    apiKeyHash: r.api_key_hash,
    enabled: r.enabled,
    rateLimit: r.rate_limit ?? 50,
  }));
}

export async function addMerchant(
  address: string,
  name: string,
  apiKeyHash: string,
  rateLimit = 50
): Promise<void> {
  await query(
    `INSERT INTO merchants (address, name, api_key_hash, rate_limit)
     VALUES ($1, $2, $3, $4)`,
    [address, name, apiKeyHash, rateLimit]
  );
  logger.info("merchant added", { address, name });
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
