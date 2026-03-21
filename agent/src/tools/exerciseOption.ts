/**
 * Tool: exercise_option
 * Builds an UNSIGNED transaction to exercise an in-the-money option position.
 * Fetches a fresh Pyth VAA, verifies moneyness, and returns calldata for the
 * user to sign with their own wallet — the backend never touches their key.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ethers } from "ethers";
import { fetchPythPrice, encodeUpdateData } from "../utils/pyth";
import { getVaultContractReadOnly, fromWad } from "../utils/hedera";

// @ts-ignore TS2589: Zod+LangChain inference depth — runtime is correct
export const exerciseOptionTool = tool(
  async ({ tokenId }) => {
    try {
      const vault = getVaultContractReadOnly();

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
          `Option #${tokenId} is OUT OF THE MONEY (${diff}).`,
          `Exercising OTM options results in a loss. Exercise only proceeds if you confirm.`,
          `Current intrinsic value: $0.00`,
        ].join("\n");
      }

      // 4. Estimate intrinsic value (read-only)
      const intrinsic = await vault.intrinsicValue(tokenId, pythPrice.priceWad);

      // 5. Encode unsigned calldata — user's wallet will sign this
      const calldata = vault.interface.encodeFunctionData("exercise", [
        tokenId,
        vaaBytes,
      ]);

      // 0.05 HBAR covers the Pyth update fee; excess is refunded by the vault
      const valueWei = ethers.parseEther("0.05").toString();

      const unsignedTx = {
        to:       vault.target as string,
        data:     calldata,
        value:    valueWei,  // in wei (1e-18 HBAR units)
        gasLimit: 500_000,
      };

      return [
        `Option #${tokenId} Ready to Exercise`,
        ``,
        `Underlying:       ${symbol}`,
        `Option Type:      ${isCall ? "CALL" : "PUT"}`,
        `Spot at Quote:    $${spotUsd.toFixed(4)}`,
        `Strike:           $${strikeUsd.toFixed(4)}`,
        ``,
        `Intrinsic Value:  $${fromWad(intrinsic as bigint)} per unit (estimated payout)`,
        ``,
        `Sign and submit the following transaction with your Hedera wallet (HashPack / Blade / MetaMask):`,
        ``,
        `\`\`\`unsigned-tx`,
        JSON.stringify(unsignedTx),
        `\`\`\``,
        ``,
        `Note: the Pyth price used on-chain will be the one in the VAA above (fetched just now).`,
        `Final payout = intrinsic value × size, paid from the writer's locked collateral.`,
      ].join("\n");
    } catch (err) {
      return `Error building exercise_option transaction: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "exercise_option",
    description:
      "Exercise an options position (OptionToken NFT) on Hedera. " +
      "Fetches the latest Pyth spot price, verifies the option is in-the-money, " +
      "and returns an UNSIGNED transaction for the user to sign with their own wallet. " +
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
