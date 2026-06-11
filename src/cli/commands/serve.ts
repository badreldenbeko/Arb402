import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { info, die } from "../ui.js";

const PKG_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// run a command inheriting stdio and forward its exit code
function run(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
    shell: false,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => die(`failed to start: ${err.message}`));
}

// dev: run the TypeScript server directly via tsx (no build needed)
export function runDev(): void {
  const entry = resolve(PKG_ROOT, "src/server.ts");
  if (!existsSync(entry)) die(`server entry not found at ${entry}`);
  info("starting facilitator in dev mode (tsx)…");
  run("npx", ["tsx", entry]);
}

// start: run the compiled server; requires a prior build
export function runStart(): void {
  const entry = resolve(PKG_ROOT, "dist/server.js");
  if (!existsSync(entry)) {
    die("dist/server.js not found — run 'npm run build' first");
  }
  info("starting facilitator…");
  run("node", [entry]);
}
