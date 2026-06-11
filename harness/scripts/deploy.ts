import { writeFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory } from "ethers";
import { ACCOUNTS, RPC_URL } from "../lib/accounts.js";
import { loadArtifact, ADDRESSES_FILE, type Addresses } from "../lib/testusdc.js";

// Deploy TestUSDC to the local node and mint a starting balance to the payer.
async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  // NonceManager tracks nonces locally — avoids a race against the auto-mining
  // node where back-to-back txs (deploy then mint) both fetch nonce 0.
  const deployer = new NonceManager(new Wallet(ACCOUNTS.facilitator.privateKey, provider));

  const { abi, bytecode } = loadArtifact();
  const factory = new ContractFactory(abi, bytecode, deployer);
  const usdc = await factory.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();

  // mint 1000 USDC (6 decimals) to the payer so it can fund payments
  const mintAmount = 1_000_000_000n; // 1000 * 1e6
  const mintTx = await (usdc as any).mint(ACCOUNTS.payer.address, mintAmount);
  await mintTx.wait();

  const addresses: Addresses = {
    usdc: usdcAddress,
    facilitator: ACCOUNTS.facilitator.address,
    payer: ACCOUNTS.payer.address,
    merchant: ACCOUNTS.merchant.address,
  };
  writeFileSync(ADDRESSES_FILE, JSON.stringify(addresses, null, 2));

  console.log(`  TestUSDC deployed:  ${usdcAddress}`);
  console.log(`  minted 1000 USDC ->  ${ACCOUNTS.payer.address} (payer)`);
  console.log(`  wrote addresses.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
