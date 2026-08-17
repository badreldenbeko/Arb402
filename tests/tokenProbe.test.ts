import { describe, it, expect } from "vitest";
import { probeToken } from "../src/tokenProbe.js";
import { buildDomainSeparator } from "../src/eip3009.js";

const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;
const CHAIN_ID = 421614;

/**
 * A fake public client. Each getter is either a value or the string "revert",
 * which makes the read throw — how a contract that lacks the function behaves.
 */
function client(reads: Record<string, unknown>) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      const v = reads[functionName];
      if (v === undefined || v === "revert") {
        throw new Error(`The contract function "${functionName}" reverted.`);
      }
      return v;
    },
  } as any;
}

const goodDomain = buildDomainSeparator("USD Coin", "2", CHAIN_ID, TOKEN);

const usdcLike = (over: Record<string, unknown> = {}) =>
  client({
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    version: "2",
    DOMAIN_SEPARATOR: goodDomain,
    authorizationState: false,
    ...over,
  });

const opts = {
  address: TOKEN,
  chainId: CHAIN_ID,
  tokenName: "USD Coin",
  tokenVersion: "2",
  expectedDecimals: 6,
};

describe("probeToken", () => {
  it("accepts a compliant EIP-3009 token", async () => {
    const p = await probeToken(usdcLike(), opts);
    expect(p.supportsEip3009).toBe(true);
    expect(p.domainMatches).toBe(true);
    expect(p.decimals).toBe(6);
    expect(p.symbol).toBe("USDC");
    expect(p.problems).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it("flags a token without EIP-3009", async () => {
    // this is Arbitrum Nova's bridged USDC.e: a well-formed ERC-20 with a
    // DOMAIN_SEPARATOR that nonetheless cannot settle a single payment
    const p = await probeToken(
      usdcLike({ authorizationState: "revert", version: "revert" }),
      opts
    );
    expect(p.supportsEip3009).toBe(false);
    expect(p.problems.join(" ")).toMatch(/does not implement EIP-3009/);
  });

  it("flags an EIP-712 domain mismatch and names the on-chain values", async () => {
    const wrong = buildDomainSeparator("USD Coin (Arb1)", "1", CHAIN_ID, TOKEN);
    const p = await probeToken(
      usdcLike({ DOMAIN_SEPARATOR: wrong, name: "USD Coin (Arb1)", version: "1" }),
      opts
    );
    expect(p.domainMatches).toBe(false);
    const msg = p.problems.join(" ");
    expect(msg).toMatch(/EIP-712 domain mismatch/);
    expect(msg).toMatch(/USD Coin \(Arb1\)/);
    expect(msg).toMatch(/USDC_NAME/);
  });

  it("passes when a corrected domain is configured", async () => {
    const arb1 = buildDomainSeparator("USD Coin (Arb1)", "1", CHAIN_ID, TOKEN);
    const p = await probeToken(usdcLike({ DOMAIN_SEPARATOR: arb1 }), {
      ...opts,
      tokenName: "USD Coin (Arb1)",
      tokenVersion: "1",
    });
    expect(p.domainMatches).toBe(true);
    expect(p.problems).toEqual([]);
  });

  it("flags wrong decimals with the magnitude of the error", async () => {
    const p = await probeToken(usdcLike({ decimals: 18 }), opts);
    expect(p.problems.join(" ")).toMatch(/expected 6 decimals, got 18/);
    expect(p.problems.join(" ")).toMatch(/10\^12/);
  });

  it("reports no contract at all as a distinct problem", async () => {
    const p = await probeToken(client({}), opts);
    expect(p.problems.join(" ")).toMatch(/no ERC-20 contract responded/);
    expect(p.problems.join(" ")).toMatch(/chain 421614/);
  });

  it("warns rather than fails when DOMAIN_SEPARATOR is absent", async () => {
    // the domain cannot be proven either way — not grounds for refusing to boot
    const p = await probeToken(
      usdcLike({ DOMAIN_SEPARATOR: "revert" }),
      opts
    );
    expect(p.domainMatches).toBeUndefined();
    expect(p.problems).toEqual([]);
    expect(p.warnings.join(" ")).toMatch(/could not be verified on-chain/);
  });

  it("always reports the expected domain separator for debugging", async () => {
    const p = await probeToken(usdcLike(), opts);
    expect(p.expectedDomainSeparator).toBe(goodDomain);
  });
});
