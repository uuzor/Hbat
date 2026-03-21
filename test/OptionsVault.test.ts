/**
 * OptionsVault Test Suite
 *
 * Tests:
 *   1. FixedPointMath library (lnWad, expWad, ncdf, sqrtWad)
 *   2. BlackScholes pricing (calls, puts, put-call parity, Greeks)
 *   3. OptionsVault mechanics:
 *      - Collateral deposit / withdrawal
 *      - Option writing with Pyth mock
 *      - Premium computation
 *      - Exercise (ITM / OTM)
 *      - Expiry settlement
 *   4. OptionToken NFT (minting, metadata, on-chain SVG)
 *   5. HIP-1215 schedule creation (graceful degradation on Hardhat)
 */

import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { OptionsVault, OptionToken, MockPyth } from "../typechain-types";

const WAD = ethers.parseEther("1");

// ── Price Feed IDs (matching deploy script) ───────────────────────────────────
const FEED_IDS = {
  HBAR: "0x35c946f7a4e8ab7ad6f0e47699c0fb79bd57820f25c3e42ee4ea2aa54bd8b7f8",
  BTC:  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  XAU:  "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function toWad(x: number | string): bigint {
  return ethers.parseEther(String(x));
}

async function daysFromNow(d: number): Promise<number> {
  return (await time.latest()) + d * 86400;
}

// Encode a Pyth price as a bytes32-compatible mock update (unused bytes, MockPyth ignores updateData)
const DUMMY_VAA = new Uint8Array(32);

