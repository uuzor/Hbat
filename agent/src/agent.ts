/**
 * Hedera Options Vault — AI Agent
 *
 * LangChain + Claude agent that can manage options positions via natural language.
 * Uses the Hedera Agent Kit pattern: tools wrap on-chain operations (vault calls,
 * Pyth updates) and the LLM handles intent parsing and risk reasoning.
 *
 * Example interactions:
 *   "Quote me a 7-day HBAR call at $0.15 for 10,000 HBAR"
 *   "What's my collateral balance?"
 *   "Hedge my HBAR by buying a put at $0.10 for next Friday"
 *   "Exercise option #5 if it's in the money"
 *   "Show me the vault status and current prices"
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { MessagesPlaceholder } from "@langchain/core/prompts";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

import {
  AI_PROVIDER,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
  OPTIONS_VAULT_ADDRESS,
} from "./config";
import { getOptionPriceTool } from "./tools/getOptionPrice";
import { writeOptionTool } from "./tools/writeOption";
import { exerciseOptionTool } from "./tools/exerciseOption";
import { vaultStatusTool } from "./tools/vaultStatus";

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert DeFi options trading assistant for the Hedera Options Vault.

You have access to the following on-chain capabilities:
1. **get_option_price** — Quote Black-Scholes premium + Greeks (Δ, Γ, ν, θ, ρ) using live Pyth prices
2. **write_option** — Write (sell) covered calls or cash-secured puts
3. **exercise_option** — Exercise in-the-money options for cash settlement
4. **vault_status** — Check live Pyth prices, collateral balances, and open positions

## Protocol Architecture:
- **Pyth Network**: Pull-oracle provides HBAR, BTC, ETH, XAU, EUR prices with <400ms latency
- **HIP-1215**: Options auto-expire via Hedera's native Schedule Service — no keeper bots needed
- **Hedera HSCS**: Smart contracts run at fixed fees (~$0.0001/tx), making frequent updates feasible
- **OptionToken**: ERC-721 NFTs (HOPT) represent option positions with on-chain SVG metadata

## Supported Underlyings:
| Symbol | Description           |
|--------|-----------------------|
| HBAR   | Hedera Hashgraph      |
| BTC    | Bitcoin               |
| ETH    | Ethereum              |
| XAU    | Gold (RWA)            |
| EUR    | Euro FX Rate          |

## Key Risk Reminders:
- **Writers** must have collateral deposited: covered call = spot×size, cash-secured put = strike×size
- **Options expire** automatically at the scheduled time via HIP-1215
- **Cash settlement**: no physical delivery, payout = intrinsic value × size
- **European-style**: exercise at expiry only (auto-executed by the protocol)

## Vault Address: ${OPTIONS_VAULT_ADDRESS || "[Deploy first: npm run deploy:testnet]"}

When users ask about options:
1. Always fetch live prices first before quoting
2. Explain the Greeks in plain language
3. Warn about out-of-the-money risks
4. Highlight Hedera's unique advantages (fixed fees, HIP-1215 automation, Pyth integration)
5. For write operations, confirm collateral sufficiency first via vault_status

Respond concisely. Use tables and structured output for Greeks/quotes.`;

// ── Agent Factory ─────────────────────────────────────────────────────────────

function buildLLM(): BaseChatModel {
  if (AI_PROVIDER === "openrouter") {
    console.log(`[Agent] Using OpenRouter (model: ${OPENROUTER_MODEL})`);
    return new ChatOpenAI({
      apiKey:      OPENROUTER_API_KEY,
      model:       OPENROUTER_MODEL,
      temperature: 0,
      maxTokens:   4096,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/hedera-options-vault",
          "X-Title":      "Hedera Options Vault Agent",
        },
      },
    }) as unknown as BaseChatModel;
  }

  if (AI_PROVIDER === "anthropic") {
    console.log(`[Agent] Using Anthropic (model: ${CLAUDE_MODEL})`);
    return new ChatAnthropic({
      apiKey:      ANTHROPIC_API_KEY,
      model:       CLAUDE_MODEL,
      temperature: 0,
      maxTokens:   4096,
    }) as unknown as BaseChatModel;
  }

  throw new Error(`AI provider "${AI_PROVIDER}" not yet supported`);
}

export async function createOptionsAgent(): Promise<AgentExecutor> {
  const llm = buildLLM();

  // Cast needed: DynamicStructuredTool schema types diverge from ToolInterface<StringInputToolSchema>
  // across langchain version combinations — runtime behaviour is correct.
  const tools: AnyTool[] = [
    getOptionPriceTool,
    writeOptionTool,
    exerciseOptionTool,
    vaultStatusTool,
  ];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM_PROMPT],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = await createReactAgent({
    llm,
    tools,
    prompt,
  });

  return new AgentExecutor({
    agent,
    tools,
    verbose:          process.env.DEBUG === "true",
    maxIterations:    8,
    returnIntermediateSteps: true,
  });
}

// ── Conversation Manager ──────────────────────────────────────────────────────

export class OptionsAgentSession {
  private executor!: AgentExecutor;
  private chatHistory: Array<HumanMessage | AIMessage> = [];

  async init(): Promise<void> {
    this.executor = await createOptionsAgent();
  }

  async chat(userMessage: string): Promise<string> {
    const result = await this.executor.invoke({
      input:        userMessage,
      chat_history: this.chatHistory,
    });

    // Maintain conversation history (last 20 messages to avoid context overflow)
    this.chatHistory.push(new HumanMessage(userMessage));
    this.chatHistory.push(new AIMessage(result.output as string));
    if (this.chatHistory.length > 20) {
      this.chatHistory = this.chatHistory.slice(-20);
    }

    return result.output as string;
  }

  clearHistory(): void {
    this.chatHistory = [];
  }
}
