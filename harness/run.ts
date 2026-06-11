import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAddresses } from "./lib/testusdc.js";
import { waitForFacilitator } from "./lib/facilitator.js";
import {
  ACCOUNTS,
  RPC_URL,
  DEV_MERCHANT_API_KEY_HASH,
} from "./lib/accounts.js";
import { runPayment, runConcurrent } from "./scripts/settle-once.js";
import { APP_SCENARIOS } from "./scenarios.js";

const HARNESS_DIR = fileURLToPath(new URL("./", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const VERBOSE = !!process.env.VERBOSE;

const children: ChildProcess[] = [];

function cleanup(): void {
  for (const c of children) {
    if (!c.killed) c.kill("SIGINT");
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function step(msg: string): void {
  console.log(`\n▶ ${msg}`);
}

// run a command to completion; reject on non-zero exit
function exec(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: VERBOSE ? "inherit" : ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    );
  });
}

// start a long-running process, capturing output so we can dump it on failure
function start(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): { child: ChildProcess; logs: () => string } {
  const buf: string[] = [];
  const child = spawn(cmd, args, { cwd, env: env ?? process.env });
  children.push(child);
  const capture = (d: Buffer) => {
    const s = d.toString();
    buf.push(s);
    if (VERBOSE) process.stderr.write(s);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => buf.join("") };
}

async function pollRpc(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body: any = await res.json();
      if (body.result) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`hardhat node RPC not ready within ${timeoutMs}ms`);
}

async function main() {
  step("compiling TestUSDC");
  await exec("npx", ["hardhat", "compile"], HARNESS_DIR);

  step("starting local hardhat node (chainId 421614)");
  const node = start("npx", ["hardhat", "node"], HARNESS_DIR);
  let nodeExited = false;
  node.child.on("exit", () => (nodeExited = true));
  await pollRpc();
  if (nodeExited) throw new Error(`hardhat node exited early:\n${node.logs()}`);

  step("deploying TestUSDC + minting to payer");
  await exec("npx", ["tsx", "scripts/deploy.ts"], HARNESS_DIR);
  const addresses = readAddresses();

  step("starting arb402 facilitator (in-memory, dev merchant)");
  const facilitatorEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NETWORK: "arbitrum-sepolia",
    ARBITRUM_SEPOLIA_RPC_URL: RPC_URL,
    USDC_ADDRESS: addresses.usdc,
    EVM_PRIVATE_KEY: ACCOUNTS.facilitator.privateKey,
    DEV_MERCHANT_API_KEY_HASH,
    DEV_MERCHANT_ADDRESS: ACCOUNTS.merchant.address,
    PORT: "3002",
  };
  delete facilitatorEnv.DATABASE_URL; // force in-memory mode
  const facilitator = start("npx", ["tsx", "src/server.ts"], ROOT_DIR, facilitatorEnv);
  let facExited = false;
  facilitator.child.on("exit", () => (facExited = true));

  try {
    await waitForFacilitator("http://127.0.0.1:3002");
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- facilitator logs ---\n${facilitator.logs()}`);
  }
  if (facExited) throw new Error(`facilitator exited early:\n${facilitator.logs()}`);

  step(`running reproducible on-chain payments for ${APP_SCENARIOS.length} applications`);
  for (const scenario of APP_SCENARIOS) {
    await runPayment(scenario);
  }

  step("running 6 concurrent settlements (wallet-nonce collision regression)");
  await runConcurrent("1000000", 6);

  console.log(
    `\n✓ harness passed — ${APP_SCENARIOS.length} applications settled reproducibly on-chain\n`
  );
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n✗ harness failed: ${err.message}\n`);
    cleanup();
    process.exit(1);
  });
