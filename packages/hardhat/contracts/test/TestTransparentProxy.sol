// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST-ONLY: pulls OpenZeppelin's TransparentUpgradeableProxy + ProxyAdmin into this project's
// artifact set so the upgrade-with-state test (test/UpgradeWithState.test.ts) can deploy a proxy
// that is actually UPGRADEABLE on-chain and exercise a real V1→V2 implementation swap.
//
// Why Transparent (not the plain ERC1967Proxy in TestERC1967Proxy.sol)? The EFS resolvers do NOT
// inherit UUPSUpgradeable — they carry no `upgradeToAndCall` hook in their own bytecode. With a
// plain ERC1967Proxy there is therefore NO on-chain upgrade entrypoint at all. The Transparent
// pattern puts the upgrade logic in the PROXY (dispatched to its ProxyAdmin), so it can upgrade a
// no-UUPS implementation. The constructor deploys a ProxyAdmin owned by `initialOwner`; call
// `ProxyAdmin.upgradeAndCall(proxy, newImpl, "")` to perform the swap. This is the ProxyAdmin /
// ERC1967 upgrade path the storage-corruption guard validates. Not production.
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract TestTransparentProxy is TransparentUpgradeableProxy {
    constructor(
        address implementation,
        address initialOwner,
        bytes memory data
    ) payable TransparentUpgradeableProxy(implementation, initialOwner, data) {}
}

// Re-export ProxyAdmin so its artifact + ABI are available to the test (the proxy creates one
// internally; the test binds to it at the address read from the proxy's ERC-1967 admin slot).
contract TestProxyAdmin is ProxyAdmin {
    constructor(address initialOwner) ProxyAdmin(initialOwner) {}
}
