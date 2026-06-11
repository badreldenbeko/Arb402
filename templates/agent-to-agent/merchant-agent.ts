/**
 * Template: agent-to-agent (A2A) — the MERCHANT agent.
 *
 * A service agent that performs a task for other agents and charges per task
 * via arb402. It is the merchant: it holds the API key and settles payments.
 * The paying side is `client-agent.ts`.
 *
 * Install: npm i express
 * Run:     FACILITATOR_URL=... MERCHANT_API_KEY=... MERCHANT_ADDRESS=... npx tsx merchant-agent.ts
 */
import express, { type Request, type Response } from "express";
import { getRequirements, settle } from "../shared/x402-client.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:3002";
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY ?? "";
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS ?? "";
const TASK_PRICE = process.env.TASK_PRICE_USDC ?? "500000"; // 0.50 USDC per task
const PORT = Number(process.env.PORT ?? 4003);

// The service this agent sells. Replace with real work (data, compute, a model…).
function performTask(input: string): string {
  return `completed task: ${input.toUpperCase()}`;
}

const app = express();
app.use(express.json());

app.post("/agent/task", async (req: Request, res: Response) => {
  const header = req.header("X-PAYMENT");

  // Quote the price if the caller hasn't paid yet.
  if (!header) {
    const requirement = await getRequirements(FACILITATOR_URL, {
      amount: TASK_PRICE,
      merchantAddress: MERCHANT_ADDRESS,
      resource: "/agent/task",
      memo: "a2a task",
    });
    res.status(402).json({
      error: "Payment Required",
      merchantAddress: MERCHANT_ADDRESS,
      price: TASK_PRICE,
      accepts: [requirement],
    });
    return;
  }

  // Settle the caller's signed payment, then deliver the result.
  const result = await settle(FACILITATOR_URL, MERCHANT_API_KEY, JSON.parse(header));
  if (!(result.status === 200 && result.body.success)) {
    res.status(402).json({ error: "payment failed", detail: result.body });
    return;
  }

  res.json({
    result: performTask(req.body?.input ?? ""),
    settledTx: result.body.outgoingTxHash,
    block: result.body.blockNumber,
  });
});

app.listen(PORT, () => {
  console.log(`merchant agent listening on :${PORT} (facilitator: ${FACILITATOR_URL})`);
});
