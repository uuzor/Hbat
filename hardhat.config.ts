import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "0x" + "0".repeat(64);
const TESTNET_OPERATOR_PRIVATE_KEY =
  process.env.TESTNET_OPERATOR_PRIVATE_KEY || "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    // Hedera Testnet (public JSON-RPC relay)
    testnet: {
      url: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
      accounts: [TESTNET_OPERATOR_PRIVATE_KEY],
      chainId: 296,
      gas: 4_000_000,
      gasPrice: 1_000_000_000, // 1 gwei (Hedera uses fixed fees, but ethers needs a value)
      timeout: 60_000,
    },
    // Hedera Mainnet
    mainnet: {
      url: process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api",
      accounts: [OPERATOR_PRIVATE_KEY],
      chainId: 295,
      gas: 4_000_000,
      gasPrice: 1_000_000_000,
      timeout: 60_000,
    },
    // Local Hedera mirror node (e.g., hedera-local-node)
    local: {
      url: "http://localhost:7546",
      accounts: [OPERATOR_PRIVATE_KEY],
      chainId: 298,
    },
    hardhat: {
      chainId: 31337,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
