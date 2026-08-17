import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineChain } from "viem";
import { arbitrum, arbitrumNova, arbitrumSepolia } from "viem/chains";
import type { Chain } from "viem";

/**
 * The chain registry (M7).
 *
 * Chains are data, not code. A built-in table covers Arbitrum One, Nova, and
 * Sepolia; any Orbit chain is added by dropping an entry into a JSON file
 * (`arb402.chains.json`, or `ARB402_CHAINS_FILE`) — no rebuild, no fork.
 *
 * Two things every entry must get right, because they are the difference
 * between a settlement that works and a signature nobody can redeem:
 *
 *   1. The token must implement **EIP-3009** (`transferWithAuthorization`).
 *      The whole gasless flow is built on it. A plain ERC-20 cannot be used.
 *   2. The token's **EIP-712 domain** (`name` + `version`) must match what the
 *      contract itself uses. Get it wrong and every signature recovers to the
 *      wrong address, with no on-chain error to tell you why.
 *
 * Neither is guessable, so both are declared per chain and then *verified
 * against the live contract* by `probeToken()` in tokenProbe.ts — surfaced via
 * `arb402 doctor` and enforced at boot.
 */

/** CAIP-2 chain identifier, e.g. "eip155:42161". */
export type Network = string;

/** Well-known networks, for call sites that want a named constant. */
export const Network = {
  ARBITRUM: "eip155:42161",
  ARBITRUM_NOVA: "eip155:42170",
  ARBITRUM_SEPOLIA: "eip155:421614",
} as const;

export type ChainFamily = "arbitrum-one" | "nova" | "orbit" | "testnet";

export interface TokenDefinition {
  address: `0x${string}`;
  /** EIP-712 domain name — must equal the token's own `name()` domain value. */
  name: string;
  /** EIP-712 domain version. Most Circle USDC deployments use "2". */
  version: string;
  decimals: number;
  /**
   * Whether this token implements EIP-3009. `false` means arb402 cannot settle
   * with it — recorded so the CLI can explain *why* instead of failing at the
   * first signature. Verified on-chain by `probeToken()`.
   */
  eip3009: boolean;
  /** Shown when eip3009 is false, to point the operator somewhere useful. */
  note?: string;
}

export interface ChainDefinition {
  /** CAIP-2 id — the canonical key. */
  id: Network;
  chainId: number;
  /** Human label for CLI output. */
  displayName: string;
  /** x402 v1 network name (v2 uses the CAIP-2 id). */
  legacyName: string;
  /** Extra accepted spellings for NETWORK=, all lowercase. */
  aliases: string[];
  family: ChainFamily;
  defaultRpcUrl: string;
  /** Env var consulted before defaultRpcUrl, e.g. ARBITRUM_NOVA_RPC_URL. */
  rpcEnvVar: string;
  /** The settlement token. Absent when no EIP-3009 token is deployed yet. */
  token?: TokenDefinition;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  /** Where this entry came from — built in, or an operator's Orbit config. */
  source: "builtin" | "orbit-config";
  testnet: boolean;
}

// ---------------------------------------------------------------------------
// built-in chains
// ---------------------------------------------------------------------------

/**
 * Arbitrum One — native Circle USDC. Verified on-chain: implements EIP-3009,
 * domain name "USD Coin", version "2".
 */
const ARBITRUM_ONE: ChainDefinition = {
  id: Network.ARBITRUM,
  chainId: 42161,
  displayName: "Arbitrum One",
  legacyName: "arbitrum",
  aliases: ["arbitrum", "arbitrum-one", "arb1"],
  family: "arbitrum-one",
  defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
  rpcEnvVar: "ARBITRUM_RPC_URL",
  token: {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin",
    version: "2",
    decimals: 6,
    eip3009: true,
  },
  blockExplorer: "https://arbiscan.io",
  source: "builtin",
  testnet: false,
};

/**
 * Arbitrum Nova.
 *
 * Nova has no native Circle USDC. Its canonical stablecoin is the *bridged*
 * USDC.e at 0x750ba8…273b, which is a standard Arbitrum gateway ERC-20: it has
 * 6 decimals and a DOMAIN_SEPARATOR, but `authorizationState` reverts — it does
 * **not** implement EIP-3009. (Verified against https://nova.arbitrum.io/rpc.)
 *
 * So Nova ships with no default settlement token. The chain is fully supported
 * — RPC, chain id, fees, CLI, settlement engine — and works the moment an
 * EIP-3009-capable token is supplied via USDC_ADDRESS (plus USDC_NAME /
 * USDC_VERSION if its domain differs). `arb402 doctor` verifies that token
 * before you rely on it.
 *
 * Declaring this rather than shipping a token that cannot settle is deliberate:
 * a wrong default here produces valid-looking signatures that revert on-chain.
 */
