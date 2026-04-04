import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  recoverAddress,
  type Address,
} from "viem";
import crypto from "node:crypto";
import type { EIP3009Authorization, EIP3009Signature } from "./types.js";

const TRANSFER_AUTH_TYPEHASH = keccak256(
  encodePacked(
    ["string"],
    [
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    ]
  )
);

const EIP712_DOMAIN_TYPEHASH = keccak256(
  encodePacked(
    ["string"],
    [
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ]
  )
);

function buildDomainSeparator(
  name: string,
  version: string,
  chainId: number,
  contract: Address
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(encodePacked(["string"], [name])),
        keccak256(encodePacked(["string"], [version])),
        BigInt(chainId),
        contract,
      ]
    )
  );
}

function buildStructHash(auth: EIP3009Authorization): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, address, address, uint256, uint256, uint256, bytes32"
      ),
      [
        TRANSFER_AUTH_TYPEHASH,
        auth.from,
        auth.to,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
      ]
    )
  );
}

// secp256k1 half-order for malleability check
const SECP256K1_HALF_N = BigInt(
  "0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0"
);

export async function verifyTransferAuthorization(
  auth: EIP3009Authorization,
  sig: EIP3009Signature,
  tokenAddress: Address,
  tokenName: string,
  tokenVersion: string,
  chainId: number
): Promise<Address> {
  const domain = buildDomainSeparator(
    tokenName,
    tokenVersion,
    chainId,
    tokenAddress
  );
  const structHash = buildStructHash(auth);

  const digest = keccak256(
    encodePacked(["bytes1", "bytes1", "bytes32", "bytes32"], [
      "0x19",
      "0x01",
      domain,
      structHash,
    ])
  );

  // basic validity checks
  const v = sig.v;
  if (v !== 27 && v !== 28) throw new Error(`invalid v value: ${v}`);

  const sBn = BigInt(sig.s);
  if (sBn === 0n || sBn > SECP256K1_HALF_N) {
    throw new Error("s value out of range (malleable)");
  }

  const rBn = BigInt(sig.r);
  if (rBn === 0n) throw new Error("r value is zero");

  // pack into 65-byte sig
  const rHex = sig.r.slice(2).padStart(64, "0");
  const sHex = sig.s.slice(2).padStart(64, "0");
  const vHex = v.toString(16).padStart(2, "0");
  const fullSig = `0x${rHex}${sHex}${vHex}` as `0x${string}`;

  const recovered = await recoverAddress({ hash: digest, signature: fullSig });
  return recovered;
}

export function generateNonce(): `0x${string}` {
  return `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
}

// split a 65-byte hex signature into v, r, s
export function splitSignature(sig: string): EIP3009Signature {
  const clean = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (clean.length !== 130) {
    throw new Error(`expected 130 hex chars, got ${clean.length}`);
  }
  const r = `0x${clean.slice(0, 64)}` as `0x${string}`;
  const s = `0x${clean.slice(64, 128)}` as `0x${string}`;
  let v = parseInt(clean.slice(128, 130), 16);

  // normalize v from 0/1 to 27/28
  if (v < 27) v += 27;

  return { v, r, s };
}
