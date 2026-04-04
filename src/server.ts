import express from "express";
import rateLimit from "express-rate-limit";
import {
  networkConfig,
  allNetworkConfigs,
  FACILITATOR_ADDRESS,
  PORT,
  BODY_SIZE_LIMIT,
  toLegacyName,
} from "./config.js";
import { splitSignature } from "./eip3009.js";
import { verifyPayment } from "./verify.js";
import { settlePayment, getFacilitatorBalance } from "./settle.js";
import { generateRequirements } from "./requirements.js";
import { executeRefund } from "./refund.js";
import {
  authenticateMerchant,
  authenticateAdmin,
  type AuthenticatedRequest,
} from "./auth.js";
import { runStartupChecks } from "./startup.js";
import { startRecoveryWorker, stopRecoveryWorker } from "./recovery.js";
import { closePool, isDatabaseConfigured } from "./db.js";
import { SDKVerifyRequestSchema } from "./types.js";
import { Logger, generateCorrelationId, logger } from "./logging.js";
import type { Request, Response, NextFunction } from "express";

const app = express();
app.use(express.json({ limit: BODY_SIZE_LIMIT }));

// attach correlation ID and logger to each request
app.use((req: Request, _res: Response, next: NextFunction) => {
  const id = generateCorrelationId();
  (req as any).correlationId = id;
  (req as any).log = new Logger({ correlationId: id });
  next();
});

function reqLog(req: Request): Logger {
  return (req as any).log || logger;
}

// rate limiters
const generalLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100 });
const settleLimiter = rateLimit({ windowMs: 15 * 60_000, max: 50 });
const adminLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20 });

app.use(generalLimiter);

// parse SDK request from body or headers
function parseSdkPayload(req: Request): unknown | null {
  if (req.body && typeof req.body === "object" && req.body.permit) {
    return req.body;
  }

  const headerVal =
    req.header("PAYMENT-SIGNATURE") ||
    req.header("X-PAYMENT");
  if (headerVal) {
    try {
      return JSON.parse(headerVal);
    } catch {
      return null;
    }
  }
  return null;
}

// convert SDK format to internal format
function sdkToInternal(sdk: any) {
  const sig = splitSignature(sdk.permit.sig);
  const merchantAddress = sdk.extra?.merchantAddress;

  const payload = {
    scheme: "exact",
    network: sdk.network,
    payload: {
      from: sdk.permit.owner as `0x${string}`,
      to: sdk.recipient as `0x${string}`,
      value: sdk.amount,
      validAfter: 0,
      validBefore: sdk.deadline,
      nonce: sdk.nonce as `0x${string}`,
      ...sig,
    },
  };

  const requirements = {
    scheme: "exact",
    network: sdk.network,
    token: sdk.token as `0x${string}`,
    amount: sdk.amount,
    recipient: sdk.recipient as `0x${string}`,
    merchantAddress: merchantAddress as `0x${string}` | undefined,
  };

  return { payload, requirements, merchantAddress };
}

// --- routes ---

app.get("/health", async (_req, res) => {
  let db: "ok" | "disconnected" | "not_configured" = "not_configured";
  if (isDatabaseConfigured()) {
    try {
      await import("./db.js").then((m) => m.testConnection());
      db = "ok";
    } catch {
      db = "disconnected";
    }
  }

  res.json({
    status: "ok",
    network: networkConfig.network,
    chainId: networkConfig.chainId,
    facilitator: FACILITATOR_ADDRESS,
    db,
    timestamp: Date.now(),
  });
});

app.get("/supported", (_req, res) => {
  const kinds = [];
  for (const cfg of allNetworkConfigs) {
    // v1 with legacy name
    kinds.push({
      x402Version: 1,
      scheme: "exact",
      network: toLegacyName(cfg.network),
    });
    // v2 with CAIP-2
    kinds.push({
      x402Version: 2,
      scheme: "exact",
      network: cfg.network,
      payTo: FACILITATOR_ADDRESS,
    });
  }
  res.json({ kinds, signingAddresses: [FACILITATOR_ADDRESS] });
});

// requirements
function handleRequirements(req: Request, res: Response) {
  const amount = req.body?.amount || req.query.amount || "1000000";
  const memo = req.body?.memo || req.query.memo;
  const version = parseInt(
    (req.body?.x402Version || req.query.version || "2") as string,
    10
  );

  const result = generateRequirements({
    amount: String(amount),
    memo: memo as string,
    x402Version: version,
    extra: req.body?.extra,
  });

  res.setHeader("PAYMENT-RESPONSE", JSON.stringify(result));
  res.setHeader("X-PAYMENT-RESPONSE", JSON.stringify(result));
  res.status(402).json(result);
}

app.get("/requirements", handleRequirements);
app.post("/requirements", handleRequirements);

// verify
app.post("/verify", async (req: Request, res: Response) => {
  const log = reqLog(req);
  const raw = parseSdkPayload(req);
  if (!raw) {
    res.status(400).json({ error: "missing payment payload" });
    return;
  }

  const parsed = SDKVerifyRequestSchema.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid payload", details: parsed.error.issues });
    return;
  }

  const { payload, requirements, merchantAddress } = sdkToInternal(parsed.data);
  const result = await verifyPayment(payload, requirements, merchantAddress, log, {
    registerNonce: false,
  });
  res.json(result);
});

// settle (merchant auth required)
app.post(
  "/settle",
  settleLimiter,
  authenticateMerchant,
  async (req: AuthenticatedRequest, res: Response) => {
    const log = reqLog(req);
    const raw = parseSdkPayload(req);
    if (!raw) {
      res.status(400).json({ error: "missing payment payload" });
      return;
    }

    const parsed = SDKVerifyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload", details: parsed.error.issues });
      return;
    }

    const { payload, requirements } = sdkToInternal(parsed.data);
    const merchantAddr = req.merchant?.address || parsed.data.extra?.merchantAddress;

    if (!merchantAddr) {
      res.status(400).json({ error: "no merchant address" });
      return;
    }

    const result = await settlePayment(payload, requirements, merchantAddr, log);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  }
);

// admin: wallet balance
app.get(
  "/admin/wallet",
  adminLimiter,
  authenticateAdmin,
  async (_req: Request, res: Response) => {
    try {
      const balance = await getFacilitatorBalance();
      res.json({ address: FACILITATOR_ADDRESS, ...balance });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

// admin: refund
app.post(
  "/admin/refund",
  adminLimiter,
  authenticateAdmin,
  async (req: Request, res: Response) => {
    const { nonce, reason } = req.body;
    if (!nonce) {
      res.status(400).json({ error: "nonce required" });
      return;
    }
    const result = await executeRefund(nonce, reason);
    res.json(result);
  }
);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// error handler — express requires all 4 params to identify this as an error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "internal error" });
});

// boot
async function start() {
  try {
    await runStartupChecks();
  } catch (err: any) {
    logger.error("startup checks failed", { error: err.message });
    process.exit(1);
  }

  startRecoveryWorker();

  const server = app.listen(PORT, () => {
    logger.info(`arb402 facilitator running on :${PORT}`, {
      network: networkConfig.network,
      chainId: networkConfig.chainId,
      facilitator: FACILITATOR_ADDRESS,
      usdc: networkConfig.usdcAddress,
    });
  });

  // graceful shutdown
  async function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down`);
    stopRecoveryWorker();
    server.close();
    await closePool();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();
