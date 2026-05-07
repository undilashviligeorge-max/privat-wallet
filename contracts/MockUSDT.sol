// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only USDT stand-in (6 decimals, like Ethereum mainnet USDT).
contract MockUSDT is ERC20 {
    constructor(address initialMinter) ERC20("Mock USDT", "USDT") {
        _mint(initialMinter, 10_000_000 * 10 ** decimals());
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Convenience for local / Sepolia testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
