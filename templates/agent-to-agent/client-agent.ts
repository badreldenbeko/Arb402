/**
 * Template: agent-to-agent (A2A) — the CLIENT agent.
 *
 * An autonomous agent that calls the merchant agent, and — if the quoted price
 * is within its budget — pays automatically and consumes the result. No human
 * in the loop: this is the machine-to-machine micropayment pattern.
 *
 * Install: npm i ethers
 * Run:     MERCHANT_URL=... RPC_URL=... PAYER_PRIVATE_KEY=... CHAIN_ID=421614 BUDGET_USDC=1000000 npx tsx client-agent.ts
 */
import { JsonRpcProvider, Wallet } from "ethers";
import { buildSignedPayment, type Requirement } from "../shared/x402-client.js";

const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://127.0.0.1:4003/agent/task";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 421614);
const PAYER_PRIVATE_KEY = process.env.PAYER_PRIVATE_KEY ?? "";
const BUDGET = BigInt(process.env.BUDGET_USDC ?? "1000000"); // max the agent will pay per task

async function main() {
  const payer = new Wallet(PAYER_PRIVATE_KEY, new JsonRpcProvider(RPC_URL));
  const body = JSON.stringify({ input: "summarize today's news" });
  const json = { "content-type": "application/json" };

  // 1. Request the task → receive a quote (402).
  const quoteRes = await fetch(MERCHANT_URL, { method: "POST", headers: json, body });
  if (quoteRes.status !== 402) throw new Error(`expected 402 quote, got ${quoteRes.status}`);
  const quote: any = await quoteRes.json();
  const requirement: Requirement = quote.accepts[0];

  // 2. Budget check — the agent decides autonomously whether to pay.
  if (BigInt(requirement.maxAmountRequired) > BUDGET) {
    console.log(`declining: price ${requirement.maxAmountRequired} exceeds budget ${BUDGET}`);
    return;
  }

  // 3. Sign and pay, then consume the result.
  const payment = await buildSignedPayment({
    payer,
    chainId: CHAIN_ID,
    requirement,
    merchantAddress: quote.merchantAddress,
    memo: "a2a task payment",
  });
  const paidRes = await fetch(MERCHANT_URL, {
    method: "POST",
    headers: { ...json, "X-PAYMENT": JSON.stringify(payment) },
    body,
  });
  console.log(`status: ${paidRes.status}`);
  console.log(await paidRes.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
