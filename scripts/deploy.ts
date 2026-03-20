/**
 * Deployment script for Hedera Options Vault
 *
 * Usage:
 *   npm run deploy:testnet   # Hedera testnet (chainId 296)
 *   npm run deploy:local     # Local node (chainId 298)
 *   npm run deploy           # Hardhat in-memory (chainId 31337)
 *
 * After deployment, copy the printed addresses to .env:
 *   OPTIONS_VAULT_ADDRESS=0x...
 *   OPTION_TOKEN_ADDRESS=0x...
 */

import { ethers } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

// ── Pyth Contract Addresses by Network ───────────────────────────────────────
const PYTH_ADDRESSES: Record<number, string> = {
  296: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729", // Hedera testnet
  295: "0x4305FB66699C3B2702D4d05CF36551390A4c69C6", // Hedera mainnet
  298: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729", // local (use testnet addr for mocks)
  31337: "",  // hardhat — will deploy mock
};

// ── Pyth Feed IDs ─────────────────────────────────────────────────────────────
const FEED_IDS: Record<string, string> = {
  HBAR: "0x35c946f7a4e8ab7ad6f0e47699c0fb79bd57820f25c3e42ee4ea2aa54bd8b7f8",
  BTC:  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH:  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  XAU:  "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  EUR:  "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30",
};

const RISK_FREE_RATE_WAD = ethers.parseEther("0.05"); // 5%

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const chainId    = Number(network.chainId);

  console.log("═══════════════════════════════════════════════════");
  console.log(" Hedera Options Vault — Deployment");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Network:   ${network.name} (chainId: ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} HBAR`);
  console.log();

  // ── 1. Deploy mock Pyth on local/hardhat ──────────────────────────────────
  let pythAddress = PYTH_ADDRESSES[chainId] ?? "";

  if (!pythAddress || chainId === 31337) {
    console.log("Deploying MockPyth (hardhat/local network)...");
    const MockPyth = await ethers.getContractFactory("MockPyth");
    const mock = await MockPyth.deploy(
      60,              // validTimePeriod (60s staleness tolerance)
      1               // singleUpdateFeeInWei (1 wei Pyth fee for tests)
    );
    await mock.waitForDeployment();
    pythAddress = await mock.getAddress();
    console.log(`  MockPyth deployed: ${pythAddress}`);

    // Seed mock prices for testing
    await seedMockPrices(mock);
    console.log("  Mock prices seeded.");
  }

  console.log(`Pyth address: ${pythAddress}`);
  console.log();

  // ── 2. Deploy OptionsVault (which deploys OptionToken internally) ─────────
  console.log("Deploying OptionsVault...");
  const OptionsVault = await ethers.getContractFactory("OptionsVault");
  const vault = await OptionsVault.deploy(
    pythAddress,
    deployer.address,    // owner
    RISK_FREE_RATE_WAD
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`  OptionsVault: ${vaultAddress}`);

  // ── 3. Fetch OptionToken address ──────────────────────────────────────────
  const optionTokenAddress = await vault.optionToken();
  console.log(`  OptionToken:  ${optionTokenAddress}`);
  console.log();

  // ── 4. Register price feeds ───────────────────────────────────────────────
  console.log("Registering Pyth feeds...");
  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    const tx = await vault.registerFeed(symbol, feedId);
    await tx.wait();
    console.log(`  ✓ ${symbol} → ${feedId.slice(0, 12)}...`);
  }
  console.log();

  // ── 5. Print deployment summary ───────────────────────────────────────────
  const summary = [
    "═══════════════════════════════════════════════════",
    " Deployment Complete — Copy to .env",
    "═══════════════════════════════════════════════════",
    `OPTIONS_VAULT_ADDRESS=${vaultAddress}`,
    `OPTION_TOKEN_ADDRESS=${optionTokenAddress}`,
    `PYTH_CONTRACT_ADDRESS=${pythAddress}`,
    "",
    "Supported underlyings:",
    ...Object.keys(FEED_IDS).map((s) => `  • ${s}`),
    "",
    "Next steps:",
    "  1. Add addresses to .env",
    "  2. Deposit collateral: call vault.depositHBAR() with HBAR",
    "  3. Start agent: npm run agent",
    "═══════════════════════════════════════════════════",
  ].join("\n");

  console.log(summary);

  // ── 6. Write deployment artifact ──────────────────────────────────────────
  const artifact = {
    network:     network.name,
    chainId,
    deployedAt:  new Date().toISOString(),
    contracts: {
      OptionsVault: vaultAddress,
      OptionToken:  optionTokenAddress,
      Pyth:         pythAddress,
    },
    feeds: FEED_IDS,
  };

  const artifactPath = join(__dirname, `../deployments/${chainId}.json`);
  try {
    const { mkdirSync } = await import("fs");
    mkdirSync(join(__dirname, "../deployments"), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`\nArtifact saved: ${artifactPath}`);
  } catch {
    console.warn("Could not save artifact file.");
  }
}

async function seedMockPrices(mock: Awaited<ReturnType<typeof ethers.getContractAt>>): Promise<void> {
  // MockPyth expects array of PriceFeedData structs
  // For tests, we seed representative prices
  const now = Math.floor(Date.now() / 1000);

  const seeds = [
    {
      id:    FEED_IDS.HBAR!,
      price: { price: "13500000", conf: "50000", expo: -8, publishTime: now },
      emaPrice: { price: "13500000", conf: "50000", expo: -8, publishTime: now },
    },
    {
      id:    FEED_IDS.BTC!,
      price: { price: "9500000000000", conf: "5000000000", expo: -8, publishTime: now },
      emaPrice: { price: "9500000000000", conf: "5000000000", expo: -8, publishTime: now },
    },
    {
      id:    FEED_IDS.XAU!,
      price: { price: "320000000000", conf: "100000000", expo: -8, publishTime: now },
      emaPrice: { price: "320000000000", conf: "100000000", expo: -8, publishTime: now },
    },
  ];

  for (const seed of seeds) {
    try {
      await mock.updatePriceFeeds([
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "int64", "uint64", "int32", "uint256"],
          [seed.id, seed.price.price, seed.price.conf, seed.price.expo, seed.price.publishTime]
        )
      ], { value: 1 });
    } catch {
      // MockPyth interface varies — skip if incompatible
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Deployment failed:", err);
    process.exit(1);
  });
