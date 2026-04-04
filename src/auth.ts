import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { getAllMerchants, type Merchant } from "./merchantStore.js";
import { logger } from "./logging.js";

export interface AuthenticatedRequest extends Request {
  merchant?: Merchant;
  isAdmin?: boolean;
}

// cache merchants for 60s to avoid hitting DB on every request
let merchantCache: Merchant[] = [];
let cacheUpdatedAt = 0;
const CACHE_TTL = 60_000;

async function refreshCache(): Promise<Merchant[]> {
  const now = Date.now();
  if (now - cacheUpdatedAt < CACHE_TTL && merchantCache.length > 0) {
    return merchantCache;
  }
  try {
    merchantCache = await getAllMerchants();
    cacheUpdatedAt = now;
  } catch (err) {
    logger.warn("failed to refresh merchant cache, using stale data");
  }
  return merchantCache;
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

  refreshCache()
    .then(async (merchants) => {
      for (const m of merchants) {
        if (!m.enabled) continue;
        const match = await bcrypt.compare(apiKey, m.apiKeyHash);
        if (match) {
          req.merchant = m;
          return next();
        }
      }
      res.status(403).json({ error: "invalid or disabled API key" });
    })
    .catch(() => {
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

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}
