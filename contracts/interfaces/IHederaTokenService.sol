// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IHederaTokenService
/// @notice Minimal interface for Hedera Token Service (HTS) precompile.
/// @dev HTS precompile address: 0x0000000000000000000000000000000000000167
///      Full interface: https://github.com/hashgraph/hedera-smart-contracts/tree/main/contracts/system-contracts/hedera-token-service
///
///      HTS is Hedera's native token standard, offering:
///        • Sub-cent transaction fees (fixed, not gas-based)
///        • Built-in KYC, freeze, and compliance controls
///        • Native NFT support (serial numbers, not ERC-721)
///        • Automatic association (opt-in model)
///
///      OptionsVault uses HTS to mint Option Tokens (NFTs) representing positions.
///      Each NFT encodes: underlying, strike, expiry, type (call/put), size, writer.

library HederaResponseCodes {
    int32 constant SUCCESS = 22;
}

interface IHederaTokenService {
    // ─── Structs ─────────────────────────────────────────────────────────────────

    struct HederaToken {
        string  name;
        string  symbol;
        address treasury;
        string  memo;
        bool    tokenSupplyType;  // false = INFINITE, true = FINITE
        int64   maxSupply;
        bool    freezeDefault;
        KeyValue[] tokenKeys;
        Expiry  expiry;
    }

    struct KeyValue {
        bool    inheritAccountKey;
        address contractId;
        bytes   ed25519;
        bytes   ECDSA_secp256k1;
        address delegatableContractId;
    }

    struct Expiry {
        int64   second;
        address autoRenewAccount;
        int64   autoRenewPeriod;
    }

    struct NftTransfer {
        address senderAccountID;
        address receiverAccountID;
        int64   serialNumber;
    }

    struct TokenTransferList {
        address token;
        AccountAmount[]  transfers;
        NftTransfer[]    nftTransfers;
    }

    struct AccountAmount {
        address accountID;
        int64   amount;
        bool    isApproval;
    }

    // ─── NFT Functions ───────────────────────────────────────────────────────────

    /// @notice Create a new non-fungible token (NFT collection).
    /// @dev Requires HBAR for token creation fee (currently ~$1 in HBAR).
    /// @param token  Token configuration.
    /// @return responseCode  22 = SUCCESS.
    /// @return tokenAddress  EVM address of the new HTS token.
    function createNonFungibleToken(HederaToken memory token)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    /// @notice Mint a new NFT serial in an existing HTS NFT collection.
    /// @param token     HTS token address.
    /// @param amounts   Unused for NFTs (pass 0).
    /// @param metadata  Array of metadata bytes per serial (IPFS CIDs or on-chain JSON).
    /// @return responseCode
    /// @return newTotalSupply
    /// @return serialNumbers  Newly minted serial numbers.
    function mintToken(address token, int64 amounts, bytes[] memory metadata)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    /// @notice Transfer ownership of an NFT serial.
    function transferNFT(address token, address sender, address receiver, int64 serialNumber)
        external
        returns (int64 responseCode);

    /// @notice Burn (destroy) an NFT serial.
    function burnToken(address token, int64 amount, int64[] memory serialNumbers)
        external
        returns (int64 responseCode, int64 newTotalSupply);

    /// @notice Associate (opt-in) a token to an account (required before receiving HTS tokens).
    function associateToken(address account, address token)
        external
        returns (int64 responseCode);

    /// @notice Batch-associate multiple tokens to one account.
    function associateTokens(address account, address[] memory tokens)
        external
        returns (int64 responseCode);

    // ─── Query Functions ──────────────────────────────────────────────────────────

    /// @notice Get the owner of an HTS NFT serial.
    function getNonFungibleTokenInfo(address token, int64 serialNumber)
        external
        view
        returns (int64 responseCode, NonFungibleTokenInfo memory tokenInfo);

    struct NonFungibleTokenInfo {
        TokenInfo     tokenInfo;
        int64         serialNumber;
        address       ownerId;
        int64         creationTime;
        bytes         metadata;
        address       spenderId;
    }

    struct TokenInfo {
        HederaToken token;
        int64       totalSupply;
        bool        deleted;
        bool        defaultKycStatus;
        bool        pauseStatus;
        FixedFee[]  fixedFees;
        FractionalFee[] fractionalFees;
        RoyaltyFee[] royaltyFees;
        string      ledgerId;
    }

    struct FixedFee {
        int64   amount;
        address tokenId;
        bool    useHbarsForPayment;
        bool    useCurrentTokenForPayment;
        address feeCollector;
    }

    struct FractionalFee {
        int64   numerator;
        int64   denominator;
        int64   minimumAmount;
        int64   maximumAmount;
        bool    netOfTransfers;
        address feeCollector;
    }

    struct RoyaltyFee {
        int64   numerator;
        int64   denominator;
        int64   amount;
        address tokenId;
        bool    useHbarsForPayment;
        address feeCollector;
    }
}
