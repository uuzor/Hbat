/**
 * Pyth Network utilities for Hedera.
 *
 * Pull-oracle workflow:
 *   1. Fetch signed VAA(s) from the Hermes REST API (off-chain).
 *   2. Submit the VAA(s) to the Pyth on-chain contract via updatePriceFeeds().
 *   3. Read the cached price via getPriceNoOlderThan().
 *
 * Hermes API docs: https://hermes.pyth.network/docs
 * Hedera Pyth contract: 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729 (testnet)
 */

import { PYTH_HERMES_ENDPOINT, PYTH_FEEDS } from "../config";

export interface PythPrice {
  symbol:      string;
  feedId:      string;
  price:       number;      // Real price (float)
  priceWad:    bigint;      // Price in WAD (1e18)
  confidence:  number;      // ±confidence (float)
  expo:        number;      // Power-of-10 exponent
  publishTime: number;      // UNIX timestamp
  vaa:         string;      // Base64-encoded signed VAA for on-chain submission
}

export interface HermesLatestResponse {
  binary: {
    encoding: string;
    data:     string[];     // VAA bytes (hex or base64 depending on encoding)
  };
  parsed: Array<{
    id:        string;
    price: {
      price:       string;
      conf:        string;
      expo:        number;
      publish_time: number;
    };
    ema_price: {
      price:       string;
      conf:        string;
      expo:        number;
      publish_time: number;
    };
  }>;
}

/// Fetch the latest price for one or more symbols from the Hermes API.
export async function fetchPythPrices(
  symbols: string[]
): Promise<PythPrice[]> {
  const feedIds = symbols.map((s) => {
    const id = PYTH_FEEDS[s.toUpperCase()];
    if (!id) throw new Error(`Unknown symbol: ${s}. Supported: ${Object.keys(PYTH_FEEDS).join(", ")}`);
    return id;
  });

  const params = new URLSearchParams();
  feedIds.forEach((id) => params.append("ids[]", id));

  const url = `${PYTH_HERMES_ENDPOINT}/v2/updates/price/latest?${params.toString()}&encoding=hex&parsed=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Hermes API error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as HermesLatestResponse;

  return json.parsed.map((feed, i) => {
    const symbol  = symbols[i];
    const rawPrice = parseInt(feed.price.price, 10);
    const expo     = feed.price.expo;
    const realPrice = rawPrice * Math.pow(10, expo);
    const priceWad  = pythRawToWad(BigInt(feed.price.price), expo);

    return {
      symbol,
      feedId:      feedIds[i],
      price:       realPrice,
      priceWad,
      confidence:  parseInt(feed.price.conf, 10) * Math.pow(10, expo),
      expo,
      publishTime: feed.price.publish_time,
      vaa:         json.binary.data[i] ?? "",
    };
  });
}

/// Fetch a single price by symbol.
export async function fetchPythPrice(symbol: string): Promise<PythPrice> {
  const prices = await fetchPythPrices([symbol]);
  return prices[0]!;
}

/// Convert a raw Pyth price (price * 10^expo) to WAD (1e18).
export function pythRawToWad(rawPrice: bigint, expo: number): bigint {
  const WAD = BigInt("1000000000000000000");
  if (expo >= 0) {
    return rawPrice * BigInt(10 ** expo) * WAD;
  } else {
    const divisor = BigInt(10 ** (-expo));
    return (rawPrice * WAD) / divisor;
  }
}

/// Format a WAD value as a human-readable string with N decimal places.
export function formatWad(wad: bigint, decimals = 4): string {
  const WAD = BigInt("1000000000000000000");
  const whole = wad / WAD;
  const frac  = wad % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  return `${whole}.${fracStr}`;
}

/// Convert VAA hex strings to bytes arrays suitable for Solidity.
export function vaasToBytes(vaas: string[]): `0x${string}`[] {
  return vaas.map((v) => (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`);
}

/// Encode VAA bytes for updatePriceFeeds call.
export function encodeUpdateData(vaas: string[]): `0x${string}`[] {
  return vaasToBytes(vaas);
}

/// Check if a price is fresh (within maxAge seconds).
export function isPriceFresh(publishTime: number, maxAgeSecs = 60): boolean {
  return Date.now() / 1000 - publishTime < maxAgeSecs;
}
