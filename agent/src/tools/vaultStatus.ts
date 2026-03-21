/**
 * Tool: vault_status
 * Query live vault state: collateral balances, open positions, accrued fees,
 * and live Pyth prices for all supported underlyings.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fetchPythPrices } from "../utils/pyth";
import { getVaultContractReadOnly, fromWad, formatExpiry } from "../utils/hedera";
import { ethers } from "ethers";
import { PYTH_FEEDS } from "../config";

// @ts-ignore TS2589: Zod+LangChain inference depth — runtime is correct
export const vaultStatusTool = tool(
  async ({ address, tokenIds }) => {
    try {
      const vault = getVaultContractReadOnly();
      const lines: string[] = [];

      // ── Live Pyth Prices ──
      lines.push("📡 Live Pyth Prices:");
      try {
        const symbols = Object.keys(PYTH_FEEDS);
        const prices  = await fetchPythPrices(symbols);
        for (const p of prices) {
          const age = Math.round(Date.now() / 1000 - p.publishTime);
          lines.push(`  ${p.symbol.padEnd(6)} $${p.price.toFixed(6).padStart(12)}  (age: ${age}s)`);
        }
      } catch (e) {
        lines.push(`  [Error fetching prices: ${e}]`);
      }
      lines.push("");

      // ── Collateral Balances ──
      if (address) {
        lines.push(`💰 Collateral Balances for ${address}:`);

        // HBAR collateral
        const hbarBal = await vault.availableCollateral(address, ethers.ZeroAddress);
        lines.push(`  HBAR (native): ${fromWad(hbarBal as bigint)} HBAR`);

        lines.push("");
      }

      // ── Vault Global State ──
      lines.push("🏦 Vault State:");
      const rateWad = await vault.riskFreeRateWad();
      lines.push(`  Risk-Free Rate:  ${(Number(rateWad) / 1e16).toFixed(2)}%`);

      const symbols = await vault.getSupportedSymbols();
      lines.push(`  Supported Feeds: ${(symbols as string[]).join(", ")}`);

      // Protocol fee balances
      const hbarFees = await vault.accruedFees(ethers.ZeroAddress);
      lines.push(`  Accrued Fees (HBAR): ${fromWad(hbarFees as bigint)} HBAR`);

      lines.push("");

      // ── Open Positions ──
      if (tokenIds && tokenIds.length > 0) {
        lines.push("📋 Position Details:");
        for (const id of tokenIds) {
          try {
            const pos = await vault.getPosition(id);
            const isCall  = Number(pos.optionType) === 0;
            const settled = pos.settled as boolean;
            lines.push(`  Option #${id}: ${pos.symbol} ${isCall ? "CALL" : "PUT"}`);
            lines.push(`    Strike: $${fromWad(pos.strikeWad as bigint)}`);
            lines.push(`    Size:   ${fromWad(pos.sizeWad as bigint)} units`);
            lines.push(`    Expiry: ${formatExpiry(Number(pos.expiry))}`);
            lines.push(`    Status: ${settled ? "✅ Settled" : "🔵 Active"}`);
            if (!settled && (pos.scheduleId as string) !== ethers.ZeroAddress) {
              lines.push(`    HIP-1215 Schedule: ${pos.scheduleId}`);
            }
          } catch {
            lines.push(`  Option #${id}: not found or error`);
          }
        }
        lines.push("");
      }

      lines.push("⚡ Network: Hedera (fixed fees ≈ $0.0001/tx | Fair Ordering | HIP-1215 native automation)");

      return lines.join("\n");
    } catch (err) {
      return `Error fetching vault status: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "vault_status",
    description:
      "Query the current state of the Hedera Options Vault: " +
      "live Pyth prices for all supported assets (HBAR, BTC, ETH, XAU, EUR), " +
      "your collateral balances, open option positions, and protocol statistics. " +
      "Use this to check prices before trading or to monitor your portfolio.",
    schema: z.object({
      address: z
        .string()
        .optional()
        .describe("EVM address to check collateral balances for. Omit to skip balance check."),
      tokenIds: z
        .array(z.number().int().nonnegative())
        .optional()
        .describe("Option NFT token IDs to show detailed position info for"),
    }),
  }
);
