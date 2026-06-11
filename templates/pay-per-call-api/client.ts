/**
 * Example client for the pay-per-call API template.
 *
 * Flow: GET the resource → receive 402 + requirement → sign EIP-3009 → resend
 * with the signed payload in the `X-PAYMENT` header → receive the content.
 *
 * Install: npm i ethers
 * Run:     API_URL=... RPC_URL=... PAYER_PRIVATE_KEY=... CHAIN_ID=421614 npx tsx client.ts
 */
import { JsonRpcProvider, Wallet } from "ethers";
import { buildSignedPayment, type Requirement } from "../shared/x402-client.js";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4001/api/premium";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 421614);
const PAYER_PRIVATE_KEY = process.env.PAYER_PRIVATE_KEY ?? "";

async function main() {
  const payer = new Wallet(PAYER_PRIVATE_KEY, new JsonRpcProvider(RPC_URL));

  // 1. Unpaid request → 402 with the requirement.
  const first = await fetch(API_URL);
  if (first.status !== 402) {
    throw new Error(`expected 402, got ${first.status}`);
  }
  const challenge: any = await first.json();
  const requirement: Requirement = challenge.accepts[0];

  // 2. Sign the EIP-3009 authorization for that requirement.
  const payment = await buildSignedPayment({
    payer,
    chainId: CHAIN_ID,
    requirement,
    merchantAddress: challenge.merchantAddress,
    memo: "pay-per-call",
  });

  // 3. Resend with the signed payload; the server settles and serves.
  const paid = await fetch(API_URL, {
    headers: { "X-PAYMENT": JSON.stringify(payment) },
  });
  console.log(`status: ${paid.status}`);
  console.log(await paid.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
