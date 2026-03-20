/**
 * Tool: exercise_option
 * Exercise an in-the-money option position. Fetches a fresh Pyth VAA
 * and submits the exercise transaction to the vault.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ethers } from "ethers";
import { fetchPythPrice, encodeUpdateData } from "../utils/pyth";
import { getVaultContract, fromWad } from "../utils/hedera";

export const exerciseOptionTool = tool(
  async ({ tokenId }) => {
    try {
      const vault    = getVaultContract();

      // 1. Load position details
      const pos = await vault.getPosition(tokenId);
      if (pos.settled) {
        return `Option #${tokenId} is already settled (exercised or expired).`;
      }

      const now    = Math.floor(Date.now() / 1000);
      const expiry = Number(pos.expiry);
      if (now > expiry) {
        return `Option #${tokenId} is past expiry. Use the vault's expireOption() instead.`;
      }

      const symbol = pos.symbol as string;

      // 2. Fetch fresh Pyth price + VAA
      const pythPrice = await fetchPythPrice(symbol);
      const vaaBytes  = encodeUpdateData([pythPrice.vaa]);

      // 3. Determine moneyness
      const spotUsd   = pythPrice.price;
      const strikeUsd = Number(fromWad(pos.strikeWad as bigint));
      const isCall    = Number(pos.optionType) === 0;
      const itm = isCall ? spotUsd > strikeUsd : spotUsd < strikeUsd;

      if (!itm) {
        const diff = isCall
          ? `spot $${spotUsd.toFixed(4)} < strike $${strikeUsd.toFixed(4)}`
          : `spot $${spotUsd.toFixed(4)} > strike $${strikeUsd.toFixed(4)}`;
        return [
          `⚠️  Option #${tokenId} is OUT OF THE MONEY (${diff}).`,
          `Exercising OTM options results in a loss. Exercise only proceeds if you confirm.`,
          `Current intrinsic value: $0.00`,
        ].join("\n");
      }

      // 4. Estimate intrinsic value
      const intrinsic = await vault.intrinsicValue(tokenId, pythPrice.priceWad);

      // 5. Submit exercise transaction
      const tx = await vault.exercise(tokenId, vaaBytes, {
        value: ethers.parseEther("0.05"), // HBAR for Pyth update fee
        gasLimit: 500_000,
      });

      console.log(`⏳ Exercise transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();

      // 6. Parse OptionExercised event
      const iface  = vault.interface;
      const events = receipt?.logs
        .map((log: { topics: string[]; data: string }) => {
          try { return iface.parseLog(log); } catch { return null; }
        })
        .filter(Boolean);

      const exercised = events?.find((e: { name: string } | null) => e?.name === "OptionExercised");

      const payoutWad = exercised
        ? (exercised.args as { payoutWad: bigint }).payoutWad
        : intrinsic as bigint;

      return [
        `✅ Option #${tokenId} Exercised!`,
        ``,
        `Underlying:    ${symbol}`,
        `Option Type:   ${isCall ? "CALL" : "PUT"}`,
        `Spot at Exercise: $${spotUsd.toFixed(4)}`,
        `Strike:           $${strikeUsd.toFixed(4)}`,
        ``,
        `Intrinsic Value: $${fromWad(intrinsic as bigint)} per unit`,
        `Total Payout:    $${fromWad(payoutWad)} (cash settled)`,
        ``,
        `Transaction: ${tx.hash}`,
      ].join("\n");
    } catch (err) {
      return `Error exercising option: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "exercise_option",
    description:
      "Exercise an options position (OptionToken NFT) on Hedera. " +
      "Fetches the latest Pyth spot price, verifies the option is in-the-money, " +
      "and submits an exercise transaction for cash settlement. " +
      "The payout (intrinsic value × size) is transferred from the locked collateral.",
    schema: z.object({
      tokenId: z
        .number()
        .int()
        .nonnegative()
        .describe("The OptionToken NFT ID to exercise"),
    }),
  }
);
