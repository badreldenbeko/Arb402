import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import type { Chain } from "viem";
import { logger } from "./logging.js";
import {
  Network,
  DEFAULT_NETWORK,
  getRegistry,
  getChain,
  resolveNetworkAlias,
  toViemChain,
  type ChainDefinition,
  type ChainFamily,
} from "./chains.js";

dotenv.config();

export { Network, DEFAULT_NETWORK };
export type { ChainDefinition, ChainFamily };

/**
 * Resolve any accepted spelling of a network to its CAIP-2 id.
 *
 * Accepts the CAIP-2 id itself ("eip155:42170"), the legacy x402 v1 name
 * ("arbitrum-nova"), or any registered alias ("nova"). Orbit chains resolve
 * exactly the same way once they are in the chains file, which is what lets
 * one codebase target One, Nova, and any L3 without a rebuild.
 */
export function normalizeNetworkId(raw?: string): Network {
  if (!raw) return DEFAULT_NETWORK;
  const lower = raw.toLowerCase().trim();
  if (lower === "") return DEFAULT_NETWORK;

  const hit = resolveNetworkAlias(lower);
  if (hit) return hit;

  // a well-formed CAIP-2 id we simply don't know about gets a message that
  // says how to fix it, rather than a bare "unsupported"
  if (/^eip155:\d+$/.test(lower)) {
    throw new Error(
      `unsupported network: ${raw} — add it to arb402.chains.json ` +
        `(or ARB402_CHAINS_FILE) to register an Orbit chain`
    );
  }
  throw new Error(`unsupported network: ${raw}`);
}

export function toLegacyName(network: Network): string {
  return getChain(network)?.legacyName ?? network;
}

/** CAIP-2 id -> numeric chain id, for every registered chain. */
export const CHAIN_IDS: Record<Network, number> = Object.fromEntries(
  getRegistry().all.map((c) => [c.id, c.chainId])
);

