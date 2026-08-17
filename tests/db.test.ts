import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A fake pg Pool. `rows` is whatever the next query resolves to; setting
 * `throws` makes it reject, which is how a server without pg_stat_ssl (or a
 * role that cannot read it) behaves.
 */
const state: { rows: unknown[]; throws: Error | null } = { rows: [], throws: null };

vi.mock("pg", () => ({
  default: {
    Pool: class {
      async query() {
        if (state.throws) throw state.throws;
        return { rows: state.rows };
      }
      on() {}
      async end() {}
    },
  },
}));

const { sslStatus, isLocalDatabase, forcesUnverifiedTls, closePool } = await import(
  "../src/db.js"
);
const { describeDatabaseTls } = await import("../src/cli/commands/doctor.js");

const ENV = { ...process.env };

beforeEach(() => {
  state.rows = [];
  state.throws = null;
});

afterEach(async () => {
  await closePool();
  process.env = { ...ENV };
});

describe("forcesUnverifiedTls", () => {
  it("triggers only on the exact string 'true'", () => {
    process.env.PGSSL = "true";
    expect(forcesUnverifiedTls()).toBe(true);
  });

  // The strict match is easy to get wrong from the operator's side, and the
  // failure is silent — an ignored value looks identical to an unset one.
  it.each(["1", "TRUE", "True", "yes", "false", ""])("ignores %o", (v) => {
    process.env.PGSSL = v;
    expect(forcesUnverifiedTls()).toBe(false);
  });

  it("is false when unset", () => {
    delete process.env.PGSSL;
    expect(forcesUnverifiedTls()).toBe(false);
  });
});

