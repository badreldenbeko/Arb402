import pg from "pg";
import { logger } from "./logging.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * The single trigger for arb402 overriding pg's own TLS resolution.
 *
 * `getPool()` acts on this; `sslStatus()` reports on it. They must read the same
 * function — a diagnostic that re-derives the condition can silently stop
 * describing what the pool actually did.
 *
 * Note the asymmetry with `ssl: undefined`: undefined does not mean "no TLS", it
 * means "pg decides", from `PGSSLMODE` and the connection string's `sslmode`.
 * So this flag only ever *downgrades* — it forces unverified TLS over whatever
 * would otherwise have been negotiated, including a verified connection.
 */
export function forcesUnverifiedTls(): boolean {
  return process.env.PGSSL === "true";
}

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      ssl: forcesUnverifiedTls() ? { rejectUnauthorized: false } : undefined,
    });

    pool.on("error", (err) => {
      logger.error("unexpected pool error", { error: err.message });
    });
  }
  return pool;
}

export async function query(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return getPool().query(text, values);
}

export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<void> {
  const res = await getPool().query("SELECT NOW()");
  logger.info("database connected", { time: res.rows[0].now });
}

export interface SslStatus {
  /** Whether the server sees this connection as encrypted. Server-side truth. */
  encrypted: boolean;
  version: string | null;
  cipher: string | null;
  /**
   * True when `PGSSL=true` made us pass `rejectUnauthorized: false`, which means
   * the server certificate was NOT verified. Read from `forcesUnverifiedTls()`,
   * the same predicate the pool uses.
   *
   * When false we passed `ssl: undefined` and pg resolved TLS itself from
   * `PGSSLMODE` / the connection string's `sslmode` — so verification depends on
   * that mode and we deliberately don't guess at it here.
   */
  forcedUnverified: boolean;
}

/**
 * Whether the database connection stays on this machine. Loopback and unix
 * sockets never touch a network, so an unencrypted one is not an exposure —
 * which is what keeps the production TLS gate from breaking sidecar and
 * docker-compose topologies.
 *
 * An unparseable URL is reported as remote: the safe direction to be wrong in.
 */
export function isLocalDatabase(): boolean {
  const url = process.env.DATABASE_URL;
  if (!url) return false;

  try {
    const u = new URL(url);

    // libpq-style unix socket: postgresql:///db?host=/var/run/postgresql
    const socket = u.searchParams.get("host");
    if (socket) return socket.startsWith("/");

    const host = u.hostname;
    if (!host) return true; // no host at all — a local socket
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Ask the server what it actually negotiated. `pg_stat_ssl` is the only
 * trustworthy source: the client's own options say what was requested, not what
 * was agreed. Requires PostgreSQL 9.5+.
 */
export async function sslStatus(): Promise<SslStatus> {
  const res = await query(
    "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
  );
  const row = res.rows[0] as
    | { ssl: boolean; version: string | null; cipher: string | null }
    | undefined;

  return {
    encrypted: row?.ssl === true,
    version: row?.version || null,
    cipher: row?.cipher || null,
    forcedUnverified: forcesUnverifiedTls(),
  };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// run this once on first boot (or via migration tool)
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payments (
  nonce         TEXT PRIMARY KEY,
  user_address  TEXT NOT NULL,
  merchant_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  network       TEXT NOT NULL,
  total_amount  TEXT NOT NULL,
  merchant_amount TEXT,
  fee_amount    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  incoming_tx_hash TEXT,
  outgoing_tx_hash TEXT,
  -- crash-safety: both legs are signed and persisted BEFORE broadcast so recovery
  -- can re-check / re-broadcast the exact same tx (idempotent) rather than
  -- building a new one and risking a double-payment (outgoing) or a zombie row
  -- that can only be polled (incoming).
  incoming_account_nonce BIGINT,
  incoming_raw_tx TEXT,
  outgoing_account_nonce BIGINT,
  outgoing_raw_tx TEXT,
  -- recovery claim marker (set when a worker takes ownership of a row)
  recovery_locked_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrations for existing deployments (no-ops if the columns already exist)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS incoming_account_nonce BIGINT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS incoming_raw_tx TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS outgoing_account_nonce BIGINT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS outgoing_raw_tx TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recovery_locked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS payment_events (
  id            SERIAL PRIMARY KEY,
  nonce         TEXT NOT NULL REFERENCES payments(nonce),
  event_type    TEXT NOT NULL,
  event_data    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchants (
  address       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- key_id is the public prefix of the API key; auth looks the merchant up by it
  -- so only ONE bcrypt.compare runs per request (not one per merchant).
  key_id        TEXT,
  api_key_hash  TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  rate_limit    INTEGER DEFAULT 50,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS key_id TEXT;

-- requirements the facilitator has issued, so settlement can be bound to the
-- server's quoted nonce/amount/deadline (not the client's own reconstruction).
CREATE TABLE IF NOT EXISTS issued_requirements (
  nonce            TEXT PRIMARY KEY,
  amount           TEXT NOT NULL,
  merchant_address TEXT,
  deadline         BIGINT NOT NULL,
  network          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_address);
CREATE INDEX IF NOT EXISTS idx_payment_events_nonce ON payment_events(nonce);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_key_id ON merchants(key_id);
CREATE INDEX IF NOT EXISTS idx_issued_requirements_created ON issued_requirements(created_at);
`;

export async function ensureSchema(): Promise<void> {
  await query(SCHEMA_SQL);
  logger.info("database schema ready");
}
