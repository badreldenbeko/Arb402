import dotenv from "dotenv";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Chain } from "viem";
import { logger } from "./logging.js";

dotenv.config();

// CAIP-2 network identifiers
export enum Network {
  ARBITRUM = "eip155:42161",
  ARBITRUM_SEPOLIA = "eip155:421614",
}

// legacy aliases
const NETWORK_ALIASES: Record<string, Network> = {
  arbitrum: Network.ARBITRUM,
  "arbitrum-one": Network.ARBITRUM,
  "arbitrum-sepolia": Network.ARBITRUM_SEPOLIA,
};

const LEGACY_NAMES: Record<Network, string> = {
  [Network.ARBITRUM]: "arbitrum",
  [Network.ARBITRUM_SEPOLIA]: "arbitrum-sepolia",
};

export function normalizeNetworkId(raw?: string): Network {
  if (!raw) return Network.ARBITRUM_SEPOLIA;
  const lower = raw.toLowerCase().trim();

  if (Object.values(Network).includes(lower as Network)) return lower as Network;
  if (NETWORK_ALIASES[lower]) return NETWORK_ALIASES[lower];

  throw new Error(`unsupported network: ${raw}`);
}

export function toLegacyName(network: Network): string {
  return LEGACY_NAMES[network] ?? network;
}

// chain constants
export const CHAIN_IDS: Record<Network, number> = {
  [Network.ARBITRUM]: 42161,
  [Network.ARBITRUM_SEPOLIA]: 421614,
};

// native USDC on Arbitrum One, test USDC on Sepolia
const DEFAULT_USDC: Record<Network, `0x${string}`> = {
  [Network.ARBITRUM]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  [Network.ARBITRUM_SEPOLIA]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};

// EIP-712 domain values for USDC
export const USDC_NAME = "USD Coin";
export const USDC_VERSION = "2";

export interface NetworkConfig {
  network: Network;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
}

const DEFAULT_RPC: Record<Network, string> = {
  [Network.ARBITRUM]: "https://arb1.arbitrum.io/rpc",
  [Network.ARBITRUM_SEPOLIA]: "https://sepolia-rollup.arbitrum.io/rpc",
};

const VIEM_CHAINS: Record<Network, Chain> = {
  [Network.ARBITRUM]: arbitrum,
  [Network.ARBITRUM_SEPOLIA]: arbitrumSepolia,
};

function buildNetworkConfig(network: Network): NetworkConfig {
  const rpcEnv =
    network === Network.ARBITRUM
      ? process.env.ARBITRUM_RPC_URL
      : process.env.ARBITRUM_SEPOLIA_RPC_URL;

  const usdcOverride = process.env.USDC_ADDRESS as `0x${string}` | undefined;

  return {
    network,
    chainId: CHAIN_IDS[network],
    chain: VIEM_CHAINS[network],
    rpcUrl: rpcEnv || DEFAULT_RPC[network],
    usdcAddress: usdcOverride || DEFAULT_USDC[network],
  };
}

// resolve active network from env
const activeNetwork = normalizeNetworkId(process.env.NETWORK);
export const networkConfig = buildNetworkConfig(activeNetwork);

// all configs (for /supported)
export const allNetworkConfigs: NetworkConfig[] = Object.values(Network).map(
  (n) => buildNetworkConfig(n)
);

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