const ARBITRUM_NOVA: ChainDefinition = {
  id: Network.ARBITRUM_NOVA,
  chainId: 42170,
  displayName: "Arbitrum Nova",
  legacyName: "arbitrum-nova",
  aliases: ["nova", "arbitrum-nova", "arb-nova"],
  family: "nova",
  defaultRpcUrl: "https://nova.arbitrum.io/rpc",
  rpcEnvVar: "ARBITRUM_NOVA_RPC_URL",
  token: undefined,
  blockExplorer: "https://nova.arbiscan.io",
  source: "builtin",
  testnet: false,
};

/** Arbitrum Sepolia — Circle test USDC, EIP-3009 capable. */
const ARBITRUM_SEPOLIA: ChainDefinition = {
  id: Network.ARBITRUM_SEPOLIA,
  chainId: 421614,
  displayName: "Arbitrum Sepolia",
  legacyName: "arbitrum-sepolia",
  aliases: ["arbitrum-sepolia", "sepolia", "arb-sepolia"],
  family: "testnet",
  defaultRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  rpcEnvVar: "ARBITRUM_SEPOLIA_RPC_URL",
  token: {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    name: "USD Coin",
    version: "2",
    decimals: 6,
    eip3009: true,
  },
  blockExplorer: "https://sepolia.arbiscan.io",
  source: "builtin",
  testnet: true,
};

export const BUILTIN_CHAINS: ChainDefinition[] = [
  ARBITRUM_ONE,
  ARBITRUM_NOVA,
  ARBITRUM_SEPOLIA,
];

// viem ships chain objects for the three built-ins; Orbit chains get one built
// on the fly by defineChain().
const VIEM_CHAINS: Record<string, Chain> = {
  [Network.ARBITRUM]: arbitrum,
  [Network.ARBITRUM_NOVA]: arbitrumNova,
  [Network.ARBITRUM_SEPOLIA]: arbitrumSepolia,
};

// ---------------------------------------------------------------------------
// orbit chain config
// ---------------------------------------------------------------------------

export const DEFAULT_ORBIT_CONFIG_FILE = "arb402.chains.json";

interface OrbitChainFile {
  chains?: unknown[];
}

function req(entry: Record<string, unknown>, key: string, where: string): string {
  const v = entry[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${where}: "${key}" is required and must be a non-empty string`);
  }
  return v.trim();
}

/**
 * Parse one Orbit entry. Kept strict on purpose: a typo'd chainId or token
 * address is a silent settlement failure, so it is rejected at load time with a
 * message naming the field.
 */
export function parseOrbitChain(raw: unknown, index: number): ChainDefinition {
  const where = `orbit chain #${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object`);
  }
  const entry = raw as Record<string, unknown>;

  const chainIdRaw = entry.chainId;
  const chainId =
    typeof chainIdRaw === "number"
      ? chainIdRaw
      : typeof chainIdRaw === "string"
        ? Number(chainIdRaw)
        : NaN;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`${where}: "chainId" must be a positive integer`);
  }

  const name = req(entry, "name", where);
  const rpcUrl = req(entry, "rpcUrl", where);

  let token: TokenDefinition | undefined;
  if (entry.token !== undefined) {
    if (typeof entry.token !== "object" || entry.token === null) {
      throw new Error(`${where}: "token" must be an object`);
    }
    const t = entry.token as Record<string, unknown>;
    const address = req(t, "address", `${where}.token`);
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error(`${where}.token: "address" is not a valid 0x address`);
    }
    const decimals = t.decimals === undefined ? 6 : Number(t.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`${where}.token: "decimals" must be an integer 0–36`);
    }
    token = {
      address: address as `0x${string}`,
      // default to the Circle USDC domain, the common case for Orbit deployments
      name: typeof t.name === "string" && t.name ? t.name : "USD Coin",
      version: typeof t.version === "string" && t.version ? t.version : "2",
      decimals,
      // trust but verify: probeToken() confirms this against the live contract
      eip3009: t.eip3009 === undefined ? true : t.eip3009 === true,
      note: typeof t.note === "string" ? t.note : undefined,
    };
  }

  const slug = (typeof entry.slug === "string" && entry.slug ? entry.slug : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return {
    id: `eip155:${chainId}`,
    chainId,
    displayName: name,
    legacyName: slug,
    aliases: [slug, ...(Array.isArray(entry.aliases) ? entry.aliases : [])
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.toLowerCase())],
    family: "orbit",
    defaultRpcUrl: rpcUrl,
    // per-chain override, e.g. ORBIT_412346_RPC_URL
    rpcEnvVar: `ORBIT_${chainId}_RPC_URL`,
    token,
    blockExplorer:
      typeof entry.blockExplorer === "string" ? entry.blockExplorer : undefined,
    nativeCurrency:
      typeof entry.nativeCurrency === "object" && entry.nativeCurrency !== null
        ? (entry.nativeCurrency as ChainDefinition["nativeCurrency"])
        : undefined,
    source: "orbit-config",
    testnet: entry.testnet === true,
  };
}

