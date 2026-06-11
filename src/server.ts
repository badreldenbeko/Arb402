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
import { recordIssued } from "./issuedStore.js";
import { getStuckPayments } from "./nonceStore.js";
import { STUCK_PAYMENT_ALERT_MS } from "./config.js";
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

// Behind a proxy/load balancer, set TRUST_PROXY (e.g. "1" or "loopback") so the
// rate limiter keys on the real client IP. Leave it unset when directly exposed:
// naively trusting X-Forwarded-For would let clients spoof their IP.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
}

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

// Express 4 does not route rejections from async handlers to the error
// middleware, so an unhandled throw leaves the request hanging until socket
// timeout. Wrap async handlers so any rejection always produces a response.
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch((err: any) => {
      reqLog(req).error("unhandled handler rejection", { error: err?.message });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      }
    });
  };
}

// rate limiters
const generalLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100 });
const settleLimiter = rateLimit({ windowMs: 15 * 60_000, max: 50 });
const adminLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20 });
// /requirements is unauthenticated and writes a row per call, so cap it tighter
const requirementsLimiter = rateLimit({ windowMs: 60_000, max: 30 });

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
async function handleRequirements(req: Request, res: Response): Promise<void> {
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

  // persist what we issued so /settle can be bound to this exact quote
  const accept = result.accepts[0];
  await recordIssued({
    nonce: String(accept.extra?.nonce),
    amount: accept.maxAmountRequired,
    merchantAddress: accept.extra?.merchantAddress as string | undefined,
    deadline: Number(accept.extra?.deadline),
    network: accept.network,
  });

  res.setHeader("PAYMENT-RESPONSE", JSON.stringify(result));
  res.setHeader("X-PAYMENT-RESPONSE", JSON.stringify(result));
  res.status(402).json(result);
}

app.get("/requirements", requirementsLimiter, asyncHandler(handleRequirements));
app.post("/requirements", requirementsLimiter, asyncHandler(handleRequirements));

// verify
app.post(
  "/verify",
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

// settle (merchant auth required)
app.post(
  "/settle",
  settleLimiter,
  authenticateMerchant,
  asyncHandler(async (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
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
    const merchantAddr = areq.merchant?.address || parsed.data.extra?.merchantAddress;

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
  })
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

// admin: list payments stuck past the alert threshold (for review / pruning)
app.get(
  "/admin/stuck",
  adminLimiter,
  authenticateAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const stuck = await getStuckPayments(STUCK_PAYMENT_ALERT_MS);
    const now = Date.now();
    res.json({
      thresholdMs: STUCK_PAYMENT_ALERT_MS,
      count: stuck.length,
      payments: stuck.map((p) => ({
        nonce: p.nonce,
        status: p.status,
        createdAt: p.createdAt,
        ageSeconds: Math.floor((now - new Date(p.createdAt).getTime()) / 1000),
        incomingTxHash: p.incomingTxHash,
        outgoingTxHash: p.outgoingTxHash,
      })),
    });
  })
);

// admin: refund
app.post(
  "/admin/refund",
  adminLimiter,
  authenticateAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { nonce, reason } = req.body;
    if (!nonce) {
      res.status(400).json({ error: "nonce required" });
      return;
    }
    const result = await executeRefund(nonce, reason);
    res.json(result);
  })
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
