import type { Wallet } from "ethers";

export interface Eip3009Auth {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string; // bytes32 hex
}

// EIP-712 typed-data for EIP-3009 TransferWithAuthorization. The domain MUST match
// the facilitator's verifier and the token contract: name "USD Coin", version "2".
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Sign an EIP-3009 authorization, returning a 65-byte hex signature. */
export async function signTransferAuthorization(
  signer: Wallet,
  token: string,
  chainId: number,
  auth: Eip3009Auth
): Promise<string> {
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId,
    verifyingContract: token,
  };
  return signer.signTypedData(domain, TYPES, {
    from: auth.from,
    to: auth.to,
    value: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce,
  });
}
