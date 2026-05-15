// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IStakeManager} from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

/// @notice Minimal EntryPoint stand-in used only by SponsorPaymaster tests.
/// @dev    Stubs IEntryPoint where required (`supportsInterface` for the BasePaymaster
///         constructor check, plus deposit/withdraw bookkeeping). All other IEntryPoint
///         methods revert — they are never reached in unit tests.
contract MockEntryPoint is IEntryPoint {
    mapping(address => uint256) public deposits;

    /// @dev BasePaymaster constructor performs an ERC-165 check against IEntryPoint.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IEntryPoint).interfaceId
            || interfaceId == 0x01ffc9a7; // ERC165
    }

    // ─── Test helpers ────────────────────────────────────────────────────────

    /// @notice Forward a paymaster validation call as if from the real EntryPoint.
    function callValidate(
        address paymaster,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData) {
        return IPaymaster(paymaster).validatePaymasterUserOp(userOp, userOpHash, maxCost);
    }

    /// @notice Forward a paymaster postOp call as if from the real EntryPoint.
    function callPostOp(
        address paymaster,
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external {
        IPaymaster(paymaster).postOp(mode, context, actualGasCost, actualUserOpFeePerGas);
    }

    // ─── IStakeManager surface used by BasePaymaster ────────────────────────

    function depositTo(address account) external payable override {
        deposits[account] += msg.value;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return deposits[account];
    }

    function withdrawTo(address payable withdrawAddress, uint256 amount) external override {
        require(deposits[msg.sender] >= amount, "insufficient deposit");
        deposits[msg.sender] -= amount;
        (bool ok, ) = withdrawAddress.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function addStake(uint32) external payable override {}
    function unlockStake() external override {}
    function withdrawStake(address payable) external override {}

    function getDepositInfo(address) external pure override returns (DepositInfo memory info) {
        return info;
    }

    // ─── Stubs (unreachable from unit tests) ────────────────────────────────

    function handleOps(PackedUserOperation[] calldata, address payable) external pure override { revert("MockEP: not impl"); }
    function handleAggregatedOps(UserOpsPerAggregator[] calldata, address payable) external pure override { revert("MockEP: not impl"); }
    function getUserOpHash(PackedUserOperation calldata) external pure override returns (bytes32) { return bytes32(0); }
    function getSenderAddress(bytes memory) external pure override { revert("MockEP: not impl"); }
    function getNonce(address, uint192) external pure override returns (uint256) { return 0; }
    function incrementNonce(uint192) external override {}
    function delegateAndRevert(address, bytes calldata) external pure override { revert("MockEP: not impl"); }

    receive() external payable {}
}
