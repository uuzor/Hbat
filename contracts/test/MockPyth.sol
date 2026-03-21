// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPyth } from "../interfaces/IPyth.sol";

/// @title MockPyth
/// @notice Test double for the Pyth oracle. Allows seeding prices directly.
/// @dev Only for use in Hardhat tests and local development.
contract MockPyth is IPyth {
    uint256 public immutable validTimePeriod;
    uint256 public immutable singleUpdateFeeInWei;

    mapping(bytes32 => Price) private _prices;
    mapping(bytes32 => Price) private _emaPrices;
    mapping(bytes32 => bool)  private _exists;

    constructor(uint256 _validTimePeriod, uint256 _singleUpdateFee) {
        validTimePeriod       = _validTimePeriod;
        singleUpdateFeeInWei  = _singleUpdateFee;
    }

    /// @notice Seed a price for testing (test helper, not in IPyth interface).
    function setPrice(
        bytes32 feedId,
        int64   price,
        uint64  conf,
        int32   expo,
        uint    publishTime
    ) external {
        _prices[feedId]    = Price(price, conf, expo, publishTime);
        _emaPrices[feedId] = Price(price, conf, expo, publishTime);
        _exists[feedId]    = true;
        emit PriceFeedUpdate(feedId, uint64(publishTime), price, conf);
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable override {
        require(msg.value >= singleUpdateFeeInWei * updateData.length, "MockPyth: insufficient fee");
        // No-op for mock: prices are set directly via setPrice()
    }

    function updatePriceFeedsIfNecessary(
        bytes[] calldata,
        bytes32[] calldata,
        uint64[] calldata
    ) external payable override {}

    function getPriceUnsafe(bytes32 id) external view override returns (Price memory) {
        require(_exists[id], "MockPyth: feed not found");
        return _prices[id];
    }

    function getPriceNoOlderThan(bytes32 id, uint age) external view override returns (Price memory) {
        require(_exists[id], "MockPyth: feed not found");
        require(block.timestamp - _prices[id].publishTime <= age, "MockPyth: stale price");
        return _prices[id];
    }

    function getEmaPriceUnsafe(bytes32 id) external view override returns (Price memory) {
        require(_exists[id], "MockPyth: feed not found");
        return _emaPrices[id];
    }

    function getEmaPriceNoOlderThan(bytes32 id, uint age) external view override returns (Price memory) {
        require(_exists[id], "MockPyth: feed not found");
        require(block.timestamp - _emaPrices[id].publishTime <= age, "MockPyth: stale EMA price");
        return _emaPrices[id];
    }

    function getPriceFeeds(bytes32[] calldata ids)
        external view override returns (PriceFeed[] memory feeds)
    {
        feeds = new PriceFeed[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            feeds[i] = PriceFeed(ids[i], _prices[ids[i]], _emaPrices[ids[i]]);
        }
    }

    function getUpdateFee(bytes[] calldata updateData)
        external view override returns (uint feeAmount)
    {
        return singleUpdateFeeInWei * updateData.length;
    }

    function priceFeedExists(bytes32 id) external view override returns (bool) {
        return _exists[id];
    }
}
