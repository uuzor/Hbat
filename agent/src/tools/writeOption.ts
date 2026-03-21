/**
 * Tool: write_option
 * Builds an UNSIGNED transaction to write (sell) an option via the OptionsVault.
 * The agent computes the premium and returns the calldata for the user to sign
 * with their own wallet (HashPack, Blade, MetaMask on Hedera, etc.).
 *
 * No private key is ever needed by the backend for this operation.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ethers } from "ethers";
import { fetchPythPrice, encodeUpdateData } from "../utils/pyth";
import {
  getVaultContractReadOnly,
  toWad,
  fromWad,
  parseOptionType,
  daysFromNow,
  formatExpiry,
} from "../utils/hedera";
import { DEFAULT_VOLATILITY, DEFAULT_EXPIRY_DAYS, OPTIONS_VAULT_ADDRESS } from "../config";

// @ts-ignore TS2589: Zod+LangChain inference depth — runtime is correct
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

      const vault = getVaultContractReadOnly();

      // 3. Get an on-chain premium quote so the user knows what to expect
      let premiumQuote = "unknown";
      try {
        const [premWad] = await vault.quotePremium({
          symbol: upperSymbol,
          optionType: optTypeIdx,
          strikeWad,
          expiry,
          sizeWad,
          sigmaWad,
        });
        premiumQuote = `$${fromWad(premWad as bigint)}`;
      } catch {
        // quotePremium is best-effort — doesn't block tx building
      }

      // 4. Encode unsigned calldata — user's wallet will sign this
      const writeParams = {
        symbol: upperSymbol,
        optionType: optTypeIdx,
        strikeWad,
        expiry,
        sizeWad,
        sigmaWad,
        collateralToken: colToken,
        pythUpdateData: vaaBytes,
      };

      const calldata = vault.interface.encodeFunctionData("writeOption", [
        writeParams,
        maxPremWad,
      ]);

      // 0.1 HBAR covers the Pyth update fee + option premium; excess is refunded by the vault
      const valueWei = ethers.parseEther("0.1").toString();

      const unsignedTx = {
        to:       vault.target as string,
        data:     calldata,
        value:    valueWei,  // in wei (1e-18 HBAR units)
        gasLimit: 1_000_000,
      };

      return [
        `Option Ready to Sign`,
        ``,
        `Underlying:    ${upperSymbol}`,
        `Type:          ${optionType.toUpperCase()}`,
        `Strike:        $${strikeUsd}`,
        `Size:          ${sizeUnits} units`,
        `Expiry:        ${formatExpiry(expiry)} (${expiryDays ?? DEFAULT_EXPIRY_DAYS} days)`,
        `Est. Premium:  ${premiumQuote}`,
        ``,
        `Sign and submit the following transaction with your Hedera wallet (HashPack / Blade / MetaMask):`,
        ``,
        `\`\`\`unsigned-tx`,
        JSON.stringify(unsignedTx),
        `\`\`\``,
        ``,
        `The vault will refund any excess HBAR after deducting the Pyth fee and actual premium.`,
        `Upon confirmation, you will receive an OptionToken NFT representing this position.`,
      ].join("\n");
    } catch (err) {
      return `Error building write_option transaction: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "write_option",
    description:
      "Write (sell) a covered call or cash-secured put option on Hedera. " +
      "This builds an UNSIGNED transaction that: " +
      "(1) fetches a fresh Pyth price update, " +
      "(2) quotes the Black-Scholes premium on-chain, " +
      "(3) returns calldata for the user to sign with their own wallet. " +
      "The user's wallet signs and submits — the backend never touches their private key. " +
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
