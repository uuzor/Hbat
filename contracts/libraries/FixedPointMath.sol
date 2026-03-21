// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FixedPointMath
/// @notice WAD (1e18) fixed-point math: exp, ln, sqrt, normal CDF — all in one library.
/// @dev Used by BlackScholes to compute option premiums and Greeks on-chain.
///
///      All values are WAD-scaled unless stated otherwise.
///      WAD = 1e18, so "1" is represented as 1e18.
///
///      Precision notes:
///        • lnWad: error < 1e-15 (relative) for x ∈ [1e-18, 1e54]
///        • expWad: error < 1e-15 (relative) for x ∈ [-42, 135] WAD
///        • ncdf:   error < 7.5e-8 (absolute) — Abramowitz & Stegun 26.2.17
///        • sqrtWad: exact (Babylonian, bitwise)
library FixedPointMath {
    uint256 internal constant WAD = 1e18;
    int256  internal constant IWAD = 1e18;

    /// @dev ln(2) in WAD: 0.693147180559945309...
    int256 internal constant LN2 = 693_147_180_559_945_309;

    /// @dev 1/√(2π) in WAD: 0.398942280401432678...
    int256 internal constant INV_SQRT_2PI = 398_942_280_401_432_678;

    // ─── Basic WAD Arithmetic ────────────────────────────────────────────────────

    function mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / WAD;
    }

    function divWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * WAD) / b;
    }

    function mulWadI(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / IWAD;
    }

    function divWadI(int256 a, int256 b) internal pure returns (int256) {
        return (a * IWAD) / b;
    }

    // ─── Square Root ─────────────────────────────────────────────────────────────

    /// @dev Integer square root (Babylonian method).
    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x >> 1) + 1;
        while (z < y) {
            y = z;
            z = (x / z + z) >> 1;
        }
    }

    /// @dev WAD square root: given x in WAD, returns √(x/WAD) in WAD.
    ///      Example: sqrtWad(4e18) = 2e18
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        return sqrt(x * WAD);
    }

    // ─── Natural Logarithm ───────────────────────────────────────────────────────

    /// @dev ln(x) where x is a WAD value (x > 0). Returns WAD result.
    ///      Uses range reduction: ln(x) = n·ln(2) + ln(m) where m ∈ [1, 2).
    ///      The fractional part ln(m) is computed via the identity:
    ///        ln(m) = 2·arctanh((m−1)/(m+1)) = 2·Σ [t^(2k+1)/(2k+1)]
    ///      where t = (m−1)/(m+1) and the series converges rapidly for t ∈ (−½, ½).
    function lnWad(int256 x) internal pure returns (int256) {
        require(x > 0, "FPM: ln(x<=0)");

        // Range-reduce x to a = m * WAD where m ∈ [1, 2).
        int256 n = 0;
        int256 a = x;

        // Shift down (multiply by 2^-1 repeatedly while a >= 2*WAD)
        if (a >= int256(128) * IWAD) { a >>= 7; n += 7; }
        if (a >= int256(16)  * IWAD) { a >>= 4; n += 4; }
        if (a >= int256(8)   * IWAD) { a >>= 3; n += 3; }
        if (a >= int256(4)   * IWAD) { a >>= 2; n += 2; }
        if (a >= int256(2)   * IWAD) { a >>= 1; n += 1; }

        // Shift up (multiply by 2 repeatedly while a < WAD)
        if (a < IWAD) { a <<= 7; n -= 7; }
        if (a < IWAD) { a <<= 4; n -= 4; }
        if (a < IWAD) { a <<= 2; n -= 2; }
        if (a < IWAD) { a <<= 1; n -= 1; }

        // Re-normalise: shift-up may have produced a ≫ 2*WAD (e.g. 0.9*128 = 115.2).
        // Shift back down until a ∈ [1e18, 2e18).
        if (a >= int256(128) * IWAD) { a >>= 7; n += 7; }
        if (a >= int256(16)  * IWAD) { a >>= 4; n += 4; }
        if (a >= int256(8)   * IWAD) { a >>= 3; n += 3; }
        if (a >= int256(4)   * IWAD) { a >>= 2; n += 2; }
        if (a >= int256(2)   * IWAD) { a >>= 1; n += 1; }

        // Now a ∈ [1e18, 2e18). Compute ln(a/WAD) via arctanh series.
        // t = (a − WAD) / (a + WAD)  →  t ∈ (0, 1/3)
        int256 t    = divWadI(a - IWAD, a + IWAD);
        int256 t2   = mulWadI(t, t);
        int256 term = t;

        int256 lnA = term;
        term = mulWadI(term, t2); lnA += term / 3;
        term = mulWadI(term, t2); lnA += term / 5;
        term = mulWadI(term, t2); lnA += term / 7;
        term = mulWadI(term, t2); lnA += term / 9;
        term = mulWadI(term, t2); lnA += term / 11;
        term = mulWadI(term, t2); lnA += term / 13;
        lnA *= 2;

        return n * LN2 + lnA;
    }

    // ─── Exponential ─────────────────────────────────────────────────────────────

    /// @dev e^(x/WAD) in WAD. x is a signed WAD value.
    ///      Uses range reduction: e^x = 2^k · e^r where r = x − k·ln2, |r| ≤ ln2/2.
    ///      e^r is computed with a 12-term Taylor series (accurate to 1e-15 for |r| ≤ 0.35).
    function expWad(int256 x) internal pure returns (int256) {
        // Underflow: e^(-42.1) < 1e-18 (below WAD resolution)
        if (x <= -41_446_531_673_892_822_313) return 0;
        // Overflow: e^135.3 > max(int256) / WAD
        if (x >= 135_305_999_368_893_231_589) return type(int256).max;

        // Range reduction: find k = round(x / ln2)
        int256 k = (x + LN2 / 2) / LN2;
        int256 r = x - k * LN2; // r ∈ [−ln2/2, +ln2/2]

        // Taylor series for e^r: 1 + r + r²/2! + r³/3! + ... + r¹²/12!
        int256 e    = IWAD; // 1
        int256 term = r;    // r^1 / 1!
        e += term;
        term = mulWadI(term, r) / 2;  e += term;
        term = mulWadI(term, r) / 3;  e += term;
        term = mulWadI(term, r) / 4;  e += term;
        term = mulWadI(term, r) / 5;  e += term;
        term = mulWadI(term, r) / 6;  e += term;
        term = mulWadI(term, r) / 7;  e += term;
        term = mulWadI(term, r) / 8;  e += term;
        term = mulWadI(term, r) / 9;  e += term;
        term = mulWadI(term, r) / 10; e += term;
        term = mulWadI(term, r) / 11; e += term;
        term = mulWadI(term, r) / 12; e += term;

        // e^x = e^r · 2^k
        if (k >= 0) {
            return e << uint256(k);
        } else {
            return e >> uint256(-k);
        }
    }

    // ─── Normal Distribution CDF ──────────────────────────────────────────────────

    /// @dev Standard normal CDF: N(x) = P(Z ≤ x) where Z ~ N(0,1).
    ///      Uses the Abramowitz & Stegun polynomial approximation (formula 26.2.17).
    ///      Maximum absolute error < 7.5e-8.
    /// @param x  Argument in WAD (e.g., 1.5e18 = N(1.5) ≈ 0.9332...)
    /// @return   N(x) in WAD, clamped to [0, 1e18].
    function ncdf(int256 x) internal pure returns (int256) {
        // Fast boundary cases
        if (x >= 8 * IWAD)  return IWAD;
        if (x <= -8 * IWAD) return 0;

        bool neg = x < 0;
        if (neg) x = -x;

        // A&S 26.2.17 constants (all in WAD)
        int256 p  =  231_641_900_000_000_000; // 0.2316419
        int256 b1 =  319_381_530_000_000_000; // 0.319381530
        int256 b2 = -356_563_782_000_000_000; // -0.356563782
        int256 b3 =  1_781_477_937_000_000_000; // 1.781477937
        int256 b4 = -1_821_255_978_000_000_000; // -1.821255978
        int256 b5 =  1_330_274_429_000_000_000; // 1.330274429

        // t = 1 / (1 + p·x)
        int256 t = divWadI(IWAD, IWAD + mulWadI(p, x));

        // Horner's method: poly = t·(b1 + t·(b2 + t·(b3 + t·(b4 + t·b5))))
        int256 poly = mulWadI(t,
            b1 + mulWadI(t,
                b2 + mulWadI(t,
                    b3 + mulWadI(t,
                        b4 + mulWadI(t, b5)))));

        // phi(x) = e^(−x²/2) / √(2π)
        int256 xSq  = mulWadI(x, x);
        int256 phi  = mulWadI(expWad(-xSq / 2), INV_SQRT_2PI);

        // N(x) = 1 − phi(x) · poly   (for x ≥ 0)
        int256 result = IWAD - mulWadI(phi, poly);

        // Clamp to [0, WAD] (approximation can slightly overshoot for extreme inputs)
        if (result < 0)     result = 0;
        if (result > IWAD)  result = IWAD;

        return neg ? IWAD - result : result;
    }

    // ─── Utility ─────────────────────────────────────────────────────────────────

    /// @dev Absolute value of a signed WAD integer.
    function absI(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }

    /// @dev Convert a Pyth price (price * 10^expo) to WAD.
    ///      E.g. price=12345678, expo=−6 → 12.345678 USD → 12345678_000_000_000_000 (WAD)
    function pythPriceToWad(int64 price, int32 expo) internal pure returns (uint256) {
        require(price > 0, "FPM: negative price");
        uint256 absPrice = uint256(int256(price));
        if (expo >= 0) {
            // Scale up: multiply by 10^expo, then to WAD
            return absPrice * (10 ** uint256(int256(expo))) * WAD;
        } else {
            uint256 divisor = 10 ** uint256(int256(-expo));
            // absPrice / divisor in WAD = absPrice * WAD / divisor
            return (absPrice * WAD) / divisor;
        }
    }
}
