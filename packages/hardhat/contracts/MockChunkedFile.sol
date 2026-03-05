// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

contract MockChunkedFile {
    address[] public chunks;

    constructor(address[] memory _chunks) {
        chunks = _chunks;
    }

    function chunkCount() external view returns (uint256) {
        return chunks.length;
    }

    function chunkAddress(uint256 index) external view returns (address) {
        return chunks[index];
    }
}
