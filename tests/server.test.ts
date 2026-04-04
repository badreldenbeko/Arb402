import { describe, it, expect, vi, beforeAll } from "vitest";

// mock startup checks so we don't hit real RPC
vi.mock("../src/startup.js", () => ({
  runStartupChecks: vi.fn().mockResolvedValue(undefined),
}));

// mock recovery so it doesn't start timers
vi.mock("../src/recovery.js", () => ({
  startRecoveryWorker: vi.fn(),
  stopRecoveryWorker: vi.fn(),
}));

// mock settle to avoid real chain interactions
vi.mock("../src/settle.js", () => ({
  settlePayment: vi.fn().mockResolvedValue({
    success: true,
    incomingTxHash: "0xaaa",
    outgoingTxHash: "0xbbb",
    blockNumber: 123,
    feeBreakdown: {
      totalAmount: "1000000",
      merchantAmount: "895522",
      serviceFee: "4478",
      gasFee: "100000",
    },
  }),
  getFacilitatorBalance: vi.fn().mockResolvedValue({
    usdc: "5000000",
    eth: "100000000000000000",
  }),
  getPublicClient: vi.fn(),
}));

// mock db
vi.mock("../src/db.js", () => ({
  isDatabaseConfigured: vi.fn().mockReturnValue(false),
  closePool: vi.fn().mockResolvedValue(undefined),
}));

// need to import after mocks are set up
import request from "supertest";
import express from "express";

// build the app inline to avoid the server.ts boot sequence
let app: express.Express;

beforeAll(async () => {
  // rebuild the app here since server.ts doesn't export it
  const { networkConfig, FACILITATOR_ADDRESS, allNetworkConfigs, BODY_SIZE_LIMIT, toLegacyName } = await import("../src/config.js");
  const { splitSignature } = await import("../src/eip3009.js");
  const { verifyPayment } = await import("../src/verify.js");
  const { generateRequirements } = await import("../src/requirements.js");
  const { SDKVerifyRequestSchema } = await import("../src/types.js");
  const rateLimit = (await import("express-rate-limit")).default;

  app = express();
  app.use(express.json({ limit: BODY_SIZE_LIMIT }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      network: networkConfig.network,
      chainId: networkConfig.chainId,
      facilitator: FACILITATOR_ADDRESS,
      db: "not_configured",
      timestamp: Date.now(),
    });
  });

  app.get("/supported", (_req, res) => {
    const kinds: any[] = [];
    for (const cfg of allNetworkConfigs) {
      kinds.push({ x402Version: 1, scheme: "exact", network: toLegacyName(cfg.network) });
      kinds.push({ x402Version: 2, scheme: "exact", network: cfg.network, payTo: FACILITATOR_ADDRESS });
    }
    res.json({ kinds, signingAddresses: [FACILITATOR_ADDRESS] });
  });

  app.get("/requirements", (_req, res) => {
    const amount = (_req.query.amount as string) || "1000000";
    const result = generateRequirements({ amount });
    res.status(402).json(result);
  });

  app.post("/requirements", (req, res) => {
    const amount = req.body?.amount || "1000000";
    const result = generateRequirements({ amount: String(amount), memo: req.body?.memo });
    res.status(402).json(result);
  });

  app.post("/verify", async (req, res) => {
    const parsed = SDKVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload", details: parsed.error.issues });
      return;
    }

    let sig;
    try {
      sig = splitSignature(parsed.data.permit.sig);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }

    const payload = {
      scheme: "exact",
      network: parsed.data.network,
      payload: {
        from: parsed.data.permit.owner as `0x${string}`,
        to: parsed.data.recipient as `0x${string}`,
        value: parsed.data.amount,
        validAfter: 0,
        validBefore: parsed.data.deadline,
        nonce: parsed.data.nonce as `0x${string}`,
        ...sig,
      },
    };
    const requirements = {
      scheme: "exact",
      network: parsed.data.network,
      token: parsed.data.token as `0x${string}`,
      amount: parsed.data.amount,
      recipient: parsed.data.recipient as `0x${string}`,
    };

    const { Logger } = await import("../src/logging.js");
    const log = new Logger();
    const result = await verifyPayment(payload, requirements, undefined, log, { registerNonce: false });
    res.json(result);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.network).toBeDefined();
    expect(res.body.chainId).toBeDefined();
    expect(res.body.timestamp).toBeTypeOf("number");
    expect(res.body.db).toBeDefined();
  });
});

