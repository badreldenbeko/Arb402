import { describe, it, expect } from "vitest";
import {
  normalizeNetworkId,
  Network,
  toLegacyName,
  networkConfig,
  allNetworkConfigs,
} from "../src/config.js";

describe("normalizeNetworkId", () => {
  it("returns sepolia as default when undefined", () => {
    expect(normalizeNetworkId(undefined)).toBe(Network.ARBITRUM_SEPOLIA);
  });

  it("returns sepolia as default for empty string", () => {
    expect(normalizeNetworkId("")).toBe(Network.ARBITRUM_SEPOLIA);
  });

  it("accepts CAIP-2 format for arbitrum one", () => {
    expect(normalizeNetworkId("eip155:42161")).toBe(Network.ARBITRUM);
  });

  it("accepts CAIP-2 format for sepolia", () => {
    expect(normalizeNetworkId("eip155:421614")).toBe(Network.ARBITRUM_SEPOLIA);
  });

  it("accepts legacy name 'arbitrum'", () => {
    expect(normalizeNetworkId("arbitrum")).toBe(Network.ARBITRUM);
  });

  it("accepts legacy name 'arbitrum-one'", () => {
    expect(normalizeNetworkId("arbitrum-one")).toBe(Network.ARBITRUM);
  });

  it("accepts legacy name 'arbitrum-sepolia'", () => {
    expect(normalizeNetworkId("arbitrum-sepolia")).toBe(Network.ARBITRUM_SEPOLIA);
  });

  it("accepts Arbitrum Nova by CAIP-2, legacy name, and alias", () => {
    expect(normalizeNetworkId("eip155:42170")).toBe(Network.ARBITRUM_NOVA);
    expect(normalizeNetworkId("arbitrum-nova")).toBe(Network.ARBITRUM_NOVA);
    expect(normalizeNetworkId("nova")).toBe(Network.ARBITRUM_NOVA);
  });

  it("is case-insensitive", () => {
    expect(normalizeNetworkId("ARBITRUM")).toBe(Network.ARBITRUM);
    expect(normalizeNetworkId("Arbitrum-Sepolia")).toBe(Network.ARBITRUM_SEPOLIA);
    expect(normalizeNetworkId("EIP155:42161")).toBe(Network.ARBITRUM);
  });

  it("trims whitespace", () => {
    expect(normalizeNetworkId("  arbitrum  ")).toBe(Network.ARBITRUM);
  });

  it("throws on unsupported network", () => {
    expect(() => normalizeNetworkId("ethereum")).toThrow("unsupported network");
    expect(() => normalizeNetworkId("base-sepolia")).toThrow("unsupported network");
    expect(() => normalizeNetworkId("eip155:1")).toThrow("unsupported network");
  });

  it("throws on random garbage", () => {
    expect(() => normalizeNetworkId("not-a-network")).toThrow(
      "unsupported network"
    );
  });

  it("points unregistered CAIP-2 ids at the Orbit chains file", () => {
    // a valid-looking id we don't know is almost always an unregistered Orbit
    // chain, so the error says how to register it
    expect(() => normalizeNetworkId("eip155:412346")).toThrow(
      /arb402\.chains\.json/
    );
  });
});

describe("toLegacyName", () => {
  it("maps arbitrum one", () => {
    expect(toLegacyName(Network.ARBITRUM)).toBe("arbitrum");
  });

  it("maps arbitrum nova", () => {
    expect(toLegacyName(Network.ARBITRUM_NOVA)).toBe("arbitrum-nova");
  });

  it("maps arbitrum sepolia", () => {
    expect(toLegacyName(Network.ARBITRUM_SEPOLIA)).toBe("arbitrum-sepolia");
  });

  it("returns the id unchanged for an unregistered chain", () => {
    expect(toLegacyName("eip155:999999")).toBe("eip155:999999");
  });
});

describe("networkConfig", () => {
  it("exposes the active chain's token domain", () => {
    // per-chain domains are what let Orbit tokens differ from Circle's
    expect(networkConfig.tokenName).toBe("USD Coin");
    expect(networkConfig.tokenVersion).toBe("2");
    expect(networkConfig.tokenDecimals).toBe(6);
    expect(networkConfig.tokenConfigured).toBe(true);
  });

  it("advertises every registered chain, Nova included", () => {
    const ids = allNetworkConfigs.map((c) => c.network);
    expect(ids).toContain(Network.ARBITRUM);
    expect(ids).toContain(Network.ARBITRUM_NOVA);
    expect(ids).toContain(Network.ARBITRUM_SEPOLIA);
  });

  it("reports Nova as having no settlement token", () => {
    const nova = allNetworkConfigs.find(
      (c) => c.network === Network.ARBITRUM_NOVA
    )!;
    expect(nova.tokenConfigured).toBe(false);
    expect(nova.chainId).toBe(42170);
    expect(nova.family).toBe("nova");
  });

  it("builds a usable viem chain for every registered chain", () => {
    for (const c of allNetworkConfigs) {
      expect(c.chain.id).toBe(c.chainId);
      expect(c.rpcUrl).toMatch(/^https?:\/\//);
    }
  });
});
