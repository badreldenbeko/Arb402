import { JsonRpcProvider, Wallet, formatUnits } from "ethers";
import {
  ACCOUNTS,
  RPC_URL,
  CHAIN_ID,
  FACILITATOR_URL,
  DEV_MERCHANT_API_KEY,
} from "../lib/accounts.js";
import { payForResource } from "../lib/facilitator.js";
import { testUsdc, readAddresses } from "../lib/testusdc.js";

export interface PaymentScenario {
  label: string;
  amount: string; // micro-USDC (6 decimals)
  memo: string;
  resource?: string;
}

function assertEq(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label} (${actual} !== ${expected})`);
  }
}

const usd = (v: bigint) => `${formatUnits(v, 6)} USDC`;

/**
 * Drive one full payment through the facilitator against the local chain and
 * assert that on-chain balances moved exactly as the fee breakdown describes.
 * Reusable by every per-app M5 script — each just passes a different scenario.
 */
export async function runPayment(scenario: PaymentScenario): Promise<void> {
  const provider = new JsonRpcProvider(RPC_URL);
  const { usdc, merchant, facilitator, payer } = readAddresses();
  const token = testUsdc(usdc, provider);
  const payerWallet = new Wallet(ACCOUNTS.payer.privateKey, provider);

  const balances = async () => ({
    payer: (await token.balanceOf(payer)) as bigint,
    merchant: (await token.balanceOf(merchant)) as bigint,
    facilitator: (await token.balanceOf(facilitator)) as bigint,
  });

  const before = await balances();

  const result = await payForResource({
    facilitatorUrl: FACILITATOR_URL,
    apiKey: DEV_MERCHANT_API_KEY,
    payer: payerWallet,
    chainId: CHAIN_ID,
    merchantAddress: merchant,
    amount: scenario.amount,
    memo: scenario.memo,
    resource: scenario.resource,
  });

  if (result.status !== 200 || !result.body.success) {
    throw new Error(
      `settlement failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`
    );
  }
  const fb = result.body.feeBreakdown!;
  const after = await balances();

  const paid = before.payer - after.payer;
  const merchantGain = after.merchant - before.merchant;
  const facilitatorGain = after.facilitator - before.facilitator;

  // on-chain reality must match the facilitator's accounting
  assertEq(paid, BigInt(scenario.amount), "payer debited the full amount");
  assertEq(merchantGain, BigInt(fb.merchantAmount), "merchant credited net amount");
  assertEq(
    facilitatorGain,
    BigInt(fb.serviceFee) + BigInt(fb.gasFee),
    "facilitator retained service fee + gas"
  );
  assertEq(merchantGain + facilitatorGain, BigInt(scenario.amount), "funds conserved");

  console.log(`\n  ✓ ${scenario.label}`);
  console.log(`      paid by payer:     ${usd(paid)}`);
  console.log(`      → merchant net:    ${usd(merchantGain)}`);
  console.log(`      → facilitator fee: ${usd(facilitatorGain)} (service ${usd(BigInt(fb.serviceFee))} + gas ${usd(BigInt(fb.gasFee))})`);
  console.log(`      incoming tx:       ${result.body.incomingTxHash}`);
  console.log(`      outgoing tx:       ${result.body.outgoingTxHash}`);
  console.log(`      block:             ${result.body.blockNumber}`);
}

/**
 * Fire `count` settlements concurrently against one facilitator wallet and
 * assert they ALL succeed and funds are conserved. This is the regression test
 * for the wallet-nonce collision: without serialization, only one would mine and
 * the rest would strand funds.
 */
export async function runConcurrent(amount: string, count: number): Promise<void> {
  const provider = new JsonRpcProvider(RPC_URL);
  const { usdc, merchant, facilitator, payer } = readAddresses();
  const token = testUsdc(usdc, provider);
  const payerWallet = new Wallet(ACCOUNTS.payer.privateKey, provider);

  const balances = async () => ({
    payer: (await token.balanceOf(payer)) as bigint,
    merchant: (await token.balanceOf(merchant)) as bigint,
    facilitator: (await token.balanceOf(facilitator)) as bigint,
  });

  const before = await balances();

  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      payForResource({
        facilitatorUrl: FACILITATOR_URL,
        apiKey: DEV_MERCHANT_API_KEY,
        payer: payerWallet,
        chainId: CHAIN_ID,
        merchantAddress: merchant,
        amount,
        memo: `concurrent #${i}`,
        resource: "/concurrent",
      })
    )
  );

  const failed = results.filter((r) => !(r.status === 200 && r.body.success));
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${count} concurrent settlements failed: ${JSON.stringify(
        failed.map((f) => f.body.errorReason ?? f.body)
      )}`
    );
  }

  const after = await balances();
  const totalPaid = before.payer - after.payer;
  const expected = BigInt(amount) * BigInt(count);
  assertEq(totalPaid, expected, "payer debited the sum of all concurrent payments");
  assertEq(
    after.merchant - before.merchant + (after.facilitator - before.facilitator),
    expected,
    "funds conserved across concurrent settlements"
  );

  // every settlement must have a distinct outgoing tx (no nonce collision)
  const hashes = new Set(results.map((r) => r.body.outgoingTxHash));
  assertEq(BigInt(hashes.size), BigInt(count), "each settlement produced a distinct outgoing tx");

  console.log(
    `\n  ✓ ${count} concurrent settlements of ${usd(BigInt(amount))} each — all succeeded, funds conserved, ${hashes.size} distinct txs`
  );
}

// run a default scenario when invoked directly
const isMain = process.argv[1] && process.argv[1].endsWith("settle-once.ts");
if (isMain) {
  runPayment({
    label: "pay-per-call: single 1.00 USDC payment",
    amount: "1000000",
    memo: "arb402 harness smoke test",
    resource: "/api/premium",
  }).catch((err) => {
    console.error(`\n  ✗ ${err.message}`);
    process.exit(1);
  });
}
