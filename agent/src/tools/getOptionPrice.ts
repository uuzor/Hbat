/**
 * Tool: get_option_price
 * Fetches the real-time Black-Scholes price + Greeks for an option.
 * Uses Pyth pull-oracle for fresh spot price, then calls BlackScholes on-chain.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fetchPythPrice, formatWad } from "../utils/pyth";
import { getVaultContract, toWad, fromWad, parseOptionType, daysFromNow, formatGreeks } from "../utils/hedera";
import { DEFAULT_VOLATILITY, DEFAULT_EXPIRY_DAYS } from "../config";

export const getOptionPriceTool = tool(
  async ({ symbol, optionType, strikeUsd, expiryDays, sizeUnits, volatilityPct }) => {
    try {
      // 1. Fetch spot price from Pyth
      const pythPrice = await fetchPythPrice(symbol.toUpperCase());

      // 2. Build quote parameters
      const strikeWad   = toWad(strikeUsd);
      const sizeWad     = toWad(sizeUnits);
      const sigmaWad    = volatilityPct
        ? BigInt(Math.round(volatilityPct * 1e16)) // e.g. 80 → 0.80e18
        : DEFAULT_VOLATILITY;
      const expiry      = daysFromNow(expiryDays ?? DEFAULT_EXPIRY_DAYS);
      const optTypeIdx  = parseOptionType(optionType);

      const vault = getVaultContract();
      const result = await vault.quotePremium({
        symbol:     symbol.toUpperCase(),
        optionType: optTypeIdx,
        strikeWad,
        expiry,
        sizeWad,
        sigmaWad,
      });

      const premiumWad = result.premiumWad as bigint;
      const greeks     = result.greeks;

      const spotStr   = `$${pythPrice.price.toFixed(4)}`;
      const staleNote = !pythPrice.publishTime
        ? " (price may be stale)"
        : ` (Pyth age: ${Math.round(Date.now() / 1000 - pythPrice.publishTime)}s)`;

      return [
        `📊 Option Quote — ${symbol.toUpperCase()} ${optionType.toUpperCase()} $${strikeUsd}`,
        ``,
        `Spot Price:  ${spotStr}${staleNote}`,
        `Strike:      $${strikeUsd}`,
        `Size:        ${sizeUnits} units`,
        `Expiry:      ${expiryDays ?? DEFAULT_EXPIRY_DAYS} days`,
        `Volatility:  ${volatilityPct ?? 80}%`,
        ``,
        `── Premium & Greeks ──`,
        `Total Premium: $${fromWad(premiumWad)} (for ${sizeUnits} units)`,
        `Per Unit:      $${fromWad(premiumWad / BigInt(Math.round(sizeUnits)))}/unit`,
        ``,
        formatGreeks(greeks),
        ``,
        `Moneyness: ${pythPrice.price > strikeUsd ? "IN THE MONEY" : pythPrice.price < strikeUsd ? "OUT OF THE MONEY" : "AT THE MONEY"}`,
        ``,
        `⚡ Hedera advantage: Settlement auto-executed by HIP-1215 (no keeper bots).`,
      ].join("\n");
    } catch (err) {
      return `Error quoting option: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "get_option_price",
    description:
      "Get the real-time Black-Scholes fair-value price and Greeks (delta, gamma, vega, theta, rho) " +
      "for a call or put option on Hedera. Uses Pyth Network for the live spot price. " +
      "Useful for: quoting before buying/selling, checking moneyness, risk management.",
    schema: z.object({
      symbol: z
        .string()
        .describe("Underlying asset symbol. Supported: HBAR, BTC, ETH, XAU, EUR"),
      optionType: z
        .enum(["call", "put", "CALL", "PUT"])
        .describe("Option type: call (right to buy) or put (right to sell)"),
      strikeUsd: z
        .number()
        .positive()
        .describe("Strike price in USD (e.g. 0.15 for an HBAR $0.15 call)"),
      expiryDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Days until expiry (default: 7). Options auto-expire via HIP-1215."),
      sizeUnits: z
        .number()
        .positive()
        .describe("Number of underlying units (e.g. 1000 HBAR, or 0.01 BTC)"),
      volatilityPct: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Implied volatility as a percentage (e.g. 80 for 80%). Default: 80%."),
    }),
  }
);
