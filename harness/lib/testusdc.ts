import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Contract, type ContractRunner, type InterfaceAbi } from "ethers";

// Load the compiled artifact produced by `hardhat compile`.
const ARTIFACT_PATH = fileURLToPath(
  new URL("../artifacts/contracts/TestUSDC.sol/TestUSDC.json", import.meta.url)
);

export function loadArtifact(): { abi: InterfaceAbi; bytecode: string } {
  try {
    const json = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
    return { abi: json.abi, bytecode: json.bytecode };
  } catch {
    throw new Error(
      "TestUSDC artifact not found — run `npm run compile` in harness/ first"
    );
  }
}

export function testUsdc(address: string, runner: ContractRunner): Contract {
  return new Contract(address, loadArtifact().abi, runner);
}

// addresses.json written by the deploy step
export interface Addresses {
  usdc: string;
  facilitator: string;
  payer: string;
  merchant: string;
}

const ADDRESSES_PATH = fileURLToPath(new URL("../addresses.json", import.meta.url));

export function readAddresses(): Addresses {
  try {
    return JSON.parse(readFileSync(ADDRESSES_PATH, "utf8"));
  } catch {
    throw new Error("addresses.json not found — run the deploy step first");
  }
}

export const ADDRESSES_FILE = ADDRESSES_PATH;
