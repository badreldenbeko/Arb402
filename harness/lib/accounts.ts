// Deterministic accounts from Hardhat's default mnemonic
// ("test test test test test test test test test test test junk").
// These keys are PUBLIC and well-known — they exist only on local dev nodes.
export const ACCOUNTS = {
  // pays gas, runs transferWithAuthorization + transfer (the arb402 facilitator)
  facilitator: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  // signs the EIP-3009 authorization (gasless payer)
  payer: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  // receives the merchant's net amount
  merchant: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
} as const;

// Fixed dev-merchant API key + its bcrypt hash. The facilitator is started with
// DEV_MERCHANT_API_KEY_HASH set to this hash (see src/auth.ts dev fallback), so
// the harness can settle without a database. Dev/test only.
export const DEV_MERCHANT_API_KEY = "arb402-dev-merchant-key";
export const DEV_MERCHANT_API_KEY_HASH =
  "$2b$10$8BOB4k5piMi5OKcn4rhAwOybBtHgwGAE2JYmDtaoVdDXwfUTdKtbC";

export const RPC_URL = "http://127.0.0.1:8545";
export const CHAIN_ID = 421614;
export const FACILITATOR_URL = "http://127.0.0.1:3002";
