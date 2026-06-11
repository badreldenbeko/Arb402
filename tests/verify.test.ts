import { describe, it, expect, vi, beforeEach } from "vitest";

// isolate verifyPayment from real crypto + DB so we can assert call ordering
vi.mock("../src/eip3009.js", () => ({
  verifyTransferAuthorization: vi.fn(),
}));
vi.mock("../src/nonceStore.js", () => ({
  registerNonce: vi.fn().mockResolvedValue(true),
}));

import { verifyPayment } from "../src/verify.js";
import { verifyTransferAuthorization } from "../src/eip3009.js";
import { registerNonce } from "../src/nonceStore.js";
import { networkConfig, FACILITATOR_ADDRESS } from "../src/config.js";
import { Logger } from "../src/logging.js";

const log = new Logger();
const FROM = "0x1111111111111111111111111111111111111111";

function makePayload(value: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    scheme: "exact",
    network: networkConfig.network,
    payload: {
      from: FROM as `0x${string}`,
      to: FACILITATOR_ADDRESS,
      value,
      validAfter: 0,
      validBefore: now + 3600,
      nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      v: 27,
      r: ("0x" + "11".repeat(32)) as `0x${string}`,
      s: ("0x" + "22".repeat(32)) as `0x${string}`,
    },
  };
}

function makeRequirements(amount: string) {
  return {
    scheme: "exact",
    network: networkConfig.network,
    token: networkConfig.usdcAddress,
    amount,
    recipient: FACILITATOR_ADDRESS,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPayment — nonce is claimed last", () => {
  it("does NOT claim the nonce when the signature is invalid", async () => {
    // recovered signer != from → signer mismatch
    (verifyTransferAuthorization as any).mockResolvedValue(
      "0x9999999999999999999999999999999999999999"
    );
    const res = await verifyPayment(makePayload("1000000"), makeRequirements("1000000"), undefined, log);
    expect(res.valid).toBe(false);
    expect(res.invalidReason).toContain("signer mismatch");
    expect(registerNonce).not.toHaveBeenCalled();
  });

  it("does NOT claim the nonce when over the settlement cap", async () => {
    (verifyTransferAuthorization as any).mockResolvedValue(FROM); // valid signer
    const big = "2000000000"; // 2000 USDC, over the 1000 USDC cap
    const res = await verifyPayment(makePayload(big), makeRequirements(big), undefined, log);
    expect(res.valid).toBe(false);
    expect(res.invalidReason).toContain("exceeds max settlement");
    expect(registerNonce).not.toHaveBeenCalled();
  });

  it("claims the nonce only after signature + cap pass", async () => {
    (verifyTransferAuthorization as any).mockResolvedValue(FROM);
    const res = await verifyPayment(makePayload("1000000"), makeRequirements("1000000"), undefined, log);
    expect(res.valid).toBe(true);
    expect(registerNonce).toHaveBeenCalledOnce();
  });
});
