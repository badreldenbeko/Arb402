import { describe, it, expect } from "vitest";
import { calculateFees } from "../src/verify.js";

describe("calculateFees", () => {
  // default config: SERVICE_FEE_BPS=50 (0.5%), GAS_FEE_USDC=100000 (0.10 USDC)

  it("basic 1 USDC payment", () => {
    const fees = calculateFees(1_000_000n);
    const merchant = BigInt(fees.merchantAmount);
    const service = BigInt(fees.serviceFee);
    const gas = BigInt(fees.gasFee);

    expect(gas).toBe(100_000n);
    // afterGas = 900000, merchant = 900000 * 10000 / 10050 = 895522
    expect(merchant).toBe(895_522n);
    expect(service).toBe(900_000n - 895_522n); // 4478
    // everything sums back to total
    expect(merchant + service + gas).toBe(1_000_000n);
  });

  it("total equals merchant + service + gas for various amounts", () => {
    const amounts = [200_000n, 500_000n, 5_000_000n, 100_000_000n];
    for (const total of amounts) {
      const fees = calculateFees(total);
      const sum =
        BigInt(fees.merchantAmount) +
        BigInt(fees.serviceFee) +
        BigInt(fees.gasFee);
      expect(sum).toBe(total);
    }
  });

  it("minimum viable amount (just covers gas)", () => {
    const fees = calculateFees(100_001n);
    // afterGas = 1, merchant = 1 * 10000 / 10050 = 0 (integer division)
    expect(BigInt(fees.merchantAmount)).toBe(0n);
    expect(BigInt(fees.serviceFee)).toBe(1n);
    expect(BigInt(fees.gasFee)).toBe(100_000n);
  });

  it("large amount keeps proportions roughly correct", () => {
    // 1000 USDC
    const fees = calculateFees(1_000_000_000n);
    const merchant = BigInt(fees.merchantAmount);
    const service = BigInt(fees.serviceFee);

    // service should be roughly 0.5% of (total - gas)
    const afterGas = 1_000_000_000n - 100_000n;
    const expectedService = (afterGas * 50n) / 10_050n;
    // allow 1 unit rounding tolerance
    expect(service - expectedService).toBeLessThanOrEqual(1n);
    expect(merchant + service).toBe(afterGas);
  });

  it("exactly gas fee means zero for merchant and service", () => {
    const fees = calculateFees(100_000n);
    expect(BigInt(fees.merchantAmount)).toBe(0n);
    expect(BigInt(fees.serviceFee)).toBe(0n);
    expect(BigInt(fees.gasFee)).toBe(100_000n);
  });
});
