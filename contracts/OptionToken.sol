// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC721URIStorage } from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @title OptionToken
/// @notice ERC-721 NFT representing a single options position on Hedera.
/// @dev Each token encodes all option terms on-chain via a dynamic tokenURI (fully on-chain SVG).
///      In production on Hedera mainnet, this would be an HTS NFT for native fee efficiency.
///      The vault is the sole minter (owner).
///
///      Token lifecycle:
///        1. Minted by vault when buyer purchases an option (buyer receives NFT).
///        2. Transferred by buyer to exercise (sends to vault, receives payout).
///        3. Burned by vault at exercise or expiry settlement.
///
///      Each token stores:
///        • Underlying feed ID (Pyth bytes32)
///        • Option type (Call / Put)
///        • Strike price (WAD)
///        • Expiry timestamp (UNIX)
///        • Notional size (WAD, units of underlying)
///        • Premium paid (WAD)
///        • Writer address
///        • Schedule ID (HIP-1215 expiry schedule entity)
contract OptionToken is ERC721URIStorage, Ownable {
    using Strings for uint256;
    using Strings for address;

    // ─── Data Structures ────────────────────────────────────────────────────────

    enum OptionType { Call, Put }
    enum OptionStatus { Active, Exercised, Expired }

    struct OptionData {
        bytes32    feedId;        // Pyth price feed ID for the underlying
        string     underlyingSymbol; // Human-readable symbol (e.g., "HBAR", "XAU")
        OptionType optionType;    // Call or Put
        uint256    strikeWad;     // Strike price in WAD (denominated in USD)
        uint256    expiry;        // UNIX timestamp of expiry
        uint256    sizeWad;       // Number of units of underlying (WAD)
        uint256    premiumWad;    // Premium paid by buyer (WAD, in collateral token)
        address    writer;        // Address that wrote (sold) the option
        address    collateralToken; // ERC-20 collateral (address(0) = native HBAR)
        address    scheduleId;    // HIP-1215 schedule entity ID for auto-expiry
        OptionStatus status;      // Current lifecycle state
        uint256    createdAt;     // Block timestamp of creation
    }

    // ─── State ──────────────────────────────────────────────────────────────────

    uint256 private _nextTokenId;
    mapping(uint256 => OptionData) private _options;

    // ─── Events ─────────────────────────────────────────────────────────────────

    event OptionMinted(
        uint256 indexed tokenId,
        address indexed buyer,
        address indexed writer,
        OptionType     optionType,
        uint256        strikeWad,
        uint256        sizeWad,
        uint256        expiry
    );

    event OptionStatusUpdated(
        uint256 indexed tokenId,
        OptionStatus    newStatus
    );

    // ─── Constructor ────────────────────────────────────────────────────────────

    constructor(address vaultAddress)
        ERC721("Hedera Option Token", "HOPT")
        Ownable(vaultAddress)
    {}

    // ─── Minting ─────────────────────────────────────────────────────────────────

    /// @notice Mint a new option NFT. Only callable by the vault (owner).
    /// @param buyer     Recipient of the option NFT (the option buyer).
    /// @param data      All option terms.
    /// @return tokenId  ID of the newly minted token.
    function mint(address buyer, OptionData calldata data)
        external
        onlyOwner
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        _options[tokenId] = data;
        _options[tokenId].status = OptionStatus.Active;
        _options[tokenId].createdAt = block.timestamp;
        _mint(buyer, tokenId);

        emit OptionMinted(
            tokenId,
            buyer,
            data.writer,
            data.optionType,
            data.strikeWad,
            data.sizeWad,
            data.expiry
        );
    }

    // ─── Status Updates ──────────────────────────────────────────────────────────

    /// @notice Update option status (exercised or expired). Only vault can call.
    function setStatus(uint256 tokenId, OptionStatus newStatus) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "OptionToken: nonexistent");
        _options[tokenId].status = newStatus;
        emit OptionStatusUpdated(tokenId, newStatus);
    }

    /// @notice Update the HIP-1215 schedule ID after scheduling the auto-expiry.
    function setScheduleId(uint256 tokenId, address scheduleId) external onlyOwner {
        _options[tokenId].scheduleId = scheduleId;
    }

    // ─── Queries ─────────────────────────────────────────────────────────────────

    /// @notice Read all option data for a given token.
    function getOption(uint256 tokenId) external view returns (OptionData memory) {
        require(_ownerOf(tokenId) != address(0), "OptionToken: nonexistent");
        return _options[tokenId];
    }

    /// @notice Returns true if the option has not expired and has not been settled.
    function isActive(uint256 tokenId) external view returns (bool) {
        OptionData storage opt = _options[tokenId];
        return opt.status == OptionStatus.Active && block.timestamp < opt.expiry;
    }

    /// @notice Returns true if the option is past its expiry timestamp.
    function isPastExpiry(uint256 tokenId) external view returns (bool) {
        return block.timestamp >= _options[tokenId].expiry;
    }

    // ─── Token URI (fully on-chain SVG) ─────────────────────────────────────────

    /// @notice Generate a fully on-chain JSON + SVG token metadata.
    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        require(_ownerOf(tokenId) != address(0), "OptionToken: nonexistent");
        OptionData storage opt = _options[tokenId];

        string memory typeStr    = opt.optionType == OptionType.Call ? "CALL" : "PUT";
        string memory statusStr  = _statusString(opt.status);
        string memory strikeStr  = _formatWad(opt.strikeWad);
        string memory sizeStr    = _formatWad(opt.sizeWad);
        string memory premStr    = _formatWad(opt.premiumWad);
        string memory typeColor  = opt.optionType == OptionType.Call ? "#22c55e" : "#ef4444";

        string memory svg = _buildSVG(
            tokenId, opt.underlyingSymbol, typeStr, strikeStr,
            sizeStr, premStr, opt.expiry, statusStr, typeColor
        );

        string memory json = Base64.encode(bytes(string.concat(
            '{"name":"', opt.underlyingSymbol, ' ', typeStr, ' $', strikeStr, ' Option #', tokenId.toString(), '",',
            '"description":"Hedera Options Vault - Agentic DeFi. Exercisable via HIP-1215 autonomous settlement.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[',
                '{"trait_type":"Underlying","value":"', opt.underlyingSymbol, '"},',
                '{"trait_type":"Type","value":"', typeStr, '"},',
                '{"trait_type":"Strike USD","value":"', strikeStr, '"},',
                '{"trait_type":"Size","value":"', sizeStr, '"},',
                '{"trait_type":"Premium","value":"', premStr, '"},',
                '{"trait_type":"Expiry","value":', opt.expiry.toString(), '},',
                '{"trait_type":"Status","value":"', statusStr, '"},',
                '{"trait_type":"Writer","value":"', Strings.toHexString(uint256(uint160(opt.writer)), 20), '"}',
            ']}'
        )));

        return string.concat("data:application/json;base64,", json);
    }

    // ─── SVG Builder ─────────────────────────────────────────────────────────────

    function _buildSVG(
        uint256 tokenId,
        string memory symbol,
        string memory typeStr,
        string memory strikeStr,
        string memory sizeStr,
        string memory premStr,
        uint256 expiry,
        string memory statusStr,
        string memory typeColor
    ) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250" style="font-family:monospace">',
            '<rect width="400" height="250" rx="16" fill="#0f172a"/>',
            '<rect x="16" y="16" width="368" height="218" rx="12" fill="#1e293b" stroke="',
            typeColor, '" stroke-width="2"/>',
            '<text x="30" y="50" fill="#94a3b8" font-size="11">HEDERA OPTIONS VAULT</text>',
            '<text x="30" y="78" fill="', typeColor, '" font-size="22" font-weight="bold">',
            symbol, ' ', typeStr, ' #', tokenId.toString(), '</text>',
            '<text x="30" y="108" fill="#e2e8f0" font-size="14">Strike: $', strikeStr, ' USD</text>',
            '<text x="30" y="132" fill="#e2e8f0" font-size="14">Size:   ', sizeStr, ' units</text>',
            '<text x="30" y="156" fill="#e2e8f0" font-size="14">Premium: $', premStr, '</text>',
            '<text x="30" y="180" fill="#64748b" font-size="11">Expiry: ', expiry.toString(), '</text>',
            '<text x="30" y="200" fill="#64748b" font-size="11">Settled via HIP-1215 Protocol Automation</text>',
            '<rect x="290" y="18" width="90" height="22" rx="6" fill="',
            _statusColor(statusStr), '"/>',
            '<text x="335" y="33" fill="#fff" font-size="10" text-anchor="middle">', statusStr, '</text>',
            '</svg>'
        );
    }

    // ─── Private Helpers ─────────────────────────────────────────────────────────

    function _statusString(OptionStatus s) private pure returns (string memory) {
        if (s == OptionStatus.Active)    return "ACTIVE";
        if (s == OptionStatus.Exercised) return "EXERCISED";
        return "EXPIRED";
    }

    function _statusColor(string memory s) private pure returns (string memory) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("ACTIVE"))    return "#16a34a";
        if (h == keccak256("EXERCISED")) return "#2563eb";
        return "#6b7280";
    }

    /// @dev Format a WAD value as "XXXX.XX" (2 decimal places) without floating point.
    function _formatWad(uint256 wad) private pure returns (string memory) {
        uint256 whole  = wad / 1e18;
        uint256 frac   = (wad % 1e18) / 1e16; // 2 decimal places
        return string.concat(
            whole.toString(),
            ".",
            frac < 10 ? string.concat("0", frac.toString()) : frac.toString()
        );
    }

    // ─── Total Supply ────────────────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _nextTokenId;
    }
}
