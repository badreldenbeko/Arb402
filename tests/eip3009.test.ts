import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { splitSignature, verifyTransferAuthorization, generateNonce } from "../src/eip3009.js";

// deterministic test key
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY);

describe("splitSignature", () => {
  it("splits a valid 65-byte hex signature", () => {
    const r = "a".repeat(64);
    const s = "b".repeat(64);
    const v = "1b"; // 27
    const sig = `0x${r}${s}${v}`;

    const result = splitSignature(sig);
    expect(result.r).toBe(`0x${r}`);
    expect(result.s).toBe(`0x${s}`);
    expect(result.v).toBe(27);
  });

  it("normalizes v=0 to v=27", () => {
    const sig = `0x${"aa".repeat(32)}${"bb".repeat(32)}00`;
    const result = splitSignature(sig);
    expect(result.v).toBe(27);
  });

  it("normalizes v=1 to v=28", () => {
    const sig = `0x${"aa".repeat(32)}${"bb".repeat(32)}01`;
    const result = splitSignature(sig);
    expect(result.v).toBe(28);
  });

  it("keeps v=27 as-is", () => {
    const sig = `0x${"aa".repeat(32)}${"bb".repeat(32)}1b`;
    expect(splitSignature(sig).v).toBe(27);
  });

  it("keeps v=28 as-is", () => {
    const sig = `0x${"aa".repeat(32)}${"bb".repeat(32)}1c`;
    expect(splitSignature(sig).v).toBe(28);
  });

  it("works without 0x prefix", () => {
    const raw = `${"cc".repeat(32)}${"dd".repeat(32)}1b`;
    const result = splitSignature(raw);
    expect(result.v).toBe(27);
  });

  it("throws on wrong length", () => {
    expect(() => splitSignature("0xabcd")).toThrow("expected 130 hex chars");
  });

  it("throws on empty string", () => {
    expect(() => splitSignature("")).toThrow();
  });
});

describe("verifyTransferAuthorization", () => {
  const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as `0x${string}`;
  const CHAIN_ID = 421614;

  it("recovers the correct signer from a valid authorization", async () => {
    const auth = {
      from: TEST_ACCOUNT.address,
      to: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      value: "1000000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: generateNonce(),
    };

    // sign using viem's signTypedData
    const signature = await TEST_ACCOUNT.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: TOKEN,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
    });

    const sig = splitSignature(signature);
    const recovered = await verifyTransferAuthorization(
      auth,
      sig,
      TOKEN,
      "USD Coin",
      "2",
      CHAIN_ID
    );

    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT.address.toLowerCase());
  });

  it("recovers a different address for wrong chain ID", async () => {
    const auth = {
      from: TEST_ACCOUNT.address,
      to: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      value: "500000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: generateNonce(),
    };

    // sign for chain 421614
    const signature = await TEST_ACCOUNT.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: TOKEN,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
    });

    const sig = splitSignature(signature);
    // verify against wrong chain
    const recovered = await verifyTransferAuthorization(
      auth,
      sig,
      TOKEN,
      "USD Coin",
      "2",
      42161 // mainnet instead of sepolia
    );

    expect(recovered.toLowerCase()).not.toBe(
      TEST_ACCOUNT.address.toLowerCase()
    );
  });
});

describe("generateNonce", () => {
  it("returns a 66-char hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("generates unique values", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });
});
