import { generateApiKey, hashApiKey } from "../src/auth.js";

async function main() {
  const key = generateApiKey();
  const hash = await hashApiKey(key);

  console.log("\n  API Key (give to merchant, cannot be recovered):");
  console.log(`  ${key}\n`);
  console.log("  Hash (store in database):");
  console.log(`  ${hash}\n`);
}

main().catch(console.error);
