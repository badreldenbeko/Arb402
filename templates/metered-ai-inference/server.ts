/**
 * Template: metered AI inference with batch settlement.
 *
 * Serves inference requests and meters usage per session. Rather than settling
 * every call (gas-heavy), it accumulates `BATCH_SIZE` calls and then requires a
 * single aggregate payment before serving more — the pattern AI agents use to
 * amortize on-chain cost.
 *
 * Replace `runInference` with a real inference provider or a local model.
 *
 * Install: npm i express
 * Run:     FACILITATOR_URL=... MERCHANT_API_KEY=... MERCHANT_ADDRESS=... npx tsx server.ts
 */
import express, { type Request, type Response } from "express";
import { getRequirements, settle } from "../shared/x402-client.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:3002";
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY ?? "";
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS ?? "";
const UNIT_PRICE = process.env.UNIT_PRICE_USDC ?? "200000"; // 0.20 USDC per call
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 5);
const PORT = Number(process.env.PORT ?? 4002);

interface Session {
  served: number; // total successful inferences
  unpaid: number; // calls accumulated since last settlement
}
const sessions = new Map<string, Session>();

// Stand-in for a real model call. Swap in your provider here.
async function runInference(prompt: string): Promise<string> {
  return `inference("${prompt}")`;
}

const app = express();
app.use(express.json());

app.post("/infer", async (req: Request, res: Response) => {
  const sessionId = req.header("X-Session") ?? "anonymous";
  const s = sessions.get(sessionId) ?? { served: 0, unpaid: 0 };

  // Batch threshold reached → require settlement of the accumulated balance.
  if (s.unpaid >= BATCH_SIZE) {
    const owed = String(BigInt(UNIT_PRICE) * BigInt(s.unpaid));
    const header = req.header("X-PAYMENT");
    if (!header) {
      const requirement = await getRequirements(FACILITATOR_URL, {
        amount: owed,
        merchantAddress: MERCHANT_ADDRESS,
        resource: "/infer",
        memo: `batch of ${s.unpaid} inferences`,
      });
      res.status(402).json({
        error: "Payment Required",
        merchantAddress: MERCHANT_ADDRESS,
        owed,
        unpaidCalls: s.unpaid,
        accepts: [requirement],
      });
      return;
    }
    const result = await settle(FACILITATOR_URL, MERCHANT_API_KEY, JSON.parse(header));
    if (!(result.status === 200 && result.body.success)) {
      res.status(402).json({ error: "settlement failed", detail: result.body });
      return;
    }
    s.unpaid = 0; // batch cleared
  }

  const output = await runInference(req.body?.prompt ?? "");
  s.served += 1;
  s.unpaid += 1;
  sessions.set(sessionId, s);

  res.json({
    output,
    served: s.served,
    unpaidInBatch: s.unpaid,
    batchSize: BATCH_SIZE,
    settleDueNext: s.unpaid >= BATCH_SIZE,
  });
});

app.listen(PORT, () => {
  console.log(`metered AI inference listening on :${PORT} (facilitator: ${FACILITATOR_URL})`);
});
