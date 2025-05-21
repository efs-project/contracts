// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/**
 * @title TopicResolver
 * @dev A resolver for validating Topic attestations
 */
contract TopicResolver is SchemaResolver {
    // Event for logging validated topics
    event TopicValidated(bytes32 uid, string name);

    /**
     * @dev Constructor
     * @param eas The address of the EAS contract
     */
    constructor(IEAS eas) SchemaResolver(eas) {}

    /**
     * @dev Validates an attestation using the given parameters
     * @return Whether the attestation is valid
     */
    function onAttest(Attestation calldata attestation, uint256 /*value*/) 
        internal 
        override
        returns (bool) 
    {
        // Decode the name string from the data
        string memory name = abi.decode(attestation.data, (string));
        
        // Validate that the name is not empty
        bytes memory nameBytes = bytes(name);
        bool isValid = nameBytes.length > 0;

        isValid = isValidIriComponentForStorage(name) && isValid;
        
        if (isValid) {
            emit TopicValidated(attestation.uid, name);
        }
        
        return isValid;
    }


    /**
     * @dev Validates if a string is suitable for use as an IRI component,
     * rejecting characters that are structurally reserved or universally unsafe
     * in URIs/IRIs, but allowing general Unicode characters (which are expected
     * to be percent-encoded by consumers when forming a URI).
     * This function aims to prevent URL parsing disruption by catching characters
     * that cannot exist raw even in an IRI component without special meaning.
     *
     * @param _name The topic name string to validate (intended as an IRI component).
     * @return True if the string is considered safe for storage as an IRI component, false otherwise.
     */
    function isValidIriComponentForStorage(string memory _name) public pure returns (bool) {
        bytes memory nameBytes = bytes(_name);

        if (nameBytes.length == 0) {
            return false; // Or true, depending on if empty names are allowed.
        }

        for (uint i = 0; i < nameBytes.length; i++) {
            bytes1 charByte = nameBytes[i];

            // 1. Reject Null character (0x00) - universally problematic
            if (charByte == 0x00) {
                return false;
            }

            // 2. Reject "Reserved" and "Unsafe" characters that *must* be percent-encoded
            // when used as data within a URI/IRI component, or characters that would
            // fundamentally break URI/IRI parsing if they appeared raw.
            // This list is based on RFC 3986 (URI) and RFC 3987 (IRI) guidelines for
            // characters that are *not* permitted directly in data segments unless encoded.
            if (
                charByte == 0x20 || // Space
                charByte == 0x22 || // " (double quote) - unsafe
                charByte == 0x23 || // # (hash) - fragment delimiter
                charByte == 0x25 || // % (percent) - used for encoding, so raw % is problematic
                charByte == 0x26 || // & (ampersand) - query parameter delimiter
                charByte == 0x2F || // / (slash) - path segment delimiter
                charByte == 0x3F || // ? (question mark) - query delimiter
                charByte == 0x3D || // = (equals) - key-value delimiter in queries
                charByte == 0x3A || // : (colon) - scheme/port delimiter
                charByte == 0x40 || // @ (at symbol) - userinfo delimiter
                charByte == 0x5B || // [ (open bracket) - specific to IPv6 literals, generally unsafe in component
                charByte == 0x5D || // ] (close bracket) - specific to IPv6 literals, generally unsafe in component
                charByte == 0x5C || // \ (backslash) - generally unsafe
                charByte == 0x5E || // ^ (caret) - generally unsafe
                charByte == 0x60 || // ` (backtick) - generally unsafe
                charByte == 0x7B || // { (open curly brace) - generally unsafe
                charByte == 0x7C || // | (pipe) - generally unsafe
                charByte == 0x7D    // } (close curly brace) - generally unsafe
                // Note: Characters like '!', '(', ')', '*', '+', ',', ';' are "reserved" but often appear in data
                // and would be percent-encoded by a consumer. This list focuses on characters
                // that cause more fundamental parsing issues or are always treated as delimiters.
            ) {
                return false;
            }
        }
        return true;
    }

    /**
     * @dev Validates attestation revocation
     * @return Whether the attestation can be revoked
     */
    function onRevoke(Attestation calldata /*attestation*/, uint256 /*value*/) 
        internal 
        override
        pure
        returns (bool) 
    {
        // Allow revocations
        return true;
    }
}
