/**
 * Template: paid MCP tool.
 *
 * An MCP server exposing a tool that requires an arb402 payment per invocation.
 * Because MCP tool calls aren't interactive, payment is two-step:
 *   1. Call the tool with no `payment` → it returns the 402 requirements.
 *   2. The client (agent) signs and calls again with `payment` → the server
 *      settles on-chain and returns the result.
 *
 * Install: npm i @modelcontextprotocol/sdk zod
 * Run:     FACILITATOR_URL=... MERCHANT_API_KEY=... MERCHANT_ADDRESS=... npx tsx server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRequirements, settle } from "../shared/x402-client.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:3002";
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY ?? "";
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS ?? "";
const PRICE = process.env.PRICE_USDC ?? "1000000"; // 1.00 USDC per call

// The premium work this tool performs once paid. Replace with real logic.
function premiumLookup(query: string): string {
  return `premium answer for "${query}"`;
}

const server = new McpServer({ name: "arb402-paid-tool", version: "0.1.0" });

server.tool(
  "premium_lookup",
  {
    query: z.string().describe("the lookup query"),
    payment: z
      .string()
      .optional()
      .describe("signed x402 payment payload (omit on first call to get a quote)"),
  },
  async ({ query, payment }: { query: string; payment?: string }) => {
    // Step 1: no payment → return the quote/requirements as JSON text.
    if (!payment) {
      const requirement = await getRequirements(FACILITATOR_URL, {
        amount: PRICE,
        merchantAddress: MERCHANT_ADDRESS,
        resource: "premium_lookup",
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "payment_required",
              merchantAddress: MERCHANT_ADDRESS,
              accepts: [requirement],
            }),
          },
        ],
      };
    }

    // Step 2: settle the signed payment, then return the result.
    const result = await settle(FACILITATOR_URL, MERCHANT_API_KEY, JSON.parse(payment));
    if (!(result.status === 200 && result.body.success)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ status: "payment_failed", detail: result.body }) }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "ok",
            result: premiumLookup(query),
            settledTx: result.body.outgoingTxHash,
          }),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("arb402 paid MCP tool running on stdio");
