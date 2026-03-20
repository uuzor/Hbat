#!/usr/bin/env ts-node
/**
 * Hedera Options Vault — Interactive Agent CLI
 *
 * Start: npm run agent
 *
 * Example commands:
 *   > vault status
 *   > quote HBAR call strike 0.15 expiry 7 days size 10000
 *   > what are my collateral balances for 0xYOUR_ADDRESS?
 *   > write a covered HBAR call at $0.18 strike, 14 days, 5000 HBAR
 *   > exercise option #3
 *   > show me all Greeks for a BTC put at $90000
 */

import * as readline from "readline/promises";
import { OptionsAgentSession } from "./agent";

const BANNER = `
╔══════════════════════════════════════════════════════════╗
║        HEDERA OPTIONS VAULT  —  Agentic DeFi             ║
║                                                          ║
║  Pyth Network  ×  HIP-1215  ×  Hedera Agent Kit          ║
║  Black-Scholes on-chain  ×  Keeperless settlement        ║
╚══════════════════════════════════════════════════════════╝

Type your request in plain English. Examples:
  "Show me the current HBAR price"
  "Quote a 7-day HBAR $0.15 call for 10,000 HBAR"
  "What's the intrinsic value of option #2?"
  "Write a covered call: HBAR, $0.18 strike, 14 days, 5000 HBAR"
  "Exercise option #5"

Type 'exit' or Ctrl+C to quit. Type 'clear' to reset conversation.
`;

async function main(): Promise<void> {
  console.log(BANNER);

  const session = new OptionsAgentSession();

  process.stdout.write("Initialising agent...");
  await session.init();
  console.log(" ready!\n");

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  const cleanup = () => {
    rl.close();
    process.exit(0);
  };

  process.on("SIGINT",  cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    let input: string;
    try {
      input = (await rl.question("You > ")).trim();
    } catch {
      break;
    }

    if (!input) continue;
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") break;
    if (input.toLowerCase() === "clear") {
      session.clearHistory();
      console.log("Conversation cleared.\n");
      continue;
    }

    try {
      process.stdout.write("Agent > ");
      const response = await session.chat(input);
      console.log(response);
      console.log();
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  cleanup();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
