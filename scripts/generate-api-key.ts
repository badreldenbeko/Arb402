import { generateApiKey, hashApiKey, apiKeyId } from "../src/auth.js";

async function main() {
  const key = generateApiKey();
  const keyId = apiKeyId(key)!;
  const hash = await hashApiKey(key);

  console.log("\n  API Key (give to merchant, cannot be recovered):");
  console.log(`  ${key}\n`);
  console.log("  Key ID (store in database):");
  console.log(`  ${keyId}\n`);
  console.log("  Hash (store in database):");
  console.log(`  ${hash}\n`);
}

main().catch(console.error);
