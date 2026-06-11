/**
 * Template: pay-per-call API paywall.
 *
 * An Express server that gates a route behind an arb402 payment. The CLIENT
 * signs an EIP-3009 authorization; THIS SERVER (the merchant, holding the API
 * key) settles it on-chain via the facilitator, then serves the resource.
 *
 * Extend by replacing the protected handler with your own logic, and by adding
 * more `paywall(...)`-wrapped routes at different prices.
 *
 * Install: npm i express
 * Run:     FACILITATOR_URL=... MERCHANT_API_KEY=... MERCHANT_ADDRESS=... npx tsx server.ts
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { getRequirements, settle } from "../shared/x402-client.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:3002";
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY ?? "";
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS ?? "";
const DEFAULT_PRICE = process.env.PRICE_USDC ?? "1000000"; // 1.00 USDC
const PORT = Number(process.env.PORT ?? 4001);

/** Gate a route: 402 until the request carries a valid, settled payment. */
function paywall(resource: string, price = DEFAULT_PRICE) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("X-PAYMENT");

    // No payment yet — return 402 with what the client must pay.
    if (!header) {
      const requirement = await getRequirements(FACILITATOR_URL, {
        amount: price,
        merchantAddress: MERCHANT_ADDRESS,
        resource,
      });
      res.status(402).json({
        error: "Payment Required",
        merchantAddress: MERCHANT_ADDRESS,
        accepts: [requirement],
      });
      return;
    }

    // Payment present — settle it with our merchant key, then serve.
    let payload: unknown;
    try {
      payload = JSON.parse(header);
    } catch {
      res.status(400).json({ error: "X-PAYMENT must be JSON" });
      return;
    }
    const result = await settle(FACILITATOR_URL, MERCHANT_API_KEY, payload);
    if (result.status === 200 && result.body.success) {
      (req as any).settlement = result.body;
      next();
    } else {
      res.status(402).json({ error: "payment failed", detail: result.body });
    }
  };
}

const app = express();
app.use(express.json());

app.get("/api/premium", paywall("/api/premium"), (req: Request, res: Response) => {
  const s = (req as any).settlement;
  res.json({
    data: "premium content unlocked",
    settledTx: s.outgoingTxHash,
    block: s.blockNumber,
  });
});

app.listen(PORT, () => {
  console.log(`pay-per-call API listening on :${PORT} (facilitator: ${FACILITATOR_URL})`);
});
