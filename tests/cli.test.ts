import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../src/cli/commands/init.js";
import { runKeygen } from "../src/cli/commands/keygen.js";
import { runMerchantList, runMerchantAdd, runMerchantCreate } from "../src/cli/commands/merchant.js";
import { c, ok, fail } from "../src/cli/ui.js";

// die() in ui.ts calls process.exit(1); make it throw so we can assert on it
const EXIT = "process.exit:";

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`${EXIT}${code ?? 0}`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logged.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("init", () => {
  let prevCwd: string;
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "arb402-cli-"));
    envPath = join(dir, ".env");
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a .env from the template", () => {
    runInit({});
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toContain("NETWORK=");
  });

  it("refuses to overwrite an existing .env without --force", () => {
    writeFileSync(envPath, "EXISTING=1");
    expect(() => runInit({})).toThrow(`${EXIT}1`);
    // the original file is left untouched
    expect(readFileSync(envPath, "utf8")).toBe("EXISTING=1");
  });

  it("overwrites with --force", () => {
    writeFileSync(envPath, "EXISTING=1");
    runInit({ force: true });
    const contents = readFileSync(envPath, "utf8");
    expect(contents).not.toBe("EXISTING=1");
    expect(contents).toContain("NETWORK=");
  });

  it("applies --network to the NETWORK line", () => {
    runInit({ network: "arbitrum" });
    expect(readFileSync(envPath, "utf8")).toMatch(/^NETWORK=arbitrum$/m);
  });

  it("accepts a CAIP-2 network id", () => {
    runInit({ network: "eip155:42161" });
    expect(readFileSync(envPath, "utf8")).toMatch(/^NETWORK=eip155:42161$/m);
  });

  it("lowercases and trims the network", () => {
    runInit({ network: "  ARBITRUM-SEPOLIA  " });
    expect(readFileSync(envPath, "utf8")).toMatch(/^NETWORK=arbitrum-sepolia$/m);
  });

  it("rejects an unsupported network and writes nothing", () => {
    expect(() => runInit({ network: "base-sepolia" })).toThrow(`${EXIT}1`);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe("keygen", () => {
  it("prints a prefixed API key and a bcrypt hash", async () => {
    await runKeygen({});
    const out = logged.join("\n");
    // new format: <16 hex>.<48 hex>
    expect(out).toMatch(/[0-9a-f]{16}\.[0-9a-f]{48}/);
    expect(out).toMatch(/\$2[aby]\$\d{2}\$/);
  });

  it("--admin references ADMIN_API_KEY_HASH", async () => {
    await runKeygen({ admin: true });
    expect(logged.join("\n")).toContain("ADMIN_API_KEY_HASH");
  });
});

describe("merchant", () => {
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("requires DATABASE_URL", async () => {
    await expect(runMerchantList()).rejects.toThrow(`${EXIT}1`);
    expect(logged.join("\n")).toContain("DATABASE_URL");
  });

  it("rejects a malformed address before touching the database", async () => {
    await expect(runMerchantAdd("0xnotanaddress", "acme", "keyid", "hash")).rejects.toThrow(`${EXIT}1`);
    await expect(runMerchantCreate("0xnotanaddress", "acme")).rejects.toThrow(`${EXIT}1`);
    expect(logged.join("\n")).toContain("invalid address");
  });
});

describe("ui", () => {
  it("passes text through unchanged when stdout is not a TTY", () => {
    // tests run without a TTY, so color codes must be suppressed
    expect(c.bold("hello")).toBe("hello");
    expect(c.green("ok")).toBe("ok");
    expect(c.red("no")).toBe("no");
  });

  it("ok() and fail() emit the message", () => {
    ok("started");
    fail("broke");
    const out = logged.join("\n");
    expect(out).toContain("started");
    expect(out).toContain("broke");
  });
});
