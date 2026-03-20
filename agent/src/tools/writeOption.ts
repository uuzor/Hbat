/**
 * Tool: write_option
 * Submits a transaction to the OptionsVault to write (sell) an option.
 * Fetches a fresh Pyth VAA, computes the premium on-chain, locks collateral,
 * and schedules auto-expiry via HIP-1215.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ethers } from "ethers";
import { fetchPythPrice, encodeUpdateData } from "../utils/pyth";
import {
  getVaultContract,
  toWad,
  fromWad,
  parseOptionType,
  daysFromNow,
  formatExpiry,
} from "../utils/hedera";
import { DEFAULT_VOLATILITY, DEFAULT_EXPIRY_DAYS, PYTH_FEEDS } from "../config";

export const writeOptionTool = tool(
  async ({
    symbol,
    optionType,
    strikeUsd,
    expiryDays,
    sizeUnits,
    volatilityPct,
    collateralToken,
    maxPremiumUsd,
  }) => {
    try {
      const upperSymbol = symbol.toUpperCase();

      // 1. Fetch fresh Pyth price + VAA
      const pythPrice = await fetchPythPrice(upperSymbol);
      const vaaBytes  = encodeUpdateData([pythPrice.vaa]);

      // 2. Build write parameters
      const strikeWad  = toWad(strikeUsd);
      const sizeWad    = toWad(sizeUnits);
      const sigmaWad   = volatilityPct
        ? BigInt(Math.round(volatilityPct * 1e16))
        : DEFAULT_VOLATILITY;
      const expiry     = daysFromNow(expiryDays ?? DEFAULT_EXPIRY_DAYS);
      const optTypeIdx = parseOptionType(optionType);
      const colToken   = collateralToken ?? ethers.ZeroAddress; // address(0) = HBAR

      const maxPremWad = maxPremiumUsd != null
        ? toWad(maxPremiumUsd)
        : toWad(9999999); // no effective cap if not specified

      const vault = getVaultContract();

      // 3. Estimate Pyth update fee
      const pythFeeWei = await vault.runner?.provider
        ?.call({
          to: await vault.getAddress(),
          data: vault.interface.encodeFunctionData("writeOption", [
            {
              symbol: upperSymbol,
              optionType: optTypeIdx,
              strikeWad,
              expiry,
              sizeWad,
              sigmaWad,
              collateralToken: colToken,
              pythUpdateData: vaaBytes,
            },
            maxPremWad,
          ]),
        })
        .catch(() => null);

      // 4. Send transaction
      const tx = await vault.writeOption(
        {
          symbol: upperSymbol,
          optionType: optTypeIdx,
          strikeWad,
          expiry,
          sizeWad,
          sigmaWad,
          collateralToken: colToken,
          pythUpdateData:  vaaBytes,
        },
        maxPremWad,
        {
          value: ethers.parseEther("0.1"), // HBAR for Pyth fee + premium (overpays, refunded)
          gasLimit: 1_000_000,
        }
      );

      console.log(`⏳ Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();

      // 5. Parse OptionWritten event
      const iface  = vault.interface;
      const events = receipt?.logs
        .map((log: { topics: string[]; data: string }) => {
          try { return iface.parseLog(log); } catch { return null; }
        })
        .filter(Boolean);

      const written = events?.find((e: { name: string } | null) => e?.name === "OptionWritten");

      if (!written) {
        return `✅ Transaction confirmed (${tx.hash}) but could not parse OptionWritten event.`;
      }

      const tokenId    = (written.args as { tokenId: bigint }).tokenId;
      const premiumWad = (written.args as { premiumWad: bigint }).premiumWad;
      const scheduleId = (written.args as { scheduleId: string }).scheduleId;

      return [
        `✅ Option Written Successfully!`,
        ``,
        `Option NFT:    #${tokenId} (OptionToken ERC-721)`,
        `Underlying:    ${upperSymbol}`,
        `Type:          ${optionType.toUpperCase()}`,
        `Strike:        $${strikeUsd}`,
        `Size:          ${sizeUnits} units`,
        `Expiry:        ${formatExpiry(expiry)} (${expiryDays ?? DEFAULT_EXPIRY_DAYS} days)`,
        `Premium Paid:  $${fromWad(premiumWad)} total`,
        ``,
        `🤖 HIP-1215 Auto-Expiry:`,
        `   Schedule ID: ${scheduleId !== ethers.ZeroAddress ? scheduleId : "N/A (scheduled off-chain)"}`,
        `   At expiry, Hedera consensus nodes will call expireOption(${tokenId}) automatically.`,
        `   No keeper bot needed — this is protocol-native automation.`,
        ``,
        `Transaction: ${tx.hash}`,
        `Gas used: ${receipt?.gasUsed?.toString() ?? "N/A"} (≈$${((Number(receipt?.gasUsed ?? 0) * 1e-9) * 0.0001).toFixed(6)} at Hedera fixed fees)`,
      ].join("\n");
    } catch (err) {
      return `Error writing option: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "write_option",
    description:
      "Write (sell) a covered call or cash-secured put option on Hedera. " +
      "This submits an on-chain transaction that: " +
      "(1) fetches a fresh Pyth price update, " +
      "(2) computes the Black-Scholes premium on-chain, " +
      "(3) locks your collateral in the vault, " +
      "(4) mints an OptionToken NFT to you, " +
      "(5) schedules automatic settlement via HIP-1215. " +
      "Requires: sufficient collateral deposited in the vault, and HBAR for gas/Pyth fees.",
    schema: z.object({
      symbol: z
        .string()
        .describe("Underlying asset: HBAR, BTC, ETH, XAU, EUR"),
      optionType: z
        .enum(["call", "put", "CALL", "PUT"])
        .describe("CALL: right to buy at strike. PUT: right to sell at strike."),
      strikeUsd: z
        .number()
        .positive()
        .describe("Strike price in USD"),
      expiryDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Days until expiry (1–365, default: 7)"),
      sizeUnits: z
        .number()
        .positive()
        .describe("Notional size in units of underlying (e.g., 1000 HBAR)"),
      volatilityPct: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Implied volatility % (default: 80). Higher vol → higher premium."),
      collateralToken: z
        .string()
        .optional()
        .describe(
          "ERC-20 collateral token address. Omit (or use address(0)) to use native HBAR."
        ),
      maxPremiumUsd: z
        .number()
        .positive()
        .optional()
        .describe(
          "Maximum premium (USD) you're willing to pay. Protects against price movement between quote and execution."
        ),
    }),
  }
);