describe("GET /supported", () => {
  it("returns v1 and v2 kinds for each network", async () => {
    const res = await request(app).get("/supported");
    expect(res.status).toBe(200);
    expect(res.body.kinds.length).toBeGreaterThanOrEqual(2);

    const v1 = res.body.kinds.filter((k: any) => k.x402Version === 1);
    const v2 = res.body.kinds.filter((k: any) => k.x402Version === 2);
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);

    // v1 uses legacy names
    expect(v1.some((k: any) => k.network === "arbitrum")).toBe(true);
    // v2 uses CAIP-2
    expect(v2.some((k: any) => k.network === "eip155:42161")).toBe(true);
  });

  it("includes signingAddresses", async () => {
    const res = await request(app).get("/supported");
    expect(res.body.signingAddresses).toBeInstanceOf(Array);
    expect(res.body.signingAddresses.length).toBe(1);
  });
});

describe("GET /requirements", () => {
  it("returns 402 with payment requirements", async () => {
    const res = await request(app).get("/requirements");
    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(2);
    expect(res.body.error).toBe("Payment required");
    expect(res.body.accepts).toBeInstanceOf(Array);
    expect(res.body.accepts.length).toBe(1);

    const accept = res.body.accepts[0];
    expect(accept.scheme).toBe("exact");
    expect(accept.asset).toBeDefined();
    expect(accept.payTo).toBeDefined();
    expect(accept.extra.nonce).toMatch(/^0x[a-f0-9]{64}$/);
    expect(accept.extra.deadline).toBeTypeOf("number");
  });

  it("accepts custom amount via query param", async () => {
    const res = await request(app).get("/requirements?amount=5000000");
    expect(res.body.accepts[0].maxAmountRequired).toBe("5000000");
  });
});

describe("POST /requirements", () => {
  it("accepts amount and memo in body", async () => {
    const res = await request(app)
      .post("/requirements")
      .send({ amount: "2000000", memo: "test payment" });

    expect(res.status).toBe(402);
    expect(res.body.accepts[0].maxAmountRequired).toBe("2000000");
    expect(res.body.accepts[0].description).toBe("test payment");
  });
});

describe("POST /verify", () => {
  it("rejects missing body", async () => {
    const res = await request(app).post("/verify").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid payload");
  });

  it("rejects malformed permit.sig", async () => {
    const res = await request(app)
      .post("/verify")
      .send({
        x402Version: 2,
        network: "eip155:421614",
        token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        recipient: "0x1234567890123456789012345678901234567890",
        amount: "1000000",
        nonce: "0x" + "ab".repeat(32),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        permit: {
          owner: "0x1234567890123456789012345678901234567890",
          spender: "0x1234567890123456789012345678901234567890",
          value: "1000000",
          deadline: Math.floor(Date.now() / 1000) + 3600,
          sig: "0xtooshort",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("expected 130 hex chars");
  });

  it("rejects missing required fields", async () => {
    const res = await request(app)
      .post("/verify")
      .send({
        x402Version: 2,
        network: "eip155:421614",
        // missing token, recipient, amount, etc.
      });
    expect(res.status).toBe(400);
  });
});

describe("404 handler", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not found");
  });

  it("returns 404 for unknown POST routes", async () => {
    const res = await request(app).post("/nonexistent").send({});
    expect(res.status).toBe(404);
  });
});
