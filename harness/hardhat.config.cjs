/**
 * Minimal Hardhat config (CommonJS so no ts-node is needed).
 * The local node runs at chainId 421614 so the arb402 facilitator's
 * Arbitrum-Sepolia chain checks pass against it. No forking required —
 * the harness deploys its own TestUSDC, so the run is fully self-contained.
 *
 * @type {import('hardhat/config').HardhatUserConfig}
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 421614,
    },
  },
};
