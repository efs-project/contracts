// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockChunkedFile {
    address[] private _chunks;

    constructor(address[] memory chunks) {
        for (uint256 i = 0; i < chunks.length; i++) {
            _chunks.push(chunks[i]);
        }
    }

    function chunkCount() external view returns (uint256) {
        return _chunks.length;
    }

    function chunkAddress(uint256 index) external view returns (address) {
        return _chunks[index];
    }
}
