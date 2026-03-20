import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ── Hedera Network ────────────────────────────────────────────────────────────

export const HEDERA_NETWORK        = (process.env.HEDERA_NETWORK || "testnet") as "mainnet" | "testnet" | "local";
export const OPERATOR_ACCOUNT_ID   = process.env["OPERATOR_ACCOUNT_ID"]  || "";
export const OPERATOR_PRIVATE_KEY  = process.env["OPERATOR_PRIVATE_KEY"] || "";
export const HEDERA_TESTNET_RPC    = process.env.HEDERA_TESTNET_RPC  || "https://testnet.hashio.io/api";
export const HEDERA_MAINNET_RPC    = process.env.HEDERA_MAINNET_RPC  || "https://mainnet.hashio.io/api";
export const HEDERA_MIRROR_NODE    = process.env.HEDERA_MIRROR_NODE  || "https://testnet.mirrornode.hedera.com";

// ── Deployed Contracts ────────────────────────────────────────────────────────

export const OPTIONS_VAULT_ADDRESS = process.env.OPTIONS_VAULT_ADDRESS || "";
export const OPTION_TOKEN_ADDRESS  = process.env.OPTION_TOKEN_ADDRESS  || "";

// ── Pyth Oracle ───────────────────────────────────────────────────────────────

export const PYTH_HERMES_ENDPOINT  = process.env.PYTH_HERMES_ENDPOINT || "https://hermes.pyth.network";
export const PYTH_CONTRACT_ADDRESS = process.env.PYTH_CONTRACT_ADDRESS || "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729";

/// Pyth price feed IDs (Hedera testnet)
export const PYTH_FEEDS: Record<string, `0x${string}`> = {
  "HBAR": "0x35c946f7a4e8ab7ad6f0e47699c0fb79bd57820f25c3e42ee4ea2aa54bd8b7f8",
  "BTC":  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH":  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "XAU":  "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  "EUR":  "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30",
  "USDC": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

// ── Claude AI ─────────────────────────────────────────────────────────────────

export const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
export const CLAUDE_MODEL      = "claude-opus-4-6"; // Latest and most capable for financial reasoning

// ── Protocol Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_RISK_FREE_RATE = BigInt(process.env.DEFAULT_RISK_FREE_RATE || "50000000000000000"); // 5%
export const DEFAULT_VOLATILITY     = BigInt(process.env.DEFAULT_VOLATILITY     || "800000000000000000"); // 80%
export const DEFAULT_EXPIRY_DAYS    = Number(process.env.DEFAULT_EXPIRY_DURATION_DAYS || "7");

export const WAD = BigInt("1000000000000000000"); // 1e18