export interface NetworkConfig {
  network: Network;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  /** EIP-712 domain name of the settlement token. */
  tokenName: string;
  /** EIP-712 domain version of the settlement token. */
  tokenVersion: string;
  tokenDecimals: number;
  /**
   * False when the chain has no EIP-3009 settlement token configured (Nova
   * out of the box). Everything else still resolves so the CLI can explain the
   * gap; settlement is what refuses.
   */
  tokenConfigured: boolean;
  family: ChainFamily;
  displayName: string;
  definition: ChainDefinition;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Token overrides apply to the *active* network only. Pointing every chain at
 * one USDC_ADDRESS would be meaningless — and dangerous, since /supported
 * advertises the inactive chains too.
 */
function tokenOverrides(isActive: boolean) {
  if (!isActive) return {};
  return {
    address: process.env.USDC_ADDRESS as `0x${string}` | undefined,
    name: process.env.USDC_NAME || undefined,
    version: process.env.USDC_VERSION || undefined,
  };
}

function buildNetworkConfig(def: ChainDefinition, isActive: boolean): NetworkConfig {
  const rpcUrl = process.env[def.rpcEnvVar] || def.defaultRpcUrl;
  const override = tokenOverrides(isActive);

  const address = override.address || def.token?.address;
  const token = def.token;

  return {
    network: def.id,
    chainId: def.chainId,
    chain: toViemChain(def, rpcUrl),
    rpcUrl,
    usdcAddress: address ?? ZERO_ADDRESS,
    tokenName: override.name ?? token?.name ?? "USD Coin",
    tokenVersion: override.version ?? token?.version ?? "2",
    tokenDecimals: token?.decimals ?? 6,
    tokenConfigured: address !== undefined,
    family: def.family,
    displayName: def.displayName,
    definition: def,
  };
}

// resolve active network from env
const activeNetwork = normalizeNetworkId(process.env.NETWORK);
const activeDefinition = getChain(activeNetwork)!;
export const networkConfig = buildNetworkConfig(activeDefinition, true);

// every registered chain (for /supported and `arb402 chains`)
export const allNetworkConfigs: NetworkConfig[] = getRegistry().all.map((def) =>
  buildNetworkConfig(def, def.id === activeNetwork)
);

/**
 * EIP-712 domain of the *active* network's token. Kept as top-level exports for
 * back-compat; new code should read networkConfig.tokenName/tokenVersion, which
 * is what makes per-chain domains work.
 */
export const USDC_NAME = networkConfig.tokenName;
export const USDC_VERSION = networkConfig.tokenVersion;

if (!networkConfig.tokenConfigured) {
  logger.warn(
    `${activeDefinition.displayName} has no EIP-3009 settlement token configured — ` +
      `set USDC_ADDRESS (and USDC_NAME/USDC_VERSION if its domain differs). ` +
      `run 'arb402 doctor' to verify it.`
  );
}

// private key
function loadPrivateKey(): `0x${string}` {
  const raw =
    process.env.EVM_PRIVATE_KEY ||
    process.env.FACILITATOR_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

  if (!raw) {
    logger.warn("no private key configured, settlement will fail");
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  }

  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (key.length !== 66 || !/^0x[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("invalid private key format");
  }
  return key as `0x${string}`;
}

export const PRIVATE_KEY = loadPrivateKey();

// only derive a real address when a key is configured
const NO_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const FACILITATOR_ADDRESS: `0x${string}` =
  PRIVATE_KEY === NO_KEY
    ? "0x0000000000000000000000000000000000000000"
    : privateKeyToAccount(PRIVATE_KEY).address;

// server
export const PORT = parseInt(process.env.PORT || "3002", 10);
export const BODY_SIZE_LIMIT = "100kb";

// fees — tuned for Arbitrum's low gas costs
export const SERVICE_FEE_BPS = Math.min(
  parseInt(process.env.SERVICE_FEE_BPS || "50", 10),
  500
);
export const GAS_FEE_USDC = BigInt(process.env.GAS_FEE_USDC || "100000"); // 0.10 USDC
const MAX_GAS_FEE = 1_000_000n;
if (GAS_FEE_USDC > MAX_GAS_FEE) {
  throw new Error(`GAS_FEE_USDC exceeds max (${MAX_GAS_FEE})`);
}

// settlement cap
export const MAX_SETTLEMENT_AMOUNT = BigInt(
  process.env.MAX_SETTLEMENT_AMOUNT || "1000000000"
); // 1000 USDC

// recovery interval
export const RECOVERY_INTERVAL_MS = parseInt(
  process.env.RECOVERY_INTERVAL_MS || "300000",
  10
);

// a payment still incomplete this long after creation is almost certainly a
// zombie (e.g. an incoming signed but never broadcast, whose nonce was reused).
// The recovery worker logs an alert so an operator can review/prune. Default 1h.
export const STUCK_PAYMENT_ALERT_MS = parseInt(
  process.env.STUCK_PAYMENT_ALERT_MS || "3600000",
  10
);

// minimum facilitator ETH balance (wei) required to attempt a settlement.
// Gas is paid in ETH while fees accrue in USDC, so without a preflight the
// wallet can silently run dry mid-settlement. Default 0.0005 ETH.
export const MIN_FACILITATOR_ETH_WEI = BigInt(
  process.env.MIN_FACILITATOR_ETH_WEI || "500000000000000"
);

// when true (default), settlement is bound to a requirement the facilitator
// actually issued (anti-replay / anti-tamper: the nonce must be one we handed
// out and the signed amount/deadline/merchant must match it). This is integrity,
// not merchant-authoritative pricing. Set "false" for the advisory x402 model
// where the resource server alone enforces price.
export const REQUIRE_ISSUED_REQUIREMENTS =
  (process.env.REQUIRE_ISSUED_REQUIREMENTS || "true").toLowerCase() !== "false";
