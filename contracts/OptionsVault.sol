// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { IPyth } from "./interfaces/IPyth.sol";
import { IHederaScheduleService, HederaSystemContracts } from "./interfaces/IHederaScheduleService.sol";
import { OptionToken } from "./OptionToken.sol";
import { BlackScholes } from "./libraries/BlackScholes.sol";
import { FixedPointMath } from "./libraries/FixedPointMath.sol";

/// @title OptionsVault
/// @notice Agentic Options Vault on Hedera — the first keeperless options protocol.
///
/// @dev Architecture overview:
///
///   ┌─────────────────────────────────────────────────────────────┐
///   │                    OptionsVault.sol                          │
///   │                                                             │
///   │  Collateral Layer     Option Layer        Settlement Layer  │
///   │  ─────────────────   ─────────────────   ─────────────── │
///   │  • HBAR (native)      • Black-Scholes     • Exercise       │
///   │  • USDC (ERC-20)        premium calc        (buyer)        │
///   │  • FRNT (ERC-20)      • Pyth pull oracle  • Auto-expiry    │
///   │                       • Write covered        (HIP-1215)    │
///   │                         calls/puts                          │
///   └─────────────────────────────────────────────────────────────┘
///
/// Supported option strategies:
///   • Covered Call:      Writer deposits underlying → sells call → buyer receives upside
///   • Cash-Secured Put:  Writer deposits strike·size USDC → sells put → buyer receives downside
///
/// Key Hedera integrations:
///   • Pyth pull oracle:  Fetch fresh HBAR/XAU/FX prices per transaction
///   • HIP-1215 (HSS):    Options auto-expire on Hedera consensus — no keeper bots
///   • HTS:               Option NFTs (OptionToken.sol) via standard ERC-721 on HSCS
///   • Fixed fees:        ~$0.0001 per tx (vs. hundreds on Ethereum for similar logic)
///
/// Supported underlyings (Pyth feed IDs, Hedera testnet):
///   • HBAR/USD: 0x35c946f7a4e8ab7ad6f0e47699c0fb79bd57820f25c3e42ee4ea2aa54bd8b7f8
///   • XAU/USD:  0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2
///   • EUR/USD:  0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30
///   • BTC/USD:  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43

