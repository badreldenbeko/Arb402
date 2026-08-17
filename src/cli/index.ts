#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import dotenv from "dotenv";
import { fail } from "./ui.js";
import { runInit } from "./commands/init.js";
import { runConfig } from "./commands/config.js";
import { runChains } from "./commands/chains.js";
import { runDoctor } from "./commands/doctor.js";
import { runWallet } from "./commands/wallet.js";
import { runKeygen } from "./commands/keygen.js";
import { runDev, runStart } from "./commands/serve.js";
import {
  runMerchantList,
  runMerchantAdd,
  runMerchantCreate,
  runMerchantSetEnabled,
  runMerchantDelete,
} from "./commands/merchant.js";

// load .env before any command touches the chain registry, so ARB402_CHAINS_FILE
// and the RPC overrides are visible even to commands that never import config.ts
dotenv.config();

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

// wrap async actions so any thrown error prints cleanly and exits non-zero
function action<A extends unknown[]>(fn: (...args: A) => unknown | Promise<unknown>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err: any) {
      fail(err?.message ?? String(err));
      process.exit(1);
    }
  };
}

const program = new Command();

program
  .name("arb402")
  .description("HTTP 402 payment facilitator toolkit for Arbitrum")
  .version(pkg.version, "-v, --version");

program
  .command("init")
  .description("scaffold a .env configuration in the current directory")
  .option("--network <id>", "target network (arbitrum, arbitrum-sepolia, or eip155:<id>)")
  .option("-f, --force", "overwrite an existing .env")
  .action(action((opts) => runInit(opts)));

program
  .command("config")
  .description("print the resolved facilitator configuration")
  .action(action(runConfig));

program
  .command("chains")
  .description("list supported chains (One, Nova, Orbit) and their token/RPC settings")
  .option("--verify", "probe each chain's token on-chain for EIP-3009 support")
  .action(action((opts) => runChains(opts)));

program
  .command("doctor")
  .description(
    "run deployment-readiness checks (env, RPC, settlement token, database)"
  )
  .action(action(runDoctor));

program
  .command("wallet")
  .description("show the facilitator wallet address and on-chain balances")
  .action(action(runWallet));

program
  .command("keygen")
  .description("generate an API key + bcrypt hash")
  .option("--admin", "generate an admin key (for ADMIN_API_KEY_HASH)")
  .action(action((opts) => runKeygen(opts)));

program
  .command("dev")
  .description("run the facilitator in development mode (tsx, no build)")
  .action(action(runDev));

program
  .command("start")
  .description("run the compiled facilitator (requires 'npm run build')")
  .action(action(runStart));

const merchant = program
  .command("merchant")
  .description("manage merchants (requires DATABASE_URL)");

merchant
  .command("list")
  .description("list registered merchants")
  .action(action(runMerchantList));

merchant
  .command("add <address> <name> <keyId> <apiKeyHash>")
  .description("register a merchant with a precomputed key id + hash")
  .action(action((address: string, name: string, keyId: string, hash: string) => runMerchantAdd(address, name, keyId, hash)));

merchant
  .command("create <address> <name>")
  .description("generate a key, register the merchant, and print the key once")
  .action(action((address: string, name: string) => runMerchantCreate(address, name)));

merchant
  .command("enable <address>")
  .description("enable a merchant")
  .action(action((address: string) => runMerchantSetEnabled(address, true)));

merchant
  .command("disable <address>")
  .description("disable a merchant")
  .action(action((address: string) => runMerchantSetEnabled(address, false)));

merchant
  .command("delete <address>")
  .description("remove a merchant")
  .action(action((address: string) => runMerchantDelete(address)));

program.parseAsync(process.argv);
