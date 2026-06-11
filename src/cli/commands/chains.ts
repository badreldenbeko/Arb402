import { heading, row, c } from "../ui.js";

export async function runChains(): Promise<void> {
  const cfg = await import("../../config.js");

  heading("supported chains");
  for (const nc of cfg.allNetworkConfigs) {
    const active = nc.network === cfg.networkConfig.network;
    const label = active ? `${cfg.toLegacyName(nc.network)} ${c.green("(active)")}` : cfg.toLegacyName(nc.network);
    console.log(`\n  ${c.bold(label)}`);
    row("caip2", nc.network, 10);
    row("chainId", String(nc.chainId), 10);
    row("usdc", nc.usdcAddress, 10);
    row("rpc", nc.rpcUrl, 10);
  }
  console.log();
}
