import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authenticateMerchant, hashApiKey, generateApiKey, apiKeyId } from "../src/auth.js";

// minimal express req/res doubles for the middleware
function makeReq(apiKey?: string) {
  return {
    header: (name: string) => (name === "X-API-Key" ? apiKey : undefined),
  } as any;
}

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

// the middleware resolves asynchronously; resolve when next() or res.json() fires
function run(req: any, res: any): Promise<{ nexted: boolean }> {
  return new Promise((resolve) => {
    const origJson = res.json.bind(res);
    res.json = (payload: unknown) => {
      origJson(payload);
      resolve({ nexted: false });
      return res;
    };
    authenticateMerchant(req, res, () => resolve({ nexted: true }));
  });
}

describe("authenticateMerchant — dev merchant fallback", () => {
  const KEY = "test-merchant-key";
  const ADDR = "0x1111111111111111111111111111111111111111";
  let savedHash: string | undefined;
  let savedAddr: string | undefined;

  beforeEach(async () => {
    savedHash = process.env.DEV_MERCHANT_API_KEY_HASH;
    savedAddr = process.env.DEV_MERCHANT_ADDRESS;
    process.env.DEV_MERCHANT_API_KEY_HASH = await hashApiKey(KEY);
    process.env.DEV_MERCHANT_ADDRESS = ADDR;
  });

  afterEach(() => {
    if (savedHash === undefined) delete process.env.DEV_MERCHANT_API_KEY_HASH;
    else process.env.DEV_MERCHANT_API_KEY_HASH = savedHash;
    if (savedAddr === undefined) delete process.env.DEV_MERCHANT_ADDRESS;
    else process.env.DEV_MERCHANT_ADDRESS = savedAddr;
    vi.restoreAllMocks();
  });

  it("rejects a request with no API key", async () => {
    const res = makeRes();
    const result = await run(makeReq(undefined), res);
    expect(result.nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("accepts the configured dev merchant key and attaches the merchant", async () => {
    const req = makeReq(KEY);
    const res = makeRes();
    const result = await run(req, res);
    expect(result.nexted).toBe(true);
    expect(req.merchant?.address).toBe(ADDR);
    expect(req.merchant?.name).toBe("dev-merchant");
  });

  it("rejects a wrong key", async () => {
    const res = makeRes();
    const result = await run(makeReq("wrong-key"), res);
    expect(result.nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("does not activate the fallback when env vars are unset", async () => {
    delete process.env.DEV_MERCHANT_API_KEY_HASH;
    delete process.env.DEV_MERCHANT_ADDRESS;
    const res = makeRes();
    const result = await run(makeReq(KEY), res);
    expect(result.nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe("api key format", () => {
  it("generateApiKey embeds a parseable 8-byte key id", () => {
    const key = generateApiKey();
    const id = apiKeyId(key);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(key.startsWith(id + ".")).toBe(true);
  });

  it("apiKeyId returns null for a key with no prefix", () => {
    expect(apiKeyId("nodelimiter")).toBeNull();
    expect(apiKeyId(".leadingdot")).toBeNull();
  });
});