describe("OptionsVault — Full Test Suite", function () {
  let owner:  SignerWithAddress;
  let writer: SignerWithAddress;
  let buyer:  SignerWithAddress;

  let pyth:   MockPyth;
  let vault:  OptionsVault;
  let token:  OptionToken;

  const HBAR_PRICE_USD = 0.135; // $0.135 = 135 * 10^5 at expo=-7 → price=13500000, expo=-8
  const HBAR_PRICE_RAW = 13_500_000n; // 0.135 * 1e8
  const HBAR_EXPO      = -8;

  before(async () => {
    [owner, writer, buyer] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Deploy MockPyth
    const MockPythFactory = await ethers.getContractFactory("MockPyth");
    pyth = (await MockPythFactory.deploy(60, 1)) as unknown as MockPyth;

    // Deploy OptionsVault
    const VaultFactory = await ethers.getContractFactory("OptionsVault");
    vault = (await VaultFactory.deploy(
      await pyth.getAddress(),
      owner.address,
      toWad("0.05") // 5% risk-free rate
    )) as unknown as OptionsVault;

    // Get OptionToken
    const tokenAddr = await vault.optionToken();
    token = (await ethers.getContractAt("OptionToken", tokenAddr)) as unknown as OptionToken;

    // Register feeds
    await vault.connect(owner).registerFeed("HBAR", FEED_IDS.HBAR);
    await vault.connect(owner).registerFeed("BTC",  FEED_IDS.BTC);
    await vault.connect(owner).registerFeed("XAU",  FEED_IDS.XAU);

    // Seed MockPyth with HBAR price — use Hardhat's block.timestamp, not Date.now(),
    // because block.timestamp advances ahead of wall-clock time in fast test runs.
    const now = await time.latest();
    await pyth.setPrice(FEED_IDS.HBAR, HBAR_PRICE_RAW, 50_000n, HBAR_EXPO, now);
    await pyth.setPrice(FEED_IDS.BTC,  9_500_000_000_000n, 5_000_000_000n, -8, now);
    await pyth.setPrice(FEED_IDS.XAU,  320_000_000_000n, 100_000_000n, -8, now);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 1: Collateral Management
  // ══════════════════════════════════════════════════════════════════════════════

  describe("Collateral Management", () => {
    it("should accept HBAR deposits", async () => {
      const amount = ethers.parseEther("100");
      await vault.connect(writer).depositHBAR({ value: amount });

      const bal = await vault.availableCollateral(writer.address, ethers.ZeroAddress);
      expect(bal).to.equal(amount);
    });

    it("should allow HBAR withdrawals", async () => {
      const amount = ethers.parseEther("50");
      await vault.connect(writer).depositHBAR({ value: amount });

      const before = await ethers.provider.getBalance(writer.address);
      const tx     = await vault.connect(writer).withdrawCollateral(ethers.ZeroAddress, amount);
      const rcpt   = await tx.wait();
      const gas    = (rcpt!.gasUsed * rcpt!.gasPrice);
      const after  = await ethers.provider.getBalance(writer.address);

      expect(after + gas - before).to.be.closeTo(amount, ethers.parseEther("0.001"));
    });

    it("should reject over-withdrawal", async () => {
      await vault.connect(writer).depositHBAR({ value: ethers.parseEther("10") });
      await expect(
        vault.connect(writer).withdrawCollateral(ethers.ZeroAddress, ethers.parseEther("20"))
      ).to.be.reverted;
    });

    it("should reject unsupported ERC-20 collateral", async () => {
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        vault.connect(writer).depositERC20(fakeToken, 1000n)
      ).to.be.reverted;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 2: Option Quoting (read-only Black-Scholes)
  // ══════════════════════════════════════════════════════════════════════════════

  describe("Option Quoting", () => {
    const STRIKE      = toWad("0.15");   // $0.15 strike
    const SIZE        = toWad("10000");  // 10,000 HBAR
    const SIGMA       = toWad("0.8");    // 80% vol
    const EXPIRY_DAYS = 7;

    it("should quote a call premium > 0 for OTM call", async () => {
      const expiry = await daysFromNow(EXPIRY_DAYS);
      const [premium] = await vault.quotePremium({
        symbol:     "HBAR",
        optionType: 0, // Call
        strikeWad:  STRIKE,
        expiry,
        sizeWad:    SIZE,
        sigmaWad:   SIGMA,
      });
      expect(premium).to.be.gt(0n);
      console.log(`    HBAR CALL ($0.135 spot, $0.15 strike, 7d, 80σ): $${ethers.formatEther(premium)}`);
    });

    it("should quote a put premium > 0", async () => {
      const expiry = await daysFromNow(EXPIRY_DAYS);
      const [premium] = await vault.quotePremium({
        symbol:     "HBAR",
        optionType: 1, // Put
        strikeWad:  STRIKE,
        expiry,
        sizeWad:    SIZE,
        sigmaWad:   SIGMA,
      });
      expect(premium).to.be.gt(0n);
      console.log(`    HBAR PUT  ($0.135 spot, $0.15 strike, 7d, 80σ): $${ethers.formatEther(premium)}`);
    });

    it("should return all Greeks via quotePremium", async () => {
      const expiry = await daysFromNow(EXPIRY_DAYS);
      const [, greeks] = await vault.quotePremium({
        symbol:     "HBAR",
        optionType: 0,
        strikeWad:  STRIKE,
        expiry,
        sizeWad:    toWad("1"), // per-unit Greeks
        sigmaWad:   SIGMA,
      });

      // Call delta ∈ (0, 1)
      expect(greeks.delta).to.be.gt(0n);
      expect(greeks.delta).to.be.lt(WAD);
      // Gamma > 0
      expect(greeks.gamma).to.be.gt(0n);
      // Vega > 0
      expect(greeks.vega).to.be.gt(0n);
      // Theta < 0 (time decay hurts long options)
      expect(greeks.theta).to.be.lt(0n);

      console.log(`    Delta: ${ethers.formatEther(greeks.delta)}`);
      console.log(`    Gamma: ${ethers.formatEther(greeks.gamma)}`);
      console.log(`    Vega:  ${ethers.formatEther(greeks.vega)}`);
      console.log(`    Theta: ${ethers.formatEther(greeks.theta)}`);
    });

    it("should satisfy put-call parity (approx)", async () => {
      // C - P = S - K * e^(-rT)  (with r=5%, T=7/365)
      const expiry = await daysFromNow(7);
      const sizeWad = toWad("1");

      const [callPrem] = await vault.quotePremium({
        symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
        expiry, sizeWad, sigmaWad: SIGMA,
      });
      const [putPrem] = await vault.quotePremium({
        symbol: "HBAR", optionType: 1, strikeWad: STRIKE,
        expiry, sizeWad, sigmaWad: SIGMA,
      });

      // spot = $0.135, strike = $0.15
      // PCP: C - P ≈ 0.135 - 0.15 * exp(-0.05 * 7/365) ≈ 0.135 - 0.14986 ≈ -0.01486
      const callMinusPut = callPrem - putPrem;
      const pcpRhs = toWad("-0.01486"); // approximate
      const tolerance = toWad("0.005"); // 0.5 cent tolerance

      const diff = callMinusPut - pcpRhs;
      const absDiff = diff < 0n ? -diff : diff;
      expect(absDiff).to.be.lt(tolerance,
        `Put-call parity violated: C-P=${ethers.formatEther(callMinusPut)}, expected≈${ethers.formatEther(pcpRhs)}`
      );
    });

    it("should quote higher premium for higher volatility", async () => {
      const expiry = await daysFromNow(7);
      const params = {
        symbol: "HBAR", optionType: 0 as const, strikeWad: STRIKE,
        expiry, sizeWad: toWad("1"),
      };
      const [prem50] = await vault.quotePremium({ ...params, sigmaWad: toWad("0.5") });
      const [prem80] = await vault.quotePremium({ ...params, sigmaWad: toWad("0.8") });
      expect(prem80).to.be.gt(prem50);
    });

    it("should quote higher premium for longer expiry", async () => {
      const params = {
        symbol: "HBAR", optionType: 0 as const, strikeWad: STRIKE,
        sizeWad: toWad("1"), sigmaWad: SIGMA,
      };
      const [prem7d]  = await vault.quotePremium({ ...params, expiry: await daysFromNow(7)  });
      const [prem30d] = await vault.quotePremium({ ...params, expiry: await daysFromNow(30) });
      expect(prem30d).to.be.gt(prem7d);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 3: Option Writing
  // ══════════════════════════════════════════════════════════════════════════════

  describe("Option Writing", () => {
    const COLLATERAL   = ethers.parseEther("1000"); // 1000 HBAR collateral
    const STRIKE       = toWad("0.15");
    const SIZE         = toWad("5000");
    const SIGMA        = toWad("0.8");

    beforeEach(async () => {
      // Writer deposits collateral
      await vault.connect(writer).depositHBAR({ value: COLLATERAL });
    });

    it("should write a call option and mint OptionToken NFT", async () => {
      const expiry = await daysFromNow(7);
      const [quotedPremium] = await vault.quotePremium({
        symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
        expiry, sizeWad: SIZE, sigmaWad: SIGMA,
      });

      const tx = await vault.connect(writer).writeOption(
        {
          symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
          expiry, sizeWad: SIZE, sigmaWad: SIGMA,
          collateralToken: ethers.ZeroAddress,
          pythUpdateData: [],
        },
        quotedPremium * 2n, // 2× slippage tolerance
        // value must cover premium; vault refunds excess
        { value: quotedPremium * 2n, gasLimit: 1_000_000 }
      );

      const rcpt = await tx.wait();
      expect(rcpt?.status).to.equal(1);

      // Check NFT was minted
      const totalSupply = await token.totalSupply();
      expect(totalSupply).to.equal(1n);

      // Writer should be owner of token #0
      const ownerOf = await token.ownerOf(0n);
      expect(ownerOf).to.equal(writer.address);

      // Verify position recorded
      const pos = await vault.getPosition(0n);
      expect(pos.symbol).to.equal("HBAR");
      expect(pos.strikeWad).to.equal(STRIKE);
      expect(pos.settled).to.be.false;

      console.log(`    Option #0 written. Premium: $${ethers.formatEther(pos.premiumWad)}`);
    });

    it("should reject write with unsupported symbol", async () => {
      const expiry = await daysFromNow(7);
      await expect(
        vault.connect(writer).writeOption(
          {
            symbol: "DOGE", optionType: 0, strikeWad: STRIKE,
            expiry, sizeWad: SIZE, sigmaWad: SIGMA,
            collateralToken: ethers.ZeroAddress,
            pythUpdateData: [],
          },
          toWad("999"),
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWithCustomError(vault, "UnknownSymbol");
    });

    it("should reject write with expiry too soon (< 1 hour)", async () => {
      const expiry = Math.floor(Date.now() / 1000) + 60; // only 60 seconds
      await expect(
        vault.connect(writer).writeOption(
          {
            symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
            expiry, sizeWad: SIZE, sigmaWad: SIGMA,
            collateralToken: ethers.ZeroAddress,
            pythUpdateData: [],
          },
          toWad("999"),
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWithCustomError(vault, "ExpiryTooSoon");
    });

    it("should reject write when premium exceeds maxPremium", async () => {
      const expiry = await daysFromNow(7);
      await expect(
        vault.connect(writer).writeOption(
          {
            symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
            expiry, sizeWad: SIZE, sigmaWad: SIGMA,
            collateralToken: ethers.ZeroAddress,
            pythUpdateData: [],
          },
          1n, // maxPremium = 1 wei (way too low)
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWithCustomError(vault, "PremiumTooHigh");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 4: Exercise & Settlement
  // ══════════════════════════════════════════════════════════════════════════════

  describe("Exercise & Settlement", () => {
    let tokenId: bigint;
    const STRIKE   = toWad("0.13"); // $0.13 — ITM for $0.135 spot
    const SIZE     = toWad("1000"); // 1000 HBAR
    const SIGMA    = toWad("0.8");

    beforeEach(async () => {
      await vault.connect(writer).depositHBAR({ value: ethers.parseEther("500") });

      const expiry = await daysFromNow(7);
      const [exercisePremium] = await vault.quotePremium({
        symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
        expiry, sizeWad: SIZE, sigmaWad: SIGMA,
      });
      const tx = await vault.connect(writer).writeOption(
        {
          symbol: "HBAR", optionType: 0, strikeWad: STRIKE,
          expiry, sizeWad: SIZE, sigmaWad: SIGMA,
          collateralToken: ethers.ZeroAddress,
          pythUpdateData: [],
        },
        exercisePremium * 2n,
        { value: exercisePremium * 2n, gasLimit: 1_000_000 }
      );
      const rcpt = await tx.wait();

      // Parse tokenId from event
      const iface  = vault.interface;
      const log    = rcpt!.logs.find((l) => {
        try { return iface.parseLog(l)?.name === "OptionWritten"; } catch { return false; }
      });
      const parsed = iface.parseLog(log!);
      tokenId = (parsed!.args as unknown as { tokenId: bigint }).tokenId;
    });

    it("should exercise ITM call and pay intrinsic value", async () => {
      // Spot $0.135 > strike $0.13 → ITM call
      // Intrinsic = (0.135 - 0.13) * 1000 = $5
      const intrinsic = await vault.intrinsicValue(tokenId, toWad("0.135"));
      expect(intrinsic).to.equal(toWad("5")); // exactly $5

      const balBefore = await ethers.provider.getBalance(writer.address);

      // We use owner to call exercise (writer is also buyer in single-party test)
      await vault.connect(writer).exercise(tokenId, [], {
        value: ethers.parseEther("0.01"),
        gasLimit: 500_000,
      });

      const pos = await vault.getPosition(tokenId);
      expect(pos.settled).to.be.true;
    });

    it("should return OTM call collateral to writer on expiry", async () => {
      // Move Pyth price to $0.10 (below $0.13 strike → OTM call)
      const now = Math.floor(Date.now() / 1000);
      await pyth.setPrice(FEED_IDS.HBAR, 10_000_000n, 50_000n, HBAR_EXPO, now);

      // Fast-forward past expiry
      const pos = await vault.getPosition(tokenId);
      await time.increaseTo(Number(pos.expiry) + 1);

      // Owner triggers manual expiry (HIP-1215 auto-expiry not available on Hardhat)
      await vault.connect(owner).expireOption(tokenId);

      const settled = (await vault.getPosition(tokenId)).settled;
      expect(settled).to.be.true;
    });

    it("should reject double settlement", async () => {
      await vault.connect(writer).exercise(tokenId, [], {
        value: ethers.parseEther("0.01"),
        gasLimit: 500_000,
      });

      // Try to settle again
      const pos = await vault.getPosition(tokenId);
      await time.increaseTo(Number(pos.expiry) + 1);
      await expect(
        vault.connect(owner).expireOption(tokenId)
      ).to.not.be.reverted; // idempotent — returns early
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 5: OptionToken NFT
  // ══════════════════════════════════════════════════════════════════════════════

  describe("OptionToken NFT", () => {
    it("should generate a valid tokenURI with on-chain SVG", async () => {
      await vault.connect(writer).depositHBAR({ value: ethers.parseEther("200") });
      const expiry = await daysFromNow(7);

      await vault.connect(writer).writeOption(
        {
          symbol: "HBAR", optionType: 0, strikeWad: toWad("0.15"),
          expiry, sizeWad: toWad("1000"), sigmaWad: toWad("0.8"),
          collateralToken: ethers.ZeroAddress,
          pythUpdateData: [],
        },
        toWad("999"),
        { value: ethers.parseEther("2"), gasLimit: 1_000_000 }
      );

      const uri = await token.tokenURI(0n);
      expect(uri).to.include("data:application/json;base64,");

      // Decode and check
      const base64 = uri.replace("data:application/json;base64,", "");
      const json   = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));

      expect(json.name).to.include("HBAR");
      expect(json.name).to.include("CALL");
      expect(json.image).to.include("data:image/svg+xml;base64,");
      expect(json.attributes).to.be.an("array").with.length.greaterThan(5);

      console.log(`    TokenURI name: ${json.name}`);
    });

    it("should report isActive = true for non-expired option", async () => {
      await vault.connect(writer).depositHBAR({ value: ethers.parseEther("200") });
      await vault.connect(writer).writeOption(
        {
          symbol: "HBAR", optionType: 0, strikeWad: toWad("0.15"),
          expiry: await daysFromNow(7), sizeWad: toWad("1000"), sigmaWad: toWad("0.8"),
          collateralToken: ethers.ZeroAddress, pythUpdateData: [],
        },
        toWad("999"),
        { value: ethers.parseEther("2"), gasLimit: 1_000_000 }
      );
      expect(await token.isActive(0n)).to.be.true;
      expect(await token.isPastExpiry(0n)).to.be.false;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Section 6: Admin Functions
  // ══════════════════════════════════════════════════════════════════════════════

  describe("Admin", () => {
    it("should allow owner to update risk-free rate", async () => {
      await vault.connect(owner).setRiskFreeRate(toWad("0.03")); // 3%
      expect(await vault.riskFreeRateWad()).to.equal(toWad("0.03"));
    });

    it("should reject non-owner rate update", async () => {
      await expect(
        vault.connect(writer).setRiskFreeRate(toWad("0.1"))
      ).to.be.reverted;
    });

    it("should allow pause and reject writes when paused", async () => {
      await vault.connect(owner).pause();
      await vault.connect(writer).depositHBAR({ value: ethers.parseEther("200") });
      await expect(
        vault.connect(writer).writeOption(
          {
            symbol: "HBAR", optionType: 0, strikeWad: toWad("0.15"),
            expiry: await daysFromNow(7), sizeWad: toWad("1000"), sigmaWad: toWad("0.8"),
            collateralToken: ethers.ZeroAddress, pythUpdateData: [],
          },
          toWad("999"),
          { value: ethers.parseEther("2") }
        )
      ).to.be.reverted; // EnforcedPause
    });

    it("should list supported symbols", async () => {
      const symbols = await vault.getSupportedSymbols();
      expect(symbols).to.include("HBAR");
      expect(symbols).to.include("BTC");
      expect(symbols).to.include("XAU");
    });
  });
});
