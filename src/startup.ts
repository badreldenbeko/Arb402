import { networkConfig } from "./config.js";
import { getPublicClient } from "./settle.js";
import { probeToken } from "./tokenProbe.js";
import { testConnection, ensureSchema, isDatabaseConfigured } from "./db.js";
import { logger } from "./logging.js";

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
  logger.info("chain ID verified", {
    chainId,
    network: networkConfig.displayName,
    family: networkConfig.family,
  });

  // A chain can be registered without a settlement token (Arbitrum Nova ships
  // that way: its bridged USDC.e has no EIP-3009). Refuse to serve rather than
  // hand out requirements no one can settle.
  if (!networkConfig.tokenConfigured) {
    throw new Error(
      `${networkConfig.displayName} has no settlement token configured — ` +
        `set USDC_ADDRESS to an EIP-3009-capable token (and USDC_NAME / ` +
        `USDC_VERSION if its EIP-712 domain differs from "USD Coin" / "2")`
    );
  }

  await verifyToken();
}

/**
 * Verify the settlement token on-chain. EIP-3009 support and a matching EIP-712
 * domain are load-bearing: without them every signature this facilitator issues
 * is unredeemable, and nothing on-chain says why. Checked at boot so the
 * failure lands here rather than mid-settlement.
 */
async function verifyToken(): Promise<void> {
  const probe = await probeToken(getPublicClient(), {
    address: networkConfig.usdcAddress,
    chainId: networkConfig.chainId,
    tokenName: networkConfig.tokenName,
    tokenVersion: networkConfig.tokenVersion,
    expectedDecimals: networkConfig.tokenDecimals,
  });

  for (const w of probe.warnings) {
    logger.warn(w, { address: networkConfig.usdcAddress });
  }

  if (probe.problems.length > 0) {
    throw new Error(
      `settlement token check failed on ${networkConfig.displayName}:\n  - ` +
        probe.problems.join("\n  - ")
    );
  }

  logger.info("settlement token verified", {
    address: networkConfig.usdcAddress,
    symbol: probe.symbol,
    decimals: probe.decimals,
    eip3009: true,
    domainVerified: probe.domainMatches === true,
  });
}
