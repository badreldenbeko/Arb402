import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ok, warn, fail, heading, c } from "../ui.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// each check returns true (pass), false (hard fail), or null (warning only)
type CheckResult = boolean | null;

async function check(label: string, fn: () => Promise<CheckResult> | CheckResult): Promise<boolean> {
  try {
    const res = await fn();
    if (res === true) ok(label);
    else if (res === null) warn(label);
    else fail(label);
    return res !== false;
  } catch (err: any) {
    fail(`${label} — ${err.message}`);
    return false;
  }
}

export interface TlsNote {
  level: "info" | "warn";
  text: string;
}

export interface TlsVerdict {
  result: CheckResult;
  notes: TlsNote[];
}

/**
 * Decide what `doctor` should say about the database connection's TLS.
 *
 * Split out from `runDoctor` so it can be tested without standing up a config,
 * an RPC, and a database. `read` is `db.sslStatus` in production use.
 *
 * Unencrypted is a warning by default — Postgres over loopback or a private
 * network is a legitimate topology — but a hard failure when
 * `NODE_ENV=production` and the host is remote, matching how the codebase
 * already escalates `DATABASE_URL` from optional to mandatory in production.
 */
export async function describeDatabaseTls(
  read: () => Promise<import("../../db.js").SslStatus>,
  env: { production: boolean; localDatabase: boolean; pgsslRaw: string | undefined }
): Promise<TlsVerdict> {
  let s: Awaited<ReturnType<typeof read>>;
  try {
    s = await read();
  } catch {
    // pg_stat_ssl unavailable: PostgreSQL < 9.5, or a role without access.
    return {
      result: null,
      notes: [{ level: "warn", text: "could not read pg_stat_ssl; TLS state unknown" }],
    };
  }

  const notes: TlsNote[] = [];

  // A value that isn't exactly "true" is ignored outright, which is invisible
  // unless we say so — the operator believes they enabled something.
  if (env.pgsslRaw !== undefined && env.pgsslRaw !== "" && env.pgsslRaw !== "true") {
    notes.push({
      level: "warn",
      text: `PGSSL="${env.pgsslRaw}" is not the exact string "true", so it was ignored`,
    });
  }

  if (!s.encrypted) {
    notes.push({ level: "warn", text: "connection is NOT encrypted" });

    if (env.production && !env.localDatabase) {
      notes.push({
        level: "warn",
        text:
          "NODE_ENV=production with a remote, unencrypted database — " +
          "add ?sslmode=verify-full to DATABASE_URL (a private network address is not " +
          "sufficient; only loopback and unix sockets are exempt)",
      });
      return { result: false, notes };
    }
    return { result: null, notes };
  }

  const detail = [s.version, s.cipher].filter(Boolean).join(", ");
  notes.push({ level: "info", text: `encrypted${detail ? ` (${detail})` : ""}` });

  if (s.forcedUnverified) {
    notes.push({
      level: "warn",
      text:
        "PGSSL=true set rejectUnauthorized: false — the server certificate was NOT verified. " +
        "Unset PGSSL and use sslmode=verify-full in DATABASE_URL for verified TLS.",
    });
    return { result: null, notes };
  }

  return { result: true, notes };
}