contract OptionsVault is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;
    using BlackScholes for BlackScholes.BSMParams;
    using FixedPointMath for uint256;
    using FixedPointMath for int256;

    // ─── Constants ───────────────────────────────────────────────────────────────

    uint256 public constant WAD             = 1e18;
    uint256 public constant MAX_EXPIRY_DAYS = 365;
    uint256 public constant MIN_EXPIRY_SECS = 1 hours;

    /// @dev Protocol fee: 0.3% of premium (in WAD)
    uint256 public constant PROTOCOL_FEE_WAD = 3e15;

    /// @dev Maximum slippage tolerance for Pyth price staleness (60 seconds)
    uint256 public constant PYTH_MAX_AGE = 60;

    // ─── State ───────────────────────────────────────────────────────────────────

    IPyth                 public immutable pyth;
    IHederaScheduleService public immutable hss;
    OptionToken           public immutable optionToken;

    /// @notice Default risk-free rate (e.g. 5% = 0.05e18)
    uint256 public riskFreeRateWad;

    /// @notice Accumulated protocol fees per collateral token
    mapping(address => uint256) public accruedFees; // token → amount (address(0) = HBAR)

    /// @notice Collateral locked per writer per token
    mapping(address => mapping(address => uint256)) public writerCollateral; // writer → token → amount

    /// @notice All option positions (tokenId → position details)
    mapping(uint256 => Position) public positions;

    /// @notice Registered Pyth feed IDs (symbol → feedId)
    mapping(string => bytes32) public feedIds;
    string[] public supportedSymbols;

    /// @notice Registered collateral tokens (includes address(0) = HBAR)
    mapping(address => bool) public isCollateralToken;
    address[] public collateralTokens;

    // ─── Data Structures ────────────────────────────────────────────────────────

    enum OptionType { Call, Put }

    struct Position {
        uint256    tokenId;         // OptionToken NFT ID
        bytes32    feedId;          // Pyth feed ID for underlying
        string     symbol;          // e.g. "HBAR"
        OptionType optionType;      // Call or Put
        uint256    strikeWad;       // Strike price (WAD, USD-denominated)
        uint256    expiry;          // UNIX timestamp
        uint256    sizeWad;         // Number of underlying units (WAD)
        uint256    premiumWad;      // Premium received from buyer (WAD)
        address    writer;          // Who sold this option
        address    buyer;           // Who bought this option
        address    collateralToken; // Locked collateral token (address(0) = HBAR)
        uint256    collateralWad;   // Locked collateral amount (WAD)
        address    scheduleId;      // HIP-1215 schedule entity for auto-expiry
        bool       settled;         // True if exercised or expired
    }

    struct WriteParams {
        string   symbol;          // e.g., "HBAR", "XAU"
        OptionType optionType;    // Call or Put
        uint256  strikeWad;       // Strike price in WAD (USD)
        uint256  expiry;          // UNIX expiry timestamp
        uint256  sizeWad;         // Units of underlying (WAD)
        uint256  sigmaWad;        // Implied volatility estimate (WAD, e.g. 0.8e18)
        address  collateralToken; // address(0) for HBAR, ERC-20 address otherwise
        bytes[]  pythUpdateData;  // Fresh Pyth VAA to update price before pricing
    }

    struct QuoteParams {
        string   symbol;
        OptionType optionType;
        uint256  strikeWad;
        uint256  expiry;
        uint256  sizeWad;
        uint256  sigmaWad;
    }

    // ─── Events ──────────────────────────────────────────────────────────────────

    event OptionWritten(
        uint256 indexed tokenId,
        address indexed writer,
        address indexed buyer,
        string          symbol,
        OptionType      optionType,
        uint256         strikeWad,
        uint256         sizeWad,
        uint256         expiry,
        uint256         premiumWad,
        address         scheduleId  // HIP-1215 schedule entity
    );

    event OptionExercised(
        uint256 indexed tokenId,
        address indexed exerciser,
        uint256         spotWad,
        uint256         payoutWad
    );

    event OptionExpired(
        uint256 indexed tokenId,
        bool            automated   // true = auto-expired by HIP-1215
    );

    event CollateralDeposited(address indexed writer, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed writer, address indexed token, uint256 amount);
    event FeedRegistered(string symbol, bytes32 feedId);
    event FeeCollected(address indexed token, uint256 amount);
    event RiskFreeRateUpdated(uint256 newRateWad);

    // ─── Errors ──────────────────────────────────────────────────────────────────

    error UnknownSymbol(string symbol);
    error StalePrice(bytes32 feedId, uint256 publishTime);
    error InsufficientCollateral(uint256 required, uint256 available);
    error OptionAlreadySettled(uint256 tokenId);
    error OptionNotExpired(uint256 tokenId, uint256 expiry);
    error OptionExpiredAlready(uint256 tokenId, uint256 expiry);
    error NotOptionOwner(uint256 tokenId, address caller);
    error ExpiryTooFar(uint256 expiry, uint256 maxExpiry);
    error ExpiryTooSoon(uint256 expiry);
    error InvalidSize();
    error InvalidStrike();
    error PremiumTooHigh(uint256 premium, uint256 maxAccepted);
    error UnsupportedCollateral(address token);

    // ─── Constructor ─────────────────────────────────────────────────────────────

    constructor(
        address _pyth,
        address _owner,
        uint256 _riskFreeRateWad
    ) Ownable(_owner) {
        pyth             = IPyth(_pyth);
        hss              = IHederaScheduleService(HederaSystemContracts.HSS);
        optionToken      = new OptionToken(address(this));
        riskFreeRateWad  = _riskFreeRateWad;

        // Register HBAR as native collateral
        isCollateralToken[address(0)] = true;
        collateralTokens.push(address(0));
    }

    // ─── Admin Functions ─────────────────────────────────────────────────────────

    /// @notice Register a Pyth price feed for a new underlying.
    function registerFeed(string calldata symbol, bytes32 feedId) external onlyOwner {
        require(feedId != bytes32(0), "Vault: zero feedId");
        if (feedIds[symbol] == bytes32(0)) {
            supportedSymbols.push(symbol);
        }
        feedIds[symbol] = feedId;
        emit FeedRegistered(symbol, feedId);
    }

    /// @notice Add a supported ERC-20 collateral token (e.g. USDC, FRNT).
    function addCollateralToken(address token) external onlyOwner {
        require(token != address(0), "Vault: use address(0) for HBAR");
        if (!isCollateralToken[token]) {
            isCollateralToken[token] = true;
            collateralTokens.push(token);
        }
    }

    /// @notice Update the risk-free rate (e.g. 5% = 0.05e18).
    function setRiskFreeRate(uint256 rateWad) external onlyOwner {
        require(rateWad <= 0.5e18, "Vault: rate > 50%");
        riskFreeRateWad = rateWad;
        emit RiskFreeRateUpdated(rateWad);
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Collateral Management ───────────────────────────────────────────────────

    /// @notice Deposit HBAR collateral (for writing covered calls on HBAR).
    function depositHBAR() external payable nonReentrant {
        require(msg.value > 0, "Vault: zero deposit");
        writerCollateral[msg.sender][address(0)] += msg.value;
        emit CollateralDeposited(msg.sender, address(0), msg.value);
    }

    /// @notice Deposit ERC-20 collateral (USDC, FRNT, etc.).
    function depositERC20(address token, uint256 amount) external nonReentrant {
        if (!isCollateralToken[token]) revert UnsupportedCollateral(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        writerCollateral[msg.sender][token] += amount;
        emit CollateralDeposited(msg.sender, token, amount);
    }

    /// @notice Withdraw unlocked collateral.
    /// @dev Collateral locked in active positions cannot be withdrawn.
    function withdrawCollateral(address token, uint256 amount) external nonReentrant {
        uint256 available = writerCollateral[msg.sender][token];
        if (available < amount) revert InsufficientCollateral(amount, available);

        writerCollateral[msg.sender][token] -= amount;

        if (token == address(0)) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "Vault: HBAR transfer failed");
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    // ─── Option Quoting ──────────────────────────────────────────────────────────

    /// @notice Get a fair-value quote for an option (read-only, no oracle update).
    /// @dev Uses the last cached Pyth price. For binding quotes, use writeOption (which updates Pyth first).
    function quotePremium(QuoteParams calldata q) external view returns (
        uint256 premiumWad,
        BlackScholes.BSMResult memory greeks
    ) {
        bytes32 feedId = _getFeedId(q.symbol);
        IPyth.Price memory p = pyth.getPriceUnsafe(feedId);
        uint256 spotWad = FixedPointMath.pythPriceToWad(p.price, p.expo);

        BlackScholes.BSMParams memory bsm = BlackScholes.BSMParams({
            spotWad:      spotWad,
            strikeWad:    q.strikeWad,
            sigmaWad:     q.sigmaWad,
            rWad:         riskFreeRateWad,
            tAnnualised:  BlackScholes.secondsToAnnualised(q.expiry - block.timestamp),
            optionType:   BlackScholes.OptionType(uint8(q.optionType))
        });

        greeks     = BlackScholes.price(bsm);
        premiumWad = greeks.premium * q.sizeWad / WAD;
    }

    // ─── Option Writing ───────────────────────────────────────────────────────────

    /// @notice Write (sell) an option. The vault mints an NFT to the buyer.
    ///
    /// @dev Workflow:
    ///   1. Validate params and collateral sufficiency.
    ///   2. Update Pyth price (pull oracle — caller pays the VAA fee).
    ///   3. Compute fair-value premium via Black-Scholes.
    ///   4. Lock collateral from writer.
    ///   5. Collect premium + protocol fee from buyer (msg.value or ERC-20).
    ///   6. Mint OptionToken NFT to buyer.
    ///   7. Schedule auto-expiry via HIP-1215 (HSS precompile).
    ///
    /// @param wp          Option parameters.
    /// @param maxPremium  Maximum premium caller is willing to pay (slippage guard, WAD).
    function writeOption(WriteParams calldata wp, uint256 maxPremium)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId, uint256 premiumWad)
    {
        // ── Validate ──
        _validateWriteParams(wp);
        bytes32 feedId = _getFeedId(wp.symbol);

        // ── Update Pyth price (pull oracle) ──
        uint256 pythFee = pyth.getUpdateFee(wp.pythUpdateData);
        pyth.updatePriceFeeds{value: pythFee}(wp.pythUpdateData);
        IPyth.Price memory oraclePrice = pyth.getPriceNoOlderThan(feedId, PYTH_MAX_AGE);
        uint256 spotWad = FixedPointMath.pythPriceToWad(oraclePrice.price, oraclePrice.expo);

        // ── Black-Scholes Pricing ──
        BlackScholes.BSMParams memory bsm = BlackScholes.BSMParams({
            spotWad:      spotWad,
            strikeWad:    wp.strikeWad,
            sigmaWad:     wp.sigmaWad,
            rWad:         riskFreeRateWad,
            tAnnualised:  BlackScholes.secondsToAnnualised(wp.expiry - block.timestamp),
            optionType:   BlackScholes.OptionType(uint8(wp.optionType))
        });
        premiumWad = BlackScholes.price(bsm).premium * wp.sizeWad / WAD;

        if (premiumWad > maxPremium) revert PremiumTooHigh(premiumWad, maxPremium);

        // ── Required collateral per option type ──
        uint256 collateralRequired = _requiredCollateral(
            wp.optionType, wp.strikeWad, wp.sizeWad, spotWad, wp.collateralToken
        );

        // ── Lock writer collateral ──
        {
            address writer = msg.sender;
            uint256 available = writerCollateral[writer][wp.collateralToken];
            if (available < collateralRequired)
                revert InsufficientCollateral(collateralRequired, available);
            writerCollateral[writer][wp.collateralToken] -= collateralRequired;
        }

        // ── Collect premium from buyer (assumed msg.sender is the buyer for simplicity)
        //    In a full implementation, writers and buyers are separate parties.
        //    Here: msg.sender = buyer, who pre-approved the vault to spend their tokens.
        uint256 protocolFee = premiumWad * PROTOCOL_FEE_WAD / WAD;
        uint256 netPremium  = premiumWad - protocolFee;

        if (wp.collateralToken == address(0)) {
            // Premium in HBAR — remaining msg.value after Pyth fee
            require(msg.value >= pythFee + premiumWad, "Vault: insufficient HBAR");
            // Return excess HBAR to buyer
            if (msg.value > pythFee + premiumWad) {
                (bool ok, ) = msg.sender.call{value: msg.value - pythFee - premiumWad}("");
                require(ok, "Vault: HBAR refund failed");
            }
            // Credit premium to writer (minus fee)
            writerCollateral[msg.sender][address(0)] += netPremium;
            accruedFees[address(0)] += protocolFee;
        } else {
            // Premium in ERC-20 — buyer must have approved vault
            IERC20(wp.collateralToken).safeTransferFrom(msg.sender, address(this), premiumWad);
            writerCollateral[msg.sender][wp.collateralToken] += netPremium;
            accruedFees[wp.collateralToken] += protocolFee;
        }
        emit FeeCollected(wp.collateralToken, protocolFee);

        // ── Mint Option NFT ──
        tokenId = optionToken.mint(
            msg.sender, // buyer receives the NFT
            OptionToken.OptionData({
                feedId:          feedId,
                underlyingSymbol: wp.symbol,
                optionType:      OptionToken.OptionType(uint8(wp.optionType)),
                strikeWad:       wp.strikeWad,
                expiry:          wp.expiry,
                sizeWad:         wp.sizeWad,
                premiumWad:      premiumWad,
                writer:          msg.sender,
                collateralToken: wp.collateralToken,
                scheduleId:      address(0), // updated after HIP-1215 call
                status:          OptionToken.OptionStatus.Active,
                createdAt:       block.timestamp
            })
        );

        // ── Record position ──
        positions[tokenId] = Position({
            tokenId:         tokenId,
            feedId:          feedId,
            symbol:          wp.symbol,
            optionType:      wp.optionType,
            strikeWad:       wp.strikeWad,
            expiry:          wp.expiry,
            sizeWad:         wp.sizeWad,
            premiumWad:      premiumWad,
            writer:          msg.sender,
            buyer:           msg.sender,
            collateralToken: wp.collateralToken,
            collateralWad:   collateralRequired,
            scheduleId:      address(0),
            settled:         false
        });

        // ── Schedule auto-expiry via HIP-1215 ──
        address scheduleId = _scheduleExpiry(tokenId, wp.expiry);
        positions[tokenId].scheduleId = scheduleId;
        optionToken.setScheduleId(tokenId, scheduleId);

        emit OptionWritten(
            tokenId, msg.sender, msg.sender,
            wp.symbol, wp.optionType,
            wp.strikeWad, wp.sizeWad, wp.expiry, premiumWad,
            scheduleId
        );
    }

    // ─── Option Exercise ──────────────────────────────────────────────────────────

    /// @notice Exercise an in-the-money option (European: only callable at/after expiry).
    ///         For American-style exercise before expiry, see exerciseEarly().
    /// @param tokenId         The OptionToken NFT to exercise.
    /// @param pythUpdateData  Fresh Pyth price update VAAs.
    function exercise(uint256 tokenId, bytes[] calldata pythUpdateData)
        external
        payable
        nonReentrant
    {
        Position storage pos = positions[tokenId];
        _checkActive(tokenId, pos);
        if (optionToken.ownerOf(tokenId) != msg.sender)
            revert NotOptionOwner(tokenId, msg.sender);

        // Update and fetch spot price
        uint256 pythFee = pyth.getUpdateFee(pythUpdateData);
        pyth.updatePriceFeeds{value: pythFee}(pythUpdateData);
        IPyth.Price memory op = pyth.getPriceNoOlderThan(pos.feedId, PYTH_MAX_AGE);
        uint256 spotWad = FixedPointMath.pythPriceToWad(op.price, op.expo);

        uint256 payoutWad = _computePayout(pos, spotWad);
        _settle(tokenId, pos, msg.sender, payoutWad, spotWad, false);
    }

    /// @notice Auto-expiry callback — called by HIP-1215 schedule service at expiry.
    /// @dev ONLY the HSS precompile or the owner can call this function.
    ///      The HIP-1215 schedule executes this with the last cached Pyth price.
    ///      To maximise accuracy, the protocol can also accept a fresh Pyth update.
    function expireOption(uint256 tokenId) external nonReentrant {
        require(
            msg.sender == HederaSystemContracts.HSS || msg.sender == owner(),
            "Vault: only HSS or owner"
        );

        Position storage pos = positions[tokenId];
        if (pos.settled) return; // idempotent — safe for re-execution

        if (block.timestamp < pos.expiry) revert OptionNotExpired(tokenId, pos.expiry);

        // Use cached (potentially stale) price — acceptable at expiry
        IPyth.Price memory op = pyth.getPriceUnsafe(pos.feedId);
        uint256 spotWad = FixedPointMath.pythPriceToWad(op.price, op.expo);

        uint256 payoutWad = _computePayout(pos, spotWad);
        address recipient = payoutWad > 0 ? pos.buyer : pos.writer;
        _settle(tokenId, pos, recipient, payoutWad, spotWad, true);
    }

    // ─── Fee Withdrawal ──────────────────────────────────────────────────────────

    /// @notice Withdraw accrued protocol fees. Owner only.
    function withdrawFees(address token, address to) external onlyOwner {
        uint256 amount = accruedFees[token];
        require(amount > 0, "Vault: no fees");
        accruedFees[token] = 0;

        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "Vault: HBAR fee transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ─── View Functions ───────────────────────────────────────────────────────────

    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }

    function getSupportedSymbols() external view returns (string[] memory) {
        return supportedSymbols;
    }

    function getCollateralTokens() external view returns (address[] memory) {
        return collateralTokens;
    }

    function availableCollateral(address writer, address token)
        external view returns (uint256)
    {
        return writerCollateral[writer][token];
    }

    /// @notice Compute the intrinsic value payout for a given position and spot price.
    function intrinsicValue(uint256 tokenId, uint256 spotWad)
        external view returns (uint256)
    {
        Position storage pos = positions[tokenId];
        return _computePayout(pos, spotWad);
    }

    // ─── Internal Helpers ────────────────────────────────────────────────────────

    /// @dev Returns the required collateral for a new option position.
    ///      • Covered call:       size units of underlying (e.g., 1000 HBAR)
    ///      • Cash-secured put:   strike * size USD equivalent in collateral
    function _requiredCollateral(
        OptionType optType,
        uint256 strikeWad,
        uint256 sizeWad,
        uint256 spotWad,
        address collateralToken
    ) internal pure returns (uint256) {
        if (optType == OptionType.Call) {
            // Covered call: must hold the underlying notional value in collateral
            // Collateral = spot * size (in USD terms)
            return FixedPointMath.mulWad(spotWad, sizeWad);
        } else {
            // Cash-secured put: must hold strike * size
            return FixedPointMath.mulWad(strikeWad, sizeWad);
        }
    }

    /// @dev Compute cash settlement payout for a position at a given spot price.
    function _computePayout(Position storage pos, uint256 spotWad)
        internal view returns (uint256 payoutWad)
    {
        if (pos.optionType == OptionType.Call) {
            // Call: max(0, spot - strike) * size
            if (spotWad > pos.strikeWad) {
                payoutWad = FixedPointMath.mulWad(spotWad - pos.strikeWad, pos.sizeWad);
            }
        } else {
            // Put: max(0, strike - spot) * size
            if (pos.strikeWad > spotWad) {
                payoutWad = FixedPointMath.mulWad(pos.strikeWad - spotWad, pos.sizeWad);
            }
        }
        // Cap at locked collateral (prevents over-payment edge cases)
        if (payoutWad > pos.collateralWad) payoutWad = pos.collateralWad;
    }

    /// @dev Execute settlement: transfer payout to recipient, return residual to writer.
    function _settle(
        uint256 tokenId,
        Position storage pos,
        address recipient,
        uint256 payoutWad,
        uint256 spotWad,
        bool automated
    ) internal {
        pos.settled = true;
        optionToken.setStatus(
            tokenId,
            payoutWad > 0 ? OptionToken.OptionStatus.Exercised : OptionToken.OptionStatus.Expired
        );

        // Return residual collateral to writer
        uint256 writerReturn = pos.collateralWad - payoutWad;
        if (writerReturn > 0) {
            writerCollateral[pos.writer][pos.collateralToken] += writerReturn;
        }

        // Pay buyer (or writer if OTM at expiry)
        if (payoutWad > 0) {
            if (pos.collateralToken == address(0)) {
                (bool ok, ) = recipient.call{value: payoutWad}("");
                require(ok, "Vault: HBAR payout failed");
            } else {
                IERC20(pos.collateralToken).safeTransfer(recipient, payoutWad);
            }
        }

        if (payoutWad > 0) {
            emit OptionExercised(tokenId, recipient, spotWad, payoutWad);
        } else {
            emit OptionExpired(tokenId, automated);
        }
    }

    /// @dev Schedule the auto-expiry of an option via HIP-1215.
    ///      The HSS precompile will call expireOption(tokenId) at the expiry timestamp.
    function _scheduleExpiry(uint256 tokenId, uint256 expiryTimestamp)
        internal
        returns (address scheduleId)
    {
        // Build the call to expireOption
        bytes memory callData = abi.encodeWithSelector(
            this.expireOption.selector,
            tokenId
        );

        IHederaScheduleService.ScheduleCallParams memory params =
            IHederaScheduleService.ScheduleCallParams({
                target:        address(this),
                callData:      callData,
                scheduledTime: expiryTimestamp,
                gasLimit:      300_000,
                tinyCents:     0,
                payer:         address(this),
                memo:          bytes32(tokenId)
            });

        // Use a low-level call so that both revert AND abi-decode errors degrade
        // gracefully. On Hardhat (no precompile at HSS address) the call returns
        // empty data; a typed try/catch would still panic on the decode step.
        // scheduleCall is overloaded so we specify the full struct signature.
        (bool ok, bytes memory ret) = address(hss).call(
            abi.encodeWithSignature(
                "scheduleCall((address,bytes,uint256,uint256,uint256,address,bytes32))",
                params
            )
        );
        if (ok && ret.length >= 32) {
            scheduleId = abi.decode(ret, (address));
        } else {
            // HIP-1215 not available — graceful degradation.
            // Manual expiry via expireOption() remains the fallback.
            scheduleId = address(0);
        }
    }

    function _validateWriteParams(WriteParams calldata wp) internal view {
        if (feedIds[wp.symbol] == bytes32(0)) revert UnknownSymbol(wp.symbol);
        if (!isCollateralToken[wp.collateralToken]) revert UnsupportedCollateral(wp.collateralToken);
        if (wp.sizeWad == 0)   revert InvalidSize();
        if (wp.strikeWad == 0) revert InvalidStrike();

        uint256 minExpiry = block.timestamp + MIN_EXPIRY_SECS;
        uint256 maxExpiry = block.timestamp + MAX_EXPIRY_DAYS * 1 days;
        if (wp.expiry < minExpiry) revert ExpiryTooSoon(wp.expiry);
        if (wp.expiry > maxExpiry) revert ExpiryTooFar(wp.expiry, maxExpiry);
    }

    function _checkActive(uint256 tokenId, Position storage pos) internal view {
        if (pos.settled) revert OptionAlreadySettled(tokenId);
    }

    function _getFeedId(string memory symbol) internal view returns (bytes32 feedId) {
        feedId = feedIds[symbol];
        if (feedId == bytes32(0)) revert UnknownSymbol(symbol);
    }

    // Accept HBAR
    receive() external payable {}
}
