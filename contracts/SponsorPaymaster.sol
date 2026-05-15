// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  SponsorPaymaster
/// @author 0xPenwright
/// @notice An ERC-4337 paymaster that sponsors gas for whitelisted senders
///         up to a per-sender daily limit (in wei of gas cost).
/// @dev    Compatible with EntryPoint v0.7 (`PackedUserOperation`).
///         Daily window is `block.timestamp / 1 days` (UTC midnight).
contract SponsorPaymaster is BasePaymaster, Pausable {
    /// @notice Per-sender sponsoring allowance.
    /// @param dailyLimit  Max wei of gas the paymaster will cover per UTC day.
    /// @param spentToday  Wei already covered today (resets when `resetDay` rolls over).
    /// @param resetDay    Day index (`block.timestamp / 1 days`) of last reset.
    struct Allowance {
        uint128 dailyLimit;
        uint128 spentToday;
        uint32  resetDay;
    }

    /// @notice Default daily limit applied when caller passes `0`.
    uint256 public constant DEFAULT_DAILY_LIMIT = 0.005 ether;

    /// @notice Sender => current allowance.
    mapping(address => Allowance) public allowances;

    event SenderWhitelisted(address indexed sender, uint128 dailyLimit);
    event SenderRemoved(address indexed sender);
    event GasSponsored(address indexed sender, uint256 actualGasCost, uint256 remainingToday);

    error SenderNotWhitelisted(address sender);
    error DailyLimitExceeded(address sender, uint256 attempted, uint256 available);

    /// @param _entryPoint Canonical EntryPoint v0.7 deployment.
    /// @param _owner      Address that controls whitelisting, pausing, and withdrawals.
    constructor(IEntryPoint _entryPoint, address _owner) BasePaymaster(_entryPoint) {
        if (_owner != msg.sender) _transferOwnership(_owner);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Whitelist `sender` with a daily wei limit. `0` applies the default.
    function whitelist(address sender, uint128 dailyLimit) external onlyOwner {
        uint128 limit = dailyLimit == 0 ? uint128(DEFAULT_DAILY_LIMIT) : dailyLimit;
        allowances[sender] = Allowance({
            dailyLimit: limit,
            spentToday: 0,
            resetDay: uint32(block.timestamp / 1 days)
        });
        emit SenderWhitelisted(sender, limit);
    }

    /// @notice Whitelist multiple senders with the same `dailyLimit`.
    function whitelistBatch(address[] calldata senders, uint128 dailyLimit) external onlyOwner {
        uint128 limit = dailyLimit == 0 ? uint128(DEFAULT_DAILY_LIMIT) : dailyLimit;
        uint32 today = uint32(block.timestamp / 1 days);
        for (uint256 i; i < senders.length; ++i) {
            allowances[senders[i]] = Allowance({
                dailyLimit: limit,
                spentToday: 0,
                resetDay: today
            });
            emit SenderWhitelisted(senders[i], limit);
        }
    }

    /// @notice Remove `sender` from the whitelist.
    function remove(address sender) external onlyOwner {
        delete allowances[sender];
        emit SenderRemoved(sender);
    }

    /// @notice Pause new sponsorship. Existing in-flight ops still complete.
    function pause() external onlyOwner { _pause(); }

    /// @notice Resume sponsorship.
    function unpause() external onlyOwner { _unpause(); }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice Returns the wei of gas still available to `sender` today.
    function remainingToday(address sender) external view returns (uint256) {
        Allowance memory a = allowances[sender];
        if (a.dailyLimit == 0) return 0;
        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = today == a.resetDay ? a.spentToday : 0;
        return a.dailyLimit - spent;
    }

    // ─── ERC-4337 hooks ──────────────────────────────────────────────────────

    /// @inheritdoc BasePaymaster
    /// @dev Reverts if the sender is not whitelisted, the contract is paused,
    ///      or the requested `maxCost` would exceed today's limit.
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) internal view override whenNotPaused returns (bytes memory context, uint256 validationData) {
        Allowance memory a = allowances[userOp.sender];
        if (a.dailyLimit == 0) revert SenderNotWhitelisted(userOp.sender);

        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = today == a.resetDay ? a.spentToday : 0;

        if (spent + maxCost > a.dailyLimit) {
            revert DailyLimitExceeded(userOp.sender, maxCost, a.dailyLimit - spent);
        }

        context = abi.encode(userOp.sender, today);
        validationData = _packValidationData(false, 0, 0);
    }

    /// @inheritdoc BasePaymaster
    /// @dev Accounts the actual gas cost against the sender's daily allowance.
    function _postOp(
        IPaymaster.PostOpMode /* mode */,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) internal override {
        (address sender, uint32 day) = abi.decode(context, (address, uint32));
        Allowance storage a = allowances[sender];

        if (a.resetDay != day) {
            a.resetDay = day;
            a.spentToday = 0;
        }
        // Safe: dailyLimit gates the maxCost upper bound in _validatePaymasterUserOp.
        a.spentToday += uint128(actualGasCost);

        emit GasSponsored(sender, actualGasCost, a.dailyLimit - a.spentToday);
    }
}
