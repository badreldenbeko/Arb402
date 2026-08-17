import { heading, row, info, c } from "../ui.js";

const FAMILY_LABEL: Record<string, string> = {
  "arbitrum-one": "Arbitrum One",
  nova: "Arbitrum Nova",
  orbit: "Orbit (L3)",
  testnet: "testnet",
};

export interface ChainsOptions {
  /** Probe each chain's token on-chain instead of trusting the registry. */
  verify?: boolean;
}

export async function runChains(opts: ChainsOptions = {}): Promise<void> {
  const cfg = await import("../../config.js");

  heading("supported chains");

  for (const nc of cfg.allNetworkConfigs) {
    const active = nc.network === cfg.networkConfig.network;
    const label = active
      ? `${nc.displayName} ${c.green("(active)")}`
      : nc.displayName;
    console.log(`\n  ${c.bold(label)}`);
    row("caip2", nc.network, 10);
    row("chainId", String(nc.chainId), 10);
    row("family", FAMILY_LABEL[nc.family] ?? nc.family, 10);
    row("alias", nc.definition.legacyName, 10);
    row("rpc", nc.rpcUrl, 10);

    if (nc.tokenConfigured) {
      row("token", nc.usdcAddress, 10);
      row("domain", `name="${nc.tokenName}" version="${nc.tokenVersion}"`, 10);
    } else {
      // Nova's bridged USDC.e is a plain gateway ERC-20 — no EIP-3009 — so
      // there is no honest default to ship. Say so instead of guessing.
      row("token", c.yellow("none configured (set USDC_ADDRESS)"), 10);
    }

    if (nc.definition.source === "orbit-config") {
      row("source", c.cyan("arb402.chains.json"), 10);
    }

    if (opts.verify) await verifyChain(nc, active);
  }

  console.log();
  const orbitCount = cfg.allNetworkConfigs.filter(
    (n) => n.family === "orbit"
  ).length;
  if (orbitCount === 0) {
    info(
      `add Orbit chains by creating ${c.bold("arb402.chains.json")} — see arb402.chains.example.json`
    );
  }
  if (!opts.verify) {
    info(`re-run with ${c.bold("--verify")} to check each token on-chain`);
  }
}

/**
 * Probe one chain's token over its own RPC. The registry records what a token
 * *should* be; this reports what it actually is.
 */
async function verifyChain(
  nc: { rpcUrl: string; chain: any; usdcAddress: `0x${string}`; chainId: number; tokenName: string; tokenVersion: string; tokenDecimals: number; tokenConfigured: boolean },
  active: boolean
): Promise<void> {
  if (!nc.tokenConfigured) {
    row("verify", c.yellow("skipped — no token configured"), 10);
    return;
  }
  try {
    const { createPublicClient, http } = await import("viem");
    const { probeToken } = await import("../../tokenProbe.js");

    // the active chain reuses the shared client; others get a throwaway one
    const client = active
      ? (await import("../../settle.js")).getPublicClient()
      : createPublicClient({ chain: nc.chain, transport: http(nc.rpcUrl) });

    const probe = await probeToken(client as any, {
      address: nc.usdcAddress,
      chainId: nc.chainId,
      tokenName: nc.tokenName,
      tokenVersion: nc.tokenVersion,
      expectedDecimals: nc.tokenDecimals,
    });

    if (probe.problems.length === 0) {
      const domain =
        probe.domainMatches === true ? "domain ok" : "domain unverified";
      row("verify", c.green(`EIP-3009 ok, ${domain}`), 10);
    } else {
      row("verify", c.red("failed"), 10);
      for (const p of probe.problems) console.log(`             ${c.red("-")} ${p}`);
    }
    for (const w of probe.warnings) console.log(`             ${c.yellow("-")} ${w}`);
  } catch (err: any) {
    row("verify", c.yellow(`unreachable — ${err.shortMessage ?? err.message}`), 10);
  }
}
