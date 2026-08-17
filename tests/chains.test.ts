import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BUILTIN_CHAINS,
  Network,
  buildRegistry,
  parseOrbitChain,
  parseOrbitChains,
  toViemChain,
  type ChainDefinition,
} from "../src/chains.js";

const orbit = (over: Record<string, unknown> = {}) => ({
  name: "My Orbit Chain",
  chainId: 412346,
  rpcUrl: "https://rpc.orbit.example",
  ...over,
});

describe("built-in chains", () => {
  it("registers Arbitrum One, Nova, and Sepolia", () => {
    expect(BUILTIN_CHAINS.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([
      42161, 42170, 421614,
    ]);
  });

  it("gives Arbitrum One the native EIP-3009 USDC", () => {
    const one = BUILTIN_CHAINS.find((c) => c.id === Network.ARBITRUM)!;
    expect(one.token?.address).toBe(
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
    );
    expect(one.token?.eip3009).toBe(true);
    expect(one.token?.name).toBe("USD Coin");
    expect(one.token?.version).toBe("2");
  });

  it("ships Nova with no settlement token", () => {
    // Nova's bridged USDC.e does not implement EIP-3009 (authorizationState
    // reverts on-chain), so there is no default that could actually settle.
    const nova = BUILTIN_CHAINS.find((c) => c.id === Network.ARBITRUM_NOVA)!;
    expect(nova.chainId).toBe(42170);
    expect(nova.token).toBeUndefined();
  });

  it("marks each chain with a family", () => {
    const families = Object.fromEntries(
      BUILTIN_CHAINS.map((c) => [c.chainId, c.family])
    );
    expect(families[42161]).toBe("arbitrum-one");
    expect(families[42170]).toBe("nova");
    expect(families[421614]).toBe("testnet");
  });
});

describe("registry alias resolution", () => {
  const reg = buildRegistry();

  it("resolves CAIP-2 ids", () => {
    expect(reg.aliasIndex.get("eip155:42170")).toBe(Network.ARBITRUM_NOVA);
  });

  it("resolves legacy names and aliases", () => {
    expect(reg.aliasIndex.get("arbitrum")).toBe(Network.ARBITRUM);
    expect(reg.aliasIndex.get("arbitrum-one")).toBe(Network.ARBITRUM);
    expect(reg.aliasIndex.get("nova")).toBe(Network.ARBITRUM_NOVA);
    expect(reg.aliasIndex.get("arbitrum-nova")).toBe(Network.ARBITRUM_NOVA);
    expect(reg.aliasIndex.get("arbitrum-sepolia")).toBe(
      Network.ARBITRUM_SEPOLIA
    );
  });

  it("does not resolve unregistered chains", () => {
    expect(reg.aliasIndex.get("eip155:1")).toBeUndefined();
    expect(reg.aliasIndex.get("base")).toBeUndefined();
  });
});

describe("orbit chain parsing", () => {
  it("parses a minimal entry", () => {
    const def = parseOrbitChain(orbit(), 0);
    expect(def.id).toBe("eip155:412346");
    expect(def.chainId).toBe(412346);
    expect(def.family).toBe("orbit");
    expect(def.source).toBe("orbit-config");
    expect(def.rpcEnvVar).toBe("ORBIT_412346_RPC_URL");
  });

  it("derives a slug from the name", () => {
    expect(parseOrbitChain(orbit(), 0).legacyName).toBe("my-orbit-chain");
    expect(parseOrbitChain(orbit({ slug: "my-orbit" }), 0).legacyName).toBe(
      "my-orbit"
    );
  });

  it("accepts a chainId given as a string", () => {
    expect(parseOrbitChain(orbit({ chainId: "999" }), 0).chainId).toBe(999);
  });

  it("defaults the token domain to Circle USDC values", () => {
    const def = parseOrbitChain(
      orbit({ token: { address: `0x${"ab".repeat(20)}` } }),
      0
    );
    expect(def.token).toMatchObject({
      name: "USD Coin",
      version: "2",
      decimals: 6,
      eip3009: true,
    });
  });

  it("keeps an explicit non-standard domain", () => {
    const def = parseOrbitChain(
      orbit({
        token: {
          address: `0x${"ab".repeat(20)}`,
          name: "Orbit Dollar",
          version: "1",
          decimals: 6,
        },
      }),
      0
    );
    expect(def.token).toMatchObject({ name: "Orbit Dollar", version: "1" });
  });

  it("rejects a missing or non-integer chainId", () => {
    expect(() => parseOrbitChain(orbit({ chainId: undefined }), 0)).toThrow(
      /"chainId" must be a positive integer/
    );
    expect(() => parseOrbitChain(orbit({ chainId: 1.5 }), 0)).toThrow(
      /"chainId" must be a positive integer/
    );
  });

  it("rejects a missing name or rpcUrl", () => {
    expect(() => parseOrbitChain(orbit({ name: undefined }), 0)).toThrow(
      /"name" is required/
    );
    expect(() => parseOrbitChain(orbit({ rpcUrl: "" }), 0)).toThrow(
      /"rpcUrl" is required/
    );
  });

  it("rejects a malformed token address", () => {
    // a typo'd address is a silent settlement failure, so it fails at load
    expect(() =>
      parseOrbitChain(orbit({ token: { address: "0xnope" } }), 0)
    ).toThrow(/not a valid 0x address/);
  });

  it("names the offending entry in the error", () => {
    expect(() => parseOrbitChain(orbit({ name: undefined }), 2)).toThrow(
      /orbit chain #3/
    );
  });
});

describe("orbit file parsing", () => {
  it("reads a { chains: [...] } document", () => {
    const out = parseOrbitChains(
      JSON.stringify({ chains: [orbit()] }),
      "test.json"
    );
    expect(out).toHaveLength(1);
    expect(out[0].chainId).toBe(412346);
  });

  it("reads a bare array", () => {
    expect(parseOrbitChains(JSON.stringify([orbit()]), "t.json")).toHaveLength(1);
  });

  it("returns nothing for a document with no chains key", () => {
    expect(parseOrbitChains("{}", "t.json")).toEqual([]);
  });

  it("reports invalid JSON with the file path", () => {
    expect(() => parseOrbitChains("{not json", "chains.json")).toThrow(
      /chains\.json: invalid JSON/
    );
  });

  it("rejects a non-array chains value", () => {
    expect(() => parseOrbitChains('{"chains":"nope"}', "t.json")).toThrow(
      /expected a "chains" array/
    );
  });

  it("parses the shipped example file", () => {
    // the Orbit sample is a grant deliverable; keep it loadable
    const contents = readFileSync(
      new URL("../arb402.chains.example.json", import.meta.url),
      "utf8"
    );
    const chains = parseOrbitChains(contents, "example");
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.map((c) => c.chainId)).toContain(42170);
  });
});