describe("sslStatus", () => {
  it("reports an encrypted connection with version and cipher", async () => {
    delete process.env.PGSSL;
    state.rows = [{ ssl: true, version: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" }];

    expect(await sslStatus()).toEqual({
      encrypted: true,
      version: "TLSv1.3",
      cipher: "TLS_AES_256_GCM_SHA384",
      forcedUnverified: false,
    });
  });

  it("flags forcedUnverified when PGSSL=true", async () => {
    process.env.PGSSL = "true";
    state.rows = [{ ssl: true, version: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" }];

    expect((await sslStatus()).forcedUnverified).toBe(true);
  });

  it("does not flag forcedUnverified for an ignored PGSSL value", async () => {
    process.env.PGSSL = "1";
    state.rows = [{ ssl: true, version: "TLSv1.3", cipher: null }];

    expect((await sslStatus()).forcedUnverified).toBe(false);
  });

  it("reports an unencrypted connection", async () => {
    state.rows = [{ ssl: false, version: null, cipher: null }];

    expect(await sslStatus()).toMatchObject({
      encrypted: false,
      version: null,
      cipher: null,
    });
  });

  it("treats a missing row as unencrypted rather than throwing", async () => {
    state.rows = [];
    expect((await sslStatus()).encrypted).toBe(false);
  });

  it("propagates a query failure for the caller to classify", async () => {
    state.throws = new Error('relation "pg_stat_ssl" does not exist');
    await expect(sslStatus()).rejects.toThrow("pg_stat_ssl");
  });
});

describe("isLocalDatabase", () => {
  const local = [
    "postgresql://u:p@localhost:5432/arb402",
    "postgresql://u:p@127.0.0.1:5432/arb402",
    "postgresql://u:p@[::1]:5432/arb402",
    "postgresql:///arb402?host=/var/run/postgresql",
  ];
  it.each(local)("treats %s as local", (url) => {
    process.env.DATABASE_URL = url;
    expect(isLocalDatabase()).toBe(true);
  });

  const remote = [
    "postgresql://u:p@db.example.com:5432/arb402",
    "postgresql://u:p@10.0.0.5:5432/arb402",
    "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/arb402?sslmode=verify-full",
  ];
  it.each(remote)("treats %s as remote", (url) => {
    process.env.DATABASE_URL = url;
    expect(isLocalDatabase()).toBe(false);
  });

  it("treats an unparseable URL as remote, failing safe", () => {
    process.env.DATABASE_URL = "not a url";
    expect(isLocalDatabase()).toBe(false);
  });

  it("is false when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    expect(isLocalDatabase()).toBe(false);
  });
});

describe("describeDatabaseTls", () => {
  const status = (over: Partial<Awaited<ReturnType<typeof sslStatus>>> = {}) => ({
    encrypted: true,
    version: "TLSv1.3",
    cipher: "TLS_AES_256_GCM_SHA384",
    forcedUnverified: false,
    ...over,
  });
  const env = (over: Partial<Parameters<typeof describeDatabaseTls>[1]> = {}) => ({
    production: false,
    localDatabase: false,
    pgsslRaw: undefined,
    ...over,
  });

  it("passes when encrypted and verification was left to pg", async () => {
    const v = await describeDatabaseTls(async () => status(), env());
    expect(v.result).toBe(true);
    expect(v.notes.map((n) => n.text)).toEqual([
      "encrypted (TLSv1.3, TLS_AES_256_GCM_SHA384)",
    ]);
  });

  it("warns, not passes, when PGSSL=true skipped certificate verification", async () => {
    const v = await describeDatabaseTls(
      async () => status({ forcedUnverified: true }),
      env({ pgsslRaw: "true" })
    );
    expect(v.result).toBeNull();
    expect(v.notes.some((n) => n.text.includes("NOT verified"))).toBe(true);
  });

  it("warns when unencrypted outside production", async () => {
    const v = await describeDatabaseTls(async () => status({ encrypted: false }), env());
    expect(v.result).toBeNull();
    expect(v.notes.some((n) => n.text.includes("NOT encrypted"))).toBe(true);
  });

  // The escalation that makes `doctor` usable as a deploy gate: a remote,
  // cleartext database in production is a hard failure, not advice.
  it("hard-fails when unencrypted, remote, and in production", async () => {
    const v = await describeDatabaseTls(
      async () => status({ encrypted: false }),
      env({ production: true, localDatabase: false })
    );
    expect(v.result).toBe(false);
    expect(v.notes.some((n) => n.text.includes("sslmode=verify-full"))).toBe(true);
  });

  // A private address is not globally routable, which is not the same as
  // trusted. The gate exempts loopback and unix sockets only, so the remedy
  // text must not send operators down a route that still fails.
  it("does not offer a private network as a remedy", async () => {
    const v = await describeDatabaseTls(
      async () => status({ encrypted: false }),
      env({ production: true, localDatabase: false })
    );
    expect(v.notes.some((n) => /private network path/.test(n.text))).toBe(false);
  });

  // ...but a private/loopback topology is legitimate and must not be broken.
  it("only warns when unencrypted in production over a local connection", async () => {
    const v = await describeDatabaseTls(
      async () => status({ encrypted: false }),
      env({ production: true, localDatabase: true })
    );
    expect(v.result).toBeNull();
  });

  it("calls out a PGSSL value that was silently ignored", async () => {
    const v = await describeDatabaseTls(
      async () => status({ encrypted: false }),
      env({ pgsslRaw: "1" })
    );
    expect(v.notes.some((n) => n.text.includes('not the exact string "true"'))).toBe(true);
  });

  it("degrades to a warning when pg_stat_ssl cannot be read", async () => {
    const v = await describeDatabaseTls(async () => {
      throw new Error('relation "pg_stat_ssl" does not exist');
    }, env({ production: true }));

    expect(v.result).toBeNull();
    expect(v.notes[0].text).toContain("TLS state unknown");
  });

  it("omits the detail parentheses when version and cipher are absent", async () => {
    const v = await describeDatabaseTls(
      async () => status({ version: null, cipher: null }),
      env()
    );
    expect(v.notes[0].text).toBe("encrypted");
  });
});
