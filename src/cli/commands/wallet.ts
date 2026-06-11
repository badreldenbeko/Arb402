import { heading, row, warn, die, c } from "../ui.js";
import { formatUnits } from "viem";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function runWallet(): Promise<void> {
  const cfg = await import("../../config.js");
  if (cfg.FACILITATOR_ADDRESS === ZERO_ADDR) {
    die("no EVM_PRIVATE_KEY configured — run 'arb402 init' then set it in .env");
  }

  const { getFacilitatorBalance } = await import("../../settle.js");
  const { usdc, eth } = await getFacilitatorBalance();

  heading("facilitator wallet");
  row("address", cfg.FACILITATOR_ADDRESS);
  row("network", cfg.toLegacyName(cfg.networkConfig.network));
  row("ETH", `${formatUnits(BigInt(eth), 18)}`);
  row("USDC", `${formatUnits(BigInt(usdc), 6)}`);
  console.log();

  if (BigInt(eth) === 0n) {
    warn("zero ETH balance — the facilitator cannot pay gas to settle payments");
  } else {
    console.log(c.dim("  ETH is used for gas; USDC accrues from service fees"));
  }
}
