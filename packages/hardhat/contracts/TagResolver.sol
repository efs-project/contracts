// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/**
 * @title TagResolver
 * @dev A resolver for validating Tag attestations
 */
contract TagResolver is SchemaResolver {
    constructor(IEAS eas) SchemaResolver(eas) {}

    function onAttest(Attestation calldata /*attestation*/, uint256 /*value*/) internal pure override returns (bool) {
        return true;
    }

    function onRevoke(Attestation calldata /*attestation*/, uint256 /*value*/) internal pure override returns (bool) {
        return true;
    }
}
