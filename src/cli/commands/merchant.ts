import { ok, fail, die, warn, info, heading, c } from "../ui.js";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// every merchant command needs persistence; fail clearly if it's missing
async function requireDb(): Promise<void> {
  const db = await import("../../db.js");
  if (!db.isDatabaseConfigured()) {
    die("merchant commands require DATABASE_URL (merchants are persisted in Postgres)");
  }
}

export async function runMerchantList(): Promise<void> {
  await requireDb();
  const { getAllMerchants } = await import("../../merchantStore.js");
  const merchants = await getAllMerchants();
  if (merchants.length === 0) {
    info("no merchants registered");
    return;
  }
  heading(`merchants (${merchants.length})`);
  for (const m of merchants) {
    const status = m.enabled ? c.green("enabled") : c.yellow("disabled");
    console.log(`  ${m.address}  ${m.name}  [${status}]`);
  }
}

export async function runMerchantAdd(
  address: string,
  name: string,
  keyId: string,
  apiKeyHash: string
): Promise<void> {
  if (!ADDR_RE.test(address)) die("invalid address (expected 0x + 40 hex chars)");
  await requireDb();
  const { addMerchant } = await import("../../merchantStore.js");
  await addMerchant(address, name, apiKeyHash, keyId);
  ok(`added merchant ${c.bold(name)} (${address})`);
}

// convenience: generate a key, hash it, persist, and print the key once
export async function runMerchantCreate(address: string, name: string): Promise<void> {
  if (!ADDR_RE.test(address)) die("invalid address (expected 0x + 40 hex chars)");
  await requireDb();
  const { generateApiKey, hashApiKey, apiKeyId } = await import("../../auth.js");
  const { addMerchant } = await import("../../merchantStore.js");

  const key = generateApiKey();
  const keyId = apiKeyId(key)!;
  const hash = await hashApiKey(key);
  await addMerchant(address, name, hash, keyId);

  ok(`created merchant ${c.bold(name)} (${address})`);
  console.log(`  ${c.dim("key id")} ${keyId}`);
  console.log(`\n  ${c.bold("API key")} (give to merchant, shown only once):`);
  console.log(`  ${c.cyan(key)}\n`);
}

export async function runMerchantSetEnabled(address: string, enabled: boolean): Promise<void> {
  await requireDb();
  const { setMerchantEnabled } = await import("../../merchantStore.js");
  await setMerchantEnabled(address, enabled);
  ok(`${enabled ? "enabled" : "disabled"} ${address}`);
}

export async function runMerchantDelete(address: string): Promise<void> {
  await requireDb();
  const { deleteMerchant } = await import("../../merchantStore.js");
  await deleteMerchant(address);
  ok(`deleted ${address}`);
}
