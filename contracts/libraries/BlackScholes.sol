// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FixedPointMath } from "./FixedPointMath.sol";

/// @title BlackScholes
/// @notice On-chain Black-Scholes-Merton option pricing + Greeks (all in WAD).
/// @dev Implements the European BSM model:
///        d1 = [ln(S/K) + (r + σ²/2)·T] / (σ·√T)
///        d2 = d1 − σ·√T
///        Call  = S·N(d1) − K·e^(−rT)·N(d2)
///        Put   = K·e^(−rT)·N(−d2) − S·N(−d1)
///
///      Greek definitions (per-unit-of-underlying):
///        Delta   = ∂V/∂S          (call: N(d1),          put: N(d1)−1)
///        Gamma   = ∂²V/∂S²        = φ(d1) / (S·σ·√T)
///        Vega    = ∂V/∂σ          = S·φ(d1)·√T           (per 1% change in σ)
///        Theta   = ∂V/∂t (time)   (daily theta, negative for long options)
///        Rho     = ∂V/∂r          (rate sensitivity)
///
///      All inputs and outputs use WAD (1e18) fixed-point.
///      Time T is in years (e.g., 7 days = 7/365 ≈ 0.01918... → 19178082191780821 WAD).
library BlackScholes {
    using FixedPointMath for int256;
    using FixedPointMath for uint256;

    int256  private constant IWAD       = 1e18;
    uint256 private constant WAD        = 1e18;
    int256  private constant SECONDS_PER_YEAR_WAD = 31_536_000 * 1e18; // 365 * 24 * 3600

    // ─── Data Structures ────────────────────────────────────────────────────────

    enum OptionType { Call, Put }

    struct BSMParams {
        uint256 spotWad;      // Current underlying price (WAD)
        uint256 strikeWad;    // Option strike price (WAD)
        uint256 sigmaWad;     // Annualised implied volatility (WAD, e.g. 0.8e18 = 80%)
        uint256 rWad;         // Annualised risk-free rate (WAD, e.g. 0.05e18 = 5%)
        uint256 tAnnualised;  // Time to expiry in years (WAD)
        OptionType optionType;
    }

    struct BSMResult {
        uint256 premium;  // Option fair value (WAD)
        int256  delta;    // ∂V/∂S in WAD (call: 0..1, put: -1..0)
        uint256 gamma;    // ∂²V/∂S² in WAD (always positive)
        uint256 vega;     // ∂V/∂σ per 1% vol change (WAD)
        int256  theta;    // ∂V/∂t per day (WAD, negative for buyers)
        int256  rho;      // ∂V/∂r per 1% rate change (WAD)
    }

    struct D1D2 {
        int256 d1;
        int256 d2;
        int256 sqrtT;   // σ·√T (WAD) — reused in Greeks
    }

    // ─── Core Pricing ────────────────────────────────────────────────────────────

    /// @notice Compute the full option premium + all Greeks in one call.
    /// @param p  BSM input parameters.
    /// @return r  Premium and all five Greeks.
    function price(BSMParams memory p) internal pure returns (BSMResult memory r) {
        require(p.spotWad   > 0, "BS: spot=0");
        require(p.strikeWad > 0, "BS: strike=0");
        require(p.sigmaWad  > 0, "BS: sigma=0");
        require(p.tAnnualised > 0, "BS: T=0");

        D1D2 memory d = _computeD1D2(p);

        int256 Nd1  = FixedPointMath.ncdf(d.d1);
        int256 Nd2  = FixedPointMath.ncdf(d.d2);
        int256 Nnd1 = IWAD - Nd1;
        int256 Nnd2 = IWAD - Nd2;

        // Discount factor: e^(-rT)
        int256 rT        = FixedPointMath.mulWadI(int256(p.rWad), int256(p.tAnnualised));
        int256 dfactor   = FixedPointMath.expWad(-rT);         // e^(-rT) in WAD
        int256 Kdf       = FixedPointMath.mulWadI(int256(p.strikeWad), dfactor); // K·e^(-rT)

        int256 spotI = int256(p.spotWad);

        // ── Premium ──
        if (p.optionType == OptionType.Call) {
            int256 c = FixedPointMath.mulWadI(spotI, Nd1) - FixedPointMath.mulWadI(Kdf, Nd2);
            r.premium = c > 0 ? uint256(c) : 0;
        } else {
            int256 put = FixedPointMath.mulWadI(Kdf, Nnd2) - FixedPointMath.mulWadI(spotI, Nnd1);
            r.premium = put > 0 ? uint256(put) : 0;
        }

        // ── phi(d1) = e^(-d1²/2) / √(2π)  ──
        int256 d1Sq = FixedPointMath.mulWadI(d.d1, d.d1);
        int256 phid1 = FixedPointMath.mulWadI(
            FixedPointMath.expWad(-d1Sq / 2),
            FixedPointMath.INV_SQRT_2PI
        );

        // ── Delta ──
        r.delta = p.optionType == OptionType.Call ? Nd1 : Nd1 - IWAD;

        // ── Gamma = phi(d1) / (S·σ·√T) ──
        {
            int256 denom = FixedPointMath.mulWadI(spotI, d.sqrtT); // S·σ·√T
            r.gamma = denom > 0 ? uint256(FixedPointMath.divWadI(phid1, denom)) : 0;
        }

        // ── Vega = S·phi(d1)·√T_raw (per 1% vol change = / 100) ──
        {
            int256 sqrtTRaw = int256(FixedPointMath.sqrtWad(p.tAnnualised)); // √T in WAD
            int256 vegaFull = FixedPointMath.mulWadI(
                FixedPointMath.mulWadI(spotI, phid1),
                sqrtTRaw
            );
            r.vega = uint256(vegaFull) / 100; // per 1% move in volatility
        }

        // ── Theta (per calendar day) ──
        {
            int256 sqrtTRaw = int256(FixedPointMath.sqrtWad(p.tAnnualised));
            // Term1 = −S·phi(d1)·σ / (2·√T)
            int256 term1Num = FixedPointMath.mulWadI(
                FixedPointMath.mulWadI(spotI, phid1),
                int256(p.sigmaWad)
            );
            int256 term1 = sqrtTRaw > 0 ? -FixedPointMath.divWadI(term1Num, 2 * sqrtTRaw) : int256(0);

            int256 term2;
            if (p.optionType == OptionType.Call) {
                // Term2 = −r·K·e^(-rT)·N(d2)
                term2 = -FixedPointMath.mulWadI(
                    FixedPointMath.mulWadI(int256(p.rWad), Kdf),
                    Nd2
                );
            } else {
                // Term2 = +r·K·e^(-rT)·N(−d2)
                term2 = FixedPointMath.mulWadI(
                    FixedPointMath.mulWadI(int256(p.rWad), Kdf),
                    Nnd2
                );
            }

            // Convert annualised theta → per-day theta
            r.theta = (term1 + term2) / 365;
        }

        // ── Rho (per 1% rate change) ──
        {
            int256 rhoAnnual;
            if (p.optionType == OptionType.Call) {
                // K·T·e^(-rT)·N(d2)
                rhoAnnual = FixedPointMath.mulWadI(
                    FixedPointMath.mulWadI(Kdf, int256(p.tAnnualised)),
                    Nd2
                );
            } else {
                // -K·T·e^(-rT)·N(-d2)
                rhoAnnual = -FixedPointMath.mulWadI(
                    FixedPointMath.mulWadI(Kdf, int256(p.tAnnualised)),
                    Nnd2
                );
            }
            r.rho = rhoAnnual / 100; // per 1% rate change
        }
    }

    /// @notice Compute only the premium (cheaper than full price()).
    function premiumOnly(BSMParams memory p) internal pure returns (uint256) {
        return price(p).premium;
    }

    // ─── Implied Volatility ───────────────────────────────────────────────────────

    /// @notice Compute implied volatility from a market premium using Newton-Raphson.
    /// @param p           BSM params with an initial sigma guess (used as seed).
    /// @param mktPremium  Observed market price of the option (WAD).
    /// @param maxIter     Newton-Raphson iterations (8–16 is usually sufficient).
    /// @return ivWad  Implied volatility (WAD). Returns 0 if no convergence.
    function impliedVolatility(
        BSMParams memory p,
        uint256 mktPremium,
        uint8 maxIter
    ) internal pure returns (uint256 ivWad) {
        uint256 sigma = p.sigmaWad; // starting guess

        for (uint8 i = 0; i < maxIter; i++) {
            p.sigmaWad = sigma;
            BSMResult memory r = price(p);

            if (r.premium == mktPremium) return sigma;

            // Newton step: σ_new = σ − (BSM(σ) − mktPremium) / vega
            // vega here is full vega (per 100%), so re-scale
            uint256 vegaFull = r.vega * 100; // undo the /100 scaling
            if (vegaFull == 0) return 0;     // degenerate

            int256 pnl = int256(r.premium) - int256(mktPremium);
            int256 step = FixedPointMath.divWadI(pnl, int256(vegaFull));

            int256 newSigma = int256(sigma) - step;
            if (newSigma <= 0) return 0;
            sigma = uint256(newSigma);

            // Convergence: within 0.01% of target
            uint256 diff = r.premium > mktPremium
                ? r.premium - mktPremium
                : mktPremium - r.premium;
            if (diff * 10_000 <= mktPremium) return sigma;
        }
        return sigma; // best approximation after maxIter iterations
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────

    /// @dev Compute d1 and d2 from BSM parameters.
    function _computeD1D2(BSMParams memory p) private pure returns (D1D2 memory d) {
        // sqrtT = √T (WAD)
        int256 sqrtT = int256(FixedPointMath.sqrtWad(p.tAnnualised));

        // σ·√T (WAD)
        d.sqrtT = FixedPointMath.mulWadI(int256(p.sigmaWad), sqrtT);

        // ln(S/K) (WAD)
        int256 lnSK = FixedPointMath.lnWad(
            int256(FixedPointMath.divWad(p.spotWad, p.strikeWad))
        );

        // (r + σ²/2)·T (WAD)
        int256 sig2half = int256(FixedPointMath.mulWad(p.sigmaWad, p.sigmaWad)) / 2;
        int256 drift = FixedPointMath.mulWadI(
            int256(p.rWad) + sig2half,
            int256(p.tAnnualised)
        );

        // d1 = (lnSK + drift) / (σ·√T)
        d.d1 = d.sqrtT > 0
            ? FixedPointMath.divWadI(lnSK + drift, d.sqrtT)
            : int256(0);

        // d2 = d1 − σ·√T
        d.d2 = d.d1 - d.sqrtT;
    }

    /// @notice Convert seconds until expiry to annualised time (WAD).
    /// @param secondsUntilExpiry  Seconds remaining (must be > 0).
    function secondsToAnnualised(uint256 secondsUntilExpiry) internal pure returns (uint256) {
        return (secondsUntilExpiry * WAD) / 365 days;
    }
}
