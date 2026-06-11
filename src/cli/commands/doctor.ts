import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi } from "viem";
import { ok, warn, fail, heading } from "../ui.js";

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// each check returns true (pass), false (hard fail), or null (warning only)
type CheckResult = boolean | null;

async function check(label: string, fn: () => Promise<CheckResult> | CheckResult): Promise<boolean> {
  try {
    const res = await fn();
    if (res === true) ok(label);
    else if (res === null) warn(label);
    else fail(label);
    return res !== false;
  } catch (err: any) {
    fail(`${label} — ${err.message}`);
    return false;
  }
}

export async function runDoctor(): Promise<void> {
  heading("arb402 doctor");
  let hardFail = false;
  const track = (passed: boolean) => {
    if (!passed) hardFail = true;
  };

  track(
    await check(`node >= 20 (found ${process.versions.node})`, () => {
      const major = parseInt(process.versions.node.split(".")[0], 10);
      return major >= 20;
    })
  );

  await check(".env present in working directory", () =>
    existsSync(resolve(process.cwd(), ".env")) ? true : null
  );

  const cfg = await import("../../config.js");

  track(
    await check("EVM_PRIVATE_KEY configured", () =>
      cfg.FACILITATOR_ADDRESS !== ZERO_ADDR
    )
  );

  track(
    await check(`RPC reachable & chainId == ${cfg.networkConfig.chainId}`, async () => {
      const { getPublicClient } = await import("../../settle.js");
      const chainId = await getPublicClient().getChainId();
      if (chainId !== cfg.networkConfig.chainId) {
        throw new Error(`RPC returned chainId ${chainId}`);
      }
      return true;
    })
  );

  track(
    await check(`USDC contract has 6 decimals (${cfg.networkConfig.usdcAddress})`, async () => {
      const { getPublicClient } = await import("../../settle.js");
      const decimals = await getPublicClient().readContract({
        address: cfg.networkConfig.usdcAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      if (Number(decimals) !== 6) throw new Error(`got ${decimals} decimals`);
      return true;
    })
  );

  const db = await import("../../db.js");
  if (db.isDatabaseConfigured()) {
    track(
      await check("database reachable", async () => {
        await db.testConnection();
        return true;
      })
    );
  } else {
    await check("database (in-memory dev mode — nonces lost on restart)", () => null);
  }

  await check("ADMIN_API_KEY_HASH set (required for /admin endpoints)", () =>
    process.env.ADMIN_API_KEY_HASH ? true : null
  );

  console.log();
  if (hardFail) {
    fail("doctor found blocking issues — see above");
    process.exit(1);
  }
  ok("all critical checks passed");
  // db pool may keep the event loop alive; exit cleanly
  if (db.isDatabaseConfigured()) await db.closePool();
}
