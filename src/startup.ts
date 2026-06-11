import { parseAbi } from "viem";
import { networkConfig } from "./config.js";
import { getPublicClient } from "./settle.js";
import { testConnection, ensureSchema, isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);

export async function runStartupChecks(): Promise<void> {
  if (isDatabaseConfigured()) {
    await testConnection();
    await ensureSchema();
  } else {
    // the in-memory nonce store grows unbounded and is lost on restart, so it is
    // unsafe for production — refuse to boot rather than silently risk replays.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_URL is required in production (the in-memory nonce store is unsafe)"
      );
    }
    logger.warn(
      "DATABASE_URL not set — running without persistence. nonces will be lost on restart."
    );
  }

  const pub = getPublicClient();
  const chainId = await pub.getChainId();
  if (chainId !== networkConfig.chainId) {
    throw new Error(
      `chain ID mismatch: RPC returned ${chainId}, config expects ${networkConfig.chainId}`
    );
  }
  logger.info("chain ID verified", { chainId });
  try {
    const decimals = await pub.readContract({
      address: networkConfig.usdcAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    if (Number(decimals) !== 6) {
      throw new Error(
        `expected USDC decimals = 6, got ${decimals} at ${networkConfig.usdcAddress}`
      );
    }
    logger.info("USDC contract verified", {
      address: networkConfig.usdcAddress,
      decimals: Number(decimals),
    });
  } catch (err: any) {
    if (err.message.includes("decimals")) throw err;
    logger.warn("could not verify USDC decimals (contract may not be deployed yet)", {
      address: networkConfig.usdcAddress,
      error: err.message,
    });
  }
}
