import { parseAbi, type PublicClient, type Address } from "viem";
import { buildDomainSeparator } from "./eip3009.js";

/**
 * On-chain verification of a settlement token (M7).
 *
 * Adding a chain to the registry is a claim; this is the check. Two failures
 * are invisible until money moves, so both are caught here instead:
 *
 *   - **No EIP-3009.** `transferWithAuthorization` is the entire basis of the
 *     gasless flow. Bridged tokens usually lack it — Arbitrum Nova's USDC.e is
 *     a plain gateway ERC-20, so it looks like USDC (6 decimals, a symbol, a
 *     DOMAIN_SEPARATOR) and cannot settle a single payment.
 *   - **Wrong EIP-712 domain.** If the configured (name, version) disagree with
 *     the contract's, every signature recovers to a wrong address. There is no
 *     revert reason for this; it just reads as "signer mismatch" forever.
 *
 * `authorizationState(address,bytes32)` is the cheap tell for the first: it is
 * a view function mandated by EIP-3009, so a static call that reverts means the
 * token does not implement the standard. For the second, we recompute the
 * domain separator from the configured values and compare it to the one the
 * contract reports.
 */

const PROBE_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

// any address/nonce works — we only care whether the call reverts
const PROBE_AUTHORIZER = "0x0000000000000000000000000000000000000001" as const;
const PROBE_NONCE = `0x${"00".repeat(32)}` as `0x${string}`;

export interface TokenProbe {
  address: Address;
  /** Undefined when the contract does not expose the getter. */
  symbol?: string;
  onChainName?: string;
  onChainVersion?: string;
  decimals?: number;
  domainSeparator?: `0x${string}`;
  /** True only if `authorizationState` is callable — the EIP-3009 marker. */
  supportsEip3009: boolean;
  /**
   * Whether the configured (name, version, chainId, address) reproduce the
   * contract's DOMAIN_SEPARATOR. Undefined when the token doesn't expose one,
   * in which case the domain can't be checked and must be trusted.
   */
  domainMatches?: boolean;
  /** The separator implied by the configured values, for error messages. */
  expectedDomainSeparator: `0x${string}`;
  /** Human-readable problems, empty when the token is fully usable. */
  problems: string[];
  /** Non-fatal observations (e.g. domain unverifiable). */
  warnings: string[];
}

async function tryRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export interface ProbeOptions {
  address: Address;
  chainId: number;
  /** Configured EIP-712 domain name. */
  tokenName: string;
  /** Configured EIP-712 domain version. */
  tokenVersion: string;
  /** Expected decimals (6 for USDC). */
  expectedDecimals?: number;
}

export async function probeToken(
  client: PublicClient,
  opts: ProbeOptions
): Promise<TokenProbe> {
  const { address, chainId, tokenName, tokenVersion } = opts;
  const expectedDecimals = opts.expectedDecimals ?? 6;

  const read = <K extends "name" | "symbol" | "decimals" | "version" | "DOMAIN_SEPARATOR">(
    functionName: K
  ) =>
    tryRead(() =>
      client.readContract({ address, abi: PROBE_ABI, functionName }) as Promise<unknown>
    );

  const [name, symbol, decimals, version, domainSeparator] = await Promise.all([
    read("name"),
    read("symbol"),
    read("decimals"),
    read("version"),
    read("DOMAIN_SEPARATOR"),
  ]);

  const supportsEip3009 =
    (await tryRead(() =>
      client.readContract({
        address,
        abi: PROBE_ABI,
        functionName: "authorizationState",
        args: [PROBE_AUTHORIZER, PROBE_NONCE],
      })
    )) !== undefined;

  const expectedDomainSeparator = buildDomainSeparator(
    tokenName,
    tokenVersion,
    chainId,
    address
  );

  const problems: string[] = [];
  const warnings: string[] = [];

  // no bytecode at all is the most common misconfiguration (wrong chain, or a
  // token address copied from a different network), so name it specifically
  const hasAnyGetter =
    name !== undefined || symbol !== undefined || decimals !== undefined;
  if (!hasAnyGetter) {
    problems.push(
      `no ERC-20 contract responded at ${address} — check USDC_ADDRESS and that the RPC points at chain ${chainId}`
    );
  }

  if (!supportsEip3009) {
    problems.push(
      `token does not implement EIP-3009 (authorizationState reverted) — ` +
        `arb402 settles via transferWithAuthorization and cannot use this token`
    );
  }

  if (decimals !== undefined && Number(decimals) !== expectedDecimals) {
    problems.push(
      `expected ${expectedDecimals} decimals, got ${Number(decimals)} — ` +
        `amounts would be off by 10^${Math.abs(Number(decimals) - expectedDecimals)}`
    );
  }

  let domainMatches: boolean | undefined;
  if (domainSeparator !== undefined) {
    domainMatches =
      (domainSeparator as string).toLowerCase() ===
      expectedDomainSeparator.toLowerCase();
    if (!domainMatches) {
      const hint =
        name !== undefined
          ? ` — the contract reports name="${String(name)}"${
              version !== undefined ? `, version="${String(version)}"` : ""
            }; set USDC_NAME / USDC_VERSION to match`
          : "";
      problems.push(
        `EIP-712 domain mismatch: configured name="${tokenName}", version="${tokenVersion}" ` +
          `produce ${expectedDomainSeparator}, but the contract reports ${domainSeparator}${hint}`
      );
    }
  } else if (supportsEip3009) {
    warnings.push(
      `token does not expose DOMAIN_SEPARATOR — the EIP-712 domain ` +
        `("${tokenName}", "${tokenVersion}") could not be verified on-chain`
    );
  }

  return {
    address,
    symbol: symbol as string | undefined,
    onChainName: name as string | undefined,
    onChainVersion: version as string | undefined,
    decimals: decimals === undefined ? undefined : Number(decimals),
    domainSeparator: domainSeparator as `0x${string}` | undefined,
    supportsEip3009,
    domainMatches,
    expectedDomainSeparator,
    problems,
    warnings,
  };
}
