import { heading, row, warn, c } from "../ui.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// USDC has 6 decimals; render a micro-USDC bigint as a human amount
function usdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export async function runConfig(): Promise<void> {
  // lazy import so commands that don't need config avoid its load-time work
  const cfg = await import("../../config.js");
  const { networkConfig: n } = cfg;

  heading("network");
  row("network", `${n.displayName} (${n.network})`);
  row("chainId", String(n.chainId));
  row("family", n.family);
  row("rpcUrl", n.rpcUrl);
  if (n.tokenConfigured) {
    row("token", n.usdcAddress);
    row("tokenDomain", `name="${n.tokenName}" version="${n.tokenVersion}"`);
  } else {
    row("token", c.yellow("none configured — set USDC_ADDRESS"));
  }

  heading("facilitator");
  if (cfg.FACILITATOR_ADDRESS === ZERO_ADDR) {
    row("address", c.yellow("(no private key configured)"));
  } else {
    row("address", cfg.FACILITATOR_ADDRESS);
  }
  row("port", String(cfg.PORT));

  heading("fees");
  row("serviceFeeBps", `${cfg.SERVICE_FEE_BPS} (${cfg.SERVICE_FEE_BPS / 100}%)`);
  row("gasFeeUsdc", `${usdc(cfg.GAS_FEE_USDC)} USDC`);
  row("maxSettlement", `${usdc(cfg.MAX_SETTLEMENT_AMOUNT)} USDC`);

  heading("persistence");
  const db = await import("../../db.js");
  row("database", db.isDatabaseConfigured() ? c.green("configured") : c.yellow("in-memory (dev)"));
  row("adminKey", process.env.ADMIN_API_KEY_HASH ? c.green("set") : c.yellow("unset"));

  console.log();
  if (cfg.FACILITATOR_ADDRESS === ZERO_ADDR) {
    warn("settlement is disabled until EVM_PRIVATE_KEY is set");
  }
  if (!n.tokenConfigured) {
    warn(
      `settlement is disabled until USDC_ADDRESS points at an EIP-3009 token on ${n.displayName}`
    );
  }
}
