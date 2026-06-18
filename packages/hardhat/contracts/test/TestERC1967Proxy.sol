// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST-ONLY: pulls OpenZeppelin's ERC1967Proxy into this project's artifact set so
// the Upgradeability test can deploy a proxy by hand (the hardhat-upgrades plugin
// pinned in this workspace targets Hardhat 3 and can't load under Hardhat 2 — see
// test/Upgradeability.test.ts header). Not production.
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract TestERC1967Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) payable ERC1967Proxy(implementation, data) {}
}
