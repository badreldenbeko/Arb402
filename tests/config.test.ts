import { describe, it, expect } from "vitest";
import { normalizeNetworkId, Network, toLegacyName } from "../src/config.js";

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
});

describe("toLegacyName", () => {
  it("maps arbitrum one", () => {
    expect(toLegacyName(Network.ARBITRUM)).toBe("arbitrum");
  });

  it("maps arbitrum sepolia", () => {
    expect(toLegacyName(Network.ARBITRUM_SEPOLIA)).toBe("arbitrum-sepolia");
  });
});