export async function runDoctor(): Promise<void> {
  heading("arb402 doctor");
  let hardFail = false;
  const track = (passed: boolean) => {
    if (!passed) hardFail = true;
  };

  track(
    await check(`node >= 20 (found ${process.versions.node})`, () => {
      const major = parseInt(process.versions.node.split(".")[0], 10);
      return major >= 20;
    })
  );

  await check(".env present in working directory", () =>
    existsSync(resolve(process.cwd(), ".env")) ? true : null
  );

  const cfg = await import("../../config.js");

  track(
    await check("EVM_PRIVATE_KEY configured", () =>
      cfg.FACILITATOR_ADDRESS !== ZERO_ADDR
    )
  );

  const n = cfg.networkConfig;
  console.log(`  ${c.dim("network")} ${n.displayName} (${n.network}, ${n.family})`);

  track(
    await check(`RPC reachable & chainId == ${n.chainId}`, async () => {
      const { getPublicClient } = await import("../../settle.js");
      const chainId = await getPublicClient().getChainId();
      if (chainId !== n.chainId) {
        throw new Error(`RPC returned chainId ${chainId}`);
      }
      return true;
    })
  );

  // A chain can be registered with no settlement token — Arbitrum Nova ships
  // that way, because its bridged USDC.e has no EIP-3009. Report it as the
  // blocking configuration gap it is, rather than probing a zero address.
  if (!n.tokenConfigured) {
    track(
      await check(
        `settlement token configured — ${n.displayName} has no EIP-3009 default; ` +
          `set USDC_ADDRESS (plus USDC_NAME / USDC_VERSION if its domain differs)`,
        () => false
      )
    );
  } else {
    // one probe, several verdicts: contract exists, implements EIP-3009,
    // has the right decimals, and its EIP-712 domain matches the config
    const { getPublicClient } = await import("../../settle.js");
    const { probeToken } = await import("../../tokenProbe.js");

    let probe: Awaited<ReturnType<typeof probeToken>> | undefined;
    track(
      await check(`settlement token reachable (${n.usdcAddress})`, async () => {
        probe = await probeToken(getPublicClient(), {
          address: n.usdcAddress,
          chainId: n.chainId,
          tokenName: n.tokenName,
          tokenVersion: n.tokenVersion,
          expectedDecimals: n.tokenDecimals,
        });
        return true;
      })
    );

    if (probe) {
      const p = probe;
      track(
        await check(
          `token implements EIP-3009 (transferWithAuthorization)`,
          () => p.supportsEip3009
        )
      );
      track(
        await check(
          `token has ${n.tokenDecimals} decimals${p.symbol ? ` (${p.symbol})` : ""}`,
          () => p.decimals === n.tokenDecimals
        )
      );
      track(
        await check(
          `EIP-712 domain matches name="${n.tokenName}" version="${n.tokenVersion}"`,
          // undefined = the token exposes no DOMAIN_SEPARATOR, so this cannot
          // be proven either way — a warning, not a failure
          () => (p.domainMatches === undefined ? null : p.domainMatches)
        )
      );
      for (const problem of p.problems) console.log(`    ${c.red("→")} ${problem}`);
      for (const w of p.warnings) console.log(`    ${c.yellow("→")} ${w}`);
    }
  }

  const db = await import("../../db.js");
  if (db.isDatabaseConfigured()) {
    const reachable = await check("database reachable", async () => {
      await db.testConnection();
      return true;
    });
    track(reachable);

    // Report what the server actually negotiated, not what we asked for. An
    // operator who sets PGSSL and sees only "database reachable" will read the
    // green tick as confirmation that TLS is on — so state it explicitly.
    if (reachable) {
      track(
        await check("database TLS", async () => {
          const verdict = await describeDatabaseTls(() => db.sslStatus(), {
            production: process.env.NODE_ENV === "production",
            localDatabase: db.isLocalDatabase(),
            pgsslRaw: process.env.PGSSL,
          });
          for (const n of verdict.notes) {
            console.log(`    ${n.level === "warn" ? c.yellow("→") : c.dim("→")} ${n.text}`);
          }
          return verdict.result;
        })
      );
    }
  } else {
    await check("database (in-memory dev mode — nonces lost on restart)", () => null);
  }

  await check("ADMIN_API_KEY_HASH set (required for /admin endpoints)", () =>
    process.env.ADMIN_API_KEY_HASH ? true : null
  );

  console.log();
  if (hardFail) {
    fail("doctor found blocking issues — see above");
    process.exit(1);
  }
  ok("all critical checks passed");
  // db pool may keep the event loop alive; exit cleanly
  if (db.isDatabaseConfigured()) await db.closePool();
}
