import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, warn, info, die, c } from "../ui.js";

// package root, resolved the same way from src (tsx) and dist (node)
const PKG_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// must match the aliases accepted by config.ts (Nova/Orbit arrive with M7)
const SUPPORTED = ["arbitrum", "arbitrum-one", "arbitrum-sepolia"];

export interface InitOptions {
  network?: string;
  force?: boolean;
}

export function runInit(opts: InitOptions): void {
  const target = resolve(process.cwd(), ".env");
  const template = resolve(PKG_ROOT, ".env.example");

  if (existsSync(target) && !opts.force) {
    die(".env already exists — pass --force to overwrite");
  }
  if (!existsSync(template)) {
    die(`.env.example not found at ${template}`);
  }

  let contents = readFileSync(template, "utf8");

  if (opts.network) {
    const net = opts.network.toLowerCase().trim();
    if (!SUPPORTED.includes(net) && !net.startsWith("eip155:")) {
      die(
        `unsupported network "${opts.network}" — expected one of ${SUPPORTED.join(
          ", "
        )} or a CAIP-2 id (eip155:<chainId>)`
      );
    }
    contents = contents.replace(/^NETWORK=.*$/m, `NETWORK=${net}`);
  }

  writeFileSync(target, contents);
  ok(`wrote ${c.cyan(".env")}`);

  info("next steps:");
  console.log(`    1. set ${c.bold("EVM_PRIVATE_KEY")} in .env (facilitator wallet)`);
  console.log(`    2. run ${c.bold("arb402 doctor")} to verify configuration`);
  console.log(`    3. run ${c.bold("arb402 dev")} to start the facilitator`);
  warn("never commit .env — it holds your facilitator private key");
}
