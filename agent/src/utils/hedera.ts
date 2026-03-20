/**
 * Hedera client utilities.
 * Wraps ethers.js JsonRpcProvider configured for Hedera's JSON-RPC relay.
 * Also provides Hedera SDK utilities for HTS and account queries.
 */

import { ethers } from "ethers";
import {
  HEDERA_NETWORK,
  HEDERA_TESTNET_RPC,
  HEDERA_MAINNET_RPC,
  OPERATOR_PRIVATE_KEY,
  OPTIONS_VAULT_ADDRESS,
  PYTH_CONTRACT_ADDRESS,
} from "../config";

// ── ABIs (minimal, for agent use) ────────────────────────────────────────────

// Minimal OptionsVault ABI for the agent
export const VAULT_ABI = [
  // View functions
  "function quotePremium((string symbol, uint8 optionType, uint256 strikeWad, uint256 expiry, uint256 sizeWad, uint256 sigmaWad) q) view returns (uint256 premiumWad, tuple(uint256 premium, int256 delta, uint256 gamma, uint256 vega, int256 theta, int256 rho) greeks)",
  "function getPosition(uint256 tokenId) view returns (tuple(uint256 tokenId, bytes32 feedId, string symbol, uint8 optionType, uint256 strikeWad, uint256 expiry, uint256 sizeWad, uint256 premiumWad, address writer, address buyer, address collateralToken, uint256 collateralWad, address scheduleId, bool settled))",
  "function availableCollateral(address writer, address token) view returns (uint256)",
  "function intrinsicValue(uint256 tokenId, uint256 spotWad) view returns (uint256)",
  "function getSupportedSymbols() view returns (string[])",
  "function riskFreeRateWad() view returns (uint256)",
  "function accruedFees(address) view returns (uint256)",
  // State-changing
  "function depositHBAR() payable",
  "function depositERC20(address token, uint256 amount)",
  "function withdrawCollateral(address token, uint256 amount)",
  "function writeOption((string symbol, uint8 optionType, uint256 strikeWad, uint256 expiry, uint256 sizeWad, uint256 sigmaWad, address collateralToken, bytes[] pythUpdateData) wp, uint256 maxPremium) payable returns (uint256 tokenId, uint256 premiumWad)",
  "function exercise(uint256 tokenId, bytes[] pythUpdateData) payable",
  "function expireOption(uint256 tokenId)",
  // Events
  "event OptionWritten(uint256 indexed tokenId, address indexed writer, address indexed buyer, string symbol, uint8 optionType, uint256 strikeWad, uint256 sizeWad, uint256 expiry, uint256 premiumWad, address scheduleId)",
  "event OptionExercised(uint256 indexed tokenId, address indexed exerciser, uint256 spotWad, uint256 payoutWad)",
  "event OptionExpired(uint256 indexed tokenId, bool automated)",
] as const;

export const OPTION_TOKEN_ABI = [
  "function getOption(uint256 tokenId) view returns (tuple(bytes32 feedId, string underlyingSymbol, uint8 optionType, uint256 strikeWad, uint256 expiry, uint256 sizeWad, uint256 premiumWad, address writer, address collateralToken, address scheduleId, uint8 status, uint256 createdAt))",
  "function isActive(uint256 tokenId) view returns (bool)",
  "function isPastExpiry(uint256 tokenId) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
] as const;

export const PYTH_ABI = [
  "function getPriceUnsafe(bytes32 id) view returns (tuple(int64 price, uint64 conf, int32 expo, uint publishTime))",
  "function getPriceNoOlderThan(bytes32 id, uint age) view returns (tuple(int64 price, uint64 conf, int32 expo, uint publishTime))",
  "function getUpdateFee(bytes[] updateData) view returns (uint feeAmount)",
  "function updatePriceFeeds(bytes[] updateData) payable",
] as const;

// ── Provider / Signer ─────────────────────────────────────────────────────────

function getRpcUrl(): string {
  if (HEDERA_NETWORK === "mainnet") return HEDERA_MAINNET_RPC;
  return HEDERA_TESTNET_RPC;
}

let _provider: ethers.JsonRpcProvider | undefined;
let _signer:   ethers.Wallet | undefined;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(getRpcUrl());
  }
  return _provider;
}

export function getSigner(): ethers.Wallet {
  if (!_signer) {
    if (!OPERATOR_PRIVATE_KEY) {
      throw new Error("OPERATOR_PRIVATE_KEY not set. This agent builds unsigned transactions for user wallets — no operator key is required for normal operation.");
    }
    _signer = new ethers.Wallet(OPERATOR_PRIVATE_KEY, getProvider());
  }
  return _signer;
}

// ── Contract Instances ────────────────────────────────────────────────────────

export function getVaultContract(address = OPTIONS_VAULT_ADDRESS): ethers.Contract {
  if (!address) throw new Error("OPTIONS_VAULT_ADDRESS not set in .env");
  return new ethers.Contract(address, VAULT_ABI, getSigner());
}

/// Read-only vault contract — no private key required.
/// Use this for view calls and building unsigned transactions.
export function getVaultContractReadOnly(address = OPTIONS_VAULT_ADDRESS): ethers.Contract {
  if (!address) throw new Error("OPTIONS_VAULT_ADDRESS not set in .env");
  return new ethers.Contract(address, VAULT_ABI, getProvider());
}

export function getPythContract(address = PYTH_CONTRACT_ADDRESS): ethers.Contract {
  return new ethers.Contract(address, PYTH_ABI, getProvider());
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export const WAD = BigInt("1000000000000000000");

export function toWad(value: number | string): bigint {
  const [whole, frac = ""] = String(value).split(".");
  const fracPadded = frac.padEnd(18, "0").slice(0, 18);
  return BigInt(whole!) * WAD + BigInt(fracPadded);
}

export function fromWad(wad: bigint, decimals = 6): string {
  const whole = wad / WAD;
  const frac  = ((wad % WAD) * BigInt(10 ** decimals)) / WAD;
  return `${whole}.${frac.toString().padStart(decimals, "0")}`;
}

/// Parse an option type string to enum index.
export function parseOptionType(type: string): number {
  const t = type.toUpperCase();
  if (t === "CALL" || t === "C") return 0;
  if (t === "PUT"  || t === "P") return 1;
  throw new Error(`Unknown option type: ${type}. Use CALL or PUT.`);
}

/// Format a UNIX timestamp as a human-readable date.
export function formatExpiry(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().split("T")[0]!;
}

/// Convert days from now to UNIX timestamp.
export function daysFromNow(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86400;
}

/// Pretty-print Greek values from the vault.
export function formatGreeks(greeks: {
  premium: bigint;
  delta:   bigint;
  gamma:   bigint;
  vega:    bigint;
  theta:   bigint;
  rho:     bigint;
}): string {
  return [
    `Premium: $${fromWad(greeks.premium)}`,
    `Delta:   ${fromWad(greeks.delta, 4)}`,
    `Gamma:   ${fromWad(greeks.gamma, 6)}`,
    `Vega:    ${fromWad(greeks.vega, 4)} per 1% vol`,
    `Theta:   ${fromWad(greeks.theta, 4)} per day`,
    `Rho:     ${fromWad(greeks.rho,   4)} per 1% rate`,
  ].join("\n");
}
