// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MultiSender
 * @notice Batch-send BEP20/ERC20 tokens to many recipients in a single transaction.
 *
 * Usage:
 *   1. Caller must approve this contract to spend at least sum(amounts) of `token`.
 *   2. Call bulkSendTokens(token, recipients, amounts).
 *
 * Gas note: each transferFrom costs ~30k gas. At 100 recipients that's ~3M gas —
 * well within BSC block limits (~140M). Keep batches ≤ 200 to stay safe.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract MultiSender {
    uint256 public constant MAX_BATCH = 500;

    event BulkSent(
        address indexed token,
        address indexed sender,
        uint256 totalRecipients,
        uint256 totalAmount
    );

    error ArrayLengthMismatch();
    error EmptyRecipients();
    error BatchTooLarge(uint256 len, uint256 max);
    error ZeroAddress(uint256 index);
    error ZeroAmount(uint256 index);
    error TransferFailed(address recipient, uint256 amount);
    error InsufficientAllowance(uint256 required, uint256 available);

    /**
     * @notice Send variable amounts to each recipient.
     * @param token    BEP20/ERC20 token address.
     * @param recipients Array of recipient addresses.
     * @param amounts    Array of token amounts (in token's smallest unit).
     */
    function bulkSendTokens(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        uint256 len = recipients.length;
        if (len == 0) revert EmptyRecipients();
        if (len > MAX_BATCH) revert BatchTooLarge(len, MAX_BATCH);
        if (len != amounts.length) revert ArrayLengthMismatch();

        uint256 total = 0;
        for (uint256 i = 0; i < len; ) {
            if (recipients[i] == address(0)) revert ZeroAddress(i);
            if (amounts[i] == 0) revert ZeroAmount(i);
            unchecked { total += amounts[i]; ++i; }
        }

        uint256 available = IERC20(token).allowance(msg.sender, address(this));
        if (available < total) revert InsufficientAllowance(total, available);

        for (uint256 i = 0; i < len; ) {
            bool ok = IERC20(token).transferFrom(msg.sender, recipients[i], amounts[i]);
            if (!ok) revert TransferFailed(recipients[i], amounts[i]);
            unchecked { ++i; }
        }

        emit BulkSent(token, msg.sender, len, total);
    }

    /**
     * @notice Send the same amount to every recipient.
     * @param token      BEP20/ERC20 token address.
     * @param recipients Array of recipient addresses.
     * @param amount     Amount per recipient (in token's smallest unit).
     */
    function bulkSendTokensEqual(
        address token,
        address[] calldata recipients,
        uint256 amount
    ) external {
        uint256 len = recipients.length;
        if (len == 0) revert EmptyRecipients();
        if (len > MAX_BATCH) revert BatchTooLarge(len, MAX_BATCH);
        if (amount == 0) revert ZeroAmount(0);

        uint256 total = amount * len;
        uint256 available = IERC20(token).allowance(msg.sender, address(this));
        if (available < total) revert InsufficientAllowance(total, available);

        for (uint256 i = 0; i < len; ) {
            if (recipients[i] == address(0)) revert ZeroAddress(i);
            bool ok = IERC20(token).transferFrom(msg.sender, recipients[i], amount);
            if (!ok) revert TransferFailed(recipients[i], amount);
            unchecked { ++i; }
        }

        emit BulkSent(token, msg.sender, len, total);
    }

    /**
     * @notice Off-chain helper: compute sum of amounts array.
     */
    function getTotalAmount(
        address,
        address[] calldata,
        uint256[] calldata amounts
    ) external pure returns (uint256 total) {
        for (uint256 i = 0; i < amounts.length; ) {
            unchecked { total += amounts[i]; ++i; }
        }
    }

    /// @notice Reject accidental BNB sends.
    receive() external payable { revert("MultiSender: no BNB accepted"); }
}
