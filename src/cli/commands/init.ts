import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNetworkAlias, getChain, knownNetworkNames } from "../../chains.js";
import { ok, warn, info, die, c } from "../ui.js";

// package root, resolved the same way from src (tsx) and dist (node)
const PKG_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
  let tokenWarning: string | undefined;

  if (opts.network) {
    // resolved against the live registry, so One, Nova, and any Orbit chain in
    // arb402.chains.json are all accepted by the same path
    const id = resolveNetworkAlias(opts.network);
    if (!id) {
      die(
        `unsupported network "${opts.network}"\n` +
          `  known networks: ${knownNetworkNames().join(", ")}\n` +
          `  Orbit chains: add them to arb402.chains.json (see arb402.chains.example.json)`
      );
    }
    const def = getChain(id)!;
    // echo back the form the user asked for: a CAIP-2 id stays CAIP-2, an
    // alias is canonicalised to the chain's slug
    const written = /^eip155:\d+$/i.test(opts.network.trim())
      ? def.id
      : def.legacyName;
    contents = contents.replace(/^NETWORK=.*$/m, `NETWORK=${written}`);

    if (!def.token) {
      // Nova is the live case: no bridged token on it implements EIP-3009, so
      // the operator must supply one before anything can settle.
      tokenWarning =
        `${def.displayName} has no default settlement token — set ` +
        `${c.bold("USDC_ADDRESS")} to an EIP-3009-capable token in .env`;
    }
  }

  writeFileSync(target, contents);
  ok(`wrote ${c.cyan(".env")}`);

  info("next steps:");
  console.log(`    1. set ${c.bold("EVM_PRIVATE_KEY")} in .env (facilitator wallet)`);
  if (tokenWarning) {
    console.log(`    2. set ${c.bold("USDC_ADDRESS")} (see below)`);
    console.log(`    3. run ${c.bold("arb402 doctor")} to verify configuration`);
    console.log(`    4. run ${c.bold("arb402 dev")} to start the facilitator`);
  } else {
    console.log(`    2. run ${c.bold("arb402 doctor")} to verify configuration`);
    console.log(`    3. run ${c.bold("arb402 dev")} to start the facilitator`);
  }

  if (tokenWarning) warn(tokenWarning);
  warn("never commit .env — it holds your facilitator private key");
}
