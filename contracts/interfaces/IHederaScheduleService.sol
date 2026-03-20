// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IHederaScheduleService
/// @notice Interface for HIP-1215: Generalized Scheduled Contract Calls
/// @dev HIP-1215 enables smart contracts to schedule their own future execution
///      at the PROTOCOL level — no external keeper bots (Gelato, Chainlink) required.
///
///      This is Hedera's killer feature for derivatives: options can auto-exercise
///      and auto-expire without any third-party infrastructure.
///
///      Precompile address: 0x0000000000000000000000000000000000000169 (Hedera HSS)
///      HIP spec: https://github.com/hashgraph/hedera-improvement-proposal/blob/main/HIP/hip-1215.md
///
///      Workflow for option expiry:
///        1. createOption() → scheduleCall(address(this), expireOption.selector, expiryTime)
///        2. At expiryTime, Hedera consensus nodes execute expireOption() automatically
///        3. No keeper required; gas is pre-funded via deposit()
///
///      Note: HIP-1215 was ratified in early 2026. This interface reflects the
///            specification. Use HEDERA_SCHEDULE_SERVICE_PRECOMPILE_ADDRESS constant.

interface IHederaScheduleService {
    // ─── Data Structures ────────────────────────────────────────────────────────

    /// @notice Parameters for scheduling a contract call.
    struct ScheduleCallParams {
        address target;          // Contract to call
        bytes   callData;        // Encoded function call (abi.encodeWithSelector(...))
        uint256 scheduledTime;   // UNIX timestamp when the call should execute
        uint256 gasLimit;        // Gas to provide for the scheduled call
        uint256 tinyCents;       // HBAR to attach (in tinyCents, 1 HBAR = 100,000,000 tinyCents)
        address payer;           // Account responsible for paying execution fees
        bytes32 memo;            // Optional memo for the schedule record
    }

    /// @notice Information about a created schedule.
    struct ScheduleInfo {
        address scheduleId;      // Hedera schedule entity ID (as EVM address)
        uint256 scheduledTime;   // Execution timestamp
        bool    executed;        // True if already executed
        bool    deleted;         // True if cancelled/deleted
        address creator;         // Contract that created this schedule
    }

    // ─── Core Functions ──────────────────────────────────────────────────────────

    /// @notice Schedule a future contract call (HIP-1215 core function).
    /// @dev The calling contract pays the scheduling fee via msg.value.
    ///      The scheduled call executes at `params.scheduledTime` ± consensus variance.
    ///      Emits ScheduleCreated event.
    /// @param params  All scheduling parameters (see ScheduleCallParams).
    /// @return scheduleId  Hedera schedule entity (as EVM address, for cancellation).
    function scheduleCall(ScheduleCallParams calldata params)
        external
        payable
        returns (address scheduleId);

    /// @notice Convenience overload: schedule a simple call with defaults.
    /// @param target         Contract to call.
    /// @param callData       ABI-encoded call.
    /// @param scheduledTime  UNIX timestamp for execution.
    /// @return scheduleId
    function scheduleCall(
        address target,
        bytes calldata callData,
        uint256 scheduledTime
    ) external payable returns (address scheduleId);

    /// @notice Cancel a previously created schedule (only creator or admin can cancel).
    /// @param scheduleId  The address returned from scheduleCall().
    function cancelSchedule(address scheduleId) external;

    /// @notice Query status of a schedule.
    function getScheduleInfo(address scheduleId) external view returns (ScheduleInfo memory info);

    /// @notice Returns the HBAR fee (in tinyCents) required to create one schedule.
    function getSchedulingFee() external view returns (uint256 tinyCents);

    // ─── Events ─────────────────────────────────────────────────────────────────

    /// @notice Emitted when a new schedule is created.
    event ScheduleCreated(
        address indexed creator,
        address indexed scheduleId,
        address indexed target,
        uint256         scheduledTime
    );

    /// @notice Emitted when a scheduled call executes successfully.
    event ScheduleExecuted(
        address indexed scheduleId,
        address indexed target,
        bool            success
    );

    /// @notice Emitted when a schedule is cancelled.
    event ScheduleCancelled(address indexed scheduleId, address indexed cancelledBy);
}

/// @notice Hedera System Contract Addresses
library HederaSystemContracts {
    /// @dev Hedera Token Service (HTS) precompile
    address internal constant HTS = 0x0000000000000000000000000000000000000167;

    /// @dev Exchange Rate precompile (HBAR ↔ USD conversion)
    address internal constant EXCHANGE_RATE = 0x0000000000000000000000000000000000000168;

    /// @dev Hedera Schedule Service (HSS) precompile — HIP-1215
    address internal constant HSS = 0x0000000000000000000000000000000000000169;

    /// @dev Hedera Account Service precompile
    address internal constant HAS = 0x000000000000000000000000000000000000016a;
}
