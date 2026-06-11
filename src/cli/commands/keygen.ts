import { generateApiKey, hashApiKey, apiKeyId } from "../../auth.js";
import { heading, info, warn, c } from "../ui.js";

export interface KeygenOptions {
  admin?: boolean;
}

export async function runKeygen(opts: KeygenOptions): Promise<void> {
  const key = generateApiKey();
  const hash = await hashApiKey(key);

  if (opts.admin) {
    heading("admin key");
    console.log(`\n  ${c.bold("X-Admin-Key")} (use in admin requests, cannot be recovered):`);
    console.log(`  ${c.cyan(key)}\n`);
    console.log(`  set this in .env as ${c.bold("ADMIN_API_KEY_HASH")}:`);
    console.log(`  ${hash}\n`);
    return;
  }

  const keyId = apiKeyId(key)!;
  heading("merchant key");
  console.log(`\n  ${c.bold("API key")} (give to merchant, cannot be recovered):`);
  console.log(`  ${c.cyan(key)}\n`);
  console.log(`  ${c.bold("key id")} ${keyId}`);
  console.log(`  ${c.bold("hash")} (store via "arb402 merchant add <addr> <name> ${keyId} <hash>"):`);
  console.log(`  ${hash}\n`);
  info('tip: "arb402 merchant create <address> <name>" does this in one step');
  warn("the key is shown only once — copy it now");
}
