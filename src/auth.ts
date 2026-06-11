import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { getMerchantByKeyId, type Merchant } from "./merchantStore.js";
import { logger } from "./logging.js";

export interface AuthenticatedRequest extends Request {
  merchant?: Merchant;
  isAdmin?: boolean;
}

// API key format: "<keyId>.<secret>". The keyId is a public prefix used to look
// up the single matching merchant, so authentication runs exactly ONE
// bcrypt.compare instead of scanning every merchant's hash.
export function apiKeyId(key: string): string | null {
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  return key.slice(0, dot);
}

// dev/test single-merchant fallback — lets the facilitator settle without a
// database (e.g. the local hardhat harness). Active ONLY when both env vars are
// set; never configure these in production.
function devMerchant(): Merchant | null {
  const apiKeyHash = process.env.DEV_MERCHANT_API_KEY_HASH;
  const address = process.env.DEV_MERCHANT_ADDRESS;
  if (!apiKeyHash || !address) return null;
  return {
    address,
    name: "dev-merchant",
    apiKeyHash,
    enabled: true,
    rateLimit: 1000,
  };
}

export function authenticateMerchant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.header("X-API-Key");
  if (!apiKey) {
    res.status(401).json({ error: "missing X-API-Key header" });
    return;
  }

  (async () => {
    // O(1): resolve the candidate merchant by the key's public prefix, plus the
    // optional dev-merchant fallback. No fixed cache, so a disabled/rotated key
    // stops working immediately.
    const candidates: Merchant[] = [];
    const keyId = apiKeyId(apiKey);
    if (keyId) {
      const m = await getMerchantByKeyId(keyId);
      if (m) candidates.push(m);
    }
    const dev = devMerchant();
    if (dev) candidates.push(dev);

    for (const m of candidates) {
      if (!m.enabled) continue;
      if (await bcrypt.compare(apiKey, m.apiKeyHash)) {
        req.merchant = m;
        return next();
      }
    }
    res.status(403).json({ error: "invalid or disabled API key" });
  })().catch((err) => {
    logger.warn("merchant auth failed", { error: err?.message });
    res.status(500).json({ error: "auth check failed" });
  });
}

export function authenticateAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const adminKey = req.header("X-Admin-Key");
  const hashEnv = process.env.ADMIN_API_KEY_HASH;

  if (!adminKey || !hashEnv) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  bcrypt
    .compare(adminKey, hashEnv)
    .then((match) => {
      if (match) {
        req.isAdmin = true;
        next();
      } else {
        res.status(403).json({ error: "invalid admin key" });
      }
    })
    .catch(() => {
      res.status(500).json({ error: "auth check failed" });
    });
}

export async function hashApiKey(key: string): Promise<string> {
  return bcrypt.hash(key, 10);
}

// Generate an API key as "<keyId>.<secret>". The keyId is stored alongside the
// merchant for O(1) lookup; the full key is what gets bcrypt-hashed.
export function generateApiKey(): string {
  const keyId = crypto.randomBytes(8).toString("hex"); // 16 hex chars
  const secret = crypto.randomBytes(24).toString("hex"); // 48 hex chars
  return `${keyId}.${secret}`;
}