/** Parse the contents of an Orbit chains file. Exported for testing. */
export function parseOrbitChains(contents: string, path: string): ChainDefinition[] {
  let doc: OrbitChainFile;
  try {
    doc = JSON.parse(contents);
  } catch (err: any) {
    throw new Error(`${path}: invalid JSON — ${err.message}`);
  }
  const list = Array.isArray(doc) ? doc : doc?.chains;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${path}: expected a "chains" array`);
  }
  return list.map((raw, i) => parseOrbitChain(raw, i));
}

function loadOrbitChains(): ChainDefinition[] {
  const explicit = process.env.ARB402_CHAINS_FILE;
  const path = resolve(process.cwd(), explicit || DEFAULT_ORBIT_CONFIG_FILE);

  if (!existsSync(path)) {
    // an explicitly configured path that is missing is an operator error;
    // the conventional default simply being absent is not.
    if (explicit) throw new Error(`ARB402_CHAINS_FILE not found: ${path}`);
    return [];
  }
  return parseOrbitChains(readFileSync(path, "utf8"), path);
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export interface ChainRegistry {
  all: ChainDefinition[];
  byId: Map<Network, ChainDefinition>;
  /** alias / legacy name / CAIP-2 id -> CAIP-2 id, all lowercase keys */
  aliasIndex: Map<string, Network>;
}

export function buildRegistry(orbit: ChainDefinition[] = []): ChainRegistry {
  const byId = new Map<Network, ChainDefinition>();
  for (const chain of BUILTIN_CHAINS) byId.set(chain.id, chain);

  // Orbit entries may override a built-in (e.g. to point Nova at a token you
  // deployed yourself, or to pin a private RPC). An override keeps the
  // built-in's identity — Nova is still Nova, not an L3 — and contributes only
  // the fields the operator actually set.
  for (const chain of orbit) {
    const builtin = byId.get(chain.id);
    byId.set(
      chain.id,
      builtin
        ? {
            ...chain,
            family: builtin.family,
            rpcEnvVar: builtin.rpcEnvVar,
            aliases: [...new Set([...builtin.aliases, ...chain.aliases])],
            token: chain.token ?? builtin.token,
            blockExplorer: chain.blockExplorer ?? builtin.blockExplorer,
            testnet: builtin.testnet,
          }
        : chain
    );
  }

  const aliasIndex = new Map<string, Network>();
  for (const chain of byId.values()) {
    const keys = [chain.id, chain.legacyName, ...chain.aliases];
    for (const k of keys) {
      const key = k.toLowerCase();
      // first registration wins, so a stray Orbit alias can't hijack
      // "arbitrum" and silently redirect settlement to another chain
      if (!aliasIndex.has(key)) aliasIndex.set(key, chain.id);
    }
  }
  return { all: [...byId.values()], byId, aliasIndex };
}

let registry: ChainRegistry | undefined;

export function getRegistry(): ChainRegistry {
  if (!registry) registry = buildRegistry(loadOrbitChains());
  return registry;
}

/** Drop the cached registry — used by tests that swap the Orbit config. */
export function resetRegistry(): void {
  registry = undefined;
}

export function getChain(id: Network): ChainDefinition | undefined {
  return getRegistry().byId.get(id);
}

/** Default network when none is configured — testnet, never mainnet. */
export const DEFAULT_NETWORK: Network = Network.ARBITRUM_SEPOLIA;

/**
 * Resolve any accepted spelling of a network to its CAIP-2 id, or undefined.
 *
 * Lives here rather than in config.ts so callers that must not trigger config's
 * load-time resolution (notably `arb402 init`, which runs before a .env exists)
 * can still resolve names.
 */
export function resolveNetworkAlias(raw: string): Network | undefined {
  return getRegistry().aliasIndex.get(raw.toLowerCase().trim());
}

/** Every accepted network name, for CLI error messages. */
export function knownNetworkNames(): string[] {
  return getRegistry().all.map((ch) => ch.legacyName);
}

/** Build the viem Chain object for a definition (synthesised for Orbit). */
export function toViemChain(def: ChainDefinition, rpcUrl: string): Chain {
  const known = VIEM_CHAINS[def.id];
  if (known) return known;

  return defineChain({
    id: def.chainId,
    name: def.displayName,
    nativeCurrency: def.nativeCurrency ?? {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: { default: { http: [rpcUrl] } },
    ...(def.blockExplorer
      ? {
          blockExplorers: {
            default: { name: "Explorer", url: def.blockExplorer },
          },
        }
      : {}),
    testnet: def.testnet,
  });
}
