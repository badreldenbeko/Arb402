import { describe, it, expect, beforeEach } from "vitest";

describe("nonceStore (in-memory mode)", () => {
  async function freshImport() {
    return await import("../src/nonceStore.js");
  }

  let store: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    store = await freshImport();
  });

  it("accepts a new nonce", async () => {
    const nonce = `0x${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}`;
    const result = await store.registerNonce(
      nonce,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "eip155:421614",
      "1000000"
    );
    expect(result).toBe(true);
  });

  it("rejects the same nonce twice", async () => {
    const nonce = `0x${"aa".repeat(32)}`;

    const first = await store.registerNonce(
      nonce,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "eip155:421614",
      "1000000"
    );
    expect(first).toBe(true);

    const second = await store.registerNonce(
      nonce,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "eip155:421614",
      "1000000"
    );
    expect(second).toBe(false);
  });

  it("different nonces don't conflict", async () => {
    const nonceA = `0x${"ab".repeat(32)}`;
    const nonceB = `0x${"cd".repeat(32)}`;

    const a = await store.registerNonce(
      nonceA,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "eip155:421614",
      "500000"
    );
    const b = await store.registerNonce(
      nonceB,
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
      "eip155:421614",
      "500000"
    );

    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("setStatus and getPayment return null in memory mode", async () => {
    // no DB, so these are no-ops / return null
    await store.setStatus("0xfake", "complete");
    const payment = await store.getPayment("0xfake");
    expect(payment).toBeNull();
  });

  it("claimIncompletePayments returns empty in memory mode", async () => {
    const incomplete = await store.claimIncompletePayments();
    expect(incomplete).toEqual([]);
  });

  it("logEvent is a no-op in memory mode", async () => {
    // should not throw
    await store.logEvent("0xfake", "test_event", { foo: "bar" });
  });
});
