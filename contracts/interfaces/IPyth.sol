// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IPyth
/// @notice Interface for the Pyth Network pull-oracle on Hedera
/// @dev Contract address on Hedera testnet: 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729
///      Pull-oracle workflow:
///        1. Off-chain: fetch signed `updateData` from https://hermes.pyth.network/api/latest_vaas
///        2. On-chain:  call `updatePriceFeeds(updateData)` (pays fee via msg.value)
///        3. On-chain:  call `getPriceUnsafe(feedId)` to read the cached price
///
///      Key HBAR/USD feed ID (testnet):
///        0x35c946f7a4e8ab7ad6f0e47699c0fb79bd57820f25c3e42ee4ea2aa54bd8b7f8
///
///      Additional feeds used by this protocol (Hedera testnet):
///        BTC/USD:  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
///        ETH/USD:  0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
///        XAU/USD:  0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2
///        EUR/USD:  0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30
///        USDC/USD: 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a

interface IPyth {
    // ─── Data Structures ────────────────────────────────────────────────────────

    /// @notice A price with a degree of uncertainty at a given timestamp.
    /// @dev expo is a power-of-10 scaling factor: price * 10^expo = real price.
    ///      Example: price=12345, expo=-4 → 1.2345
    struct Price {
        int64  price;       // Price scaled by 10^expo
        uint64 conf;        // Confidence interval: real_price ∈ [price±conf] * 10^expo
        int32  expo;        // Exponent (typically negative, e.g. -8 for 8 decimal places)
        uint   publishTime; // UNIX timestamp of the price update
    }

    /// @notice A price feed record including the EMA (exponential moving average) price.
    struct PriceFeed {
        bytes32 id;       // The price feed ID (matches the hex IDs above)
        Price   price;    // Latest price
        Price   emaPrice; // EMA price (less volatile, useful for options)
    }

    // ─── Core Functions ──────────────────────────────────────────────────────────

    /// @notice Submit off-chain price update VAAs to the oracle.
    /// @dev Must send updateFee() wei alongside the call.
    /// @param updateData Encoded price update data from Hermes API.
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @notice Update prices only if the new data is more recent than cached.
    /// @dev Cheaper than updatePriceFeeds when price may already be fresh.
    function updatePriceFeedsIfNecessary(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64[] calldata publishTimes
    ) external payable;

    /// @notice Get the most recent price (may be stale — caller must check publishTime).
    /// @dev Reverts with PriceFeedNotFound if the feed has never been updated on-chain.
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);

    /// @notice Get the price, reverting if it is older than `age` seconds.
    /// @param id      The price feed ID.
    /// @param age     Maximum acceptable age in seconds (e.g. 60 = 1 minute).
    function getPriceNoOlderThan(bytes32 id, uint age) external view returns (Price memory price);

    /// @notice Get the EMA price (recommended for options pricing, more stable).
    function getEmaPriceUnsafe(bytes32 id) external view returns (Price memory price);

    /// @notice Get EMA price, reverting if older than `age` seconds.
    function getEmaPriceNoOlderThan(bytes32 id, uint age) external view returns (Price memory price);

    /// @notice Get a batch of prices in one call.
    function getPriceFeeds(bytes32[] calldata ids) external view returns (PriceFeed[] memory feeds);

    /// @notice HBAR fee required to submit one price update VAA.
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint feeAmount);

    /// @notice Returns true if the given feed ID is registered.
    function priceFeedExists(bytes32 id) external view returns (bool exists);

    // ─── Events ─────────────────────────────────────────────────────────────────

    event PriceFeedUpdate(
        bytes32 indexed id,
        uint64  publishTime,
        int64   price,
        uint64  conf
    );
}