describe("registry with orbit chains", () => {
  it("adds orbit chains alongside the built-ins", () => {
    const reg = buildRegistry([parseOrbitChain(orbit(), 0)]);
    expect(reg.all).toHaveLength(BUILTIN_CHAINS.length + 1);
    expect(reg.aliasIndex.get("eip155:412346")).toBe("eip155:412346");
    expect(reg.aliasIndex.get("my-orbit-chain")).toBe("eip155:412346");
  });

  it("lets an orbit entry override a built-in by chain id", () => {
    // the documented way to give Nova an EIP-3009 token
    const override = parseOrbitChain(
      orbit({
        name: "Arbitrum Nova",
        slug: "arbitrum-nova",
        chainId: 42170,
        rpcUrl: "https://my-nova-rpc.example",
        token: { address: `0x${"cd".repeat(20)}` },
      }),
      0
    );
    const reg = buildRegistry([override]);
    expect(reg.all).toHaveLength(BUILTIN_CHAINS.length);
    const nova = reg.byId.get(Network.ARBITRUM_NOVA)!;
    expect(nova.token?.address).toBe(`0x${"cd".repeat(20)}`);
    expect(nova.defaultRpcUrl).toBe("https://my-nova-rpc.example");
    // overriding a built-in's token must not reclassify the chain itself
    expect(nova.family).toBe("nova");
    expect(nova.rpcEnvVar).toBe("ARBITRUM_NOVA_RPC_URL");
    expect(nova.aliases).toContain("nova");
    expect(nova.source).toBe("orbit-config");
  });

  it("does not let an orbit alias hijack a built-in name", () => {
    // otherwise a stray alias could silently redirect settlement to another chain
    const sneaky = parseOrbitChain(
      orbit({ name: "Sneaky", chainId: 999999, aliases: ["arbitrum"] }),
      0
    );
    const reg = buildRegistry([sneaky]);
    expect(reg.aliasIndex.get("arbitrum")).toBe(Network.ARBITRUM);
  });
});

describe("toViemChain", () => {
  it("returns viem's own chain object for built-ins", () => {
    const one = BUILTIN_CHAINS.find((c) => c.id === Network.ARBITRUM)!;
    expect(toViemChain(one, one.defaultRpcUrl).id).toBe(42161);
  });

  it("synthesises a chain for orbit ids viem does not know", () => {
    const def: ChainDefinition = parseOrbitChain(orbit(), 0);
    const chain = toViemChain(def, "https://rpc.orbit.example");
    expect(chain.id).toBe(412346);
    expect(chain.name).toBe("My Orbit Chain");
    expect(chain.rpcUrls.default.http[0]).toBe("https://rpc.orbit.example");
    expect(chain.nativeCurrency.symbol).toBe("ETH");
  });

  it("uses a custom native currency when given", () => {
    const def = parseOrbitChain(
      orbit({ nativeCurrency: { name: "Orbit", symbol: "ORB", decimals: 18 } }),
      0
    );
    expect(toViemChain(def, "https://x").nativeCurrency.symbol).toBe("ORB");
  });
});
