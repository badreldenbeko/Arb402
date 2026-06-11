import type { PaymentScenario } from "./scripts/settle-once.js";

/**
 * One reproducible on-chain payment per M5 application. Each settles
 * independently (fresh nonce), proving "TXs working and reproducible for all
 * applications". Amounts are in micro-USDC (6 decimals).
 *
 * The metered-inference entry models a *batch* settlement: 5 calls at 0.20 USDC
 * accumulate into a single 1.00 USDC on-chain payment.
 */
export const APP_SCENARIOS: PaymentScenario[] = [
  {
    label: "pay-per-call API — single 1.00 USDC call",
    amount: "1000000",
    memo: "pay-per-call API",
    resource: "/api/premium",
  },
  {
    label: "metered AI inference — batch of 5 × 0.20 USDC settled as 1.00 USDC",
    amount: "1000000",
    memo: "inference batch x5",
    resource: "/infer",
  },
  {
    label: "agent-to-agent — 0.50 USDC task payment",
    amount: "500000",
    memo: "a2a task payment",
    resource: "/agent/task",
  },
  {
    label: "paid MCP tool — 1.00 USDC per invocation",
    amount: "1000000",
    memo: "premium_lookup",
    resource: "premium_lookup",
  },
];
