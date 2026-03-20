# Hedera Options Vault

> **Agentic, Keeperless Options Protocol on Hedera**
> Built for the Hello Future Apex Hackathon 2026 — Onchain Finance & RWA Track

---

## What Is This?

A decentralised options vault where:

1. **Users deposit collateral** (HBAR, USDC, or FRNT) and write covered calls / cash-secured puts.
2. **Black-Scholes pricing** runs on-chain using Pyth Network's real-time price feeds.
3. **Options auto-expire and settle** via **HIP-1215** (Hedera's native Protocol Automation) — no keeper bots, no Gelato, no Chainlink Automation. The Hedera consensus nodes handle it.
4. **An AI agent** (Claude + Hedera Agent Kit pattern) lets users manage positions via natural language.

---

## Hedera Stack

| Layer | Component | Role |
|-------|-----------|------|
| Smart Contracts | Hedera Smart Contract Service (HSCS) | Vault logic in Solidity |
| Automation | **HIP-1215** (HSS Precompile) | Keeperless option expiry |
| Oracle | **Pyth Network** (pull-oracle) | HBAR, BTC, ETH, XAU, EUR price feeds |
| Tokens | **HTS** + ERC-721 (**OptionToken**) | NFT option positions |
| AI Agent | Claude API + LangChain | Natural-language trading interface |
| Fair Ordering | Hedera consensus | Prevents front-running on liquidations |
| Fees | Fixed ($0.0001/tx) | Makes frequent Greek updates viable |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     OptionsVault.sol                          │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │   Collateral │   │  Black-Scholes│   │  HIP-1215 HSS   │  │
│  │   (HBAR /    │   │  Pricing     │   │  Auto-Expiry    │  │
│  │   USDC /     │   │  (on-chain)  │   │  Scheduler      │  │
│  │   FRNT)      │   │              │   │                 │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬────────┘  │
│         │                  │                     │           │
│         ▼                  ▼                     ▼           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Pyth Network (Pull Oracle)               │   │
│  │  HBAR · BTC · ETH · XAU (Gold) · EUR/USD            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  OptionToken.sol (ERC-721 NFT with on-chain SVG metadata)   │
└──────────────────────────────────────────────────────────────┘
                           ▲
                           │
            ┌──────────────────────────┐
            │   AI Agent (LangChain)   │
            │   Claude claude-opus-4-6         │
            │                          │
            │  Tools:                  │
            │  • get_option_price      │
            │  • write_option          │
            │  • exercise_option       │
            │  • vault_status          │
            └──────────────────────────┘
```

---

## Why Options on Hedera Wins

### vs. Ethereum
| Feature | Ethereum Options (e.g. Lyra) | Hedera Options Vault |
|---------|------------------------------|----------------------|
| Auto-expiry | Chainlink Keepers ($$$) | **HIP-1215** (native, free) |
| Oracle | Chainlink push (~$0.50/update) | **Pyth pull** ($0.0001/update) |
| Greek updates | $5–50/tx | **$0.0001/tx** (fixed) |
| Front-running | MEV bots exploit liquidations | **Fair Ordering** prevents this |
| Settlement | Manual or keeper | **Fully autonomous** |

### The HIP-1215 Advantage
When you write an option, the vault calls `scheduleCall()` on the Hedera Schedule Service precompile. At expiry, Hedera consensus nodes automatically call `expireOption(tokenId)` — no external infrastructure needed. This is a first-of-its-kind feature for DeFi derivatives.

---

## Quick Start

### Prerequisites
- Node.js 20+
- A Hedera testnet account ([portal.hedera.com](https://portal.hedera.com))
- HBAR testnet tokens (free from the faucet)
- Anthropic API key

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Fill in OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, ANTHROPIC_API_KEY
```

### 3. Compile
```bash
npm run compile
```

### 4. Test (Hardhat local)
```bash
npm test
```

### 5. Deploy to Hedera Testnet
```bash
npm run deploy:testnet
# Copy the printed addresses to .env
```

### 6. Start the AI Agent
```bash
npm run agent
```

Example conversation:
```
You > show me the current HBAR price and quote a 7-day $0.15 call for 10,000 HBAR

Agent > 📊 Option Quote — HBAR CALL $0.15
        Spot Price:  $0.1352 (Pyth age: 2s)
        Strike:      $0.15
        Size:        10000 units
        Expiry:      7 days
        Volatility:  80%

        ── Premium & Greeks ──
        Total Premium: $42.18 (for 10000 units)
        Per Unit:      $0.004218/unit

        Delta:   0.3241
        Gamma:   0.0000
        Vega:    0.1823 per 1% vol
        Theta:   -0.0061 per day
        Rho:     0.0142 per 1% rate

        Moneyness: OUT OF THE MONEY
        ⚡ Hedera advantage: Settlement auto-executed by HIP-1215 (no keeper bots).
```

---

## Supported Underlyings

| Symbol | Description | Pyth Feed ID |
|--------|-------------|--------------|
| HBAR   | Hedera Hashgraph | `0x35c946...` |
| BTC    | Bitcoin | `0xe62df6...` |
| ETH    | Ethereum | `0xff6149...` |
| XAU    | Gold (RWA) | `0x765d2b...` |
| EUR    | Euro / USD FX | `0xa995d0...` |

---

## Contract Architecture

### `OptionsVault.sol`
Main protocol contract. Handles:
- Collateral deposits (HBAR + ERC-20)
- Option writing with BSM premium computation
- Exercise and settlement
- HIP-1215 scheduling

### `OptionToken.sol`
ERC-721 NFT representing option positions. Each token:
- Encodes all option terms (strike, expiry, type, size)
- Generates fully on-chain SVG artwork via `tokenURI()`
- Tracks lifecycle: Active → Exercised / Expired

### `libraries/BlackScholes.sol`
On-chain BSM implementation using WAD fixed-point math:
- `price(params)` → premium + all 5 Greeks (Δ, Γ, ν, θ, ρ)
- `impliedVolatility()` → Newton-Raphson IV solver
- `secondsToAnnualised()` → time conversion utility

### `libraries/FixedPointMath.sol`
WAD (1e18) math primitives:
- `lnWad`, `expWad` — accurate to < 1e-15 relative error
- `ncdf` — Abramowitz & Stegun normal CDF (error < 7.5e-8)
- `sqrtWad` — Babylonian method
- `pythPriceToWad` — Pyth price format conversion

---

## RWA & Institutional Focus

The XAU (gold) feed from Pyth enables options on **tokenised real-world assets** — directly aligned with Hedera's Governing Council (DBS, DTCC, Google) and the hackathon's RWA track. Users can hedge gold exposure on-chain at Hedera's fixed-fee infrastructure.

The FRNT (Wyoming Frontier Stable Token) integration as collateral demonstrates Hedera's native stablecoin ecosystem support.

---

## License

MIT

---

*Built for the Hello Future Apex Hackathon 2026 — Onchain Finance & RWA Track*
*$250,000 prize pool | Feb 17 – March 23, 2026 | [hellofuturehackathon.dev](https://hellofuturehackathon.dev)*
