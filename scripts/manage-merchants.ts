import dotenv from "dotenv";
dotenv.config();

import {
  getAllMerchants,
  addMerchant,
  setMerchantEnabled,
  deleteMerchant,
} from "../src/merchantStore.js";

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "list": {
      const merchants = await getAllMerchants();
      if (merchants.length === 0) {
        console.log("  no merchants registered");
        return;
      }
      for (const m of merchants) {
        const status = m.enabled ? "enabled" : "disabled";
        console.log(`  ${m.address}  ${m.name}  [${status}]`);
      }
      break;
    }

    case "add": {
      const [address, name, apiKeyHash] = args;
      if (!address || !name || !apiKeyHash) {
        console.log("  usage: merchants add <address> <name> <apiKeyHash>");
        process.exit(1);
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.log("  error: invalid address format (expected 0x + 40 hex chars)");
        process.exit(1);
      }
      await addMerchant(address, name, apiKeyHash);
      console.log(`  added merchant ${name} (${address})`);
      break;
    }

    case "enable": {
      const [addr] = args;
      if (!addr) {
        console.log("  usage: merchants enable <address>");
        process.exit(1);
      }
      await setMerchantEnabled(addr, true);
      console.log(`  enabled ${addr}`);
      break;
    }

    case "disable": {
      const [addr2] = args;
      if (!addr2) {
        console.log("  usage: merchants disable <address>");
        process.exit(1);
      }
      await setMerchantEnabled(addr2, false);
      console.log(`  disabled ${addr2}`);
      break;
    }

    case "delete": {
      const [addr3] = args;
      if (!addr3) {
        console.log("  usage: merchants delete <address>");
        process.exit(1);
      }
      await deleteMerchant(addr3);
      console.log(`  deleted ${addr3}`);
      break;
    }

    default:
      console.log("  commands: list, add, enable, disable, delete");
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
