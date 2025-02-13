import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * @example
 * const externalContracts = {
 *   1: {
 *     DAI: {
 *       address: "0x...",
 *       abi: [...],
 *     },
 *   },
 * } as const;
 */
const externalContracts = {
    31337: {
      EAS: {
        "address": "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
        "abi": [
          {
            "inputs": [
              {
                "internalType": "contract ISchemaRegistry",
                "name": "registry",
                "type": "address"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "constructor"
          },
          {
            "inputs": [],
            "name": "AccessDenied",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "AlreadyRevoked",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "AlreadyRevokedOffchain",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "AlreadyTimestamped",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InsufficientValue",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidAttestation",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidAttestations",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidExpirationTime",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidLength",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidOffset",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidRegistry",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidRevocation",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidRevocations",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidSchema",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidSignature",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidVerifier",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "Irrevocable",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "NotFound",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "NotPayable",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "WrongSchema",
            "type": "error"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "indexed": true,
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "indexed": false,
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              },
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              }
            ],
            "name": "Attested",
            "type": "event"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "indexed": true,
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "indexed": false,
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              },
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              }
            ],
            "name": "Revoked",
            "type": "event"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "address",
                "name": "revoker",
                "type": "address"
              },
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              },
              {
                "indexed": true,
                "internalType": "uint64",
                "name": "timestamp",
                "type": "uint64"
              }
            ],
            "name": "RevokedOffchain",
            "type": "event"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              },
              {
                "indexed": true,
                "internalType": "uint64",
                "name": "timestamp",
                "type": "uint64"
              }
            ],
            "name": "Timestamped",
            "type": "event"
          },
          {
            "inputs": [],
            "name": "VERSION",
            "outputs": [
              {
                "internalType": "string",
                "name": "",
                "type": "string"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData",
                    "name": "data",
                    "type": "tuple"
                  }
                ],
                "internalType": "struct AttestationRequest",
                "name": "request",
                "type": "tuple"
              }
            ],
            "name": "attest",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData",
                    "name": "data",
                    "type": "tuple"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct EIP712Signature",
                    "name": "signature",
                    "type": "tuple"
                  },
                  {
                    "internalType": "address",
                    "name": "attester",
                    "type": "address"
                  }
                ],
                "internalType": "struct DelegatedAttestationRequest",
                "name": "delegatedRequest",
                "type": "tuple"
              }
            ],
            "name": "attestByDelegation",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getAttestTypeHash",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "pure",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              }
            ],
            "name": "getAttestation",
            "outputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "uid",
                    "type": "bytes32"
                  },
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "internalType": "uint64",
                    "name": "time",
                    "type": "uint64"
                  },
                  {
                    "internalType": "uint64",
                    "name": "expirationTime",
                    "type": "uint64"
                  },
                  {
                    "internalType": "uint64",
                    "name": "revocationTime",
                    "type": "uint64"
                  },
                  {
                    "internalType": "bytes32",
                    "name": "refUID",
                    "type": "bytes32"
                  },
                  {
                    "internalType": "address",
                    "name": "recipient",
                    "type": "address"
                  },
                  {
                    "internalType": "address",
                    "name": "attester",
                    "type": "address"
                  },
                  {
                    "internalType": "bool",
                    "name": "revocable",
                    "type": "bool"
                  },
                  {
                    "internalType": "bytes",
                    "name": "data",
                    "type": "bytes"
                  }
                ],
                "internalType": "struct Attestation",
                "name": "",
                "type": "tuple"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getDomainSeparator",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "account",
                "type": "address"
              }
            ],
            "name": "getNonce",
            "outputs": [
              {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "revoker",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              }
            ],
            "name": "getRevokeOffchain",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getRevokeTypeHash",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "pure",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getSchemaRegistry",
            "outputs": [
              {
                "internalType": "contract ISchemaRegistry",
                "name": "",
                "type": "address"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              }
            ],
            "name": "getTimestamp",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              }
            ],
            "name": "isAttestationValid",
            "outputs": [
              {
                "internalType": "bool",
                "name": "",
                "type": "bool"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  }
                ],
                "internalType": "struct MultiAttestationRequest[]",
                "name": "multiRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiAttest",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct EIP712Signature[]",
                    "name": "signatures",
                    "type": "tuple[]"
                  },
                  {
                    "internalType": "address",
                    "name": "attester",
                    "type": "address"
                  }
                ],
                "internalType": "struct MultiDelegatedAttestationRequest[]",
                "name": "multiDelegatedRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiAttestByDelegation",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  }
                ],
                "internalType": "struct MultiRevocationRequest[]",
                "name": "multiRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiRevoke",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct EIP712Signature[]",
                    "name": "signatures",
                    "type": "tuple[]"
                  },
                  {
                    "internalType": "address",
                    "name": "revoker",
                    "type": "address"
                  }
                ],
                "internalType": "struct MultiDelegatedRevocationRequest[]",
                "name": "multiDelegatedRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiRevokeByDelegation",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32[]",
                "name": "data",
                "type": "bytes32[]"
              }
            ],
            "name": "multiRevokeOffchain",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32[]",
                "name": "data",
                "type": "bytes32[]"
              }
            ],
            "name": "multiTimestamp",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData",
                    "name": "data",
                    "type": "tuple"
                  }
                ],
                "internalType": "struct RevocationRequest",
                "name": "request",
                "type": "tuple"
              }
            ],
            "name": "revoke",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData",
                    "name": "data",
                    "type": "tuple"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct EIP712Signature",
                    "name": "signature",
                    "type": "tuple"
                  },
                  {
                    "internalType": "address",
                    "name": "revoker",
                    "type": "address"
                  }
                ],
                "internalType": "struct DelegatedRevocationRequest",
                "name": "delegatedRequest",
                "type": "tuple"
              }
            ],
            "name": "revokeByDelegation",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              }
            ],
            "name": "revokeOffchain",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "data",
                "type": "bytes32"
              }
            ],
            "name": "timestamp",
            "outputs": [
              {
                "internalType": "uint64",
                "name": "",
                "type": "uint64"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
          }
        ],
        "transactionHash": "0x3bf3cf413a67070229f435645c00e0902b1be926157500d8d474ff8e96c5dffc",
        "receipt": {
          "to": null,
          "from": "0x01a93612f26100B6E18a2e3dd57df5c3ccaFeca1",
          "contractAddress": "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
          "transactionIndex": 1,
          "gasUsed": "4349707",
          "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          "blockHash": "0x5fbc93dc9669ff02da9a9b31344259accb5180d93e7927bdd23baa991ada5be5",
          "transactionHash": "0x3bf3cf413a67070229f435645c00e0902b1be926157500d8d474ff8e96c5dffc",
          "logs": [],
          "blockNumber": 2958571,
          "cumulativeGasUsed": "7608274",
          "status": 1,
          "byzantium": true
        },
        "args": ["0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0"],
        "numDeployments": 1,
        "solcInputHash": "a71fe784ec2ddd03c0373182f6192f42",
        "metadata": "{\"compiler\":{\"version\":\"0.8.18+commit.87f61d96\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[{\"internalType\":\"contract ISchemaRegistry\",\"name\":\"registry\",\"type\":\"address\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"AccessDenied\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"AlreadyRevoked\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"AlreadyRevokedOffchain\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"AlreadyTimestamped\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InsufficientValue\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidAttestation\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidAttestations\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidExpirationTime\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidLength\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidOffset\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidRegistry\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidRevocation\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidRevocations\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidSchema\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidSignature\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidVerifier\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"Irrevocable\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"NotFound\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"NotPayable\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"WrongSchema\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"}],\"name\":\"Attested\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"}],\"name\":\"Revoked\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"},{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"uint64\",\"name\":\"timestamp\",\"type\":\"uint64\"}],\"name\":\"RevokedOffchain\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"uint64\",\"name\":\"timestamp\",\"type\":\"uint64\"}],\"name\":\"Timestamped\",\"type\":\"event\"},{\"inputs\":[],\"name\":\"VERSION\",\"outputs\":[{\"internalType\":\"string\",\"name\":\"\",\"type\":\"string\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData\",\"name\":\"data\",\"type\":\"tuple\"}],\"internalType\":\"struct AttestationRequest\",\"name\":\"request\",\"type\":\"tuple\"}],\"name\":\"attest\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData\",\"name\":\"data\",\"type\":\"tuple\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct EIP712Signature\",\"name\":\"signature\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"}],\"internalType\":\"struct DelegatedAttestationRequest\",\"name\":\"delegatedRequest\",\"type\":\"tuple\"}],\"name\":\"attestByDelegation\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getAttestTypeHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"pure\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"}],\"name\":\"getAttestation\",\"outputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"uint64\",\"name\":\"time\",\"type\":\"uint64\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"uint64\",\"name\":\"revocationTime\",\"type\":\"uint64\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"}],\"internalType\":\"struct Attestation\",\"name\":\"\",\"type\":\"tuple\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getDomainSeparator\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"}],\"name\":\"getNonce\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"}],\"name\":\"getRevokeOffchain\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getRevokeTypeHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"pure\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getSchemaRegistry\",\"outputs\":[{\"internalType\":\"contract ISchemaRegistry\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"}],\"name\":\"getTimestamp\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"}],\"name\":\"isAttestationValid\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"}],\"internalType\":\"struct MultiAttestationRequest[]\",\"name\":\"multiRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiAttest\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct EIP712Signature[]\",\"name\":\"signatures\",\"type\":\"tuple[]\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"}],\"internalType\":\"struct MultiDelegatedAttestationRequest[]\",\"name\":\"multiDelegatedRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiAttestByDelegation\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"}],\"internalType\":\"struct MultiRevocationRequest[]\",\"name\":\"multiRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiRevoke\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct EIP712Signature[]\",\"name\":\"signatures\",\"type\":\"tuple[]\"},{\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"}],\"internalType\":\"struct MultiDelegatedRevocationRequest[]\",\"name\":\"multiDelegatedRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiRevokeByDelegation\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"data\",\"type\":\"bytes32[]\"}],\"name\":\"multiRevokeOffchain\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"data\",\"type\":\"bytes32[]\"}],\"name\":\"multiTimestamp\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData\",\"name\":\"data\",\"type\":\"tuple\"}],\"internalType\":\"struct RevocationRequest\",\"name\":\"request\",\"type\":\"tuple\"}],\"name\":\"revoke\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData\",\"name\":\"data\",\"type\":\"tuple\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct EIP712Signature\",\"name\":\"signature\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"}],\"internalType\":\"struct DelegatedRevocationRequest\",\"name\":\"delegatedRequest\",\"type\":\"tuple\"}],\"name\":\"revokeByDelegation\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"}],\"name\":\"revokeOffchain\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"data\",\"type\":\"bytes32\"}],\"name\":\"timestamp\",\"outputs\":[{\"internalType\":\"uint64\",\"name\":\"\",\"type\":\"uint64\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}],\"devdoc\":{\"events\":{\"Attested(address,address,bytes32,bytes32)\":{\"details\":\"Emitted when an attestation has been made.\",\"params\":{\"attester\":\"The attesting account.\",\"recipient\":\"The recipient of the attestation.\",\"schema\":\"The UID of the schema.\",\"uid\":\"The UID the revoked attestation.\"}},\"Revoked(address,address,bytes32,bytes32)\":{\"details\":\"Emitted when an attestation has been revoked.\",\"params\":{\"attester\":\"The attesting account.\",\"recipient\":\"The recipient of the attestation.\",\"schema\":\"The UID of the schema.\",\"uid\":\"The UID the revoked attestation.\"}},\"RevokedOffchain(address,bytes32,uint64)\":{\"details\":\"Emitted when a data has been revoked.\",\"params\":{\"data\":\"The data.\",\"revoker\":\"The address of the revoker.\",\"timestamp\":\"The timestamp.\"}},\"Timestamped(bytes32,uint64)\":{\"details\":\"Emitted when a data has been timestamped.\",\"params\":{\"data\":\"The data.\",\"timestamp\":\"The timestamp.\"}}},\"kind\":\"dev\",\"methods\":{\"attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))\":{\"details\":\"Attests to a specific schema.\",\"params\":{\"request\":\"The arguments of the attestation request. Example: attest({     schema: \\\"0facc36681cbe2456019c1b0d1e7bedd6d1d40f6f324bf3dd3a4cef2999200a0\\\",     data: {         recipient: \\\"0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf\\\",         expirationTime: 0,         revocable: true,         refUID: \\\"0x0000000000000000000000000000000000000000000000000000000000000000\\\",         data: \\\"0xF00D\\\",         value: 0     } })\"},\"returns\":{\"_0\":\"The UID of the new attestation.\"}},\"attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address))\":{\"details\":\"Attests to a specific schema via the provided EIP712 signature.\",\"params\":{\"delegatedRequest\":\"The arguments of the delegated attestation request. Example: attestByDelegation({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 0     },     signature: {         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e' })\"},\"returns\":{\"_0\":\"The UID of the new attestation.\"}},\"constructor\":{\"details\":\"Creates a new EAS instance.\",\"params\":{\"registry\":\"The address of the global schema registry.\"}},\"getAttestation(bytes32)\":{\"details\":\"Returns an existing attestation by UID.\",\"params\":{\"uid\":\"The UID of the attestation to retrieve.\"},\"returns\":{\"_0\":\"The attestation data members.\"}},\"getDomainSeparator()\":{\"details\":\"Returns the domain separator used in the encoding of the signatures for attest, and revoke.\"},\"getNonce(address)\":{\"details\":\"Returns the current nonce per-account.\",\"params\":{\"account\":\"The requested account.\"},\"returns\":{\"_0\":\"The current nonce.\"}},\"getRevokeOffchain(address,bytes32)\":{\"details\":\"Returns the timestamp that the specified data was timestamped with.\",\"params\":{\"data\":\"The data to query.\"},\"returns\":{\"_0\":\"The timestamp the data was timestamped with.\"}},\"getSchemaRegistry()\":{\"details\":\"Returns the address of the global schema registry.\",\"returns\":{\"_0\":\"The address of the global schema registry.\"}},\"getTimestamp(bytes32)\":{\"details\":\"Returns the timestamp that the specified data was timestamped with.\",\"params\":{\"data\":\"The data to query.\"},\"returns\":{\"_0\":\"The timestamp the data was timestamped with.\"}},\"isAttestationValid(bytes32)\":{\"details\":\"Checks whether an attestation exists.\",\"params\":{\"uid\":\"The UID of the attestation to retrieve.\"},\"returns\":{\"_0\":\"Whether an attestation exists.\"}},\"multiAttest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[])[])\":{\"details\":\"Attests to multiple schemas.\",\"params\":{\"multiRequests\":\"The arguments of the multi attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiAttest([{     schema: '0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd',     data: [{         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 1000     },     {         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 0,         revocable: false,         refUID: '0x480df4a039efc31b11bfdf491b383ca138b6bde160988222a2a3509c02cee174',         data: '0x00',         value: 0     }], }, {     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',     data: [{         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 0,         revocable: true,         refUID: '0x75bf2ed8dca25a8190c50c52db136664de25b2449535839008ccfdab469b214f',         data: '0x12345678',         value: 0     }, }])\"},\"returns\":{\"_0\":\"The UIDs of the new attestations.\"}},\"multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address)[])\":{\"details\":\"Attests to multiple schemas using via provided EIP712 signatures.\",\"params\":{\"multiDelegatedRequests\":\"The arguments of the delegated multi attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiAttestByDelegation([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 0     },     {         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 0,         revocable: false,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x00',         value: 0     }],     signatures: [{         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     {         v: 28,         r: '0x487s...67bb',         s: '0x12ad...2366'     }],     attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4' }])\"},\"returns\":{\"_0\":\"The UIDs of the new attestations.\"}},\"multiRevoke((bytes32,(bytes32,uint256)[])[])\":{\"details\":\"Revokes existing attestations to multiple schemas.\",\"params\":{\"multiRequests\":\"The arguments of the multi revocation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiRevoke([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',         value: 1000     },     {         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',         value: 0     }], }, {     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',     data: [{         uid: '0x053d42abce1fd7c8fcddfae21845ad34dae287b2c326220b03ba241bc5a8f019',         value: 0     }, }])\"}},\"multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address)[])\":{\"details\":\"Revokes existing attestations to multiple schemas via provided EIP712 signatures.\",\"params\":{\"multiDelegatedRequests\":\"The arguments of the delegated multi revocation attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiRevokeByDelegation([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',         value: 1000     },     {         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',         value: 0     }],     signatures: [{         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     {         v: 28,         r: '0x487s...67bb',         s: '0x12ad...2366'     }],     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992' }])\"}},\"multiRevokeOffchain(bytes32[])\":{\"details\":\"Revokes the specified multiple bytes32 data.\",\"params\":{\"data\":\"The data to timestamp.\"},\"returns\":{\"_0\":\"The timestamp the data was revoked with.\"}},\"multiTimestamp(bytes32[])\":{\"details\":\"Timestamps the specified multiple bytes32 data.\",\"params\":{\"data\":\"The data to timestamp.\"},\"returns\":{\"_0\":\"The timestamp the data was timestamped with.\"}},\"revoke((bytes32,(bytes32,uint256)))\":{\"details\":\"Revokes an existing attestation to a specific schema. Example: revoke({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         uid: '0x101032e487642ee04ee17049f99a70590c735b8614079fc9275f9dd57c00966d',         value: 0     } })\",\"params\":{\"request\":\"The arguments of the revocation request.\"}},\"revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address))\":{\"details\":\"Revokes an existing attestation to a specific schema via the provided EIP712 signature. Example: revokeByDelegation({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',         value: 0     },     signature: {         v: 27,         r: '0xb593...7142',         s: '0x0f5b...2cce'     },     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992' })\",\"params\":{\"delegatedRequest\":\"The arguments of the delegated revocation request.\"}},\"revokeOffchain(bytes32)\":{\"details\":\"Revokes the specified bytes32 data.\",\"params\":{\"data\":\"The data to timestamp.\"},\"returns\":{\"_0\":\"The timestamp the data was revoked with.\"}},\"timestamp(bytes32)\":{\"details\":\"Timestamps the specified bytes32 data.\",\"params\":{\"data\":\"The data to timestamp.\"},\"returns\":{\"_0\":\"The timestamp the data was timestamped with.\"}}},\"title\":\"EAS - Ethereum Attestation Service\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{\"getAttestTypeHash()\":{\"notice\":\"Returns the EIP712 type hash for the attest function.\"},\"getRevokeTypeHash()\":{\"notice\":\"Returns the EIP712 type hash for the revoke function.\"}},\"version\":1}},\"settings\":{\"compilationTarget\":{\"contracts/EAS.sol\":\"EAS\"},\"evmVersion\":\"paris\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"none\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":1000000},\"remappings\":[],\"viaIR\":true},\"sources\":{\"@openzeppelin/contracts/utils/Address.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/Address.sol)\\n\\npragma solidity ^0.8.1;\\n\\n/**\\n * @dev Collection of functions related to the address type\\n */\\nlibrary Address {\\n    /**\\n     * @dev Returns true if `account` is a contract.\\n     *\\n     * [IMPORTANT]\\n     * ====\\n     * It is unsafe to assume that an address for which this function returns\\n     * false is an externally-owned account (EOA) and not a contract.\\n     *\\n     * Among others, `isContract` will return false for the following\\n     * types of addresses:\\n     *\\n     *  - an externally-owned account\\n     *  - a contract in construction\\n     *  - an address where a contract will be created\\n     *  - an address where a contract lived, but was destroyed\\n     * ====\\n     *\\n     * [IMPORTANT]\\n     * ====\\n     * You shouldn't rely on `isContract` to protect against flash loan attacks!\\n     *\\n     * Preventing calls from contracts is highly discouraged. It breaks composability, breaks support for smart wallets\\n     * like Gnosis Safe, and does not provide security since it can be circumvented by calling from a contract\\n     * constructor.\\n     * ====\\n     */\\n    function isContract(address account) internal view returns (bool) {\\n        // This method relies on extcodesize/address.code.length, which returns 0\\n        // for contracts in construction, since the code is only stored at the end\\n        // of the constructor execution.\\n\\n        return account.code.length > 0;\\n    }\\n\\n    /**\\n     * @dev Replacement for Solidity's `transfer`: sends `amount` wei to\\n     * `recipient`, forwarding all available gas and reverting on errors.\\n     *\\n     * https://eips.ethereum.org/EIPS/eip-1884[EIP1884] increases the gas cost\\n     * of certain opcodes, possibly making contracts go over the 2300 gas limit\\n     * imposed by `transfer`, making them unable to receive funds via\\n     * `transfer`. {sendValue} removes this limitation.\\n     *\\n     * https://diligence.consensys.net/posts/2019/09/stop-using-soliditys-transfer-now/[Learn more].\\n     *\\n     * IMPORTANT: because control is transferred to `recipient`, care must be\\n     * taken to not create reentrancy vulnerabilities. Consider using\\n     * {ReentrancyGuard} or the\\n     * https://solidity.readthedocs.io/en/v0.5.11/security-considerations.html#use-the-checks-effects-interactions-pattern[checks-effects-interactions pattern].\\n     */\\n    function sendValue(address payable recipient, uint256 amount) internal {\\n        require(address(this).balance >= amount, \\\"Address: insufficient balance\\\");\\n\\n        (bool success, ) = recipient.call{value: amount}(\\\"\\\");\\n        require(success, \\\"Address: unable to send value, recipient may have reverted\\\");\\n    }\\n\\n    /**\\n     * @dev Performs a Solidity function call using a low level `call`. A\\n     * plain `call` is an unsafe replacement for a function call: use this\\n     * function instead.\\n     *\\n     * If `target` reverts with a revert reason, it is bubbled up by this\\n     * function (like regular Solidity function calls).\\n     *\\n     * Returns the raw returned data. To convert to the expected return value,\\n     * use https://solidity.readthedocs.io/en/latest/units-and-global-variables.html?highlight=abi.decode#abi-encoding-and-decoding-functions[`abi.decode`].\\n     *\\n     * Requirements:\\n     *\\n     * - `target` must be a contract.\\n     * - calling `target` with `data` must not revert.\\n     *\\n     * _Available since v3.1._\\n     */\\n    function functionCall(address target, bytes memory data) internal returns (bytes memory) {\\n        return functionCallWithValue(target, data, 0, \\\"Address: low-level call failed\\\");\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`], but with\\n     * `errorMessage` as a fallback revert reason when `target` reverts.\\n     *\\n     * _Available since v3.1._\\n     */\\n    function functionCall(\\n        address target,\\n        bytes memory data,\\n        string memory errorMessage\\n    ) internal returns (bytes memory) {\\n        return functionCallWithValue(target, data, 0, errorMessage);\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],\\n     * but also transferring `value` wei to `target`.\\n     *\\n     * Requirements:\\n     *\\n     * - the calling contract must have an ETH balance of at least `value`.\\n     * - the called Solidity function must be `payable`.\\n     *\\n     * _Available since v3.1._\\n     */\\n    function functionCallWithValue(\\n        address target,\\n        bytes memory data,\\n        uint256 value\\n    ) internal returns (bytes memory) {\\n        return functionCallWithValue(target, data, value, \\\"Address: low-level call with value failed\\\");\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCallWithValue-address-bytes-uint256-}[`functionCallWithValue`], but\\n     * with `errorMessage` as a fallback revert reason when `target` reverts.\\n     *\\n     * _Available since v3.1._\\n     */\\n    function functionCallWithValue(\\n        address target,\\n        bytes memory data,\\n        uint256 value,\\n        string memory errorMessage\\n    ) internal returns (bytes memory) {\\n        require(address(this).balance >= value, \\\"Address: insufficient balance for call\\\");\\n        (bool success, bytes memory returndata) = target.call{value: value}(data);\\n        return verifyCallResultFromTarget(target, success, returndata, errorMessage);\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],\\n     * but performing a static call.\\n     *\\n     * _Available since v3.3._\\n     */\\n    function functionStaticCall(address target, bytes memory data) internal view returns (bytes memory) {\\n        return functionStaticCall(target, data, \\\"Address: low-level static call failed\\\");\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-string-}[`functionCall`],\\n     * but performing a static call.\\n     *\\n     * _Available since v3.3._\\n     */\\n    function functionStaticCall(\\n        address target,\\n        bytes memory data,\\n        string memory errorMessage\\n    ) internal view returns (bytes memory) {\\n        (bool success, bytes memory returndata) = target.staticcall(data);\\n        return verifyCallResultFromTarget(target, success, returndata, errorMessage);\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],\\n     * but performing a delegate call.\\n     *\\n     * _Available since v3.4._\\n     */\\n    function functionDelegateCall(address target, bytes memory data) internal returns (bytes memory) {\\n        return functionDelegateCall(target, data, \\\"Address: low-level delegate call failed\\\");\\n    }\\n\\n    /**\\n     * @dev Same as {xref-Address-functionCall-address-bytes-string-}[`functionCall`],\\n     * but performing a delegate call.\\n     *\\n     * _Available since v3.4._\\n     */\\n    function functionDelegateCall(\\n        address target,\\n        bytes memory data,\\n        string memory errorMessage\\n    ) internal returns (bytes memory) {\\n        (bool success, bytes memory returndata) = target.delegatecall(data);\\n        return verifyCallResultFromTarget(target, success, returndata, errorMessage);\\n    }\\n\\n    /**\\n     * @dev Tool to verify that a low level call to smart-contract was successful, and revert (either by bubbling\\n     * the revert reason or using the provided one) in case of unsuccessful call or if target was not a contract.\\n     *\\n     * _Available since v4.8._\\n     */\\n    function verifyCallResultFromTarget(\\n        address target,\\n        bool success,\\n        bytes memory returndata,\\n        string memory errorMessage\\n    ) internal view returns (bytes memory) {\\n        if (success) {\\n            if (returndata.length == 0) {\\n                // only check isContract if the call was successful and the return data is empty\\n                // otherwise we already know that it was a contract\\n                require(isContract(target), \\\"Address: call to non-contract\\\");\\n            }\\n            return returndata;\\n        } else {\\n            _revert(returndata, errorMessage);\\n        }\\n    }\\n\\n    /**\\n     * @dev Tool to verify that a low level call was successful, and revert if it wasn't, either by bubbling the\\n     * revert reason or using the provided one.\\n     *\\n     * _Available since v4.3._\\n     */\\n    function verifyCallResult(\\n        bool success,\\n        bytes memory returndata,\\n        string memory errorMessage\\n    ) internal pure returns (bytes memory) {\\n        if (success) {\\n            return returndata;\\n        } else {\\n            _revert(returndata, errorMessage);\\n        }\\n    }\\n\\n    function _revert(bytes memory returndata, string memory errorMessage) private pure {\\n        // Look for revert reason and bubble it up if present\\n        if (returndata.length > 0) {\\n            // The easiest way to bubble the revert reason is using memory via assembly\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                let returndata_size := mload(returndata)\\n                revert(add(32, returndata), returndata_size)\\n            }\\n        } else {\\n            revert(errorMessage);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xf96f969e24029d43d0df89e59d365f277021dac62b48e1c1e3ebe0acdd7f1ca1\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/Strings.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/Strings.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"./math/Math.sol\\\";\\n\\n/**\\n * @dev String operations.\\n */\\nlibrary Strings {\\n    bytes16 private constant _SYMBOLS = \\\"0123456789abcdef\\\";\\n    uint8 private constant _ADDRESS_LENGTH = 20;\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` decimal representation.\\n     */\\n    function toString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            uint256 length = Math.log10(value) + 1;\\n            string memory buffer = new string(length);\\n            uint256 ptr;\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                ptr := add(buffer, add(32, length))\\n            }\\n            while (true) {\\n                ptr--;\\n                /// @solidity memory-safe-assembly\\n                assembly {\\n                    mstore8(ptr, byte(mod(value, 10), _SYMBOLS))\\n                }\\n                value /= 10;\\n                if (value == 0) break;\\n            }\\n            return buffer;\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            return toHexString(value, Math.log256(value) + 1);\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation with fixed length.\\n     */\\n    function toHexString(uint256 value, uint256 length) internal pure returns (string memory) {\\n        bytes memory buffer = new bytes(2 * length + 2);\\n        buffer[0] = \\\"0\\\";\\n        buffer[1] = \\\"x\\\";\\n        for (uint256 i = 2 * length + 1; i > 1; --i) {\\n            buffer[i] = _SYMBOLS[value & 0xf];\\n            value >>= 4;\\n        }\\n        require(value == 0, \\\"Strings: hex length insufficient\\\");\\n        return string(buffer);\\n    }\\n\\n    /**\\n     * @dev Converts an `address` with fixed length of 20 bytes to its not checksummed ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(address addr) internal pure returns (string memory) {\\n        return toHexString(uint256(uint160(addr)), _ADDRESS_LENGTH);\\n    }\\n}\\n\",\"keccak256\":\"0xa4d1d62251f8574deb032a35fc948386a9b4de74b812d4f545a1ac120486b48a\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/cryptography/ECDSA.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/cryptography/ECDSA.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"../Strings.sol\\\";\\n\\n/**\\n * @dev Elliptic Curve Digital Signature Algorithm (ECDSA) operations.\\n *\\n * These functions can be used to verify that a message was signed by the holder\\n * of the private keys of a given address.\\n */\\nlibrary ECDSA {\\n    enum RecoverError {\\n        NoError,\\n        InvalidSignature,\\n        InvalidSignatureLength,\\n        InvalidSignatureS,\\n        InvalidSignatureV // Deprecated in v4.8\\n    }\\n\\n    function _throwError(RecoverError error) private pure {\\n        if (error == RecoverError.NoError) {\\n            return; // no error: do nothing\\n        } else if (error == RecoverError.InvalidSignature) {\\n            revert(\\\"ECDSA: invalid signature\\\");\\n        } else if (error == RecoverError.InvalidSignatureLength) {\\n            revert(\\\"ECDSA: invalid signature length\\\");\\n        } else if (error == RecoverError.InvalidSignatureS) {\\n            revert(\\\"ECDSA: invalid signature 's' value\\\");\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns the address that signed a hashed message (`hash`) with\\n     * `signature` or error string. This address can then be used for verification purposes.\\n     *\\n     * The `ecrecover` EVM opcode allows for malleable (non-unique) signatures:\\n     * this function rejects them by requiring the `s` value to be in the lower\\n     * half order, and the `v` value to be either 27 or 28.\\n     *\\n     * IMPORTANT: `hash` _must_ be the result of a hash operation for the\\n     * verification to be secure: it is possible to craft signatures that\\n     * recover to arbitrary addresses for non-hashed data. A safe way to ensure\\n     * this is by receiving a hash of the original message (which may otherwise\\n     * be too long), and then calling {toEthSignedMessageHash} on it.\\n     *\\n     * Documentation for signature generation:\\n     * - with https://web3js.readthedocs.io/en/v1.3.4/web3-eth-accounts.html#sign[Web3.js]\\n     * - with https://docs.ethers.io/v5/api/signer/#Signer-signMessage[ethers]\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(bytes32 hash, bytes memory signature) internal pure returns (address, RecoverError) {\\n        if (signature.length == 65) {\\n            bytes32 r;\\n            bytes32 s;\\n            uint8 v;\\n            // ecrecover takes the signature parameters, and the only way to get them\\n            // currently is to use assembly.\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                r := mload(add(signature, 0x20))\\n                s := mload(add(signature, 0x40))\\n                v := byte(0, mload(add(signature, 0x60)))\\n            }\\n            return tryRecover(hash, v, r, s);\\n        } else {\\n            return (address(0), RecoverError.InvalidSignatureLength);\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns the address that signed a hashed message (`hash`) with\\n     * `signature`. This address can then be used for verification purposes.\\n     *\\n     * The `ecrecover` EVM opcode allows for malleable (non-unique) signatures:\\n     * this function rejects them by requiring the `s` value to be in the lower\\n     * half order, and the `v` value to be either 27 or 28.\\n     *\\n     * IMPORTANT: `hash` _must_ be the result of a hash operation for the\\n     * verification to be secure: it is possible to craft signatures that\\n     * recover to arbitrary addresses for non-hashed data. A safe way to ensure\\n     * this is by receiving a hash of the original message (which may otherwise\\n     * be too long), and then calling {toEthSignedMessageHash} on it.\\n     */\\n    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, signature);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-tryRecover} that receives the `r` and `vs` short-signature fields separately.\\n     *\\n     * See https://eips.ethereum.org/EIPS/eip-2098[EIP-2098 short signatures]\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(\\n        bytes32 hash,\\n        bytes32 r,\\n        bytes32 vs\\n    ) internal pure returns (address, RecoverError) {\\n        bytes32 s = vs & bytes32(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);\\n        uint8 v = uint8((uint256(vs) >> 255) + 27);\\n        return tryRecover(hash, v, r, s);\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-recover} that receives the `r and `vs` short-signature fields separately.\\n     *\\n     * _Available since v4.2._\\n     */\\n    function recover(\\n        bytes32 hash,\\n        bytes32 r,\\n        bytes32 vs\\n    ) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, r, vs);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-tryRecover} that receives the `v`,\\n     * `r` and `s` signature fields separately.\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(\\n        bytes32 hash,\\n        uint8 v,\\n        bytes32 r,\\n        bytes32 s\\n    ) internal pure returns (address, RecoverError) {\\n        // EIP-2 still allows signature malleability for ecrecover(). Remove this possibility and make the signature\\n        // unique. Appendix F in the Ethereum Yellow paper (https://ethereum.github.io/yellowpaper/paper.pdf), defines\\n        // the valid range for s in (301): 0 < s < secp256k1n \\u00f7 2 + 1, and for v in (302): v \\u2208 {27, 28}. Most\\n        // signatures from current libraries generate a unique signature with an s-value in the lower half order.\\n        //\\n        // If your library generates malleable signatures, such as s-values in the upper range, calculate a new s-value\\n        // with 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - s1 and flip v from 27 to 28 or\\n        // vice versa. If your library also generates signatures with 0/1 for v instead 27/28, add 27 to v to accept\\n        // these malleable signatures as well.\\n        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {\\n            return (address(0), RecoverError.InvalidSignatureS);\\n        }\\n\\n        // If the signature is valid (and not malleable), return the signer address\\n        address signer = ecrecover(hash, v, r, s);\\n        if (signer == address(0)) {\\n            return (address(0), RecoverError.InvalidSignature);\\n        }\\n\\n        return (signer, RecoverError.NoError);\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-recover} that receives the `v`,\\n     * `r` and `s` signature fields separately.\\n     */\\n    function recover(\\n        bytes32 hash,\\n        uint8 v,\\n        bytes32 r,\\n        bytes32 s\\n    ) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, v, r, s);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Message, created from a `hash`. This\\n     * produces hash corresponding to the one signed with the\\n     * https://eth.wiki/json-rpc/API#eth_sign[`eth_sign`]\\n     * JSON-RPC method as part of EIP-191.\\n     *\\n     * See {recover}.\\n     */\\n    function toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {\\n        // 32 is the length in bytes of hash,\\n        // enforced by the type signature above\\n        return keccak256(abi.encodePacked(\\\"\\\\x19Ethereum Signed Message:\\\\n32\\\", hash));\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Message, created from `s`. This\\n     * produces hash corresponding to the one signed with the\\n     * https://eth.wiki/json-rpc/API#eth_sign[`eth_sign`]\\n     * JSON-RPC method as part of EIP-191.\\n     *\\n     * See {recover}.\\n     */\\n    function toEthSignedMessageHash(bytes memory s) internal pure returns (bytes32) {\\n        return keccak256(abi.encodePacked(\\\"\\\\x19Ethereum Signed Message:\\\\n\\\", Strings.toString(s.length), s));\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Typed Data, created from a\\n     * `domainSeparator` and a `structHash`. This produces hash corresponding\\n     * to the one signed with the\\n     * https://eips.ethereum.org/EIPS/eip-712[`eth_signTypedData`]\\n     * JSON-RPC method as part of EIP-712.\\n     *\\n     * See {recover}.\\n     */\\n    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {\\n        return keccak256(abi.encodePacked(\\\"\\\\x19\\\\x01\\\", domainSeparator, structHash));\\n    }\\n}\\n\",\"keccak256\":\"0xda898fa084aa1ddfdb346e6a40459e00a59d87071cce7c315a46d648dd71d0ba\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/cryptography/EIP712.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/cryptography/EIP712.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"./ECDSA.sol\\\";\\n\\n/**\\n * @dev https://eips.ethereum.org/EIPS/eip-712[EIP 712] is a standard for hashing and signing of typed structured data.\\n *\\n * The encoding specified in the EIP is very generic, and such a generic implementation in Solidity is not feasible,\\n * thus this contract does not implement the encoding itself. Protocols need to implement the type-specific encoding\\n * they need in their contracts using a combination of `abi.encode` and `keccak256`.\\n *\\n * This contract implements the EIP 712 domain separator ({_domainSeparatorV4}) that is used as part of the encoding\\n * scheme, and the final step of the encoding to obtain the message digest that is then signed via ECDSA\\n * ({_hashTypedDataV4}).\\n *\\n * The implementation of the domain separator was designed to be as efficient as possible while still properly updating\\n * the chain id to protect against replay attacks on an eventual fork of the chain.\\n *\\n * NOTE: This contract implements the version of the encoding known as \\\"v4\\\", as implemented by the JSON RPC method\\n * https://docs.metamask.io/guide/signing-data.html[`eth_signTypedDataV4` in MetaMask].\\n *\\n * _Available since v3.4._\\n */\\nabstract contract EIP712 {\\n    /* solhint-disable var-name-mixedcase */\\n    // Cache the domain separator as an immutable value, but also store the chain id that it corresponds to, in order to\\n    // invalidate the cached domain separator if the chain id changes.\\n    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;\\n    uint256 private immutable _CACHED_CHAIN_ID;\\n    address private immutable _CACHED_THIS;\\n\\n    bytes32 private immutable _HASHED_NAME;\\n    bytes32 private immutable _HASHED_VERSION;\\n    bytes32 private immutable _TYPE_HASH;\\n\\n    /* solhint-enable var-name-mixedcase */\\n\\n    /**\\n     * @dev Initializes the domain separator and parameter caches.\\n     *\\n     * The meaning of `name` and `version` is specified in\\n     * https://eips.ethereum.org/EIPS/eip-712#definition-of-domainseparator[EIP 712]:\\n     *\\n     * - `name`: the user readable name of the signing domain, i.e. the name of the DApp or the protocol.\\n     * - `version`: the current major version of the signing domain.\\n     *\\n     * NOTE: These parameters cannot be changed except through a xref:learn::upgrading-smart-contracts.adoc[smart\\n     * contract upgrade].\\n     */\\n    constructor(string memory name, string memory version) {\\n        bytes32 hashedName = keccak256(bytes(name));\\n        bytes32 hashedVersion = keccak256(bytes(version));\\n        bytes32 typeHash = keccak256(\\n            \\\"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)\\\"\\n        );\\n        _HASHED_NAME = hashedName;\\n        _HASHED_VERSION = hashedVersion;\\n        _CACHED_CHAIN_ID = block.chainid;\\n        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator(typeHash, hashedName, hashedVersion);\\n        _CACHED_THIS = address(this);\\n        _TYPE_HASH = typeHash;\\n    }\\n\\n    /**\\n     * @dev Returns the domain separator for the current chain.\\n     */\\n    function _domainSeparatorV4() internal view returns (bytes32) {\\n        if (address(this) == _CACHED_THIS && block.chainid == _CACHED_CHAIN_ID) {\\n            return _CACHED_DOMAIN_SEPARATOR;\\n        } else {\\n            return _buildDomainSeparator(_TYPE_HASH, _HASHED_NAME, _HASHED_VERSION);\\n        }\\n    }\\n\\n    function _buildDomainSeparator(\\n        bytes32 typeHash,\\n        bytes32 nameHash,\\n        bytes32 versionHash\\n    ) private view returns (bytes32) {\\n        return keccak256(abi.encode(typeHash, nameHash, versionHash, block.chainid, address(this)));\\n    }\\n\\n    /**\\n     * @dev Given an already https://eips.ethereum.org/EIPS/eip-712#definition-of-hashstruct[hashed struct], this\\n     * function returns the hash of the fully encoded EIP712 message for this domain.\\n     *\\n     * This hash can be used together with {ECDSA-recover} to obtain the signer of a message. For example:\\n     *\\n     * ```solidity\\n     * bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(\\n     *     keccak256(\\\"Mail(address to,string contents)\\\"),\\n     *     mailTo,\\n     *     keccak256(bytes(mailContents))\\n     * )));\\n     * address signer = ECDSA.recover(digest, signature);\\n     * ```\\n     */\\n    function _hashTypedDataV4(bytes32 structHash) internal view virtual returns (bytes32) {\\n        return ECDSA.toTypedDataHash(_domainSeparatorV4(), structHash);\\n    }\\n}\\n\",\"keccak256\":\"0x948d8b2d18f38141ec78c5229d770d950ebc781ed3f44cc9e3ccbb9fded5846a\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/math/Math.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/math/Math.sol)\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Standard math utilities missing in the Solidity language.\\n */\\nlibrary Math {\\n    enum Rounding {\\n        Down, // Toward negative infinity\\n        Up, // Toward infinity\\n        Zero // Toward zero\\n    }\\n\\n    /**\\n     * @dev Returns the largest of two numbers.\\n     */\\n    function max(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a > b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the smallest of two numbers.\\n     */\\n    function min(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a < b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the average of two numbers. The result is rounded towards\\n     * zero.\\n     */\\n    function average(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b) / 2 can overflow.\\n        return (a & b) + (a ^ b) / 2;\\n    }\\n\\n    /**\\n     * @dev Returns the ceiling of the division of two numbers.\\n     *\\n     * This differs from standard division with `/` in that it rounds up instead\\n     * of rounding down.\\n     */\\n    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b - 1) / b can overflow on addition, so we distribute.\\n        return a == 0 ? 0 : (a - 1) / b + 1;\\n    }\\n\\n    /**\\n     * @notice Calculates floor(x * y / denominator) with full precision. Throws if result overflows a uint256 or denominator == 0\\n     * @dev Original credit to Remco Bloemen under MIT license (https://xn--2-umb.com/21/muldiv)\\n     * with further edits by Uniswap Labs also under MIT license.\\n     */\\n    function mulDiv(\\n        uint256 x,\\n        uint256 y,\\n        uint256 denominator\\n    ) internal pure returns (uint256 result) {\\n        unchecked {\\n            // 512-bit multiply [prod1 prod0] = x * y. Compute the product mod 2^256 and mod 2^256 - 1, then use\\n            // use the Chinese Remainder Theorem to reconstruct the 512 bit result. The result is stored in two 256\\n            // variables such that product = prod1 * 2^256 + prod0.\\n            uint256 prod0; // Least significant 256 bits of the product\\n            uint256 prod1; // Most significant 256 bits of the product\\n            assembly {\\n                let mm := mulmod(x, y, not(0))\\n                prod0 := mul(x, y)\\n                prod1 := sub(sub(mm, prod0), lt(mm, prod0))\\n            }\\n\\n            // Handle non-overflow cases, 256 by 256 division.\\n            if (prod1 == 0) {\\n                return prod0 / denominator;\\n            }\\n\\n            // Make sure the result is less than 2^256. Also prevents denominator == 0.\\n            require(denominator > prod1);\\n\\n            ///////////////////////////////////////////////\\n            // 512 by 256 division.\\n            ///////////////////////////////////////////////\\n\\n            // Make division exact by subtracting the remainder from [prod1 prod0].\\n            uint256 remainder;\\n            assembly {\\n                // Compute remainder using mulmod.\\n                remainder := mulmod(x, y, denominator)\\n\\n                // Subtract 256 bit number from 512 bit number.\\n                prod1 := sub(prod1, gt(remainder, prod0))\\n                prod0 := sub(prod0, remainder)\\n            }\\n\\n            // Factor powers of two out of denominator and compute largest power of two divisor of denominator. Always >= 1.\\n            // See https://cs.stackexchange.com/q/138556/92363.\\n\\n            // Does not overflow because the denominator cannot be zero at this stage in the function.\\n            uint256 twos = denominator & (~denominator + 1);\\n            assembly {\\n                // Divide denominator by twos.\\n                denominator := div(denominator, twos)\\n\\n                // Divide [prod1 prod0] by twos.\\n                prod0 := div(prod0, twos)\\n\\n                // Flip twos such that it is 2^256 / twos. If twos is zero, then it becomes one.\\n                twos := add(div(sub(0, twos), twos), 1)\\n            }\\n\\n            // Shift in bits from prod1 into prod0.\\n            prod0 |= prod1 * twos;\\n\\n            // Invert denominator mod 2^256. Now that denominator is an odd number, it has an inverse modulo 2^256 such\\n            // that denominator * inv = 1 mod 2^256. Compute the inverse by starting with a seed that is correct for\\n            // four bits. That is, denominator * inv = 1 mod 2^4.\\n            uint256 inverse = (3 * denominator) ^ 2;\\n\\n            // Use the Newton-Raphson iteration to improve the precision. Thanks to Hensel's lifting lemma, this also works\\n            // in modular arithmetic, doubling the correct bits in each step.\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^8\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^16\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^32\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^64\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^128\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^256\\n\\n            // Because the division is now exact we can divide by multiplying with the modular inverse of denominator.\\n            // This will give us the correct result modulo 2^256. Since the preconditions guarantee that the outcome is\\n            // less than 2^256, this is the final result. We don't need to compute the high bits of the result and prod1\\n            // is no longer required.\\n            result = prod0 * inverse;\\n            return result;\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates x * y / denominator with full precision, following the selected rounding direction.\\n     */\\n    function mulDiv(\\n        uint256 x,\\n        uint256 y,\\n        uint256 denominator,\\n        Rounding rounding\\n    ) internal pure returns (uint256) {\\n        uint256 result = mulDiv(x, y, denominator);\\n        if (rounding == Rounding.Up && mulmod(x, y, denominator) > 0) {\\n            result += 1;\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Returns the square root of a number. If the number is not a perfect square, the value is rounded down.\\n     *\\n     * Inspired by Henry S. Warren, Jr.'s \\\"Hacker's Delight\\\" (Chapter 11).\\n     */\\n    function sqrt(uint256 a) internal pure returns (uint256) {\\n        if (a == 0) {\\n            return 0;\\n        }\\n\\n        // For our first guess, we get the biggest power of 2 which is smaller than the square root of the target.\\n        //\\n        // We know that the \\\"msb\\\" (most significant bit) of our target number `a` is a power of 2 such that we have\\n        // `msb(a) <= a < 2*msb(a)`. This value can be written `msb(a)=2**k` with `k=log2(a)`.\\n        //\\n        // This can be rewritten `2**log2(a) <= a < 2**(log2(a) + 1)`\\n        // \\u2192 `sqrt(2**k) <= sqrt(a) < sqrt(2**(k+1))`\\n        // \\u2192 `2**(k/2) <= sqrt(a) < 2**((k+1)/2) <= 2**(k/2 + 1)`\\n        //\\n        // Consequently, `2**(log2(a) / 2)` is a good first approximation of `sqrt(a)` with at least 1 correct bit.\\n        uint256 result = 1 << (log2(a) >> 1);\\n\\n        // At this point `result` is an estimation with one bit of precision. We know the true value is a uint128,\\n        // since it is the square root of a uint256. Newton's method converges quadratically (precision doubles at\\n        // every iteration). We thus need at most 7 iteration to turn our partial result with one bit of precision\\n        // into the expected uint128 result.\\n        unchecked {\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            return min(result, a / result);\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates sqrt(a), following the selected rounding direction.\\n     */\\n    function sqrt(uint256 a, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = sqrt(a);\\n            return result + (rounding == Rounding.Up && result * result < a ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 128;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 64;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 32;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 16;\\n            }\\n            if (value >> 8 > 0) {\\n                value >>= 8;\\n                result += 8;\\n            }\\n            if (value >> 4 > 0) {\\n                value >>= 4;\\n                result += 4;\\n            }\\n            if (value >> 2 > 0) {\\n                value >>= 2;\\n                result += 2;\\n            }\\n            if (value >> 1 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log2(value);\\n            return result + (rounding == Rounding.Up && 1 << result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >= 10**64) {\\n                value /= 10**64;\\n                result += 64;\\n            }\\n            if (value >= 10**32) {\\n                value /= 10**32;\\n                result += 32;\\n            }\\n            if (value >= 10**16) {\\n                value /= 10**16;\\n                result += 16;\\n            }\\n            if (value >= 10**8) {\\n                value /= 10**8;\\n                result += 8;\\n            }\\n            if (value >= 10**4) {\\n                value /= 10**4;\\n                result += 4;\\n            }\\n            if (value >= 10**2) {\\n                value /= 10**2;\\n                result += 2;\\n            }\\n            if (value >= 10**1) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log10(value);\\n            return result + (rounding == Rounding.Up && 10**result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 256, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     *\\n     * Adding one to the result gives the number of pairs of hex symbols needed to represent `value` as a hex string.\\n     */\\n    function log256(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 16;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 8;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 4;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 2;\\n            }\\n            if (value >> 8 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log256(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log256(value);\\n            return result + (rounding == Rounding.Up && 1 << (result * 8) < value ? 1 : 0);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xa1e8e83cd0087785df04ac79fb395d9f3684caeaf973d9e2c71caef723a3a5d6\",\"license\":\"MIT\"},\"contracts/EAS.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\nimport { Address } from \\\"@openzeppelin/contracts/utils/Address.sol\\\";\\n\\nimport { EMPTY_UID, EIP712Signature } from \\\"./Types.sol\\\";\\n\\n// prettier-ignore\\nimport {\\n    Attestation,\\n    AttestationRequest,\\n    AttestationRequestData,\\n    DelegatedAttestationRequest,\\n    DelegatedRevocationRequest,\\n    IEAS,\\n    MultiAttestationRequest,\\n    MultiDelegatedAttestationRequest,\\n    MultiDelegatedRevocationRequest,\\n    MultiRevocationRequest,\\n    RevocationRequest,\\n    RevocationRequestData\\n} from \\\"./IEAS.sol\\\";\\nimport { ISchemaRegistry, SchemaRecord } from \\\"./ISchemaRegistry.sol\\\";\\nimport { EIP712Verifier } from \\\"./EIP712Verifier.sol\\\";\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\nstruct AttestationsResult {\\n    uint256 usedValue; // Total ETH amount that was sent to resolvers.\\n    bytes32[] uids; // UIDs of the new attestations.\\n}\\n\\n/**\\n * @title EAS - Ethereum Attestation Service\\n */\\ncontract EAS is IEAS, EIP712Verifier {\\n    using Address for address payable;\\n\\n    error AccessDenied();\\n    error AlreadyRevoked();\\n    error AlreadyRevokedOffchain();\\n    error AlreadyTimestamped();\\n    error InsufficientValue();\\n    error InvalidAttestation();\\n    error InvalidAttestations();\\n    error InvalidExpirationTime();\\n    error InvalidLength();\\n    error InvalidOffset();\\n    error InvalidRegistry();\\n    error InvalidRevocation();\\n    error InvalidRevocations();\\n    error InvalidSchema();\\n    error InvalidVerifier();\\n    error Irrevocable();\\n    error NotFound();\\n    error NotPayable();\\n    error WrongSchema();\\n\\n    // The version of the contract.\\n    string public constant VERSION = \\\"0.26\\\";\\n\\n    // A zero expiration represents an non-expiring attestation.\\n    uint64 private constant NO_EXPIRATION_TIME = 0;\\n\\n    // The global schema registry.\\n    ISchemaRegistry private immutable _schemaRegistry;\\n\\n    // The global mapping between attestations and their UIDs.\\n    mapping(bytes32 uid => Attestation attestation) private _db;\\n\\n    // The global mapping between data and their timestamps.\\n    mapping(bytes32 data => uint64 timestamp) private _timestamps;\\n\\n    // The global mapping between data and their revocation timestamps.\\n    mapping(address revoker => mapping(bytes32 data => uint64 timestamp)) private _revocationsOffchain;\\n\\n    /**\\n     * @dev Creates a new EAS instance.\\n     *\\n     * @param registry The address of the global schema registry.\\n     */\\n    constructor(ISchemaRegistry registry) EIP712Verifier(VERSION) {\\n        if (address(registry) == address(0)) {\\n            revert InvalidRegistry();\\n        }\\n\\n        _schemaRegistry = registry;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function getSchemaRegistry() external view returns (ISchemaRegistry) {\\n        return _schemaRegistry;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function attest(AttestationRequest calldata request) public payable virtual returns (bytes32) {\\n        AttestationRequestData[] memory requests = new AttestationRequestData[](1);\\n        requests[0] = request.data;\\n\\n        return _attest(request.schema, requests, msg.sender, msg.value, true).uids[0];\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function attestByDelegation(\\n        DelegatedAttestationRequest calldata delegatedRequest\\n    ) public payable virtual returns (bytes32) {\\n        _verifyAttest(delegatedRequest);\\n\\n        AttestationRequestData[] memory data = new AttestationRequestData[](1);\\n        data[0] = delegatedRequest.data;\\n\\n        return _attest(delegatedRequest.schema, data, delegatedRequest.attester, msg.value, true).uids[0];\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiAttest(MultiAttestationRequest[] calldata multiRequests) external payable returns (bytes32[] memory) {\\n        // Since a multi-attest call is going to make multiple attestations for multiple schemas, we'd need to collect\\n        // all the returned UIDs into a single list.\\n        bytes32[][] memory totalUids = new bytes32[][](multiRequests.length);\\n        uint256 totalUidsCount = 0;\\n\\n        // We are keeping track of the total available ETH amount that can be sent to resolvers and will keep deducting\\n        // from it to verify that there isn't any attempt to send too much ETH to resolvers. Please note that unless\\n        // some ETH was stuck in the contract by accident (which shouldn't happen in normal conditions), it won't be\\n        // possible to send too much ETH anyway.\\n        uint availableValue = msg.value;\\n\\n        for (uint256 i = 0; i < multiRequests.length; ) {\\n            // The last batch is handled slightly differently: if the total available ETH wasn't spent in full and there\\n            // is a remainder - it will be refunded back to the attester (something that we can only verify during the\\n            // last and final batch).\\n            bool last;\\n            unchecked {\\n                last = i == multiRequests.length - 1;\\n            }\\n\\n            // Process the current batch of attestations.\\n            MultiAttestationRequest calldata multiRequest = multiRequests[i];\\n            AttestationsResult memory res = _attest(\\n                multiRequest.schema,\\n                multiRequest.data,\\n                msg.sender,\\n                availableValue,\\n                last\\n            );\\n\\n            // Ensure to deduct the ETH that was forwarded to the resolver during the processing of this batch.\\n            availableValue -= res.usedValue;\\n\\n            // Collect UIDs (and merge them later).\\n            totalUids[i] = res.uids;\\n            unchecked {\\n                totalUidsCount += res.uids.length;\\n            }\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        // Merge all the collected UIDs and return them as a flatten array.\\n        return _mergeUIDs(totalUids, totalUidsCount);\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiAttestByDelegation(\\n        MultiDelegatedAttestationRequest[] calldata multiDelegatedRequests\\n    ) external payable returns (bytes32[] memory) {\\n        // Since a multi-attest call is going to make multiple attestations for multiple schemas, we'd need to collect\\n        // all the returned UIDs into a single list.\\n        bytes32[][] memory totalUids = new bytes32[][](multiDelegatedRequests.length);\\n        uint256 totalUidsCount = 0;\\n\\n        // We are keeping track of the total available ETH amount that can be sent to resolvers and will keep deducting\\n        // from it to verify that there isn't any attempt to send too much ETH to resolvers. Please note that unless\\n        // some ETH was stuck in the contract by accident (which shouldn't happen in normal conditions), it won't be\\n        // possible to send too much ETH anyway.\\n        uint availableValue = msg.value;\\n\\n        for (uint256 i = 0; i < multiDelegatedRequests.length; ) {\\n            // The last batch is handled slightly differently: if the total available ETH wasn't spent in full and there\\n            // is a remainder - it will be refunded back to the attester (something that we can only verify during the\\n            // last and final batch).\\n            bool last;\\n            unchecked {\\n                last = i == multiDelegatedRequests.length - 1;\\n            }\\n\\n            MultiDelegatedAttestationRequest calldata multiDelegatedRequest = multiDelegatedRequests[i];\\n            AttestationRequestData[] calldata data = multiDelegatedRequest.data;\\n\\n            // Ensure that no inputs are missing.\\n            if (data.length == 0 || data.length != multiDelegatedRequest.signatures.length) {\\n                revert InvalidLength();\\n            }\\n\\n            // Verify EIP712 signatures. Please note that the signatures are assumed to be signed with increasing nonces.\\n            for (uint256 j = 0; j < data.length; ) {\\n                _verifyAttest(\\n                    DelegatedAttestationRequest({\\n                        schema: multiDelegatedRequest.schema,\\n                        data: data[j],\\n                        signature: multiDelegatedRequest.signatures[j],\\n                        attester: multiDelegatedRequest.attester\\n                    })\\n                );\\n\\n                unchecked {\\n                    ++j;\\n                }\\n            }\\n\\n            // Process the current batch of attestations.\\n            AttestationsResult memory res = _attest(\\n                multiDelegatedRequest.schema,\\n                data,\\n                multiDelegatedRequest.attester,\\n                availableValue,\\n                last\\n            );\\n\\n            // Ensure to deduct the ETH that was forwarded to the resolver during the processing of this batch.\\n            availableValue -= res.usedValue;\\n\\n            // Collect UIDs (and merge them later).\\n            totalUids[i] = res.uids;\\n            unchecked {\\n                totalUidsCount += res.uids.length;\\n            }\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        // Merge all the collected UIDs and return them as a flatten array.\\n        return _mergeUIDs(totalUids, totalUidsCount);\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function revoke(RevocationRequest calldata request) public payable virtual {\\n        RevocationRequestData[] memory requests = new RevocationRequestData[](1);\\n        requests[0] = request.data;\\n\\n        _revoke(request.schema, requests, msg.sender, msg.value, true);\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function revokeByDelegation(DelegatedRevocationRequest calldata delegatedRequest) public payable virtual {\\n        _verifyRevoke(delegatedRequest);\\n\\n        RevocationRequestData[] memory data = new RevocationRequestData[](1);\\n        data[0] = delegatedRequest.data;\\n\\n        _revoke(delegatedRequest.schema, data, delegatedRequest.revoker, msg.value, true);\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiRevoke(MultiRevocationRequest[] calldata multiRequests) external payable {\\n        // We are keeping track of the total available ETH amount that can be sent to resolvers and will keep deducting\\n        // from it to verify that there isn't any attempt to send too much ETH to resolvers. Please note that unless\\n        // some ETH was stuck in the contract by accident (which shouldn't happen in normal conditions), it won't be\\n        // possible to send too much ETH anyway.\\n        uint availableValue = msg.value;\\n\\n        for (uint256 i = 0; i < multiRequests.length; ) {\\n            // The last batch is handled slightly differently: if the total available ETH wasn't spent in full and there\\n            // is a remainder - it will be refunded back to the attester (something that we can only verify during the\\n            // last and final batch).\\n            bool last;\\n            unchecked {\\n                last = i == multiRequests.length - 1;\\n            }\\n\\n            MultiRevocationRequest calldata multiRequest = multiRequests[i];\\n\\n            // Ensure to deduct the ETH that was forwarded to the resolver during the processing of this batch.\\n            availableValue -= _revoke(multiRequest.schema, multiRequest.data, msg.sender, availableValue, last);\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiRevokeByDelegation(\\n        MultiDelegatedRevocationRequest[] calldata multiDelegatedRequests\\n    ) external payable {\\n        // We are keeping track of the total available ETH amount that can be sent to resolvers and will keep deducting\\n        // from it to verify that there isn't any attempt to send too much ETH to resolvers. Please note that unless\\n        // some ETH was stuck in the contract by accident (which shouldn't happen in normal conditions), it won't be\\n        // possible to send too much ETH anyway.\\n        uint availableValue = msg.value;\\n\\n        for (uint256 i = 0; i < multiDelegatedRequests.length; ) {\\n            // The last batch is handled slightly differently: if the total available ETH wasn't spent in full and there\\n            // is a remainder - it will be refunded back to the attester (something that we can only verify during the\\n            // last and final batch).\\n            bool last;\\n            unchecked {\\n                last = i == multiDelegatedRequests.length - 1;\\n            }\\n\\n            MultiDelegatedRevocationRequest memory multiDelegatedRequest = multiDelegatedRequests[i];\\n            RevocationRequestData[] memory data = multiDelegatedRequest.data;\\n\\n            // Ensure that no inputs are missing.\\n            if (data.length == 0 || data.length != multiDelegatedRequest.signatures.length) {\\n                revert InvalidLength();\\n            }\\n\\n            // Verify EIP712 signatures. Please note that the signatures are assumed to be signed with increasing nonces.\\n            for (uint256 j = 0; j < data.length; ) {\\n                _verifyRevoke(\\n                    DelegatedRevocationRequest({\\n                        schema: multiDelegatedRequest.schema,\\n                        data: data[j],\\n                        signature: multiDelegatedRequest.signatures[j],\\n                        revoker: multiDelegatedRequest.revoker\\n                    })\\n                );\\n\\n                unchecked {\\n                    ++j;\\n                }\\n            }\\n\\n            // Ensure to deduct the ETH that was forwarded to the resolver during the processing of this batch.\\n            availableValue -= _revoke(\\n                multiDelegatedRequest.schema,\\n                data,\\n                multiDelegatedRequest.revoker,\\n                availableValue,\\n                last\\n            );\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function timestamp(bytes32 data) external returns (uint64) {\\n        uint64 time = _time();\\n\\n        _timestamp(data, time);\\n\\n        return time;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function revokeOffchain(bytes32 data) external returns (uint64) {\\n        uint64 time = _time();\\n\\n        _revokeOffchain(msg.sender, data, time);\\n\\n        return time;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiRevokeOffchain(bytes32[] calldata data) external returns (uint64) {\\n        uint64 time = _time();\\n\\n        uint256 length = data.length;\\n        for (uint256 i = 0; i < length; ) {\\n            _revokeOffchain(msg.sender, data[i], time);\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        return time;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function multiTimestamp(bytes32[] calldata data) external returns (uint64) {\\n        uint64 time = _time();\\n\\n        uint256 length = data.length;\\n        for (uint256 i = 0; i < length; ) {\\n            _timestamp(data[i], time);\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        return time;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function getAttestation(bytes32 uid) external view returns (Attestation memory) {\\n        return _db[uid];\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function isAttestationValid(bytes32 uid) public view returns (bool) {\\n        return _db[uid].uid != 0;\\n    }\\n\\n    /**\\n     * @inheritdoc IEAS\\n     */\\n    function getTimestamp(bytes32 data) external view returns (uint64) {\\n        return _timestamps[data];\\n    }\\n\\n    /**\\n      * @inheritdoc IEAS\\n      */\\n    function getRevokeOffchain(address revoker, bytes32 data) external view returns (uint64) {\\n        return _revocationsOffchain[revoker][data];\\n    }\\n\\n    /**\\n     * @dev Attests to a specific schema.\\n     *\\n     * @param schema // the unique identifier of the schema to attest to.\\n     * @param data The arguments of the attestation requests.\\n     * @param attester The attesting account.\\n     * @param availableValue The total available ETH amount that can be sent to the resolver.\\n     * @param last Whether this is the last attestations/revocations set.\\n     *\\n     * @return The UID of the new attestations and the total sent ETH amount.\\n     */\\n    function _attest(\\n        bytes32 schema,\\n        AttestationRequestData[] memory data,\\n        address attester,\\n        uint256 availableValue,\\n        bool last\\n    ) private returns (AttestationsResult memory) {\\n        uint256 length = data.length;\\n\\n        AttestationsResult memory res;\\n        res.uids = new bytes32[](length);\\n\\n        // Ensure that we aren't attempting to attest to a non-existing schema.\\n        SchemaRecord memory schemaRecord = _schemaRegistry.getSchema(schema);\\n        if (schemaRecord.uid == EMPTY_UID) {\\n            revert InvalidSchema();\\n        }\\n\\n        Attestation[] memory attestations = new Attestation[](length);\\n        uint256[] memory values = new uint256[](length);\\n\\n        for (uint256 i = 0; i < length; ) {\\n            AttestationRequestData memory request = data[i];\\n\\n            // Ensure that either no expiration time was set or that it was set in the future.\\n            if (request.expirationTime != NO_EXPIRATION_TIME && request.expirationTime <= _time()) {\\n                revert InvalidExpirationTime();\\n            }\\n\\n            // Ensure that we aren't trying to make a revocable attestation for a non-revocable schema.\\n            if (!schemaRecord.revocable && request.revocable) {\\n                revert Irrevocable();\\n            }\\n\\n            Attestation memory attestation = Attestation({\\n                uid: EMPTY_UID,\\n                schema: schema,\\n                refUID: request.refUID,\\n                time: _time(),\\n                expirationTime: request.expirationTime,\\n                revocationTime: 0,\\n                recipient: request.recipient,\\n                attester: attester,\\n                revocable: request.revocable,\\n                data: request.data\\n            });\\n\\n            // Look for the first non-existing UID (and use a bump seed/nonce in the rare case of a conflict).\\n            bytes32 uid;\\n            uint32 bump = 0;\\n            while (true) {\\n                uid = _getUID(attestation, bump);\\n                if (_db[uid].uid == EMPTY_UID) {\\n                    break;\\n                }\\n\\n                unchecked {\\n                    ++bump;\\n                }\\n            }\\n            attestation.uid = uid;\\n\\n            _db[uid] = attestation;\\n\\n            if (request.refUID != 0) {\\n                // Ensure that we aren't trying to attest to a non-existing referenced UID.\\n                if (!isAttestationValid(request.refUID)) {\\n                    revert NotFound();\\n                }\\n            }\\n\\n            attestations[i] = attestation;\\n            values[i] = request.value;\\n\\n            res.uids[i] = uid;\\n\\n            emit Attested(request.recipient, attester, uid, schema);\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        res.usedValue = _resolveAttestations(schemaRecord, attestations, values, false, availableValue, last);\\n\\n        return res;\\n    }\\n\\n    /**\\n     * @dev Revokes an existing attestation to a specific schema.\\n     *\\n     * @param schema The unique identifier of the schema to attest to.\\n     * @param data The arguments of the revocation requests.\\n     * @param revoker The revoking account.\\n     * @param availableValue The total available ETH amount that can be sent to the resolver.\\n     * @param last Whether this is the last attestations/revocations set.\\n     *\\n     * @return Returns the total sent ETH amount.\\n     */\\n    function _revoke(\\n        bytes32 schema,\\n        RevocationRequestData[] memory data,\\n        address revoker,\\n        uint256 availableValue,\\n        bool last\\n    ) private returns (uint256) {\\n        // Ensure that a non-existing schema ID wasn't passed by accident.\\n        SchemaRecord memory schemaRecord = _schemaRegistry.getSchema(schema);\\n        if (schemaRecord.uid == EMPTY_UID) {\\n            revert InvalidSchema();\\n        }\\n\\n        uint256 length = data.length;\\n        Attestation[] memory attestations = new Attestation[](length);\\n        uint256[] memory values = new uint256[](length);\\n\\n        for (uint256 i = 0; i < length; ) {\\n            RevocationRequestData memory request = data[i];\\n\\n            Attestation storage attestation = _db[request.uid];\\n\\n            // Ensure that we aren't attempting to revoke a non-existing attestation.\\n            if (attestation.uid == EMPTY_UID) {\\n                revert NotFound();\\n            }\\n\\n            // Ensure that a wrong schema ID wasn't passed by accident.\\n            if (attestation.schema != schema) {\\n                revert InvalidSchema();\\n            }\\n\\n            // Allow only original attesters to revoke their attestations.\\n            if (attestation.attester != revoker) {\\n                revert AccessDenied();\\n            }\\n\\n            // Please note that also checking of the schema itself is revocable is unnecessary, since it's not possible to\\n            // make revocable attestations to an irrevocable schema.\\n            if (!attestation.revocable) {\\n                revert Irrevocable();\\n            }\\n\\n            // Ensure that we aren't trying to revoke the same attestation twice.\\n            if (attestation.revocationTime != 0) {\\n                revert AlreadyRevoked();\\n            }\\n            attestation.revocationTime = _time();\\n\\n            attestations[i] = attestation;\\n            values[i] = request.value;\\n\\n            emit Revoked(attestation.recipient, revoker, request.uid, attestation.schema);\\n\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        return _resolveAttestations(schemaRecord, attestations, values, true, availableValue, last);\\n    }\\n\\n    /**\\n     * @dev Resolves a new attestation or a revocation of an existing attestation.\\n     *\\n     * @param schemaRecord The schema of the attestation.\\n     * @param attestation The data of the attestation to make/revoke.\\n     * @param value An explicit ETH amount to send to the resolver.\\n     * @param isRevocation Whether to resolve an attestation or its revocation.\\n     * @param availableValue The total available ETH amount that can be sent to the resolver.\\n     * @param last Whether this is the last attestations/revocations set.\\n     *\\n     * @return Returns the total sent ETH amount.\\n     */\\n    function _resolveAttestation(\\n        SchemaRecord memory schemaRecord,\\n        Attestation memory attestation,\\n        uint256 value,\\n        bool isRevocation,\\n        uint256 availableValue,\\n        bool last\\n    ) private returns (uint256) {\\n        ISchemaResolver resolver = schemaRecord.resolver;\\n        if (address(resolver) == address(0)) {\\n            // Ensure that we don't accept payments if there is no resolver.\\n            if (value != 0) {\\n                revert NotPayable();\\n            }\\n\\n            return 0;\\n        }\\n\\n        // Ensure that we don't accept payments which can't be forwarded to the resolver.\\n        if (value != 0 && !resolver.isPayable()) {\\n            revert NotPayable();\\n        }\\n\\n        // Ensure that the attester/revoker doesn't try to spend more than available.\\n        if (value > availableValue) {\\n            revert InsufficientValue();\\n        }\\n\\n        // Ensure to deduct the sent value explicitly.\\n        unchecked {\\n            availableValue -= value;\\n        }\\n\\n        if (isRevocation) {\\n            if (!resolver.revoke{ value: value }(attestation)) {\\n                revert InvalidRevocation();\\n            }\\n        } else if (!resolver.attest{ value: value }(attestation)) {\\n            revert InvalidAttestation();\\n        }\\n\\n        if (last) {\\n            _refund(availableValue);\\n        }\\n\\n        return value;\\n    }\\n\\n    /**\\n     * @dev Resolves multiple attestations or revocations of existing attestations.\\n     *\\n     * @param schemaRecord The schema of the attestation.\\n     * @param attestations The data of the attestations to make/revoke.\\n     * @param values Explicit ETH amounts to send to the resolver.\\n     * @param isRevocation Whether to resolve an attestation or its revocation.\\n     * @param availableValue The total available ETH amount that can be sent to the resolver.\\n     * @param last Whether this is the last attestations/revocations set.\\n     *\\n     * @return Returns the total sent ETH amount.\\n     */\\n    function _resolveAttestations(\\n        SchemaRecord memory schemaRecord,\\n        Attestation[] memory attestations,\\n        uint256[] memory values,\\n        bool isRevocation,\\n        uint256 availableValue,\\n        bool last\\n    ) private returns (uint256) {\\n        uint256 length = attestations.length;\\n        if (length == 1) {\\n            return _resolveAttestation(schemaRecord, attestations[0], values[0], isRevocation, availableValue, last);\\n        }\\n\\n        ISchemaResolver resolver = schemaRecord.resolver;\\n        if (address(resolver) == address(0)) {\\n            // Ensure that we don't accept payments if there is no resolver.\\n            for (uint256 i = 0; i < length; ) {\\n                if (values[i] != 0) {\\n                    revert NotPayable();\\n                }\\n\\n                unchecked {\\n                    ++i;\\n                }\\n            }\\n\\n            return 0;\\n        }\\n\\n        uint256 totalUsedValue = 0;\\n\\n        for (uint256 i = 0; i < length; ) {\\n            uint256 value = values[i];\\n\\n            // Ensure that we don't accept payments which can't be forwarded to the resolver.\\n            if (value != 0 && !resolver.isPayable()) {\\n                revert NotPayable();\\n            }\\n\\n            // Ensure that the attester/revoker doesn't try to spend more than available.\\n            if (value > availableValue) {\\n                revert InsufficientValue();\\n            }\\n\\n            // Ensure to deduct the sent value explicitly and add it to the total used value by the batch.\\n            unchecked {\\n                availableValue -= value;\\n                totalUsedValue += value;\\n\\n                ++i;\\n            }\\n        }\\n\\n        if (isRevocation) {\\n            if (!resolver.multiRevoke{ value: totalUsedValue }(attestations, values)) {\\n                revert InvalidRevocations();\\n            }\\n        } else if (!resolver.multiAttest{ value: totalUsedValue }(attestations, values)) {\\n            revert InvalidAttestations();\\n        }\\n\\n        if (last) {\\n            _refund(availableValue);\\n        }\\n\\n        return totalUsedValue;\\n    }\\n\\n    /**\\n     * @dev Calculates a UID for a given attestation.\\n     *\\n     * @param attestation The input attestation.\\n     * @param bump A bump value to use in case of a UID conflict.\\n     *\\n     * @return Attestation UID.\\n     */\\n    function _getUID(Attestation memory attestation, uint32 bump) private pure returns (bytes32) {\\n        return\\n            keccak256(\\n                abi.encodePacked(\\n                    attestation.schema,\\n                    attestation.recipient,\\n                    attestation.attester,\\n                    attestation.time,\\n                    attestation.expirationTime,\\n                    attestation.revocable,\\n                    attestation.refUID,\\n                    attestation.data,\\n                    bump\\n                )\\n            );\\n    }\\n\\n    /**\\n     * @dev Refunds remaining ETH amount to the attester.\\n     *\\n     * @param remainingValue The remaining ETH amount that was not sent to the resolver.\\n     */\\n    function _refund(uint256 remainingValue) private {\\n        if (remainingValue > 0) {\\n            // Using a regular transfer here might revert, for some non-EOA attesters, due to exceeding of the 2300\\n            // gas limit which is why we're using call instead (via sendValue), which the 2300 gas limit does not\\n            // apply for.\\n            payable(msg.sender).sendValue(remainingValue);\\n        }\\n    }\\n\\n    /**\\n     * @dev Merges lists of UIDs.\\n     *\\n     * @param uidLists The provided lists of UIDs.\\n     * @param uidsCount Total UIDs count.\\n     *\\n     * @return A merged and flatten list of all the UIDs.\\n     */\\n    function _mergeUIDs(bytes32[][] memory uidLists, uint256 uidsCount) private pure returns (bytes32[] memory) {\\n        bytes32[] memory uids = new bytes32[](uidsCount);\\n\\n        uint256 currentIndex = 0;\\n        for (uint256 i = 0; i < uidLists.length; ) {\\n            bytes32[] memory currentUids = uidLists[i];\\n            for (uint256 j = 0; j < currentUids.length; ) {\\n                uids[currentIndex] = currentUids[j];\\n\\n                unchecked {\\n                    ++j;\\n                    ++currentIndex;\\n                }\\n            }\\n            unchecked {\\n                ++i;\\n            }\\n        }\\n\\n        return uids;\\n    }\\n\\n    /**\\n     * @dev Timestamps the specified bytes32 data.\\n     *\\n     * @param data The data to timestamp.\\n     * @param time The timestamp.\\n     */\\n    function _timestamp(bytes32 data, uint64 time) private {\\n        if (_timestamps[data] != 0) {\\n            revert AlreadyTimestamped();\\n        }\\n\\n        _timestamps[data] = time;\\n\\n        emit Timestamped(data, time);\\n    }\\n\\n    /**\\n         * @dev Timestamps the specified bytes32 data.\\n         *\\n         * @param data The data to timestamp.\\n         * @param time The timestamp.\\n         */\\n    function _revokeOffchain(address revoker, bytes32 data, uint64 time) private {\\n        mapping(bytes32 data => uint64 timestamp) storage revocations = _revocationsOffchain[revoker];\\n\\n\\n        if (revocations[data] != 0) {\\n            revert AlreadyRevokedOffchain();\\n        }\\n\\n        revocations[data] = time;\\n\\n        emit RevokedOffchain(revoker, data, time);\\n    }\\n\\n    /**\\n     * @dev Returns the current's block timestamp. This method is overridden during tests and used to simulate the\\n     * current block time.\\n     */\\n    function _time() internal view virtual returns (uint64) {\\n        return uint64(block.timestamp);\\n    }\\n}\\n\",\"keccak256\":\"0x8b7233cc7377d5d90ccffcd67c93287fda47bcdc92ca0df0b10c22bf35a3f231\",\"license\":\"MIT\"},\"contracts/EIP712Verifier.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\nimport { EIP712 } from \\\"@openzeppelin/contracts/utils/cryptography/EIP712.sol\\\";\\nimport { ECDSA } from \\\"@openzeppelin/contracts/utils/cryptography/ECDSA.sol\\\";\\n\\n// prettier-ignore\\nimport {\\n    AttestationRequest,\\n    AttestationRequestData,\\n    DelegatedAttestationRequest,\\n    DelegatedRevocationRequest,\\n    RevocationRequest,\\n    RevocationRequestData\\n} from \\\"./IEAS.sol\\\";\\n\\nimport { EIP712Signature } from \\\"./Types.sol\\\";\\n\\n/**\\n * @title EIP712 typed signatures verifier for EAS delegated attestations.\\n */\\nabstract contract EIP712Verifier is EIP712 {\\n    error InvalidSignature();\\n\\n    // The hash of the data type used to relay calls to the attest function. It's the value of\\n    // keccak256(\\\"Attest(bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 nonce)\\\").\\n    bytes32 private constant ATTEST_TYPEHASH = 0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61;\\n\\n    // The hash of the data type used to relay calls to the revoke function. It's the value of\\n    // keccak256(\\\"Revoke(bytes32 schema,bytes32 uid,uint256 nonce)\\\").\\n    bytes32 private constant REVOKE_TYPEHASH = 0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650;\\n\\n    // Replay protection nonces.\\n    mapping(address => uint256) private _nonces;\\n\\n    /**\\n     * @dev Creates a new EIP712Verifier instance.\\n     *\\n     * @param version The current major version of the signing domain\\n     */\\n    constructor(string memory version) EIP712(\\\"EAS\\\", version) {}\\n\\n    /**\\n     * @dev Returns the domain separator used in the encoding of the signatures for attest, and revoke.\\n     */\\n    function getDomainSeparator() external view returns (bytes32) {\\n        return _domainSeparatorV4();\\n    }\\n\\n    /**\\n     * @dev Returns the current nonce per-account.\\n     *\\n     * @param account The requested account.\\n     *\\n     * @return The current nonce.\\n     */\\n    function getNonce(address account) external view returns (uint256) {\\n        return _nonces[account];\\n    }\\n\\n    /**\\n     * Returns the EIP712 type hash for the attest function.\\n     */\\n    function getAttestTypeHash() external pure returns (bytes32) {\\n        return ATTEST_TYPEHASH;\\n    }\\n\\n    /**\\n     * Returns the EIP712 type hash for the revoke function.\\n     */\\n    function getRevokeTypeHash() external pure returns (bytes32) {\\n        return REVOKE_TYPEHASH;\\n    }\\n\\n    /**\\n     * @dev Verifies delegated attestation request.\\n     *\\n     * @param request The arguments of the delegated attestation request.\\n     */\\n    function _verifyAttest(DelegatedAttestationRequest memory request) internal {\\n        AttestationRequestData memory data = request.data;\\n        EIP712Signature memory signature = request.signature;\\n\\n        uint256 nonce;\\n        unchecked {\\n            nonce = _nonces[request.attester]++;\\n        }\\n\\n        bytes32 digest = _hashTypedDataV4(\\n            keccak256(\\n                abi.encode(\\n                    ATTEST_TYPEHASH,\\n                    request.schema,\\n                    data.recipient,\\n                    data.expirationTime,\\n                    data.revocable,\\n                    data.refUID,\\n                    keccak256(data.data),\\n                    nonce\\n                )\\n            )\\n        );\\n\\n        if (ECDSA.recover(digest, signature.v, signature.r, signature.s) != request.attester) {\\n            revert InvalidSignature();\\n        }\\n    }\\n\\n    /**\\n     * @dev Verifies delegated revocation request.\\n     *\\n     * @param request The arguments of the delegated revocation request.\\n     */\\n    function _verifyRevoke(DelegatedRevocationRequest memory request) internal {\\n        RevocationRequestData memory data = request.data;\\n        EIP712Signature memory signature = request.signature;\\n\\n        uint256 nonce;\\n        unchecked {\\n            nonce = _nonces[request.revoker]++;\\n        }\\n\\n        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, request.schema, data.uid, nonce)));\\n\\n        if (ECDSA.recover(digest, signature.v, signature.r, signature.s) != request.revoker) {\\n            revert InvalidSignature();\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0x373763eb3fa3bd3a8b7e839bfdc3319fbcd259d1029f227b88121c5450bdfae4\",\"license\":\"MIT\"},\"contracts/IEAS.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaRegistry } from \\\"./ISchemaRegistry.sol\\\";\\nimport { Attestation, EIP712Signature } from \\\"./Types.sol\\\";\\n\\n/**\\n * @dev A struct representing the arguments of the attestation request.\\n */\\nstruct AttestationRequestData {\\n    address recipient; // The recipient of the attestation.\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes32 refUID; // The UID of the related attestation.\\n    bytes data; // Custom attestation data.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the attestation request.\\n */\\nstruct AttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the full delegated attestation request.\\n */\\nstruct DelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n    EIP712Signature signature; // The EIP712 signature data.\\n    address attester; // The attesting account.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the multi attestation request.\\n */\\nstruct MultiAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation request.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the delegated multi attestation request.\\n */\\nstruct MultiDelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation requests.\\n    EIP712Signature[] signatures; // The EIP712 signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address attester; // The attesting account.\\n}\\n\\n/**\\n * @dev A struct representing the arguments of the revocation request.\\n */\\nstruct RevocationRequestData {\\n    bytes32 uid; // The UID of the attestation to revoke.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the revocation request.\\n */\\nstruct RevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n}\\n\\n/**\\n * @dev A struct representing the arguments of the full delegated revocation request.\\n */\\nstruct DelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n    EIP712Signature signature; // The EIP712 signature data.\\n    address revoker; // The revoking account.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the multi revocation request.\\n */\\nstruct MultiRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation request.\\n}\\n\\n/**\\n * @dev A struct representing the full arguments of the delegated multi revocation request.\\n */\\nstruct MultiDelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation requests.\\n    EIP712Signature[] signatures; // The EIP712 signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address revoker; // The revoking account.\\n}\\n\\n/**\\n * @title EAS - Ethereum Attestation Service interface.\\n */\\ninterface IEAS {\\n    /**\\n     * @dev Emitted when an attestation has been made.\\n     *\\n     * @param recipient The recipient of the attestation.\\n     * @param attester The attesting account.\\n     * @param uid The UID the revoked attestation.\\n     * @param schema The UID of the schema.\\n     */\\n    event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema);\\n\\n    /**\\n     * @dev Emitted when an attestation has been revoked.\\n     *\\n     * @param recipient The recipient of the attestation.\\n     * @param attester The attesting account.\\n     * @param schema The UID of the schema.\\n     * @param uid The UID the revoked attestation.\\n     */\\n    event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema);\\n\\n    /**\\n     * @dev Emitted when a data has been timestamped.\\n     *\\n     * @param data The data.\\n     * @param timestamp The timestamp.\\n     */\\n    event Timestamped(bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /**\\n     * @dev Emitted when a data has been revoked.\\n     *\\n     * @param revoker The address of the revoker.\\n     * @param data The data.\\n     * @param timestamp The timestamp.\\n     */\\n    event RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /**\\n     * @dev Returns the address of the global schema registry.\\n     *\\n     * @return The address of the global schema registry.\\n     */\\n    function getSchemaRegistry() external view returns (ISchemaRegistry);\\n\\n    /**\\n     * @dev Attests to a specific schema.\\n     *\\n     * @param request The arguments of the attestation request.\\n     *\\n     * Example:\\n     *\\n     * attest({\\n     *     schema: \\\"0facc36681cbe2456019c1b0d1e7bedd6d1d40f6f324bf3dd3a4cef2999200a0\\\",\\n     *     data: {\\n     *         recipient: \\\"0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf\\\",\\n     *         expirationTime: 0,\\n     *         revocable: true,\\n     *         refUID: \\\"0x0000000000000000000000000000000000000000000000000000000000000000\\\",\\n     *         data: \\\"0xF00D\\\",\\n     *         value: 0\\n     *     }\\n     * })\\n     *\\n     * @return The UID of the new attestation.\\n     */\\n    function attest(AttestationRequest calldata request) external payable returns (bytes32);\\n\\n    /**\\n     * @dev Attests to a specific schema via the provided EIP712 signature.\\n     *\\n     * @param delegatedRequest The arguments of the delegated attestation request.\\n     *\\n     * Example:\\n     *\\n     * attestByDelegation({\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: {\\n     *         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n     *         expirationTime: 1673891048,\\n     *         revocable: true,\\n     *         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n     *         data: '0x1234',\\n     *         value: 0\\n     *     },\\n     *     signature: {\\n     *         v: 28,\\n     *         r: '0x148c...b25b',\\n     *         s: '0x5a72...be22'\\n     *     },\\n     *     attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e'\\n     * })\\n     *\\n     * @return The UID of the new attestation.\\n     */\\n    function attestByDelegation(\\n        DelegatedAttestationRequest calldata delegatedRequest\\n    ) external payable returns (bytes32);\\n\\n    /**\\n     * @dev Attests to multiple schemas.\\n     *\\n     * @param multiRequests The arguments of the multi attestation requests. The requests should be grouped by distinct\\n     * schema ids to benefit from the best batching optimization.\\n     *\\n     * Example:\\n     *\\n     * multiAttest([{\\n     *     schema: '0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd',\\n     *     data: [{\\n     *         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n     *         expirationTime: 1673891048,\\n     *         revocable: true,\\n     *         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n     *         data: '0x1234',\\n     *         value: 1000\\n     *     },\\n     *     {\\n     *         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n     *         expirationTime: 0,\\n     *         revocable: false,\\n     *         refUID: '0x480df4a039efc31b11bfdf491b383ca138b6bde160988222a2a3509c02cee174',\\n     *         data: '0x00',\\n     *         value: 0\\n     *     }],\\n     * },\\n     * {\\n     *     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n     *     data: [{\\n     *         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n     *         expirationTime: 0,\\n     *         revocable: true,\\n     *         refUID: '0x75bf2ed8dca25a8190c50c52db136664de25b2449535839008ccfdab469b214f',\\n     *         data: '0x12345678',\\n     *         value: 0\\n     *     },\\n     * }])\\n     *\\n     * @return The UIDs of the new attestations.\\n     */\\n    function multiAttest(MultiAttestationRequest[] calldata multiRequests) external payable returns (bytes32[] memory);\\n\\n    /**\\n     * @dev Attests to multiple schemas using via provided EIP712 signatures.\\n     *\\n     * @param multiDelegatedRequests The arguments of the delegated multi attestation requests. The requests should be\\n     * grouped by distinct schema ids to benefit from the best batching optimization.\\n     *\\n     * Example:\\n     *\\n     * multiAttestByDelegation([{\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: [{\\n     *         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n     *         expirationTime: 1673891048,\\n     *         revocable: true,\\n     *         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n     *         data: '0x1234',\\n     *         value: 0\\n     *     },\\n     *     {\\n     *         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n     *         expirationTime: 0,\\n     *         revocable: false,\\n     *         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n     *         data: '0x00',\\n     *         value: 0\\n     *     }],\\n     *     signatures: [{\\n     *         v: 28,\\n     *         r: '0x148c...b25b',\\n     *         s: '0x5a72...be22'\\n     *     },\\n     *     {\\n     *         v: 28,\\n     *         r: '0x487s...67bb',\\n     *         s: '0x12ad...2366'\\n     *     }],\\n     *     attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4'\\n     * }])\\n     *\\n     * @return The UIDs of the new attestations.\\n     */\\n    function multiAttestByDelegation(\\n        MultiDelegatedAttestationRequest[] calldata multiDelegatedRequests\\n    ) external payable returns (bytes32[] memory);\\n\\n    /**\\n     * @dev Revokes an existing attestation to a specific schema.\\n     *\\n     * Example:\\n     *\\n     * revoke({\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: {\\n     *         uid: '0x101032e487642ee04ee17049f99a70590c735b8614079fc9275f9dd57c00966d',\\n     *         value: 0\\n     *     }\\n     * })\\n     *\\n     * @param request The arguments of the revocation request.\\n     */\\n    function revoke(RevocationRequest calldata request) external payable;\\n\\n    /**\\n     * @dev Revokes an existing attestation to a specific schema via the provided EIP712 signature.\\n     *\\n     * Example:\\n     *\\n     * revokeByDelegation({\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: {\\n     *         uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',\\n     *         value: 0\\n     *     },\\n     *     signature: {\\n     *         v: 27,\\n     *         r: '0xb593...7142',\\n     *         s: '0x0f5b...2cce'\\n     *     },\\n     *     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992'\\n     * })\\n     *\\n     * @param delegatedRequest The arguments of the delegated revocation request.\\n     */\\n    function revokeByDelegation(DelegatedRevocationRequest calldata delegatedRequest) external payable;\\n\\n    /**\\n     * @dev Revokes existing attestations to multiple schemas.\\n     *\\n     * @param multiRequests The arguments of the multi revocation requests. The requests should be grouped by distinct\\n     * schema ids to benefit from the best batching optimization.\\n     *\\n     * Example:\\n     *\\n     * multiRevoke([{\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: [{\\n     *         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n     *         value: 1000\\n     *     },\\n     *     {\\n     *         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n     *         value: 0\\n     *     }],\\n     * },\\n     * {\\n     *     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n     *     data: [{\\n     *         uid: '0x053d42abce1fd7c8fcddfae21845ad34dae287b2c326220b03ba241bc5a8f019',\\n     *         value: 0\\n     *     },\\n     * }])\\n     */\\n    function multiRevoke(MultiRevocationRequest[] calldata multiRequests) external payable;\\n\\n    /**\\n     * @dev Revokes existing attestations to multiple schemas via provided EIP712 signatures.\\n     *\\n     * @param multiDelegatedRequests The arguments of the delegated multi revocation attestation requests. The requests should be\\n     * grouped by distinct schema ids to benefit from the best batching optimization.\\n     *\\n     * Example:\\n     *\\n     * multiRevokeByDelegation([{\\n     *     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n     *     data: [{\\n     *         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n     *         value: 1000\\n     *     },\\n     *     {\\n     *         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n     *         value: 0\\n     *     }],\\n     *     signatures: [{\\n     *         v: 28,\\n     *         r: '0x148c...b25b',\\n     *         s: '0x5a72...be22'\\n     *     },\\n     *     {\\n     *         v: 28,\\n     *         r: '0x487s...67bb',\\n     *         s: '0x12ad...2366'\\n     *     }],\\n     *     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992'\\n     * }])\\n     *\\n     */\\n    function multiRevokeByDelegation(\\n        MultiDelegatedRevocationRequest[] calldata multiDelegatedRequests\\n    ) external payable;\\n\\n    /**\\n     * @dev Timestamps the specified bytes32 data.\\n     *\\n     * @param data The data to timestamp.\\n     *\\n     * @return The timestamp the data was timestamped with.\\n     */\\n    function timestamp(bytes32 data) external returns (uint64);\\n\\n    /**\\n     * @dev Timestamps the specified multiple bytes32 data.\\n     *\\n     * @param data The data to timestamp.\\n     *\\n     * @return The timestamp the data was timestamped with.\\n     */\\n    function multiTimestamp(bytes32[] calldata data) external returns (uint64);\\n\\n    /**\\n     * @dev Revokes the specified bytes32 data.\\n     *\\n     * @param data The data to timestamp.\\n     *\\n     * @return The timestamp the data was revoked with.\\n     */\\n    function revokeOffchain(bytes32 data) external returns (uint64);\\n\\n    /**\\n     * @dev Revokes the specified multiple bytes32 data.\\n     *\\n     * @param data The data to timestamp.\\n     *\\n     * @return The timestamp the data was revoked with.\\n     */\\n    function multiRevokeOffchain(bytes32[] calldata data) external returns (uint64);\\n\\n    /**\\n     * @dev Returns an existing attestation by UID.\\n     *\\n     * @param uid The UID of the attestation to retrieve.\\n     *\\n     * @return The attestation data members.\\n     */\\n    function getAttestation(bytes32 uid) external view returns (Attestation memory);\\n\\n    /**\\n     * @dev Checks whether an attestation exists.\\n     *\\n     * @param uid The UID of the attestation to retrieve.\\n     *\\n     * @return Whether an attestation exists.\\n     */\\n    function isAttestationValid(bytes32 uid) external view returns (bool);\\n\\n    /**\\n     * @dev Returns the timestamp that the specified data was timestamped with.\\n     *\\n     * @param data The data to query.\\n     *\\n     * @return The timestamp the data was timestamped with.\\n     */\\n    function getTimestamp(bytes32 data) external view returns (uint64);\\n\\n    /**\\n     * @dev Returns the timestamp that the specified data was timestamped with.\\n     *\\n     * @param data The data to query.\\n     *\\n     * @return The timestamp the data was timestamped with.\\n     */\\n    function getRevokeOffchain(address revoker, bytes32 data) external view returns (uint64);\\n}\\n\",\"keccak256\":\"0x77037a2caac190938c12fc150159abc4b59069fa4cb71a7b75f0c3d08a55a419\",\"license\":\"MIT\"},\"contracts/ISchemaRegistry.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\n/**\\n * @title A struct representing a record for a submitted schema.\\n */\\nstruct SchemaRecord {\\n    bytes32 uid; // The unique identifier of the schema.\\n    ISchemaResolver resolver; // Optional schema resolver.\\n    bool revocable; // Whether the schema allows revocations explicitly.\\n    string schema; // Custom specification of the schema (e.g., an ABI).\\n}\\n\\n/**\\n * @title The global schema registry interface.\\n */\\ninterface ISchemaRegistry {\\n    /**\\n     * @dev Emitted when a new schema has been registered\\n     *\\n     * @param uid The schema UID.\\n     * @param registerer The address of the account used to register the schema.\\n     */\\n    event Registered(bytes32 indexed uid, address registerer);\\n\\n    /**\\n     * @dev Submits and reserves a new schema\\n     *\\n     * @param schema The schema data schema.\\n     * @param resolver An optional schema resolver.\\n     * @param revocable Whether the schema allows revocations explicitly.\\n     *\\n     * @return The UID of the new schema.\\n     */\\n    function register(string calldata schema, ISchemaResolver resolver, bool revocable) external returns (bytes32);\\n\\n    /**\\n     * @dev Returns an existing schema by UID\\n     *\\n     * @param uid The UID of the schema to retrieve.\\n     *\\n     * @return The schema data members.\\n     */\\n    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);\\n}\\n\",\"keccak256\":\"0xef47e449dd02bd034e26b1dea505ce533906f8462fc674c938ed0e872a68d640\",\"license\":\"MIT\"},\"contracts/Types.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\n// A representation of an empty/uninitialized UID.\\nbytes32 constant EMPTY_UID = 0;\\n\\n/**\\n * @dev A struct representing EIP712 signature data.\\n */\\nstruct EIP712Signature {\\n    uint8 v; // The recovery ID.\\n    bytes32 r; // The x-coordinate of the nonce R.\\n    bytes32 s; // The signature data.\\n}\\n\\n/**\\n * @dev A struct representing a single attestation.\\n */\\nstruct Attestation {\\n    bytes32 uid; // A unique identifier of the attestation.\\n    bytes32 schema; // The unique identifier of the schema.\\n    uint64 time; // The time when the attestation was created (Unix timestamp).\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    uint64 revocationTime; // The time when the attestation was revoked (Unix timestamp).\\n    bytes32 refUID; // The UID of the related attestation.\\n    address recipient; // The recipient of the attestation.\\n    address attester; // The attester/sender of the attestation.\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes data; // Custom attestation data.\\n}\\n\",\"keccak256\":\"0x547096b5cb7bfad9591bdc520705f8110534cd040ed0f7a0ba8d83ea4a565b45\",\"license\":\"MIT\"},\"contracts/resolver/ISchemaResolver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { Attestation } from \\\"../Types.sol\\\";\\n\\n/**\\n * @title The interface of an optional schema resolver.\\n */\\ninterface ISchemaResolver {\\n    /**\\n     * @dev Returns whether the resolver supports ETH transfers.\\n     */\\n    function isPayable() external pure returns (bool);\\n\\n    /**\\n     * @dev Processes an attestation and verifies whether it's valid.\\n     *\\n     * @param attestation The new attestation.\\n     *\\n     * @return Whether the attestation is valid.\\n     */\\n    function attest(Attestation calldata attestation) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes multiple attestations and verifies whether they are valid.\\n     *\\n     * @param attestations The new attestations.\\n     * @param values Explicit ETH amounts which were sent with each attestation.\\n     *\\n     * @return Whether all the attestations are valid.\\n     */\\n    function multiAttest(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes an attestation revocation and verifies if it can be revoked.\\n     *\\n     * @param attestation The existing attestation to be revoked.\\n     *\\n     * @return Whether the attestation can be revoked.\\n     */\\n    function revoke(Attestation calldata attestation) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes revocation of multiple attestation and verifies they can be revoked.\\n     *\\n     * @param attestations The existing attestations to be revoked.\\n     * @param values Explicit ETH amounts which were sent with each revocation.\\n     *\\n     * @return Whether the attestations can be revoked.\\n     */\\n    function multiRevoke(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n}\\n\",\"keccak256\":\"0x0f3a75c28cdb91fa9227a6eef183379ecea2b6bf38db52795b5c4e6af79299e8\",\"license\":\"MIT\"}},\"version\":1}",
        "bytecode": "0x61016034620001b657601f62004fdb38819003918201601f19168301926001600160401b0392909183851183861017620001a0578160209284926040978852833981010312620001b657516001600160a01b03811692838203620001b6578051926200006b84620001bb565b6004845260208401631817191b60e11b81526003602084516200008e81620001bb565b828152016245415360e81b81522094519020948460e052610100958087524660a052835160208101917f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f978884528683015260608201524660808201523060a082015260a0815260c081019381851090851117620001a0578385525190206080523060c052610120948552156200019157506101409182525191614e039384620001d8853960805184614892015260a0518461494d015260c05184614863015260e051846148e101525183614907015251826148be01525181818161028601528181610ab4015281816110b801528181612b5e0152818161324c01526134ca0152f35b6311a1e69760e01b8152600490fd5b634e487b7160e01b600052604160045260246000fd5b600080fd5b604081019081106001600160401b03821117620001a05760405256fe61010080604052600436101561001457600080fd5b60003560e01c90816312b11a1714611eec5750806313893f6114611e645780632d0335ab14611dff57806344adc90e14611cfc5780634692626714611c9e5780634cb7e9e514611b9c5780634d00307014611b54578063831e05a11461192e578063a3112a64146118c7578063b469318d1461184a578063b83010d3146117f1578063cf190f34146117a8578063d45c443514611754578063e13458fc14610f5c578063e30bb56314610f08578063e45d03f914610ca4578063e57a6b1b14610ba0578063e71ff36514610b19578063ed24911d14610ad8578063f10b5cc814610a69578063f17325e7146101975763ffa1ad741461011257600080fd5b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925761018e60405161015081612149565b600481527f302e3236000000000000000000000000000000000000000000000000000000006020820152604051918291602083526020830190612016565b0390f35b600080fd5b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc602081360112610192576004359067ffffffffffffffff821161019257604082600401918336030112610192576102046101f0612215565b926101ff60243692018461227d565b6122d1565b61020d836122b0565b52610217826122b0565b50610220612942565b5081519161022c612942565b916102368461295c565b6020840152604051937fa2ea7c6e0000000000000000000000000000000000000000000000000000000085528135600486015260008560248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa948515610a5d57600095610a38575b50845115610a0e57916102c983612a7f565b916102d38461295c565b936000925b8184106103045760206102fb81896102f2348b8b8f61376d565b815201516122b0565b51604051908152f35b610316848299949698939597996122bd565b519267ffffffffffffffff60208501511680151590816109f9575b506109cf57604081015115806109c2575b6109985760608401519467ffffffffffffffff6020860151169573ffffffffffffffffffffffffffffffffffffffff86511660408701511515906080880151926040519961038f8b612165565b60008b528b3560208c015267ffffffffffffffff421660408c015260608b0152600060808b015260a08a015260c08901523360e089015261010088015261012087015260005b602087015160c08801516104de609d60e08b015160408c01518c60608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b8201907fffffffff000000000000000000000000000000000000000000000000000000008860e01b169082015203607d810184520182612182565b51902080600052600160205260406000205415610504575060010163ffffffff166103d5565b919690509997919998969492939881815281600052600160205260406000209080518255602081015160018301556105e36002830167ffffffffffffffff6040840151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff0000000000000000606087015160401b1692161717815567ffffffffffffffff6080840151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a081015160038301556004820173ffffffffffffffffffffffffffffffffffffffff60c0830151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005820173ffffffffffffffffffffffffffffffffffffffff60e0830151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff0000000000000000000000000000000000000000610100860151151560a01b1692161717905561012081015180519167ffffffffffffffff831161096957838c938c938f9660066106ca91015461278f565b601f81116108f5575b50602090601f831160011461081857600692916000918361080d575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b6060870151806107b8575b5085602073ffffffffffffffffffffffffffffffffffffffff9560019995610765848761077d9761075f838e9b6122bd565b526122bd565b506107758460a0890151926122bd565b5201516122bd565b525116906040519081528535917f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b3560203393a40192906102d8565b915092506107d491506000526001602052604060002054151590565b156107e35788888b928e61072d565b60046040517fc5723b51000000000000000000000000000000000000000000000000000000008152fd5b0151905038806106ef565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0851681106108ca5750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06006971610610893575b505050811b01910155610722565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080610885565b9497509295509396506020600181928685015181550194019201928f9693928f9693928f9693610829565b9295509295509250600684016000526020600020601f840160051c810160208510610962575b928f9693928f9693928f96935b601f830160051c8201811061093e5750506106d3565b60019396995080929598506000919497505501928f9693928f9693928f9693610928565b508061091b565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60046040517f157bd4c3000000000000000000000000000000000000000000000000000000008152fd5b5060408401511515610342565b60046040517f08e8b937000000000000000000000000000000000000000000000000000000008152fd5b905067ffffffffffffffff421610158a610331565b60046040517fbf37b20e000000000000000000000000000000000000000000000000000000008152fd5b610a569195503d806000833e610a4e8183612182565b8101906129b8565b93856102b7565b6040513d6000823e3d90fd5b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602060405173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576020610b1161484c565b604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257610b69903690600401611f43565b9142169160005b818110610b8257602084604051908152f35b80610b9a85610b946001948688612734565b356146e1565b01610b70565b60e07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257604051610bd6816120f5565b600435808252610be53661267c565b602083015260607fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c36011261019257604051610c208161212d565b60643560ff81168103610192578152608435602082015260a4356040820152604083015260c43573ffffffffffffffffffffffffffffffffffffffff8116810361019257610c7683826060610ca2960152614d30565b610c7e61262d565b610c873661267c565b610c90826122b0565b52610c9a816122b0565b5034926131ff565b005b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257610cf183913690600401611f43565b909234926000915b838310610d0257005b610d0d838588612599565b946080863603126101925760405195610d25876120f5565b803587528381013583811161019257810194601f9536878201121561019257610d5490369087813591016126c2565b9285890193845260408301358581116101925783019636908801121561019257863594610d80866121fd565b97610d8e604051998a612182565b868952878901886060809902830101913683116101925789808a9201925b848410610ef05750509050610dca915060408c01958a875201611f97565b94868b01958652519788518015918215610ee4575b5050610eba5760005b8851811015610e5057600190610e4a8c51610e03838d6122bd565b51610e0f848a516122bd565b5173ffffffffffffffffffffffffffffffffffffffff8b51169160405193610e36856120f5565b84528d84015260408301528a820152614d30565b01610de8565b50986001955081935090610eaa929a97610eb09592519073ffffffffffffffffffffffffffffffffffffffff8d7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8d01149451169161347c565b9061255d565b9501919493610cf9565b60046040517f947d5a84000000000000000000000000000000000000000000000000000000008152fd5b51141590508c80610ddf565b610efa3685612393565b815201910190898991610dac565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576020610f526004356000526001602052604060002054151590565b6040519015158152f35b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc6020813601126101925760043567ffffffffffffffff81116101925760c0816004019282360301126101925760405190610fb6826120f5565b82358252602481019182359167ffffffffffffffff83116101925760a461101691610fea61104695600436918401016122d1565b6020850152610ffc3660448301612393565b6040850152019161100c83611f97565b6060820152614973565b61102d611021612215565b936101ff36918761227d565b611036846122b0565b52611040836122b0565b506123d1565b9061104f612942565b5080519061105b612942565b60e0526110678261295c565b602060e05101526040517fa2ea7c6e0000000000000000000000000000000000000000000000000000000081528435600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa8015610a5d576000608052611737575b506080515115610a0e5790916110ff83612a7f565b60a05261110b8361295c565b60c0526000915b83831061113f5761112b3460c05160a05160805161376d565b60e0515260206102fb8160e05101516122b0565b61114983826122bd565b519067ffffffffffffffff6020830151168015159081611722575b506109cf57604060805101511580611715575b6109985760608201519467ffffffffffffffff6020840151169573ffffffffffffffffffffffffffffffffffffffff8451166040850151151590608086015192604051996111c48b612165565b60008b528b3560208c015267ffffffffffffffff421660408c015260608b0152600060808b015260a08a015260c089015273ffffffffffffffffffffffffffffffffffffffff861660e089015261010088015261012087015260005b602087015160c08801516112ee609d60e08b015160408c01518c60608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b51902080600052600160205260406000205415611314575060010163ffffffff16611220565b91959294969050818152816000526001602052604060002081518155602082015160018201556113eb6002820167ffffffffffffffff6040850151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff0000000000000000606088015160401b1692161717815567ffffffffffffffff6080850151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a082015160038201556004810173ffffffffffffffffffffffffffffffffffffffff60c0840151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005810173ffffffffffffffffffffffffffffffffffffffff60e0840151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff0000000000000000000000000000000000000000610100870151151560a01b1692161717905561012082015180519067ffffffffffffffff8211610969576114cb600684015461278f565b601f81116116ce575b50602090601f83116001146116045760069291600091836115f9575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b6060840151806115d7575b5060019373ffffffffffffffffffffffffffffffffffffffff916115548560a0516122bd565b526115618460a0516122bd565b5060a08101516115738560c0516122bd565b528261158585602060e05101516122bd565b525116906040519081528735917f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35602073ffffffffffffffffffffffffffffffffffffffff8a1693a401919290611112565b6115ee906000526001602052604060002054151590565b156107e3578861152e565b015190508c806114f0565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0851681106116b65750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0600697161061167f575b505050811b01910155611523565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c191690558c8080611671565b91926020600181928685015181550194019201611615565b600684016000526020600020601f840160051c81016020851061170e575b601f830160051c820181106117025750506114d4565b600081556001016116ec565b50806116ec565b5060408201511515611177565b905067ffffffffffffffff4216101587611164565b61174b903d806000833e610a4e8183612182565b608052846110ea565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576004356000526002602052602067ffffffffffffffff60406000205416604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602067ffffffffffffffff4216610b118160043533614787565b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760206040517fa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a996508152f35b346101925760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925773ffffffffffffffffffffffffffffffffffffffff611896611f74565b1660005260036020526040600020602435600052602052602067ffffffffffffffff60406000205416604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576118fe612744565b50600435600052600160205261018e61191a60406000206127e2565b604051918291602083526020830190612059565b60207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760043567ffffffffffffffff811161019257611978903690600401611f43565b90611982826123f2565b9160009134906000925b8084106119ac5761018e6119a08688614674565b60405191829182611fb8565b909192936119bb858385612599565b6119c86020820182612499565b9081158015611b3c575b610eba57908691600090898760608701968035945b868110611a6f57505093611a3f93611a396001999894611a31602099957fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff611a489a0114966123d1565b9336916124ed565b90612aec565b9687519061255d565b95018051611a56888a6122bd565b52611a6187896122bd565b50515101940192919061198c565b9250929394955050611a868160051b84018461227d565b90611a9460408401846125d9565b821015611b0d5760019273ffffffffffffffffffffffffffffffffffffffff611aff92611aef611ac38c6123d1565b91611ade60405195611ad4876120f5565b8c875236906122d1565b602086015236906060880201612393565b6040840152166060820152614973565b01878a959493928c926119e7565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b50611b4a60408401846125d9565b90508214156119d2565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602067ffffffffffffffff4216610b11816004356146e1565b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff9060043582811161019257611be9903690600401611f43565b929091600090345b858310611bfa57005b611c05838787612459565b828101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181121561019257810191823592868411610192578401928060061b360384136101925760019382610eaa92611c9695611c8f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8e018b1494339336916126c2565b903561347c565b920191611bf1565b60607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257610ca2611cd361262d565b611cdc3661267c565b611ce5826122b0565b52611cef816122b0565b50349033906004356131ff565b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760043567ffffffffffffffff811161019257611d47903690600401611f43565b611d53819392936123f2565b92600092346000937fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8101905b808610611d945761018e6119a0888a614674565b90919293949560019085611dd6611a3f8a8888611db2838a8f612459565b611dcf611dc188830183612499565b9390951494339336916124ed565b9035612aec565b95018051611de48a8c6122bd565b52611def898b6122bd565b5051510196019493929190611d80565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925773ffffffffffffffffffffffffffffffffffffffff611e4b611f74565b1660005260006020526020604060002054604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257611eb4903690600401611f43565b9142169160005b818110611ecd57602084604051908152f35b80611ee685611edf6001948688612734565b3533614787565b01611ebb565b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257807fdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de6160209252f35b9181601f840112156101925782359167ffffffffffffffff8311610192576020808501948460051b01011161019257565b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361019257565b359073ffffffffffffffffffffffffffffffffffffffff8216820361019257565b6020908160408183019282815285518094520193019160005b828110611fdf575050505090565b835185529381019392810192600101611fd1565b60005b8381106120065750506000910152565b8181015183820152602001611ff6565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f60209361205281518092818752878088019101611ff3565b0116010190565b906120f291805182526020810151602083015267ffffffffffffffff806040830151166040840152806060830151166060840152608082015116608083015260a081015160a083015273ffffffffffffffffffffffffffffffffffffffff8060c08301511660c084015260e08201511660e083015261010080820151151590830152610120809101519161014080928201520190612016565b90565b6080810190811067ffffffffffffffff82111761096957604052565b60c0810190811067ffffffffffffffff82111761096957604052565b6060810190811067ffffffffffffffff82111761096957604052565b6040810190811067ffffffffffffffff82111761096957604052565b610140810190811067ffffffffffffffff82111761096957604052565b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff82111761096957604052565b67ffffffffffffffff811161096957601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200190565b67ffffffffffffffff81116109695760051b60200190565b60409081519161222483612149565b60018352829160005b6020808210156122755783516020929161224682612111565b6000825260008183015260008683015260606000818401526080830152600060a083015282880101520161222d565b505091925050565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff4181360301821215610192570190565b805115611b0d5760200190565b8051821015611b0d5760209160051b010190565b91909160c08184031261019257604051906122eb82612111565b81936122f682611f97565b835260209167ffffffffffffffff8184013581811681036101925784860152604082013580151581036101925760408601526060820135606086015260808201359081116101925781019180601f8401121561019257823592612358846121c3565b916123666040519384612182565b84835285858301011161019257848460a09695879660009401838601378301015260808501520135910152565b9190826060910312610192576040516123ab8161212d565b8092803560ff811681036101925760409182918452602081013560208501520135910152565b3573ffffffffffffffffffffffffffffffffffffffff811681036101925790565b906123fc826121fd565b6124096040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe061243782946121fd565b019060005b82811061244857505050565b80606060208093850101520161243c565b9190811015611b0d5760051b810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc181360301821215610192570190565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301821215610192570180359067ffffffffffffffff821161019257602001918160051b3603831361019257565b929190926124fa846121fd565b916125086040519384612182565b829480845260208094019060051b8301928284116101925780915b84831061253257505050505050565b823567ffffffffffffffff811161019257869161255286849386016122d1565b815201920191612523565b9190820391821161256a57565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b9190811015611b0d5760051b810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8181360301821215610192570190565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301821215610192570180359067ffffffffffffffff82116101925760200191606082023603831361019257565b60409081519161263c83612149565b600183528291600091825b6020808210156126735782516020929161266082612149565b8682528681830152828901015201612647565b50505091925050565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdc604091011261019257604051906126b382612149565b60243582526044356020830152565b9291926126ce826121fd565b6040926126dd84519283612182565b819581835260208093019160061b84019381851161019257915b84831061270657505050505050565b858383031261019257838691825161271d81612149565b8535815282860135838201528152019201916126f7565b9190811015611b0d5760051b0190565b6040519061275182612165565b606061012083600080825280602083015280604083015280848301528060808301528060a08301528060c08301528060e08301526101008201520152565b90600182811c921680156127d8575b60208310146127a957565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b91607f169161279e565b90604051916127f083612165565b828154815260016006818401549360209485850152600281015467ffffffffffffffff908181166040870152818160401c16606087015260801c166080850152600381015460a085015260ff73ffffffffffffffffffffffffffffffffffffffff8060048401541660c0870152600583015490811660e087015260a01c161515610100850152019060405193849260009281549161288d8361278f565b8087529282811690811561290257506001146128bc575b5050505061012092916128b8910384612182565b0152565b60009081528381209695945091905b8183106128ea575093945091925090820101816128b8610120386128a4565b865488840185015295860195879450918301916128cb565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001685880152505050151560051b8301019050816128b8610120386128a4565b6040519061294f82612149565b6060602083600081520152565b90612966826121fd565b6129736040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06129a182946121fd565b0190602036910137565b5190811515820361019257565b906020808383031261019257825167ffffffffffffffff9384821161019257019260808484031261019257604051936129f0856120f5565b805185528281015173ffffffffffffffffffffffffffffffffffffffff811681036101925783860152612a25604082016129ab565b60408601526060810151918211610192570182601f8201121561019257805190612a4e826121c3565b93612a5c6040519586612182565b8285528383830101116101925782612a779385019101611ff3565b606082015290565b90612a89826121fd565b612a966040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0612ac482946121fd565b019060005b828110612ad557505050565b602090612ae0612744565b82828501015201612ac9565b9290949391612af9612942565b50855193612b05612942565b94612b0f8161295c565b6020870152604051907fa2ea7c6e00000000000000000000000000000000000000000000000000000000825282600483015260008260248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa918215610a5d576000926131e2575b50815115610a0e5792979091612ba484612a7f565b98612bae8561295c565b946000935b818510612bd057505050505095612bcb9495966139d4565b815290565b91959398949699909297612be48a846122bd565b519a67ffffffffffffffff60208d01511680151590816131cd575b506109cf57604089015115806131c0575b61099857899860608d01518d602081015167ffffffffffffffff1691815173ffffffffffffffffffffffffffffffffffffffff1690604083015115159260800151936040519e8f90612c6182612165565b6000825260208201524267ffffffffffffffff166040820152606001528d608081016000905260a0015260c08d015273ffffffffffffffffffffffffffffffffffffffff8b1660e08d01526101008c01526101208b015260005b60208b01518b612d8c609d60c08301519260e08101519060408101519060608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b51902080600052600160205260406000205415612db2575060010163ffffffff16612cbb565b90509d979b9199929a949d9c909698939c8084528060005260016020526040600020918451835560208501516001840155612e946002840167ffffffffffffffff6040880151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff000000000000000060608b015160401b1692161717815567ffffffffffffffff6080880151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a085015160038401556004830173ffffffffffffffffffffffffffffffffffffffff60c0870151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005830173ffffffffffffffffffffffffffffffffffffffff60e0870151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff00000000000000000000000000000000000000006101008a0151151560a01b1692161717905561012085015192835167ffffffffffffffff8111610969578894612f76600684015461278f565b601f8111613165575b50602090601f831160011461309857600692916000918361308d575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b8d8b8b606084015180613060575b5086602073ffffffffffffffffffffffffffffffffffffffff95948794610765848660019e61075f8361300e9a6122bd565b5251166040519182527f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35602073ffffffffffffffffffffffffffffffffffffffff881693a4019290919293949a612bb3565b9250505061307d9193506000526001602052604060002054151590565b156107e35785918d8b8b38612fdc565b015190503880612f9b565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08516811061314a5750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06006971610613113575b505050811b01910155612fce565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080613105565b8183015184558c9850600190930192602092830192016130a9565b90919293949550600684016000526020600020601f840160051c8101602085106131b9575b908b979695949392915b601f830160051c820181106131aa575050612f7f565b600081558c9850600101613194565b508061318a565b5060408c01511515612c10565b905067ffffffffffffffff4216101538612bff565b6131f89192503d806000833e610a4e8183612182565b9038612b8f565b939291936040517fa2ea7c6e00000000000000000000000000000000000000000000000000000000815281600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa908115610a5d57600091613461575b50805115610a0e57825161329081612a7f565b9261329a8261295c565b9460005b8381106132b457505050506120f2949550613bb5565b6132be81836122bd565b5190815160005260016020526040600020918254156107e35784600184015403610a0e57600583015473ffffffffffffffffffffffffffffffffffffffff8d1673ffffffffffffffffffffffffffffffffffffffff8216036134375760a01c60ff16156109985767ffffffffffffffff600284015460801c1661340d576002830180547fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff164260801b77ffffffffffffffff00000000000000000000000000000000161790556001928c91613392826127e2565b61339c858c6122bd565b526133a7848b6122bd565b5060208101516133b7858d6122bd565b527ff930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615602073ffffffffffffffffffffffffffffffffffffffff87816004870154169451950154956040519586521693a40161329e565b60046040517f905e7107000000000000000000000000000000000000000000000000000000008152fd5b60046040517f4ca88867000000000000000000000000000000000000000000000000000000008152fd5b61347691503d806000833e610a4e8183612182565b3861327d565b90949392916040517fa2ea7c6e00000000000000000000000000000000000000000000000000000000815282600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa908115610a5d5760009161369e575b50805115610a0e57865161350e81612a7f565b926135188261295c565b9460005b83811061353257505050506120f2959650613db4565b61353c818c6122bd565b5190815160005260016020526040600020918254156107e35783600184015403610a0e57600583015473ffffffffffffffffffffffffffffffffffffffff861673ffffffffffffffffffffffffffffffffffffffff8216036134375760a01c60ff16156109985767ffffffffffffffff600284015460801c1661340d576002830180547fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff164260801b77ffffffffffffffff000000000000000000000000000000001617905560019261360e816127e2565b613618848b6122bd565b52613623838a6122bd565b506020820151613633848c6122bd565b528373ffffffffffffffffffffffffffffffffffffffff6004830154169251910154916040519182527ff930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615602073ffffffffffffffffffffffffffffffffffffffff891693a40161351c565b6136b391503d806000833e610a4e8183612182565b386134fb565b60408101906040815282518092526060810160608360051b830101926020809501916000905b82821061372257505050508281830391015281808451928381520193019160005b82811061370e575050505090565b835185529381019392810192600101613700565b9091929594858061375d837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa089600196030186528a51612059565b97980194939190910191016136df565b9092918351936001908186146139b35773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613983579560009687915b80831061387557505050918392916137f09492876040518097819582947f91db0b7e000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d5760009161383e575b50905015613814576120f290614545565b60046040517fe8bee839000000000000000000000000000000000000000000000000000000008152fd5b82813d831161386e575b6138528183612182565b8101031261386b5750613864906129ab565b8038613803565b80fd5b503d613848565b9091979661388389876122bd565b51801515806138fd575b6138d3578181116138a9578084920398019801909190916137a7565b60046040517f11011294000000000000000000000000000000000000000000000000000000008152fd5b60046040517f1574f9f3000000000000000000000000000000000000000000000000000000008152fd5b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613944575b501561388d565b908982813d8311613972575b61395a8183612182565b8101031261386b575061396c906129ab565b3861393d565b503d613950565b513d6000823e3d90fd5b9594505050905060005b82811061399d5750505050600090565b6139a781836122bd565b516138d357830161398d565b6120f295506139cd91506139c6906122b0565b51916122b0565b5191613f8c565b909391845194600190818714613b985773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613b67579660009788915b808310613ab75750505091839291613a579492886040518097819582947f91db0b7e000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613a83575b5090501561381457613a7a575090565b6120f290614545565b82813d8311613ab0575b613a978183612182565b8101031261386b5750613aa9906129ab565b8038613a6a565b503d613a8d565b90919897613ac58a876122bd565b5180151580613aeb575b6138d3578181116138a957808492039901990190919091613a0e565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613b32575b5015613acf565b908982813d8311613b60575b613b488183612182565b8101031261386b5750613b5a906129ab565b38613b2b565b503d613b3e565b969550505091505060005b828110613b825750505050600090565b613b8c81836122bd565b516138d3578301613b72565b6120f29650613bae91506139c6909594956122b0565b5191614113565b909291835193600190818614613d9a5773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613d6a579560009687915b808310613cba5750505091839291613c389492876040518097819582947f88e5b2d9000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613c86575b50905015613c5c576120f290614545565b60046040517fbf2f3a8b000000000000000000000000000000000000000000000000000000008152fd5b82813d8311613cb3575b613c9a8183612182565b8101031261386b5750613cac906129ab565b8038613c4b565b503d613c90565b90919796613cc889876122bd565b5180151580613cee575b6138d3578181116138a957808492039801980190919091613bef565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613d35575b5015613cd2565b908982813d8311613d63575b613d4b8183612182565b8101031261386b5750613d5d906129ab565b38613d2e565b503d613d41565b9594505050905060005b828110613d845750505050600090565b613d8e81836122bd565b516138d3578301613d74565b6120f29550613dad91506139c6906122b0565b519161427b565b909391845194600190818714613f6f5773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613f3e579660009788915b808310613e8e5750505091839291613e379492886040518097819582947f88e5b2d9000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613e5a575b50905015613c5c57613a7a575090565b82813d8311613e87575b613e6e8183612182565b8101031261386b5750613e80906129ab565b8038613e4a565b503d613e64565b90919897613e9c8a876122bd565b5180151580613ec2575b6138d3578181116138a957808492039901990190919091613dee565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613f09575b5015613ea6565b908982813d8311613f37575b613f1f8183612182565b8101031261386b5750613f31906129ab565b38613f02565b503d613f15565b969550505091505060005b828110613f595750505050600090565b613f6381836122bd565b516138d3578301613f49565b6120f29650613f8591506139c6909594956122b0565b51916143f5565b92919273ffffffffffffffffffffffffffffffffffffffff602080920151168015614106578415158061408c575b6138d3578385116138a957614008829186946040519586809481937fe60c35050000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614058575b5090501561402e57816120f29103614545565b60046040517fbd8ba84d000000000000000000000000000000000000000000000000000000008152fd5b82813d8311614085575b61406c8183612182565b8101031261386b575061407e906129ab565b803861401b565b503d614062565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d576000916140d1575b5015613fba565b908382813d83116140ff575b6140e78183612182565b8101031261386b57506140f9906129ab565b386140ca565b503d6140dd565b505050506138d357600090565b93919373ffffffffffffffffffffffffffffffffffffffff60208092015116801561426d57851515806141f3575b6138d3578486116138a95761418f829187946040519586809481937fe60c35050000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d576000916141bf575b5090501561402e5782906141b557505090565b6120f29103614545565b82813d83116141ec575b6141d38183612182565b8101031261386b57506141e5906129ab565b80386141a2565b503d6141c9565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d57600091614238575b5015614141565b908382813d8311614266575b61424e8183612182565b8101031261386b5750614260906129ab565b38614231565b503d614244565b50505050506138d357600090565b92919273ffffffffffffffffffffffffffffffffffffffff602080920151168015614106578415158061437b575b6138d3578385116138a9576142f7829186946040519586809481937fe49617e10000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614347575b5090501561431d57816120f29103614545565b60046040517fccf3bb27000000000000000000000000000000000000000000000000000000008152fd5b82813d8311614374575b61435b8183612182565b8101031261386b575061436d906129ab565b803861430a565b503d614351565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d576000916143c0575b50156142a9565b908382813d83116143ee575b6143d68183612182565b8101031261386b57506143e8906129ab565b386143b9565b503d6143cc565b93919373ffffffffffffffffffffffffffffffffffffffff60208092015116801561426d57851515806144cb575b6138d3578486116138a957614471829187946040519586809481937fe49617e10000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614497575b5090501561431d5782906141b557505090565b82813d83116144c4575b6144ab8183612182565b8101031261386b57506144bd906129ab565b8038614484565b503d6144a1565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d57600091614510575b5015614423565b908382813d831161453e575b6145268183612182565b8101031261386b5750614538906129ab565b38614509565b503d61451c565b8061454d5750565b80471061461657600080808093335af13d15614611573d61456d816121c3565b9061457b6040519283612182565b8152600060203d92013e5b1561458d57565b60846040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152603a60248201527f416464726573733a20756e61626c6520746f2073656e642076616c75652c207260448201527f6563697069656e74206d617920686176652072657665727465640000000000006064820152fd5b614586565b60646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f416464726573733a20696e73756666696369656e742062616c616e63650000006044820152fd5b9061467e9061295c565b60009283925b80518410156146d9579361469884866122bd565b519160005b83518110156146c8576146b081856122bd565b516146bb84876122bd565b526001928301920161469d565b509094600190940193909150614684565b509250905090565b6000818152600260205267ffffffffffffffff908160408220541661475d577f5aafceeb1c7ad58e4a84898bdee37c02c0fc46e7d24e6b60e8209449f183459f91838252600260205260408220941693847fffffffffffffffffffffffffffffffffffffffffffffffff000000000000000082541617905580a3565b60046040517f2e267946000000000000000000000000000000000000000000000000000000008152fd5b73ffffffffffffffffffffffffffffffffffffffff166000818152600360205260408120908381528160205267ffffffffffffffff80604083205416614822577f92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a22299285835260205260408220951694857fffffffffffffffffffffffffffffffffffffffffffffffff000000000000000082541617905580a4565b60046040517fec9d6eeb000000000000000000000000000000000000000000000000000000008152fd5b73ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001630148061494a575b156148b4577f000000000000000000000000000000000000000000000000000000000000000090565b60405160208101907f000000000000000000000000000000000000000000000000000000000000000082527f000000000000000000000000000000000000000000000000000000000000000060408201527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260a0815261494481612111565b51902090565b507f0000000000000000000000000000000000000000000000000000000000000000461461488b565b6020908181015190604080938183015192606081019173ffffffffffffffffffffffffffffffffffffffff948584511660005260008252846000209283549360018501905551928688511667ffffffffffffffff988985820151168882015115159060806060840151930151878151910120938a5198888a019b7fdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de618d528a01526060890152608088015260a087015260c086015260e0850152610100908185015283526101208301968388109088111761096957614a5e8695614a7294614a7a998b52519020614ce4565b918860ff8351169183015192015192614c48565b949094614aaf565b5116911603614a865750565b600490517f8baa579f000000000000000000000000000000000000000000000000000000008152fd5b6005811015614c195780614ac05750565b60018103614b265760646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f45434453413a20696e76616c6964207369676e617475726500000000000000006044820152fd5b60028103614b8c5760646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f45434453413a20696e76616c6964207369676e6174757265206c656e677468006044820152fd5b600314614b9557565b60846040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202773272076616c60448201527f75650000000000000000000000000000000000000000000000000000000000006064820152fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fd5b9291907f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08311614cd85791608094939160ff602094604051948552168484015260408301526060820152600093849182805260015afa15614ccb57815173ffffffffffffffffffffffffffffffffffffffff811615614cc5579190565b50600190565b50604051903d90823e3d90fd5b50505050600090600390565b614cec61484c565b906040519060208201927f190100000000000000000000000000000000000000000000000000000000000084526022830152604282015260428152614944816120f5565b602081015160409182810151916060820173ffffffffffffffffffffffffffffffffffffffff9283825116600052600060205285600020908154916001830190555192519086519160208301947fa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650865288840152606083015260808201526080815260a081019481861067ffffffffffffffff87111761096957614de18594614a7293614a7a988a52519020614ce4565b9060ff81511688602083015192015192614c4856fea164736f6c6343000812000a",
        "deployedBytecode": "0x61010080604052600436101561001457600080fd5b60003560e01c90816312b11a1714611eec5750806313893f6114611e645780632d0335ab14611dff57806344adc90e14611cfc5780634692626714611c9e5780634cb7e9e514611b9c5780634d00307014611b54578063831e05a11461192e578063a3112a64146118c7578063b469318d1461184a578063b83010d3146117f1578063cf190f34146117a8578063d45c443514611754578063e13458fc14610f5c578063e30bb56314610f08578063e45d03f914610ca4578063e57a6b1b14610ba0578063e71ff36514610b19578063ed24911d14610ad8578063f10b5cc814610a69578063f17325e7146101975763ffa1ad741461011257600080fd5b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925761018e60405161015081612149565b600481527f302e3236000000000000000000000000000000000000000000000000000000006020820152604051918291602083526020830190612016565b0390f35b600080fd5b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc602081360112610192576004359067ffffffffffffffff821161019257604082600401918336030112610192576102046101f0612215565b926101ff60243692018461227d565b6122d1565b61020d836122b0565b52610217826122b0565b50610220612942565b5081519161022c612942565b916102368461295c565b6020840152604051937fa2ea7c6e0000000000000000000000000000000000000000000000000000000085528135600486015260008560248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa948515610a5d57600095610a38575b50845115610a0e57916102c983612a7f565b916102d38461295c565b936000925b8184106103045760206102fb81896102f2348b8b8f61376d565b815201516122b0565b51604051908152f35b610316848299949698939597996122bd565b519267ffffffffffffffff60208501511680151590816109f9575b506109cf57604081015115806109c2575b6109985760608401519467ffffffffffffffff6020860151169573ffffffffffffffffffffffffffffffffffffffff86511660408701511515906080880151926040519961038f8b612165565b60008b528b3560208c015267ffffffffffffffff421660408c015260608b0152600060808b015260a08a015260c08901523360e089015261010088015261012087015260005b602087015160c08801516104de609d60e08b015160408c01518c60608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b8201907fffffffff000000000000000000000000000000000000000000000000000000008860e01b169082015203607d810184520182612182565b51902080600052600160205260406000205415610504575060010163ffffffff166103d5565b919690509997919998969492939881815281600052600160205260406000209080518255602081015160018301556105e36002830167ffffffffffffffff6040840151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff0000000000000000606087015160401b1692161717815567ffffffffffffffff6080840151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a081015160038301556004820173ffffffffffffffffffffffffffffffffffffffff60c0830151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005820173ffffffffffffffffffffffffffffffffffffffff60e0830151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff0000000000000000000000000000000000000000610100860151151560a01b1692161717905561012081015180519167ffffffffffffffff831161096957838c938c938f9660066106ca91015461278f565b601f81116108f5575b50602090601f831160011461081857600692916000918361080d575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b6060870151806107b8575b5085602073ffffffffffffffffffffffffffffffffffffffff9560019995610765848761077d9761075f838e9b6122bd565b526122bd565b506107758460a0890151926122bd565b5201516122bd565b525116906040519081528535917f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b3560203393a40192906102d8565b915092506107d491506000526001602052604060002054151590565b156107e35788888b928e61072d565b60046040517fc5723b51000000000000000000000000000000000000000000000000000000008152fd5b0151905038806106ef565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0851681106108ca5750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06006971610610893575b505050811b01910155610722565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080610885565b9497509295509396506020600181928685015181550194019201928f9693928f9693928f9693610829565b9295509295509250600684016000526020600020601f840160051c810160208510610962575b928f9693928f9693928f96935b601f830160051c8201811061093e5750506106d3565b60019396995080929598506000919497505501928f9693928f9693928f9693610928565b508061091b565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60046040517f157bd4c3000000000000000000000000000000000000000000000000000000008152fd5b5060408401511515610342565b60046040517f08e8b937000000000000000000000000000000000000000000000000000000008152fd5b905067ffffffffffffffff421610158a610331565b60046040517fbf37b20e000000000000000000000000000000000000000000000000000000008152fd5b610a569195503d806000833e610a4e8183612182565b8101906129b8565b93856102b7565b6040513d6000823e3d90fd5b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602060405173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576020610b1161484c565b604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257610b69903690600401611f43565b9142169160005b818110610b8257602084604051908152f35b80610b9a85610b946001948688612734565b356146e1565b01610b70565b60e07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257604051610bd6816120f5565b600435808252610be53661267c565b602083015260607fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c36011261019257604051610c208161212d565b60643560ff81168103610192578152608435602082015260a4356040820152604083015260c43573ffffffffffffffffffffffffffffffffffffffff8116810361019257610c7683826060610ca2960152614d30565b610c7e61262d565b610c873661267c565b610c90826122b0565b52610c9a816122b0565b5034926131ff565b005b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257610cf183913690600401611f43565b909234926000915b838310610d0257005b610d0d838588612599565b946080863603126101925760405195610d25876120f5565b803587528381013583811161019257810194601f9536878201121561019257610d5490369087813591016126c2565b9285890193845260408301358581116101925783019636908801121561019257863594610d80866121fd565b97610d8e604051998a612182565b868952878901886060809902830101913683116101925789808a9201925b848410610ef05750509050610dca915060408c01958a875201611f97565b94868b01958652519788518015918215610ee4575b5050610eba5760005b8851811015610e5057600190610e4a8c51610e03838d6122bd565b51610e0f848a516122bd565b5173ffffffffffffffffffffffffffffffffffffffff8b51169160405193610e36856120f5565b84528d84015260408301528a820152614d30565b01610de8565b50986001955081935090610eaa929a97610eb09592519073ffffffffffffffffffffffffffffffffffffffff8d7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8d01149451169161347c565b9061255d565b9501919493610cf9565b60046040517f947d5a84000000000000000000000000000000000000000000000000000000008152fd5b51141590508c80610ddf565b610efa3685612393565b815201910190898991610dac565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576020610f526004356000526001602052604060002054151590565b6040519015158152f35b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc6020813601126101925760043567ffffffffffffffff81116101925760c0816004019282360301126101925760405190610fb6826120f5565b82358252602481019182359167ffffffffffffffff83116101925760a461101691610fea61104695600436918401016122d1565b6020850152610ffc3660448301612393565b6040850152019161100c83611f97565b6060820152614973565b61102d611021612215565b936101ff36918761227d565b611036846122b0565b52611040836122b0565b506123d1565b9061104f612942565b5080519061105b612942565b60e0526110678261295c565b602060e05101526040517fa2ea7c6e0000000000000000000000000000000000000000000000000000000081528435600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa8015610a5d576000608052611737575b506080515115610a0e5790916110ff83612a7f565b60a05261110b8361295c565b60c0526000915b83831061113f5761112b3460c05160a05160805161376d565b60e0515260206102fb8160e05101516122b0565b61114983826122bd565b519067ffffffffffffffff6020830151168015159081611722575b506109cf57604060805101511580611715575b6109985760608201519467ffffffffffffffff6020840151169573ffffffffffffffffffffffffffffffffffffffff8451166040850151151590608086015192604051996111c48b612165565b60008b528b3560208c015267ffffffffffffffff421660408c015260608b0152600060808b015260a08a015260c089015273ffffffffffffffffffffffffffffffffffffffff861660e089015261010088015261012087015260005b602087015160c08801516112ee609d60e08b015160408c01518c60608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b51902080600052600160205260406000205415611314575060010163ffffffff16611220565b91959294969050818152816000526001602052604060002081518155602082015160018201556113eb6002820167ffffffffffffffff6040850151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff0000000000000000606088015160401b1692161717815567ffffffffffffffff6080850151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a082015160038201556004810173ffffffffffffffffffffffffffffffffffffffff60c0840151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005810173ffffffffffffffffffffffffffffffffffffffff60e0840151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff0000000000000000000000000000000000000000610100870151151560a01b1692161717905561012082015180519067ffffffffffffffff8211610969576114cb600684015461278f565b601f81116116ce575b50602090601f83116001146116045760069291600091836115f9575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b6060840151806115d7575b5060019373ffffffffffffffffffffffffffffffffffffffff916115548560a0516122bd565b526115618460a0516122bd565b5060a08101516115738560c0516122bd565b528261158585602060e05101516122bd565b525116906040519081528735917f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35602073ffffffffffffffffffffffffffffffffffffffff8a1693a401919290611112565b6115ee906000526001602052604060002054151590565b156107e3578861152e565b015190508c806114f0565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0851681106116b65750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0600697161061167f575b505050811b01910155611523565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c191690558c8080611671565b91926020600181928685015181550194019201611615565b600684016000526020600020601f840160051c81016020851061170e575b601f830160051c820181106117025750506114d4565b600081556001016116ec565b50806116ec565b5060408201511515611177565b905067ffffffffffffffff4216101587611164565b61174b903d806000833e610a4e8183612182565b608052846110ea565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576004356000526002602052602067ffffffffffffffff60406000205416604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602067ffffffffffffffff4216610b118160043533614787565b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760206040517fa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a996508152f35b346101925760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925773ffffffffffffffffffffffffffffffffffffffff611896611f74565b1660005260036020526040600020602435600052602052602067ffffffffffffffff60406000205416604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610192576118fe612744565b50600435600052600160205261018e61191a60406000206127e2565b604051918291602083526020830190612059565b60207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760043567ffffffffffffffff811161019257611978903690600401611f43565b90611982826123f2565b9160009134906000925b8084106119ac5761018e6119a08688614674565b60405191829182611fb8565b909192936119bb858385612599565b6119c86020820182612499565b9081158015611b3c575b610eba57908691600090898760608701968035945b868110611a6f57505093611a3f93611a396001999894611a31602099957fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff611a489a0114966123d1565b9336916124ed565b90612aec565b9687519061255d565b95018051611a56888a6122bd565b52611a6187896122bd565b50515101940192919061198c565b9250929394955050611a868160051b84018461227d565b90611a9460408401846125d9565b821015611b0d5760019273ffffffffffffffffffffffffffffffffffffffff611aff92611aef611ac38c6123d1565b91611ade60405195611ad4876120f5565b8c875236906122d1565b602086015236906060880201612393565b6040840152166060820152614973565b01878a959493928c926119e7565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b50611b4a60408401846125d9565b90508214156119d2565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257602067ffffffffffffffff4216610b11816004356146e1565b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff9060043582811161019257611be9903690600401611f43565b929091600090345b858310611bfa57005b611c05838787612459565b828101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181121561019257810191823592868411610192578401928060061b360384136101925760019382610eaa92611c9695611c8f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8e018b1494339336916126c2565b903561347c565b920191611bf1565b60607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257610ca2611cd361262d565b611cdc3661267c565b611ce5826122b0565b52611cef816122b0565b50349033906004356131ff565b6020807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925760043567ffffffffffffffff811161019257611d47903690600401611f43565b611d53819392936123f2565b92600092346000937fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8101905b808610611d945761018e6119a0888a614674565b90919293949560019085611dd6611a3f8a8888611db2838a8f612459565b611dcf611dc188830183612499565b9390951494339336916124ed565b9035612aec565b95018051611de48a8c6122bd565b52611def898b6122bd565b5051510196019493929190611d80565b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925773ffffffffffffffffffffffffffffffffffffffff611e4b611f74565b1660005260006020526020604060002054604051908152f35b346101925760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101925767ffffffffffffffff60043581811161019257611eb4903690600401611f43565b9142169160005b818110611ecd57602084604051908152f35b80611ee685611edf6001948688612734565b3533614787565b01611ebb565b346101925760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261019257807fdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de6160209252f35b9181601f840112156101925782359167ffffffffffffffff8311610192576020808501948460051b01011161019257565b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361019257565b359073ffffffffffffffffffffffffffffffffffffffff8216820361019257565b6020908160408183019282815285518094520193019160005b828110611fdf575050505090565b835185529381019392810192600101611fd1565b60005b8381106120065750506000910152565b8181015183820152602001611ff6565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f60209361205281518092818752878088019101611ff3565b0116010190565b906120f291805182526020810151602083015267ffffffffffffffff806040830151166040840152806060830151166060840152608082015116608083015260a081015160a083015273ffffffffffffffffffffffffffffffffffffffff8060c08301511660c084015260e08201511660e083015261010080820151151590830152610120809101519161014080928201520190612016565b90565b6080810190811067ffffffffffffffff82111761096957604052565b60c0810190811067ffffffffffffffff82111761096957604052565b6060810190811067ffffffffffffffff82111761096957604052565b6040810190811067ffffffffffffffff82111761096957604052565b610140810190811067ffffffffffffffff82111761096957604052565b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff82111761096957604052565b67ffffffffffffffff811161096957601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200190565b67ffffffffffffffff81116109695760051b60200190565b60409081519161222483612149565b60018352829160005b6020808210156122755783516020929161224682612111565b6000825260008183015260008683015260606000818401526080830152600060a083015282880101520161222d565b505091925050565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff4181360301821215610192570190565b805115611b0d5760200190565b8051821015611b0d5760209160051b010190565b91909160c08184031261019257604051906122eb82612111565b81936122f682611f97565b835260209167ffffffffffffffff8184013581811681036101925784860152604082013580151581036101925760408601526060820135606086015260808201359081116101925781019180601f8401121561019257823592612358846121c3565b916123666040519384612182565b84835285858301011161019257848460a09695879660009401838601378301015260808501520135910152565b9190826060910312610192576040516123ab8161212d565b8092803560ff811681036101925760409182918452602081013560208501520135910152565b3573ffffffffffffffffffffffffffffffffffffffff811681036101925790565b906123fc826121fd565b6124096040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe061243782946121fd565b019060005b82811061244857505050565b80606060208093850101520161243c565b9190811015611b0d5760051b810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc181360301821215610192570190565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301821215610192570180359067ffffffffffffffff821161019257602001918160051b3603831361019257565b929190926124fa846121fd565b916125086040519384612182565b829480845260208094019060051b8301928284116101925780915b84831061253257505050505050565b823567ffffffffffffffff811161019257869161255286849386016122d1565b815201920191612523565b9190820391821161256a57565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b9190811015611b0d5760051b810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8181360301821215610192570190565b9035907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301821215610192570180359067ffffffffffffffff82116101925760200191606082023603831361019257565b60409081519161263c83612149565b600183528291600091825b6020808210156126735782516020929161266082612149565b8682528681830152828901015201612647565b50505091925050565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdc604091011261019257604051906126b382612149565b60243582526044356020830152565b9291926126ce826121fd565b6040926126dd84519283612182565b819581835260208093019160061b84019381851161019257915b84831061270657505050505050565b858383031261019257838691825161271d81612149565b8535815282860135838201528152019201916126f7565b9190811015611b0d5760051b0190565b6040519061275182612165565b606061012083600080825280602083015280604083015280848301528060808301528060a08301528060c08301528060e08301526101008201520152565b90600182811c921680156127d8575b60208310146127a957565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b91607f169161279e565b90604051916127f083612165565b828154815260016006818401549360209485850152600281015467ffffffffffffffff908181166040870152818160401c16606087015260801c166080850152600381015460a085015260ff73ffffffffffffffffffffffffffffffffffffffff8060048401541660c0870152600583015490811660e087015260a01c161515610100850152019060405193849260009281549161288d8361278f565b8087529282811690811561290257506001146128bc575b5050505061012092916128b8910384612182565b0152565b60009081528381209695945091905b8183106128ea575093945091925090820101816128b8610120386128a4565b865488840185015295860195879450918301916128cb565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001685880152505050151560051b8301019050816128b8610120386128a4565b6040519061294f82612149565b6060602083600081520152565b90612966826121fd565b6129736040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06129a182946121fd565b0190602036910137565b5190811515820361019257565b906020808383031261019257825167ffffffffffffffff9384821161019257019260808484031261019257604051936129f0856120f5565b805185528281015173ffffffffffffffffffffffffffffffffffffffff811681036101925783860152612a25604082016129ab565b60408601526060810151918211610192570182601f8201121561019257805190612a4e826121c3565b93612a5c6040519586612182565b8285528383830101116101925782612a779385019101611ff3565b606082015290565b90612a89826121fd565b612a966040519182612182565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0612ac482946121fd565b019060005b828110612ad557505050565b602090612ae0612744565b82828501015201612ac9565b9290949391612af9612942565b50855193612b05612942565b94612b0f8161295c565b6020870152604051907fa2ea7c6e00000000000000000000000000000000000000000000000000000000825282600483015260008260248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa918215610a5d576000926131e2575b50815115610a0e5792979091612ba484612a7f565b98612bae8561295c565b946000935b818510612bd057505050505095612bcb9495966139d4565b815290565b91959398949699909297612be48a846122bd565b519a67ffffffffffffffff60208d01511680151590816131cd575b506109cf57604089015115806131c0575b61099857899860608d01518d602081015167ffffffffffffffff1691815173ffffffffffffffffffffffffffffffffffffffff1690604083015115159260800151936040519e8f90612c6182612165565b6000825260208201524267ffffffffffffffff166040820152606001528d608081016000905260a0015260c08d015273ffffffffffffffffffffffffffffffffffffffff8b1660e08d01526101008c01526101208b015260005b60208b01518b612d8c609d60c08301519260e08101519060408101519060608101519161010082015115159061012060a084015193015193604051988996602088019b8c527fffffffffffffffffffffffffffffffffffffffff000000000000000000000000809260601b16604089015260601b1660548701527fffffffffffffffff000000000000000000000000000000000000000000000000809260c01b16606887015260c01b16607085015260f81b6078840152607983015280516104a38160999360208587019101611ff3565b51902080600052600160205260406000205415612db2575060010163ffffffff16612cbb565b90509d979b9199929a949d9c909698939c8084528060005260016020526040600020918451835560208501516001840155612e946002840167ffffffffffffffff6040880151168154907fffffffffffffffffffffffffffffffff000000000000000000000000000000006fffffffffffffffff000000000000000060608b015160401b1692161717815567ffffffffffffffff6080880151167fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff77ffffffffffffffff0000000000000000000000000000000083549260801b169116179055565b60a085015160038401556004830173ffffffffffffffffffffffffffffffffffffffff60c0870151167fffffffffffffffffffffffff00000000000000000000000000000000000000008254161790556005830173ffffffffffffffffffffffffffffffffffffffff60e0870151168154907fffffffffffffffffffffff00000000000000000000000000000000000000000074ff00000000000000000000000000000000000000006101008a0151151560a01b1692161717905561012085015192835167ffffffffffffffff8111610969578894612f76600684015461278f565b601f8111613165575b50602090601f831160011461309857600692916000918361308d575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8260011b9260031b1c1916179101555b8d8b8b606084015180613060575b5086602073ffffffffffffffffffffffffffffffffffffffff95948794610765848660019e61075f8361300e9a6122bd565b5251166040519182527f8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35602073ffffffffffffffffffffffffffffffffffffffff881693a4019290919293949a612bb3565b9250505061307d9193506000526001602052604060002054151590565b156107e35785918d8b8b38612fdc565b015190503880612f9b565b906006840160005260206000209160005b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08516811061314a5750918391600193837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06006971610613113575b505050811b01910155612fce565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080613105565b8183015184558c9850600190930192602092830192016130a9565b90919293949550600684016000526020600020601f840160051c8101602085106131b9575b908b979695949392915b601f830160051c820181106131aa575050612f7f565b600081558c9850600101613194565b508061318a565b5060408c01511515612c10565b905067ffffffffffffffff4216101538612bff565b6131f89192503d806000833e610a4e8183612182565b9038612b8f565b939291936040517fa2ea7c6e00000000000000000000000000000000000000000000000000000000815281600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa908115610a5d57600091613461575b50805115610a0e57825161329081612a7f565b9261329a8261295c565b9460005b8381106132b457505050506120f2949550613bb5565b6132be81836122bd565b5190815160005260016020526040600020918254156107e35784600184015403610a0e57600583015473ffffffffffffffffffffffffffffffffffffffff8d1673ffffffffffffffffffffffffffffffffffffffff8216036134375760a01c60ff16156109985767ffffffffffffffff600284015460801c1661340d576002830180547fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff164260801b77ffffffffffffffff00000000000000000000000000000000161790556001928c91613392826127e2565b61339c858c6122bd565b526133a7848b6122bd565b5060208101516133b7858d6122bd565b527ff930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615602073ffffffffffffffffffffffffffffffffffffffff87816004870154169451950154956040519586521693a40161329e565b60046040517f905e7107000000000000000000000000000000000000000000000000000000008152fd5b60046040517f4ca88867000000000000000000000000000000000000000000000000000000008152fd5b61347691503d806000833e610a4e8183612182565b3861327d565b90949392916040517fa2ea7c6e00000000000000000000000000000000000000000000000000000000815282600482015260008160248173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000165afa908115610a5d5760009161369e575b50805115610a0e57865161350e81612a7f565b926135188261295c565b9460005b83811061353257505050506120f2959650613db4565b61353c818c6122bd565b5190815160005260016020526040600020918254156107e35783600184015403610a0e57600583015473ffffffffffffffffffffffffffffffffffffffff861673ffffffffffffffffffffffffffffffffffffffff8216036134375760a01c60ff16156109985767ffffffffffffffff600284015460801c1661340d576002830180547fffffffffffffffff0000000000000000ffffffffffffffffffffffffffffffff164260801b77ffffffffffffffff000000000000000000000000000000001617905560019261360e816127e2565b613618848b6122bd565b52613623838a6122bd565b506020820151613633848c6122bd565b528373ffffffffffffffffffffffffffffffffffffffff6004830154169251910154916040519182527ff930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615602073ffffffffffffffffffffffffffffffffffffffff891693a40161351c565b6136b391503d806000833e610a4e8183612182565b386134fb565b60408101906040815282518092526060810160608360051b830101926020809501916000905b82821061372257505050508281830391015281808451928381520193019160005b82811061370e575050505090565b835185529381019392810192600101613700565b9091929594858061375d837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa089600196030186528a51612059565b97980194939190910191016136df565b9092918351936001908186146139b35773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613983579560009687915b80831061387557505050918392916137f09492876040518097819582947f91db0b7e000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d5760009161383e575b50905015613814576120f290614545565b60046040517fe8bee839000000000000000000000000000000000000000000000000000000008152fd5b82813d831161386e575b6138528183612182565b8101031261386b5750613864906129ab565b8038613803565b80fd5b503d613848565b9091979661388389876122bd565b51801515806138fd575b6138d3578181116138a9578084920398019801909190916137a7565b60046040517f11011294000000000000000000000000000000000000000000000000000000008152fd5b60046040517f1574f9f3000000000000000000000000000000000000000000000000000000008152fd5b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613944575b501561388d565b908982813d8311613972575b61395a8183612182565b8101031261386b575061396c906129ab565b3861393d565b503d613950565b513d6000823e3d90fd5b9594505050905060005b82811061399d5750505050600090565b6139a781836122bd565b516138d357830161398d565b6120f295506139cd91506139c6906122b0565b51916122b0565b5191613f8c565b909391845194600190818714613b985773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613b67579660009788915b808310613ab75750505091839291613a579492886040518097819582947f91db0b7e000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613a83575b5090501561381457613a7a575090565b6120f290614545565b82813d8311613ab0575b613a978183612182565b8101031261386b5750613aa9906129ab565b8038613a6a565b503d613a8d565b90919897613ac58a876122bd565b5180151580613aeb575b6138d3578181116138a957808492039901990190919091613a0e565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613b32575b5015613acf565b908982813d8311613b60575b613b488183612182565b8101031261386b5750613b5a906129ab565b38613b2b565b503d613b3e565b969550505091505060005b828110613b825750505050600090565b613b8c81836122bd565b516138d3578301613b72565b6120f29650613bae91506139c6909594956122b0565b5191614113565b909291835193600190818614613d9a5773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613d6a579560009687915b808310613cba5750505091839291613c389492876040518097819582947f88e5b2d9000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613c86575b50905015613c5c576120f290614545565b60046040517fbf2f3a8b000000000000000000000000000000000000000000000000000000008152fd5b82813d8311613cb3575b613c9a8183612182565b8101031261386b5750613cac906129ab565b8038613c4b565b503d613c90565b90919796613cc889876122bd565b5180151580613cee575b6138d3578181116138a957808492039801980190919091613bef565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613d35575b5015613cd2565b908982813d8311613d63575b613d4b8183612182565b8101031261386b5750613d5d906129ab565b38613d2e565b503d613d41565b9594505050905060005b828110613d845750505050600090565b613d8e81836122bd565b516138d3578301613d74565b6120f29550613dad91506139c6906122b0565b519161427b565b909391845194600190818714613f6f5773ffffffffffffffffffffffffffffffffffffffff60208095015116918215613f3e579660009788915b808310613e8e5750505091839291613e379492886040518097819582947f88e5b2d9000000000000000000000000000000000000000000000000000000008452600484016136b9565b03925af1908115610a5d57600091613e5a575b50905015613c5c57613a7a575090565b82813d8311613e87575b613e6e8183612182565b8101031261386b5750613e80906129ab565b8038613e4a565b503d613e64565b90919897613e9c8a876122bd565b5180151580613ec2575b6138d3578181116138a957808492039901990190919091613dee565b50604080517fce46e04600000000000000000000000000000000000000000000000000000000815289816004818b5afa9182156139795750600091613f09575b5015613ea6565b908982813d8311613f37575b613f1f8183612182565b8101031261386b5750613f31906129ab565b38613f02565b503d613f15565b969550505091505060005b828110613f595750505050600090565b613f6381836122bd565b516138d3578301613f49565b6120f29650613f8591506139c6909594956122b0565b51916143f5565b92919273ffffffffffffffffffffffffffffffffffffffff602080920151168015614106578415158061408c575b6138d3578385116138a957614008829186946040519586809481937fe60c35050000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614058575b5090501561402e57816120f29103614545565b60046040517fbd8ba84d000000000000000000000000000000000000000000000000000000008152fd5b82813d8311614085575b61406c8183612182565b8101031261386b575061407e906129ab565b803861401b565b503d614062565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d576000916140d1575b5015613fba565b908382813d83116140ff575b6140e78183612182565b8101031261386b57506140f9906129ab565b386140ca565b503d6140dd565b505050506138d357600090565b93919373ffffffffffffffffffffffffffffffffffffffff60208092015116801561426d57851515806141f3575b6138d3578486116138a95761418f829187946040519586809481937fe60c35050000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d576000916141bf575b5090501561402e5782906141b557505090565b6120f29103614545565b82813d83116141ec575b6141d38183612182565b8101031261386b57506141e5906129ab565b80386141a2565b503d6141c9565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d57600091614238575b5015614141565b908382813d8311614266575b61424e8183612182565b8101031261386b5750614260906129ab565b38614231565b503d614244565b50505050506138d357600090565b92919273ffffffffffffffffffffffffffffffffffffffff602080920151168015614106578415158061437b575b6138d3578385116138a9576142f7829186946040519586809481937fe49617e10000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614347575b5090501561431d57816120f29103614545565b60046040517fccf3bb27000000000000000000000000000000000000000000000000000000008152fd5b82813d8311614374575b61435b8183612182565b8101031261386b575061436d906129ab565b803861430a565b503d614351565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d576000916143c0575b50156142a9565b908382813d83116143ee575b6143d68183612182565b8101031261386b57506143e8906129ab565b386143b9565b503d6143cc565b93919373ffffffffffffffffffffffffffffffffffffffff60208092015116801561426d57851515806144cb575b6138d3578486116138a957614471829187946040519586809481937fe49617e10000000000000000000000000000000000000000000000000000000083528760048401526024830190612059565b03925af1908115610a5d57600091614497575b5090501561431d5782906141b557505090565b82813d83116144c4575b6144ab8183612182565b8101031261386b57506144bd906129ab565b8038614484565b503d6144a1565b506040517fce46e0460000000000000000000000000000000000000000000000000000000081528281600481855afa908115610a5d57600091614510575b5015614423565b908382813d831161453e575b6145268183612182565b8101031261386b5750614538906129ab565b38614509565b503d61451c565b8061454d5750565b80471061461657600080808093335af13d15614611573d61456d816121c3565b9061457b6040519283612182565b8152600060203d92013e5b1561458d57565b60846040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152603a60248201527f416464726573733a20756e61626c6520746f2073656e642076616c75652c207260448201527f6563697069656e74206d617920686176652072657665727465640000000000006064820152fd5b614586565b60646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f416464726573733a20696e73756666696369656e742062616c616e63650000006044820152fd5b9061467e9061295c565b60009283925b80518410156146d9579361469884866122bd565b519160005b83518110156146c8576146b081856122bd565b516146bb84876122bd565b526001928301920161469d565b509094600190940193909150614684565b509250905090565b6000818152600260205267ffffffffffffffff908160408220541661475d577f5aafceeb1c7ad58e4a84898bdee37c02c0fc46e7d24e6b60e8209449f183459f91838252600260205260408220941693847fffffffffffffffffffffffffffffffffffffffffffffffff000000000000000082541617905580a3565b60046040517f2e267946000000000000000000000000000000000000000000000000000000008152fd5b73ffffffffffffffffffffffffffffffffffffffff166000818152600360205260408120908381528160205267ffffffffffffffff80604083205416614822577f92a1f7a41a7c585a8b09e25b195e225b1d43248daca46b0faf9e0792777a22299285835260205260408220951694857fffffffffffffffffffffffffffffffffffffffffffffffff000000000000000082541617905580a4565b60046040517fec9d6eeb000000000000000000000000000000000000000000000000000000008152fd5b73ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001630148061494a575b156148b4577f000000000000000000000000000000000000000000000000000000000000000090565b60405160208101907f000000000000000000000000000000000000000000000000000000000000000082527f000000000000000000000000000000000000000000000000000000000000000060408201527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260a0815261494481612111565b51902090565b507f0000000000000000000000000000000000000000000000000000000000000000461461488b565b6020908181015190604080938183015192606081019173ffffffffffffffffffffffffffffffffffffffff948584511660005260008252846000209283549360018501905551928688511667ffffffffffffffff988985820151168882015115159060806060840151930151878151910120938a5198888a019b7fdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de618d528a01526060890152608088015260a087015260c086015260e0850152610100908185015283526101208301968388109088111761096957614a5e8695614a7294614a7a998b52519020614ce4565b918860ff8351169183015192015192614c48565b949094614aaf565b5116911603614a865750565b600490517f8baa579f000000000000000000000000000000000000000000000000000000008152fd5b6005811015614c195780614ac05750565b60018103614b265760646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f45434453413a20696e76616c6964207369676e617475726500000000000000006044820152fd5b60028103614b8c5760646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f45434453413a20696e76616c6964207369676e6174757265206c656e677468006044820152fd5b600314614b9557565b60846040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202773272076616c60448201527f75650000000000000000000000000000000000000000000000000000000000006064820152fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fd5b9291907f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08311614cd85791608094939160ff602094604051948552168484015260408301526060820152600093849182805260015afa15614ccb57815173ffffffffffffffffffffffffffffffffffffffff811615614cc5579190565b50600190565b50604051903d90823e3d90fd5b50505050600090600390565b614cec61484c565b906040519060208201927f190100000000000000000000000000000000000000000000000000000000000084526022830152604282015260428152614944816120f5565b602081015160409182810151916060820173ffffffffffffffffffffffffffffffffffffffff9283825116600052600060205285600020908154916001830190555192519086519160208301947fa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650865288840152606083015260808201526080815260a081019481861067ffffffffffffffff87111761096957614de18594614a7293614a7a988a52519020614ce4565b9060ff81511688602083015192015192614c4856fea164736f6c6343000812000a",
        "devdoc": {
          "events": {
            "Attested(address,address,bytes32,bytes32)": {
              "details": "Emitted when an attestation has been made.",
              "params": {
                "attester": "The attesting account.",
                "recipient": "The recipient of the attestation.",
                "schema": "The UID of the schema.",
                "uid": "The UID the revoked attestation."
              }
            },
            "Revoked(address,address,bytes32,bytes32)": {
              "details": "Emitted when an attestation has been revoked.",
              "params": {
                "attester": "The attesting account.",
                "recipient": "The recipient of the attestation.",
                "schema": "The UID of the schema.",
                "uid": "The UID the revoked attestation."
              }
            },
            "RevokedOffchain(address,bytes32,uint64)": {
              "details": "Emitted when a data has been revoked.",
              "params": {
                "data": "The data.",
                "revoker": "The address of the revoker.",
                "timestamp": "The timestamp."
              }
            },
            "Timestamped(bytes32,uint64)": {
              "details": "Emitted when a data has been timestamped.",
              "params": {
                "data": "The data.",
                "timestamp": "The timestamp."
              }
            }
          },
          "kind": "dev",
          "methods": {
            "attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))": {
              "details": "Attests to a specific schema.",
              "params": {
                "request": "The arguments of the attestation request. Example: attest({     schema: \"0facc36681cbe2456019c1b0d1e7bedd6d1d40f6f324bf3dd3a4cef2999200a0\",     data: {         recipient: \"0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf\",         expirationTime: 0,         revocable: true,         refUID: \"0x0000000000000000000000000000000000000000000000000000000000000000\",         data: \"0xF00D\",         value: 0     } })"
              },
              "returns": {
                "_0": "The UID of the new attestation."
              }
            },
            "attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address))": {
              "details": "Attests to a specific schema via the provided EIP712 signature.",
              "params": {
                "delegatedRequest": "The arguments of the delegated attestation request. Example: attestByDelegation({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 0     },     signature: {         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e' })"
              },
              "returns": {
                "_0": "The UID of the new attestation."
              }
            },
            "constructor": {
              "details": "Creates a new EAS instance.",
              "params": {
                "registry": "The address of the global schema registry."
              }
            },
            "getAttestation(bytes32)": {
              "details": "Returns an existing attestation by UID.",
              "params": {
                "uid": "The UID of the attestation to retrieve."
              },
              "returns": {
                "_0": "The attestation data members."
              }
            },
            "getDomainSeparator()": {
              "details": "Returns the domain separator used in the encoding of the signatures for attest, and revoke."
            },
            "getNonce(address)": {
              "details": "Returns the current nonce per-account.",
              "params": {
                "account": "The requested account."
              },
              "returns": {
                "_0": "The current nonce."
              }
            },
            "getRevokeOffchain(address,bytes32)": {
              "details": "Returns the timestamp that the specified data was timestamped with.",
              "params": {
                "data": "The data to query."
              },
              "returns": {
                "_0": "The timestamp the data was timestamped with."
              }
            },
            "getSchemaRegistry()": {
              "details": "Returns the address of the global schema registry.",
              "returns": {
                "_0": "The address of the global schema registry."
              }
            },
            "getTimestamp(bytes32)": {
              "details": "Returns the timestamp that the specified data was timestamped with.",
              "params": {
                "data": "The data to query."
              },
              "returns": {
                "_0": "The timestamp the data was timestamped with."
              }
            },
            "isAttestationValid(bytes32)": {
              "details": "Checks whether an attestation exists.",
              "params": {
                "uid": "The UID of the attestation to retrieve."
              },
              "returns": {
                "_0": "Whether an attestation exists."
              }
            },
            "multiAttest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[])[])": {
              "details": "Attests to multiple schemas.",
              "params": {
                "multiRequests": "The arguments of the multi attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiAttest([{     schema: '0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd',     data: [{         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 1000     },     {         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 0,         revocable: false,         refUID: '0x480df4a039efc31b11bfdf491b383ca138b6bde160988222a2a3509c02cee174',         data: '0x00',         value: 0     }], }, {     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',     data: [{         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 0,         revocable: true,         refUID: '0x75bf2ed8dca25a8190c50c52db136664de25b2449535839008ccfdab469b214f',         data: '0x12345678',         value: 0     }, }])"
              },
              "returns": {
                "_0": "The UIDs of the new attestations."
              }
            },
            "multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address)[])": {
              "details": "Attests to multiple schemas using via provided EIP712 signatures.",
              "params": {
                "multiDelegatedRequests": "The arguments of the delegated multi attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiAttestByDelegation([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',         expirationTime: 1673891048,         revocable: true,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x1234',         value: 0     },     {         recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',         expirationTime: 0,         revocable: false,         refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',         data: '0x00',         value: 0     }],     signatures: [{         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     {         v: 28,         r: '0x487s...67bb',         s: '0x12ad...2366'     }],     attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4' }])"
              },
              "returns": {
                "_0": "The UIDs of the new attestations."
              }
            },
            "multiRevoke((bytes32,(bytes32,uint256)[])[])": {
              "details": "Revokes existing attestations to multiple schemas.",
              "params": {
                "multiRequests": "The arguments of the multi revocation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiRevoke([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',         value: 1000     },     {         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',         value: 0     }], }, {     schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',     data: [{         uid: '0x053d42abce1fd7c8fcddfae21845ad34dae287b2c326220b03ba241bc5a8f019',         value: 0     }, }])"
              }
            },
            "multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address)[])": {
              "details": "Revokes existing attestations to multiple schemas via provided EIP712 signatures.",
              "params": {
                "multiDelegatedRequests": "The arguments of the delegated multi revocation attestation requests. The requests should be grouped by distinct schema ids to benefit from the best batching optimization. Example: multiRevokeByDelegation([{     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: [{         uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',         value: 1000     },     {         uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',         value: 0     }],     signatures: [{         v: 28,         r: '0x148c...b25b',         s: '0x5a72...be22'     },     {         v: 28,         r: '0x487s...67bb',         s: '0x12ad...2366'     }],     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992' }])"
              }
            },
            "multiRevokeOffchain(bytes32[])": {
              "details": "Revokes the specified multiple bytes32 data.",
              "params": {
                "data": "The data to timestamp."
              },
              "returns": {
                "_0": "The timestamp the data was revoked with."
              }
            },
            "multiTimestamp(bytes32[])": {
              "details": "Timestamps the specified multiple bytes32 data.",
              "params": {
                "data": "The data to timestamp."
              },
              "returns": {
                "_0": "The timestamp the data was timestamped with."
              }
            },
            "revoke((bytes32,(bytes32,uint256)))": {
              "details": "Revokes an existing attestation to a specific schema. Example: revoke({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         uid: '0x101032e487642ee04ee17049f99a70590c735b8614079fc9275f9dd57c00966d',         value: 0     } })",
              "params": {
                "request": "The arguments of the revocation request."
              }
            },
            "revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address))": {
              "details": "Revokes an existing attestation to a specific schema via the provided EIP712 signature. Example: revokeByDelegation({     schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',     data: {         uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',         value: 0     },     signature: {         v: 27,         r: '0xb593...7142',         s: '0x0f5b...2cce'     },     revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992' })",
              "params": {
                "delegatedRequest": "The arguments of the delegated revocation request."
              }
            },
            "revokeOffchain(bytes32)": {
              "details": "Revokes the specified bytes32 data.",
              "params": {
                "data": "The data to timestamp."
              },
              "returns": {
                "_0": "The timestamp the data was revoked with."
              }
            },
            "timestamp(bytes32)": {
              "details": "Timestamps the specified bytes32 data.",
              "params": {
                "data": "The data to timestamp."
              },
              "returns": {
                "_0": "The timestamp the data was timestamped with."
              }
            }
          },
          "title": "EAS - Ethereum Attestation Service",
          "version": 1
        },
        "userdoc": {
          "kind": "user",
          "methods": {
            "getAttestTypeHash()": {
              "notice": "Returns the EIP712 type hash for the attest function."
            },
            "getRevokeTypeHash()": {
              "notice": "Returns the EIP712 type hash for the revoke function."
            }
          },
          "version": 1
        },
        "storageLayout": {
          "storage": [
            {
              "astId": 3790,
              "contract": "contracts/EAS.sol:EAS",
              "label": "_nonces",
              "offset": 0,
              "slot": "0",
              "type": "t_mapping(t_address,t_uint256)"
            },
            {
              "astId": 1977,
              "contract": "contracts/EAS.sol:EAS",
              "label": "_db",
              "offset": 0,
              "slot": "1",
              "type": "t_mapping(t_bytes32,t_struct(Attestation)4348_storage)"
            },
            {
              "astId": 1981,
              "contract": "contracts/EAS.sol:EAS",
              "label": "_timestamps",
              "offset": 0,
              "slot": "2",
              "type": "t_mapping(t_bytes32,t_uint64)"
            },
            {
              "astId": 1987,
              "contract": "contracts/EAS.sol:EAS",
              "label": "_revocationsOffchain",
              "offset": 0,
              "slot": "3",
              "type": "t_mapping(t_address,t_mapping(t_bytes32,t_uint64))"
            }
          ],
          "types": {
            "t_address": {
              "encoding": "inplace",
              "label": "address",
              "numberOfBytes": "20"
            },
            "t_bool": {
              "encoding": "inplace",
              "label": "bool",
              "numberOfBytes": "1"
            },
            "t_bytes32": {
              "encoding": "inplace",
              "label": "bytes32",
              "numberOfBytes": "32"
            },
            "t_bytes_storage": {
              "encoding": "bytes",
              "label": "bytes",
              "numberOfBytes": "32"
            },
            "t_mapping(t_address,t_mapping(t_bytes32,t_uint64))": {
              "encoding": "mapping",
              "key": "t_address",
              "label": "mapping(address => mapping(bytes32 => uint64))",
              "numberOfBytes": "32",
              "value": "t_mapping(t_bytes32,t_uint64)"
            },
            "t_mapping(t_address,t_uint256)": {
              "encoding": "mapping",
              "key": "t_address",
              "label": "mapping(address => uint256)",
              "numberOfBytes": "32",
              "value": "t_uint256"
            },
            "t_mapping(t_bytes32,t_struct(Attestation)4348_storage)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => struct Attestation)",
              "numberOfBytes": "32",
              "value": "t_struct(Attestation)4348_storage"
            },
            "t_mapping(t_bytes32,t_uint64)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => uint64)",
              "numberOfBytes": "32",
              "value": "t_uint64"
            },
            "t_struct(Attestation)4348_storage": {
              "encoding": "inplace",
              "label": "struct Attestation",
              "members": [
                {
                  "astId": 4329,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "uid",
                  "offset": 0,
                  "slot": "0",
                  "type": "t_bytes32"
                },
                {
                  "astId": 4331,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "schema",
                  "offset": 0,
                  "slot": "1",
                  "type": "t_bytes32"
                },
                {
                  "astId": 4333,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "time",
                  "offset": 0,
                  "slot": "2",
                  "type": "t_uint64"
                },
                {
                  "astId": 4335,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "expirationTime",
                  "offset": 8,
                  "slot": "2",
                  "type": "t_uint64"
                },
                {
                  "astId": 4337,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "revocationTime",
                  "offset": 16,
                  "slot": "2",
                  "type": "t_uint64"
                },
                {
                  "astId": 4339,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "refUID",
                  "offset": 0,
                  "slot": "3",
                  "type": "t_bytes32"
                },
                {
                  "astId": 4341,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "recipient",
                  "offset": 0,
                  "slot": "4",
                  "type": "t_address"
                },
                {
                  "astId": 4343,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "attester",
                  "offset": 0,
                  "slot": "5",
                  "type": "t_address"
                },
                {
                  "astId": 4345,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "revocable",
                  "offset": 20,
                  "slot": "5",
                  "type": "t_bool"
                },
                {
                  "astId": 4347,
                  "contract": "contracts/EAS.sol:EAS",
                  "label": "data",
                  "offset": 0,
                  "slot": "6",
                  "type": "t_bytes_storage"
                }
              ],
              "numberOfBytes": "224"
            },
            "t_uint256": {
              "encoding": "inplace",
              "label": "uint256",
              "numberOfBytes": "32"
            },
            "t_uint64": {
              "encoding": "inplace",
              "label": "uint64",
              "numberOfBytes": "8"
            }
          }
        }
      },
      SchemaRegistry: {
        "address": "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
        "abi": [
          {
            "inputs": [],
            "name": "AlreadyExists",
            "type": "error"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              },
              {
                "indexed": false,
                "internalType": "address",
                "name": "registerer",
                "type": "address"
              }
            ],
            "name": "Registered",
            "type": "event"
          },
          {
            "inputs": [],
            "name": "VERSION",
            "outputs": [
              {
                "internalType": "string",
                "name": "",
                "type": "string"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              }
            ],
            "name": "getSchema",
            "outputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "uid",
                    "type": "bytes32"
                  },
                  {
                    "internalType": "contract ISchemaResolver",
                    "name": "resolver",
                    "type": "address"
                  },
                  {
                    "internalType": "bool",
                    "name": "revocable",
                    "type": "bool"
                  },
                  {
                    "internalType": "string",
                    "name": "schema",
                    "type": "string"
                  }
                ],
                "internalType": "struct SchemaRecord",
                "name": "",
                "type": "tuple"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "string",
                "name": "schema",
                "type": "string"
              },
              {
                "internalType": "contract ISchemaResolver",
                "name": "resolver",
                "type": "address"
              },
              {
                "internalType": "bool",
                "name": "revocable",
                "type": "bool"
              }
            ],
            "name": "register",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "function"
          }
        ],
        "transactionHash": "0x731c2d25800a3e44a5f080d9acf8079949991271a9ae52c470662fe96835d667",
        "receipt": {
          "to": null,
          "from": "0x01a93612f26100B6E18a2e3dd57df5c3ccaFeca1",
          "contractAddress": "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
          "transactionIndex": 3,
          "gasUsed": "477737",
          "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          "blockHash": "0x931e77b81f334ea2fa8cc283b0637457523379a317555dfddad312996fac0c85",
          "transactionHash": "0x731c2d25800a3e44a5f080d9acf8079949991271a9ae52c470662fe96835d667",
          "logs": [],
          "blockNumber": 2958569,
          "cumulativeGasUsed": "29612372",
          "status": 1,
          "byzantium": true
        },
        "args": [],
        "numDeployments": 1,
        "solcInputHash": "78891d974a28827b8f023101fe409776",
        "metadata": "{\"compiler\":{\"version\":\"0.8.18+commit.87f61d96\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[],\"name\":\"AlreadyExists\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"registerer\",\"type\":\"address\"}],\"name\":\"Registered\",\"type\":\"event\"},{\"inputs\":[],\"name\":\"VERSION\",\"outputs\":[{\"internalType\":\"string\",\"name\":\"\",\"type\":\"string\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"}],\"name\":\"getSchema\",\"outputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"contract ISchemaResolver\",\"name\":\"resolver\",\"type\":\"address\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"string\",\"name\":\"schema\",\"type\":\"string\"}],\"internalType\":\"struct SchemaRecord\",\"name\":\"\",\"type\":\"tuple\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"string\",\"name\":\"schema\",\"type\":\"string\"},{\"internalType\":\"contract ISchemaResolver\",\"name\":\"resolver\",\"type\":\"address\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"}],\"name\":\"register\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}],\"devdoc\":{\"events\":{\"Registered(bytes32,address)\":{\"details\":\"Emitted when a new schema has been registered\",\"params\":{\"registerer\":\"The address of the account used to register the schema.\",\"uid\":\"The schema UID.\"}}},\"kind\":\"dev\",\"methods\":{\"getSchema(bytes32)\":{\"details\":\"Returns an existing schema by UID\",\"params\":{\"uid\":\"The UID of the schema to retrieve.\"},\"returns\":{\"_0\":\"The schema data members.\"}},\"register(string,address,bool)\":{\"details\":\"Submits and reserves a new schema\",\"params\":{\"resolver\":\"An optional schema resolver.\",\"revocable\":\"Whether the schema allows revocations explicitly.\",\"schema\":\"The schema data schema.\"},\"returns\":{\"_0\":\"The UID of the new schema.\"}}},\"title\":\"The global schema registry.\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{},\"version\":1}},\"settings\":{\"compilationTarget\":{\"contracts/SchemaRegistry.sol\":\"SchemaRegistry\"},\"evmVersion\":\"paris\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"none\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":1000000},\"remappings\":[],\"viaIR\":true},\"sources\":{\"contracts/ISchemaRegistry.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\n/**\\n * @title A struct representing a record for a submitted schema.\\n */\\nstruct SchemaRecord {\\n    bytes32 uid; // The unique identifier of the schema.\\n    ISchemaResolver resolver; // Optional schema resolver.\\n    bool revocable; // Whether the schema allows revocations explicitly.\\n    string schema; // Custom specification of the schema (e.g., an ABI).\\n}\\n\\n/**\\n * @title The global schema registry interface.\\n */\\ninterface ISchemaRegistry {\\n    /**\\n     * @dev Emitted when a new schema has been registered\\n     *\\n     * @param uid The schema UID.\\n     * @param registerer The address of the account used to register the schema.\\n     */\\n    event Registered(bytes32 indexed uid, address registerer);\\n\\n    /**\\n     * @dev Submits and reserves a new schema\\n     *\\n     * @param schema The schema data schema.\\n     * @param resolver An optional schema resolver.\\n     * @param revocable Whether the schema allows revocations explicitly.\\n     *\\n     * @return The UID of the new schema.\\n     */\\n    function register(string calldata schema, ISchemaResolver resolver, bool revocable) external returns (bytes32);\\n\\n    /**\\n     * @dev Returns an existing schema by UID\\n     *\\n     * @param uid The UID of the schema to retrieve.\\n     *\\n     * @return The schema data members.\\n     */\\n    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);\\n}\\n\",\"keccak256\":\"0xef47e449dd02bd034e26b1dea505ce533906f8462fc674c938ed0e872a68d640\",\"license\":\"MIT\"},\"contracts/SchemaRegistry.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\nimport { EMPTY_UID } from \\\"./Types.sol\\\";\\nimport { ISchemaRegistry, SchemaRecord } from \\\"./ISchemaRegistry.sol\\\";\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\n/**\\n * @title The global schema registry.\\n */\\ncontract SchemaRegistry is ISchemaRegistry {\\n    error AlreadyExists();\\n\\n    // The version of the contract.\\n    string public constant VERSION = \\\"0.26\\\";\\n\\n    // The global mapping between schema records and their IDs.\\n    mapping(bytes32 uid => SchemaRecord schemaRecord) private _registry;\\n\\n    /**\\n     * @inheritdoc ISchemaRegistry\\n     */\\n    function register(string calldata schema, ISchemaResolver resolver, bool revocable) external returns (bytes32) {\\n        SchemaRecord memory schemaRecord = SchemaRecord({\\n            uid: EMPTY_UID,\\n            schema: schema,\\n            resolver: resolver,\\n            revocable: revocable\\n        });\\n\\n        bytes32 uid = _getUID(schemaRecord);\\n        if (_registry[uid].uid != EMPTY_UID) {\\n            revert AlreadyExists();\\n        }\\n\\n        schemaRecord.uid = uid;\\n        _registry[uid] = schemaRecord;\\n\\n        emit Registered(uid, msg.sender);\\n\\n        return uid;\\n    }\\n\\n    /**\\n     * @inheritdoc ISchemaRegistry\\n     */\\n    function getSchema(bytes32 uid) external view returns (SchemaRecord memory) {\\n        return _registry[uid];\\n    }\\n\\n    /**\\n     * @dev Calculates a UID for a given schema.\\n     *\\n     * @param schemaRecord The input schema.\\n     *\\n     * @return schema UID.\\n     */\\n    function _getUID(SchemaRecord memory schemaRecord) private pure returns (bytes32) {\\n        return keccak256(abi.encodePacked(schemaRecord.schema, schemaRecord.resolver, schemaRecord.revocable));\\n    }\\n}\\n\",\"keccak256\":\"0x11ca856573f1b53530d27d40b0a5629a5c591957e221a1b4b8eae2b2053f168b\",\"license\":\"MIT\"},\"contracts/Types.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\n// A representation of an empty/uninitialized UID.\\nbytes32 constant EMPTY_UID = 0;\\n\\n/**\\n * @dev A struct representing EIP712 signature data.\\n */\\nstruct EIP712Signature {\\n    uint8 v; // The recovery ID.\\n    bytes32 r; // The x-coordinate of the nonce R.\\n    bytes32 s; // The signature data.\\n}\\n\\n/**\\n * @dev A struct representing a single attestation.\\n */\\nstruct Attestation {\\n    bytes32 uid; // A unique identifier of the attestation.\\n    bytes32 schema; // The unique identifier of the schema.\\n    uint64 time; // The time when the attestation was created (Unix timestamp).\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    uint64 revocationTime; // The time when the attestation was revoked (Unix timestamp).\\n    bytes32 refUID; // The UID of the related attestation.\\n    address recipient; // The recipient of the attestation.\\n    address attester; // The attester/sender of the attestation.\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes data; // Custom attestation data.\\n}\\n\",\"keccak256\":\"0x547096b5cb7bfad9591bdc520705f8110534cd040ed0f7a0ba8d83ea4a565b45\",\"license\":\"MIT\"},\"contracts/resolver/ISchemaResolver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { Attestation } from \\\"../Types.sol\\\";\\n\\n/**\\n * @title The interface of an optional schema resolver.\\n */\\ninterface ISchemaResolver {\\n    /**\\n     * @dev Returns whether the resolver supports ETH transfers.\\n     */\\n    function isPayable() external pure returns (bool);\\n\\n    /**\\n     * @dev Processes an attestation and verifies whether it's valid.\\n     *\\n     * @param attestation The new attestation.\\n     *\\n     * @return Whether the attestation is valid.\\n     */\\n    function attest(Attestation calldata attestation) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes multiple attestations and verifies whether they are valid.\\n     *\\n     * @param attestations The new attestations.\\n     * @param values Explicit ETH amounts which were sent with each attestation.\\n     *\\n     * @return Whether all the attestations are valid.\\n     */\\n    function multiAttest(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes an attestation revocation and verifies if it can be revoked.\\n     *\\n     * @param attestation The existing attestation to be revoked.\\n     *\\n     * @return Whether the attestation can be revoked.\\n     */\\n    function revoke(Attestation calldata attestation) external payable returns (bool);\\n\\n    /**\\n     * @dev Processes revocation of multiple attestation and verifies they can be revoked.\\n     *\\n     * @param attestations The existing attestations to be revoked.\\n     * @param values Explicit ETH amounts which were sent with each revocation.\\n     *\\n     * @return Whether the attestations can be revoked.\\n     */\\n    function multiRevoke(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n}\\n\",\"keccak256\":\"0x0f3a75c28cdb91fa9227a6eef183379ecea2b6bf38db52795b5c4e6af79299e8\",\"license\":\"MIT\"}},\"version\":1}",
        "bytecode": "0x60808060405234610016576107b8908161001c8239f35b600080fdfe60806040908082526004918236101561001757600080fd5b600091823560e01c90816360d7a2781461029757508063a2ea7c6e146101045763ffa1ad741461004657600080fd5b3461010057817ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610100578051918183019083821067ffffffffffffffff8311176100d45750926100d093825282527f302e323600000000000000000000000000000000000000000000000000000000602083015251918291602083526020830190610689565b0390f35b806041867f4e487b71000000000000000000000000000000000000000000000000000000006024945252fd5b5080fd5b503461010057602092837ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610293576060808351610144816106cc565b85815285878201528585820152015235825281835280822090805191610169836106cc565b805483526001918282015491868501600273ffffffffffffffffffffffffffffffffffffffff92838616835260ff8589019660a01c16151586520188845196898354936101b585610758565b808b52948381169081156102505750600114610214575b50505050506101e1856100d097980386610717565b606087019485528251978897818952519088015251169085015251151560608401525160808084015260a0830190610689565b908094939b50528983205b82841061023d575050508501909601956101e1886100d087386101cc565b80548985018c0152928a0192810161021f565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0016858c01525050505090151560051b86010196506101e1886100d087386101cc565b8280fd5b92939050346106625760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126106625780359067ffffffffffffffff80831161065e573660238401121561065e57828201359181831161065a57366024848601011161065a576024359673ffffffffffffffffffffffffffffffffffffffff9182891680990361010057604435978815158099036102935761033b816106cc565b8281526020998a8201908152888201998a52885197848c7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe099818b601f83011601610386908d610717565b808c5280828d019460240185378b0101528b6060840199808b5283518d5115158d519384938185019687915180926103bd92610666565b84019260601b7fffffffffffffffffffffffffffffffffffffffff000000000000000000000000169083015260f81b6034820152036015810182526035016104059082610717565b519020998a8552848c5289852054610632579082918b600294528b8652858d528a8620925183556001968784019251167fffffffffffffffffffffff00000000000000000000000000000000000000000074ff000000000000000000000000000000000000000084549351151560a01b1692161717905501955190815194851161060657506104948654610758565b601f81116105c0575b508891601f8511600114610545578495509084939492919361051a575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff91921b9260031b1c19161790555b817f7d917fcbc9a29a9705ff9936ffa599500e4fd902e4486bae317414fe967b307c848351338152a251908152f35b015191507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff386104ba565b9294849081168785528a8520945b8b888383106105a95750505010610572575b505050811b0190556104eb565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080610565565b868601518855909601959485019487935001610553565b868352898320601f860160051c8101918b87106105fc575b601f0160051c019084905b8281106105f157505061049d565b8481550184906105e3565b90915081906105d8565b8260416024927f4e487b7100000000000000000000000000000000000000000000000000000000835252fd5b838a517f23369fa6000000000000000000000000000000000000000000000000000000008152fd5b8680fd5b8580fd5b8380fd5b60005b8381106106795750506000910152565b8181015183820152602001610669565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f6020936106c581518092818752878088019101610666565b0116010190565b6080810190811067ffffffffffffffff8211176106e857604052565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff8211176106e857604052565b90600182811c921680156107a1575b602083101461077257565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b91607f169161076756fea164736f6c6343000812000a",
        "deployedBytecode": "0x60806040908082526004918236101561001757600080fd5b600091823560e01c90816360d7a2781461029757508063a2ea7c6e146101045763ffa1ad741461004657600080fd5b3461010057817ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610100578051918183019083821067ffffffffffffffff8311176100d45750926100d093825282527f302e323600000000000000000000000000000000000000000000000000000000602083015251918291602083526020830190610689565b0390f35b806041867f4e487b71000000000000000000000000000000000000000000000000000000006024945252fd5b5080fd5b503461010057602092837ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610293576060808351610144816106cc565b85815285878201528585820152015235825281835280822090805191610169836106cc565b805483526001918282015491868501600273ffffffffffffffffffffffffffffffffffffffff92838616835260ff8589019660a01c16151586520188845196898354936101b585610758565b808b52948381169081156102505750600114610214575b50505050506101e1856100d097980386610717565b606087019485528251978897818952519088015251169085015251151560608401525160808084015260a0830190610689565b908094939b50528983205b82841061023d575050508501909601956101e1886100d087386101cc565b80548985018c0152928a0192810161021f565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0016858c01525050505090151560051b86010196506101e1886100d087386101cc565b8280fd5b92939050346106625760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126106625780359067ffffffffffffffff80831161065e573660238401121561065e57828201359181831161065a57366024848601011161065a576024359673ffffffffffffffffffffffffffffffffffffffff9182891680990361010057604435978815158099036102935761033b816106cc565b8281526020998a8201908152888201998a52885197848c7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe099818b601f83011601610386908d610717565b808c5280828d019460240185378b0101528b6060840199808b5283518d5115158d519384938185019687915180926103bd92610666565b84019260601b7fffffffffffffffffffffffffffffffffffffffff000000000000000000000000169083015260f81b6034820152036015810182526035016104059082610717565b519020998a8552848c5289852054610632579082918b600294528b8652858d528a8620925183556001968784019251167fffffffffffffffffffffff00000000000000000000000000000000000000000074ff000000000000000000000000000000000000000084549351151560a01b1692161717905501955190815194851161060657506104948654610758565b601f81116105c0575b508891601f8511600114610545578495509084939492919361051a575b50507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff91921b9260031b1c19161790555b817f7d917fcbc9a29a9705ff9936ffa599500e4fd902e4486bae317414fe967b307c848351338152a251908152f35b015191507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff386104ba565b9294849081168785528a8520945b8b888383106105a95750505010610572575b505050811b0190556104eb565b01517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60f88460031b161c19169055388080610565565b868601518855909601959485019487935001610553565b868352898320601f860160051c8101918b87106105fc575b601f0160051c019084905b8281106105f157505061049d565b8481550184906105e3565b90915081906105d8565b8260416024927f4e487b7100000000000000000000000000000000000000000000000000000000835252fd5b838a517f23369fa6000000000000000000000000000000000000000000000000000000008152fd5b8680fd5b8580fd5b8380fd5b60005b8381106106795750506000910152565b8181015183820152602001610669565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f6020936106c581518092818752878088019101610666565b0116010190565b6080810190811067ffffffffffffffff8211176106e857604052565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff8211176106e857604052565b90600182811c921680156107a1575b602083101461077257565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b91607f169161076756fea164736f6c6343000812000a",
        "devdoc": {
          "events": {
            "Registered(bytes32,address)": {
              "details": "Emitted when a new schema has been registered",
              "params": {
                "registerer": "The address of the account used to register the schema.",
                "uid": "The schema UID."
              }
            }
          },
          "kind": "dev",
          "methods": {
            "getSchema(bytes32)": {
              "details": "Returns an existing schema by UID",
              "params": {
                "uid": "The UID of the schema to retrieve."
              },
              "returns": {
                "_0": "The schema data members."
              }
            },
            "register(string,address,bool)": {
              "details": "Submits and reserves a new schema",
              "params": {
                "resolver": "An optional schema resolver.",
                "revocable": "Whether the schema allows revocations explicitly.",
                "schema": "The schema data schema."
              },
              "returns": {
                "_0": "The UID of the new schema."
              }
            }
          },
          "title": "The global schema registry.",
          "version": 1
        },
        "userdoc": {
          "kind": "user",
          "methods": {},
          "version": 1
        },
        "storageLayout": {
          "storage": [
            {
              "astId": 5366,
              "contract": "contracts/SchemaRegistry.sol:SchemaRegistry",
              "label": "_registry",
              "offset": 0,
              "slot": "0",
              "type": "t_mapping(t_bytes32,t_struct(SchemaRecord)5313_storage)"
            }
          ],
          "types": {
            "t_bool": {
              "encoding": "inplace",
              "label": "bool",
              "numberOfBytes": "1"
            },
            "t_bytes32": {
              "encoding": "inplace",
              "label": "bytes32",
              "numberOfBytes": "32"
            },
            "t_contract(ISchemaResolver)5553": {
              "encoding": "inplace",
              "label": "contract ISchemaResolver",
              "numberOfBytes": "20"
            },
            "t_mapping(t_bytes32,t_struct(SchemaRecord)5313_storage)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => struct SchemaRecord)",
              "numberOfBytes": "32",
              "value": "t_struct(SchemaRecord)5313_storage"
            },
            "t_string_storage": {
              "encoding": "bytes",
              "label": "string",
              "numberOfBytes": "32"
            },
            "t_struct(SchemaRecord)5313_storage": {
              "encoding": "inplace",
              "label": "struct SchemaRecord",
              "members": [
                {
                  "astId": 5305,
                  "contract": "contracts/SchemaRegistry.sol:SchemaRegistry",
                  "label": "uid",
                  "offset": 0,
                  "slot": "0",
                  "type": "t_bytes32"
                },
                {
                  "astId": 5308,
                  "contract": "contracts/SchemaRegistry.sol:SchemaRegistry",
                  "label": "resolver",
                  "offset": 0,
                  "slot": "1",
                  "type": "t_contract(ISchemaResolver)5553"
                },
                {
                  "astId": 5310,
                  "contract": "contracts/SchemaRegistry.sol:SchemaRegistry",
                  "label": "revocable",
                  "offset": 20,
                  "slot": "1",
                  "type": "t_bool"
                },
                {
                  "astId": 5312,
                  "contract": "contracts/SchemaRegistry.sol:SchemaRegistry",
                  "label": "schema",
                  "offset": 0,
                  "slot": "2",
                  "type": "t_string_storage"
                }
              ],
              "numberOfBytes": "96"
            }
          }
        }
      },
      EIP712Proxy: {
        "address": "0x9C9d17bEE150E4eCDf3b99baFA62c08Cb30E82BC",
        "abi": [
          {
            "inputs": [
              {
                "internalType": "contract IEAS",
                "name": "eas",
                "type": "address"
              },
              {
                "internalType": "string",
                "name": "name",
                "type": "string"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "constructor"
          },
          {
            "inputs": [],
            "name": "AccessDenied",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "DeadlineExpired",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidEAS",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidLength",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidShortString",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidSignature",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "NotFound",
            "type": "error"
          },
          {
            "inputs": [
              {
                "internalType": "string",
                "name": "str",
                "type": "string"
              }
            ],
            "name": "StringTooLong",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "UsedSignature",
            "type": "error"
          },
          {
            "anonymous": false,
            "inputs": [],
            "name": "EIP712DomainChanged",
            "type": "event"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData",
                    "name": "data",
                    "type": "tuple"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct Signature",
                    "name": "signature",
                    "type": "tuple"
                  },
                  {
                    "internalType": "address",
                    "name": "attester",
                    "type": "address"
                  },
                  {
                    "internalType": "uint64",
                    "name": "deadline",
                    "type": "uint64"
                  }
                ],
                "internalType": "struct DelegatedProxyAttestationRequest",
                "name": "delegatedRequest",
                "type": "tuple"
              }
            ],
            "name": "attestByDelegation",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "eip712Domain",
            "outputs": [
              {
                "internalType": "bytes1",
                "name": "fields",
                "type": "bytes1"
              },
              {
                "internalType": "string",
                "name": "name",
                "type": "string"
              },
              {
                "internalType": "string",
                "name": "version",
                "type": "string"
              },
              {
                "internalType": "uint256",
                "name": "chainId",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "verifyingContract",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "salt",
                "type": "bytes32"
              },
              {
                "internalType": "uint256[]",
                "name": "extensions",
                "type": "uint256[]"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getAttestTypeHash",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "pure",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              }
            ],
            "name": "getAttester",
            "outputs": [
              {
                "internalType": "address",
                "name": "",
                "type": "address"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getDomainSeparator",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getEAS",
            "outputs": [
              {
                "internalType": "contract IEAS",
                "name": "",
                "type": "address"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getName",
            "outputs": [
              {
                "internalType": "string",
                "name": "",
                "type": "string"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "getRevokeTypeHash",
            "outputs": [
              {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
              }
            ],
            "stateMutability": "pure",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                      },
                      {
                        "internalType": "uint64",
                        "name": "expirationTime",
                        "type": "uint64"
                      },
                      {
                        "internalType": "bool",
                        "name": "revocable",
                        "type": "bool"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "refUID",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct AttestationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct Signature[]",
                    "name": "signatures",
                    "type": "tuple[]"
                  },
                  {
                    "internalType": "address",
                    "name": "attester",
                    "type": "address"
                  },
                  {
                    "internalType": "uint64",
                    "name": "deadline",
                    "type": "uint64"
                  }
                ],
                "internalType": "struct MultiDelegatedProxyAttestationRequest[]",
                "name": "multiDelegatedRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiAttestByDelegation",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData[]",
                    "name": "data",
                    "type": "tuple[]"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct Signature[]",
                    "name": "signatures",
                    "type": "tuple[]"
                  },
                  {
                    "internalType": "address",
                    "name": "revoker",
                    "type": "address"
                  },
                  {
                    "internalType": "uint64",
                    "name": "deadline",
                    "type": "uint64"
                  }
                ],
                "internalType": "struct MultiDelegatedProxyRevocationRequest[]",
                "name": "multiDelegatedRequests",
                "type": "tuple[]"
              }
            ],
            "name": "multiRevokeByDelegation",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "components": [
                  {
                    "internalType": "bytes32",
                    "name": "schema",
                    "type": "bytes32"
                  },
                  {
                    "components": [
                      {
                        "internalType": "bytes32",
                        "name": "uid",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "uint256",
                        "name": "value",
                        "type": "uint256"
                      }
                    ],
                    "internalType": "struct RevocationRequestData",
                    "name": "data",
                    "type": "tuple"
                  },
                  {
                    "components": [
                      {
                        "internalType": "uint8",
                        "name": "v",
                        "type": "uint8"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "r",
                        "type": "bytes32"
                      },
                      {
                        "internalType": "bytes32",
                        "name": "s",
                        "type": "bytes32"
                      }
                    ],
                    "internalType": "struct Signature",
                    "name": "signature",
                    "type": "tuple"
                  },
                  {
                    "internalType": "address",
                    "name": "revoker",
                    "type": "address"
                  },
                  {
                    "internalType": "uint64",
                    "name": "deadline",
                    "type": "uint64"
                  }
                ],
                "internalType": "struct DelegatedProxyRevocationRequest",
                "name": "delegatedRequest",
                "type": "tuple"
              }
            ],
            "name": "revokeByDelegation",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "version",
            "outputs": [
              {
                "internalType": "string",
                "name": "",
                "type": "string"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          }
        ],
        "transactionHash": "0x89ec68408e1af7af85041daf58be8deee89a7b6f4b28aadb9a51ace53a8e477b",
        "receipt": {
          "to": null,
          "from": "0x6457B4DB9575DBc1bac391DaE4B239722c4000d0",
          "contractAddress": "0x9C9d17bEE150E4eCDf3b99baFA62c08Cb30E82BC",
          "transactionIndex": 18,
          "gasUsed": "2301134",
          "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          "blockHash": "0x59f87dfceab831472c6a93584ffb9883b2505ff6e25f9650f8fd61f0b4d0e00a",
          "transactionHash": "0x89ec68408e1af7af85041daf58be8deee89a7b6f4b28aadb9a51ace53a8e477b",
          "logs": [],
          "blockNumber": 4604300,
          "cumulativeGasUsed": "9524966",
          "status": 1,
          "byzantium": true
        },
        "args": [
          "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
          "EIP712Proxy"
        ],
        "numDeployments": 2,
        "solcInputHash": "363c8b5710f335e9a0bfd66216b6038c",
        "metadata": "{\"compiler\":{\"version\":\"0.8.19+commit.7dd6d404\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[{\"internalType\":\"contract IEAS\",\"name\":\"eas\",\"type\":\"address\"},{\"internalType\":\"string\",\"name\":\"name\",\"type\":\"string\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"AccessDenied\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DeadlineExpired\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidEAS\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidLength\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidShortString\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidSignature\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"NotFound\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"string\",\"name\":\"str\",\"type\":\"string\"}],\"name\":\"StringTooLong\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"UsedSignature\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[],\"name\":\"EIP712DomainChanged\",\"type\":\"event\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData\",\"name\":\"data\",\"type\":\"tuple\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct Signature\",\"name\":\"signature\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"}],\"internalType\":\"struct DelegatedProxyAttestationRequest\",\"name\":\"delegatedRequest\",\"type\":\"tuple\"}],\"name\":\"attestByDelegation\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"eip712Domain\",\"outputs\":[{\"internalType\":\"bytes1\",\"name\":\"fields\",\"type\":\"bytes1\"},{\"internalType\":\"string\",\"name\":\"name\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"version\",\"type\":\"string\"},{\"internalType\":\"uint256\",\"name\":\"chainId\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"verifyingContract\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"salt\",\"type\":\"bytes32\"},{\"internalType\":\"uint256[]\",\"name\":\"extensions\",\"type\":\"uint256[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getAttestTypeHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"pure\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"}],\"name\":\"getAttester\",\"outputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getDomainSeparator\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getEAS\",\"outputs\":[{\"internalType\":\"contract IEAS\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getName\",\"outputs\":[{\"internalType\":\"string\",\"name\":\"\",\"type\":\"string\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getRevokeTypeHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"pure\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"expirationTime\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"revocable\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"refUID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes\",\"name\":\"data\",\"type\":\"bytes\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct AttestationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct Signature[]\",\"name\":\"signatures\",\"type\":\"tuple[]\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"}],\"internalType\":\"struct MultiDelegatedProxyAttestationRequest[]\",\"name\":\"multiDelegatedRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiAttestByDelegation\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData[]\",\"name\":\"data\",\"type\":\"tuple[]\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct Signature[]\",\"name\":\"signatures\",\"type\":\"tuple[]\"},{\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"}],\"internalType\":\"struct MultiDelegatedProxyRevocationRequest[]\",\"name\":\"multiDelegatedRequests\",\"type\":\"tuple[]\"}],\"name\":\"multiRevokeByDelegation\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"value\",\"type\":\"uint256\"}],\"internalType\":\"struct RevocationRequestData\",\"name\":\"data\",\"type\":\"tuple\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"v\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"r\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"s\",\"type\":\"bytes32\"}],\"internalType\":\"struct Signature\",\"name\":\"signature\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"revoker\",\"type\":\"address\"},{\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"}],\"internalType\":\"struct DelegatedProxyRevocationRequest\",\"name\":\"delegatedRequest\",\"type\":\"tuple\"}],\"name\":\"revokeByDelegation\",\"outputs\":[],\"stateMutability\":\"payable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"version\",\"outputs\":[{\"internalType\":\"string\",\"name\":\"\",\"type\":\"string\"}],\"stateMutability\":\"view\",\"type\":\"function\"}],\"devdoc\":{\"events\":{\"EIP712DomainChanged()\":{\"details\":\"MAY be emitted to signal that the domain could have changed.\"}},\"kind\":\"dev\",\"methods\":{\"attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address,uint64))\":{\"params\":{\"delegatedRequest\":\"The arguments of the delegated attestation request.\"},\"returns\":{\"_0\":\"The UID of the new attestation. Example:     attestByDelegation({         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: {             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',             expirationTime: 1673891048,             revocable: true,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x1234',             value: 0         },         signature: {             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e',         deadline: 1673891048     })\"}},\"constructor\":{\"details\":\"Creates a new EIP1271Verifier instance.\",\"params\":{\"eas\":\"The address of the global EAS contract.\",\"name\":\"The user readable name of the signing domain.\"}},\"eip712Domain()\":{\"details\":\"See {EIP-5267}. _Available since v4.9._\"},\"multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])\":{\"params\":{\"multiDelegatedRequests\":\"The arguments of the delegated multi attestation requests. The requests should be     grouped by distinct schema ids to benefit from the best batching optimization.\"},\"returns\":{\"_0\":\"The UIDs of the new attestations. Example:     multiAttestByDelegation([{         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: [{             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',             expirationTime: 1673891048,             revocable: true,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x1234',             value: 0         },         {             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',             expirationTime: 0,             revocable: false,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x00',             value: 0         }],         signatures: [{             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         {             v: 28,             r: '0x487s...67bb',             s: '0x12ad...2366'         }],         attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4',         deadline: 1673891048     }])\"}},\"multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])\":{\"params\":{\"multiDelegatedRequests\":\"The arguments of the delegated multi revocation attestation requests. The requests     should be grouped by distinct schema ids to benefit from the best batching optimization. Example:     multiRevokeByDelegation([{         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: [{             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',             value: 1000         },         {             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',             value: 0         }],         signatures: [{             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         {             v: 28,             r: '0x487s...67bb',             s: '0x12ad...2366'         }],         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',         deadline: 1673891048     }])\"}},\"revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address,uint64))\":{\"params\":{\"delegatedRequest\":\"The arguments of the delegated revocation request. Example:     revokeByDelegation({         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: {             uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',             value: 0         },         signature: {             v: 27,             r: '0xb593...7142',             s: '0x0f5b...2cce'         },         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',         deadline: 1673891048     })\"}},\"version()\":{\"returns\":{\"_0\":\"Semver contract version as a string.\"}}},\"title\":\"EIP712Proxy\",\"version\":1},\"userdoc\":{\"kind\":\"user\",\"methods\":{\"attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address,uint64))\":{\"notice\":\"Attests to a specific schema via the provided EIP712 signature.\"},\"getAttestTypeHash()\":{\"notice\":\"Returns the EIP712 type hash for the attest function.\"},\"getAttester(bytes32)\":{\"notice\":\"Returns the attester for a given uid.\"},\"getDomainSeparator()\":{\"notice\":\"Returns the domain separator used in the encoding of the signatures for attest, and revoke.\"},\"getEAS()\":{\"notice\":\"Returns the EAS.\"},\"getName()\":{\"notice\":\"Returns the EIP712 name.\"},\"getRevokeTypeHash()\":{\"notice\":\"Returns the EIP712 type hash for the revoke function.\"},\"multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])\":{\"notice\":\"Attests to multiple schemas using via provided EIP712 signatures.\"},\"multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])\":{\"notice\":\"Revokes existing attestations to multiple schemas via provided EIP712 signatures.\"},\"revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address,uint64))\":{\"notice\":\"Revokes an existing attestation to a specific schema via the provided EIP712 signature.\"},\"version()\":{\"notice\":\"Returns the full semver contract version.\"}},\"notice\":\"This utility contract an be used to aggregate delegated attestations without requiring a specific order via     nonces. The contract doesn't request nonces and implements replay protection by storing ***immalleable***     signatures.\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"contracts/eip712/proxy/EIP712Proxy.sol\":\"EIP712Proxy\"},\"evmVersion\":\"paris\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"none\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":1000000},\"remappings\":[]},\"sources\":{\"@openzeppelin/contracts/interfaces/IERC5267.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (interfaces/IERC5267.sol)\\n\\npragma solidity ^0.8.0;\\n\\ninterface IERC5267 {\\n    /**\\n     * @dev MAY be emitted to signal that the domain could have changed.\\n     */\\n    event EIP712DomainChanged();\\n\\n    /**\\n     * @dev returns the fields and values that describe the domain separator used by this contract for EIP-712\\n     * signature.\\n     */\\n    function eip712Domain()\\n        external\\n        view\\n        returns (\\n            bytes1 fields,\\n            string memory name,\\n            string memory version,\\n            uint256 chainId,\\n            address verifyingContract,\\n            bytes32 salt,\\n            uint256[] memory extensions\\n        );\\n}\\n\",\"keccak256\":\"0xac6c2efc64baccbde4904ae18ed45139c9aa8cff96d6888344d1e4d2eb8b659f\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/ShortStrings.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/ShortStrings.sol)\\n\\npragma solidity ^0.8.8;\\n\\nimport \\\"./StorageSlot.sol\\\";\\n\\n// | string  | 0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA   |\\n// | length  | 0x                                                              BB |\\ntype ShortString is bytes32;\\n\\n/**\\n * @dev This library provides functions to convert short memory strings\\n * into a `ShortString` type that can be used as an immutable variable.\\n *\\n * Strings of arbitrary length can be optimized using this library if\\n * they are short enough (up to 31 bytes) by packing them with their\\n * length (1 byte) in a single EVM word (32 bytes). Additionally, a\\n * fallback mechanism can be used for every other case.\\n *\\n * Usage example:\\n *\\n * ```solidity\\n * contract Named {\\n *     using ShortStrings for *;\\n *\\n *     ShortString private immutable _name;\\n *     string private _nameFallback;\\n *\\n *     constructor(string memory contractName) {\\n *         _name = contractName.toShortStringWithFallback(_nameFallback);\\n *     }\\n *\\n *     function name() external view returns (string memory) {\\n *         return _name.toStringWithFallback(_nameFallback);\\n *     }\\n * }\\n * ```\\n */\\nlibrary ShortStrings {\\n    // Used as an identifier for strings longer than 31 bytes.\\n    bytes32 private constant _FALLBACK_SENTINEL = 0x00000000000000000000000000000000000000000000000000000000000000FF;\\n\\n    error StringTooLong(string str);\\n    error InvalidShortString();\\n\\n    /**\\n     * @dev Encode a string of at most 31 chars into a `ShortString`.\\n     *\\n     * This will trigger a `StringTooLong` error is the input string is too long.\\n     */\\n    function toShortString(string memory str) internal pure returns (ShortString) {\\n        bytes memory bstr = bytes(str);\\n        if (bstr.length > 31) {\\n            revert StringTooLong(str);\\n        }\\n        return ShortString.wrap(bytes32(uint256(bytes32(bstr)) | bstr.length));\\n    }\\n\\n    /**\\n     * @dev Decode a `ShortString` back to a \\\"normal\\\" string.\\n     */\\n    function toString(ShortString sstr) internal pure returns (string memory) {\\n        uint256 len = byteLength(sstr);\\n        // using `new string(len)` would work locally but is not memory safe.\\n        string memory str = new string(32);\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            mstore(str, len)\\n            mstore(add(str, 0x20), sstr)\\n        }\\n        return str;\\n    }\\n\\n    /**\\n     * @dev Return the length of a `ShortString`.\\n     */\\n    function byteLength(ShortString sstr) internal pure returns (uint256) {\\n        uint256 result = uint256(ShortString.unwrap(sstr)) & 0xFF;\\n        if (result > 31) {\\n            revert InvalidShortString();\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Encode a string into a `ShortString`, or write it to storage if it is too long.\\n     */\\n    function toShortStringWithFallback(string memory value, string storage store) internal returns (ShortString) {\\n        if (bytes(value).length < 32) {\\n            return toShortString(value);\\n        } else {\\n            StorageSlot.getStringSlot(store).value = value;\\n            return ShortString.wrap(_FALLBACK_SENTINEL);\\n        }\\n    }\\n\\n    /**\\n     * @dev Decode a string that was encoded to `ShortString` or written to storage using {setWithFallback}.\\n     */\\n    function toStringWithFallback(ShortString value, string storage store) internal pure returns (string memory) {\\n        if (ShortString.unwrap(value) != _FALLBACK_SENTINEL) {\\n            return toString(value);\\n        } else {\\n            return store;\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the length of a string that was encoded to `ShortString` or written to storage using {setWithFallback}.\\n     *\\n     * WARNING: This will return the \\\"byte length\\\" of the string. This may not reflect the actual length in terms of\\n     * actual characters as the UTF-8 encoding of a single character can span over multiple bytes.\\n     */\\n    function byteLengthWithFallback(ShortString value, string storage store) internal view returns (uint256) {\\n        if (ShortString.unwrap(value) != _FALLBACK_SENTINEL) {\\n            return byteLength(value);\\n        } else {\\n            return bytes(store).length;\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xc0e310c163edf15db45d4ff938113ab357f94fa86e61ea8e790853c4d2e13256\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/StorageSlot.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/StorageSlot.sol)\\n// This file was procedurally generated from scripts/generate/templates/StorageSlot.js.\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Library for reading and writing primitive types to specific storage slots.\\n *\\n * Storage slots are often used to avoid storage conflict when dealing with upgradeable contracts.\\n * This library helps with reading and writing to such slots without the need for inline assembly.\\n *\\n * The functions in this library return Slot structs that contain a `value` member that can be used to read or write.\\n *\\n * Example usage to set ERC1967 implementation slot:\\n * ```solidity\\n * contract ERC1967 {\\n *     bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;\\n *\\n *     function _getImplementation() internal view returns (address) {\\n *         return StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value;\\n *     }\\n *\\n *     function _setImplementation(address newImplementation) internal {\\n *         require(Address.isContract(newImplementation), \\\"ERC1967: new implementation is not a contract\\\");\\n *         StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value = newImplementation;\\n *     }\\n * }\\n * ```\\n *\\n * _Available since v4.1 for `address`, `bool`, `bytes32`, `uint256`._\\n * _Available since v4.9 for `string`, `bytes`._\\n */\\nlibrary StorageSlot {\\n    struct AddressSlot {\\n        address value;\\n    }\\n\\n    struct BooleanSlot {\\n        bool value;\\n    }\\n\\n    struct Bytes32Slot {\\n        bytes32 value;\\n    }\\n\\n    struct Uint256Slot {\\n        uint256 value;\\n    }\\n\\n    struct StringSlot {\\n        string value;\\n    }\\n\\n    struct BytesSlot {\\n        bytes value;\\n    }\\n\\n    /**\\n     * @dev Returns an `AddressSlot` with member `value` located at `slot`.\\n     */\\n    function getAddressSlot(bytes32 slot) internal pure returns (AddressSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `BooleanSlot` with member `value` located at `slot`.\\n     */\\n    function getBooleanSlot(bytes32 slot) internal pure returns (BooleanSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `Bytes32Slot` with member `value` located at `slot`.\\n     */\\n    function getBytes32Slot(bytes32 slot) internal pure returns (Bytes32Slot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `Uint256Slot` with member `value` located at `slot`.\\n     */\\n    function getUint256Slot(bytes32 slot) internal pure returns (Uint256Slot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `StringSlot` with member `value` located at `slot`.\\n     */\\n    function getStringSlot(bytes32 slot) internal pure returns (StringSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `StringSlot` representation of the string storage pointer `store`.\\n     */\\n    function getStringSlot(string storage store) internal pure returns (StringSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := store.slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `BytesSlot` with member `value` located at `slot`.\\n     */\\n    function getBytesSlot(bytes32 slot) internal pure returns (BytesSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := slot\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an `BytesSlot` representation of the bytes storage pointer `store`.\\n     */\\n    function getBytesSlot(bytes storage store) internal pure returns (BytesSlot storage r) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            r.slot := store.slot\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xf09e68aa0dc6722a25bc46490e8d48ed864466d17313b8a0b254c36b54e49899\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/Strings.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/Strings.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"./math/Math.sol\\\";\\nimport \\\"./math/SignedMath.sol\\\";\\n\\n/**\\n * @dev String operations.\\n */\\nlibrary Strings {\\n    bytes16 private constant _SYMBOLS = \\\"0123456789abcdef\\\";\\n    uint8 private constant _ADDRESS_LENGTH = 20;\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` decimal representation.\\n     */\\n    function toString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            uint256 length = Math.log10(value) + 1;\\n            string memory buffer = new string(length);\\n            uint256 ptr;\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                ptr := add(buffer, add(32, length))\\n            }\\n            while (true) {\\n                ptr--;\\n                /// @solidity memory-safe-assembly\\n                assembly {\\n                    mstore8(ptr, byte(mod(value, 10), _SYMBOLS))\\n                }\\n                value /= 10;\\n                if (value == 0) break;\\n            }\\n            return buffer;\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `int256` to its ASCII `string` decimal representation.\\n     */\\n    function toString(int256 value) internal pure returns (string memory) {\\n        return string(abi.encodePacked(value < 0 ? \\\"-\\\" : \\\"\\\", toString(SignedMath.abs(value))));\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            return toHexString(value, Math.log256(value) + 1);\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation with fixed length.\\n     */\\n    function toHexString(uint256 value, uint256 length) internal pure returns (string memory) {\\n        bytes memory buffer = new bytes(2 * length + 2);\\n        buffer[0] = \\\"0\\\";\\n        buffer[1] = \\\"x\\\";\\n        for (uint256 i = 2 * length + 1; i > 1; --i) {\\n            buffer[i] = _SYMBOLS[value & 0xf];\\n            value >>= 4;\\n        }\\n        require(value == 0, \\\"Strings: hex length insufficient\\\");\\n        return string(buffer);\\n    }\\n\\n    /**\\n     * @dev Converts an `address` with fixed length of 20 bytes to its not checksummed ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(address addr) internal pure returns (string memory) {\\n        return toHexString(uint256(uint160(addr)), _ADDRESS_LENGTH);\\n    }\\n\\n    /**\\n     * @dev Returns true if the two strings are equal.\\n     */\\n    function equal(string memory a, string memory b) internal pure returns (bool) {\\n        return keccak256(bytes(a)) == keccak256(bytes(b));\\n    }\\n}\\n\",\"keccak256\":\"0x3088eb2868e8d13d89d16670b5f8612c4ab9ff8956272837d8e90106c59c14a0\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/cryptography/ECDSA.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/cryptography/ECDSA.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"../Strings.sol\\\";\\n\\n/**\\n * @dev Elliptic Curve Digital Signature Algorithm (ECDSA) operations.\\n *\\n * These functions can be used to verify that a message was signed by the holder\\n * of the private keys of a given address.\\n */\\nlibrary ECDSA {\\n    enum RecoverError {\\n        NoError,\\n        InvalidSignature,\\n        InvalidSignatureLength,\\n        InvalidSignatureS,\\n        InvalidSignatureV // Deprecated in v4.8\\n    }\\n\\n    function _throwError(RecoverError error) private pure {\\n        if (error == RecoverError.NoError) {\\n            return; // no error: do nothing\\n        } else if (error == RecoverError.InvalidSignature) {\\n            revert(\\\"ECDSA: invalid signature\\\");\\n        } else if (error == RecoverError.InvalidSignatureLength) {\\n            revert(\\\"ECDSA: invalid signature length\\\");\\n        } else if (error == RecoverError.InvalidSignatureS) {\\n            revert(\\\"ECDSA: invalid signature 's' value\\\");\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns the address that signed a hashed message (`hash`) with\\n     * `signature` or error string. This address can then be used for verification purposes.\\n     *\\n     * The `ecrecover` EVM opcode allows for malleable (non-unique) signatures:\\n     * this function rejects them by requiring the `s` value to be in the lower\\n     * half order, and the `v` value to be either 27 or 28.\\n     *\\n     * IMPORTANT: `hash` _must_ be the result of a hash operation for the\\n     * verification to be secure: it is possible to craft signatures that\\n     * recover to arbitrary addresses for non-hashed data. A safe way to ensure\\n     * this is by receiving a hash of the original message (which may otherwise\\n     * be too long), and then calling {toEthSignedMessageHash} on it.\\n     *\\n     * Documentation for signature generation:\\n     * - with https://web3js.readthedocs.io/en/v1.3.4/web3-eth-accounts.html#sign[Web3.js]\\n     * - with https://docs.ethers.io/v5/api/signer/#Signer-signMessage[ethers]\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(bytes32 hash, bytes memory signature) internal pure returns (address, RecoverError) {\\n        if (signature.length == 65) {\\n            bytes32 r;\\n            bytes32 s;\\n            uint8 v;\\n            // ecrecover takes the signature parameters, and the only way to get them\\n            // currently is to use assembly.\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                r := mload(add(signature, 0x20))\\n                s := mload(add(signature, 0x40))\\n                v := byte(0, mload(add(signature, 0x60)))\\n            }\\n            return tryRecover(hash, v, r, s);\\n        } else {\\n            return (address(0), RecoverError.InvalidSignatureLength);\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns the address that signed a hashed message (`hash`) with\\n     * `signature`. This address can then be used for verification purposes.\\n     *\\n     * The `ecrecover` EVM opcode allows for malleable (non-unique) signatures:\\n     * this function rejects them by requiring the `s` value to be in the lower\\n     * half order, and the `v` value to be either 27 or 28.\\n     *\\n     * IMPORTANT: `hash` _must_ be the result of a hash operation for the\\n     * verification to be secure: it is possible to craft signatures that\\n     * recover to arbitrary addresses for non-hashed data. A safe way to ensure\\n     * this is by receiving a hash of the original message (which may otherwise\\n     * be too long), and then calling {toEthSignedMessageHash} on it.\\n     */\\n    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, signature);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-tryRecover} that receives the `r` and `vs` short-signature fields separately.\\n     *\\n     * See https://eips.ethereum.org/EIPS/eip-2098[EIP-2098 short signatures]\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(bytes32 hash, bytes32 r, bytes32 vs) internal pure returns (address, RecoverError) {\\n        bytes32 s = vs & bytes32(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);\\n        uint8 v = uint8((uint256(vs) >> 255) + 27);\\n        return tryRecover(hash, v, r, s);\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-recover} that receives the `r and `vs` short-signature fields separately.\\n     *\\n     * _Available since v4.2._\\n     */\\n    function recover(bytes32 hash, bytes32 r, bytes32 vs) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, r, vs);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-tryRecover} that receives the `v`,\\n     * `r` and `s` signature fields separately.\\n     *\\n     * _Available since v4.3._\\n     */\\n    function tryRecover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address, RecoverError) {\\n        // EIP-2 still allows signature malleability for ecrecover(). Remove this possibility and make the signature\\n        // unique. Appendix F in the Ethereum Yellow paper (https://ethereum.github.io/yellowpaper/paper.pdf), defines\\n        // the valid range for s in (301): 0 < s < secp256k1n \\u00f7 2 + 1, and for v in (302): v \\u2208 {27, 28}. Most\\n        // signatures from current libraries generate a unique signature with an s-value in the lower half order.\\n        //\\n        // If your library generates malleable signatures, such as s-values in the upper range, calculate a new s-value\\n        // with 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - s1 and flip v from 27 to 28 or\\n        // vice versa. If your library also generates signatures with 0/1 for v instead 27/28, add 27 to v to accept\\n        // these malleable signatures as well.\\n        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {\\n            return (address(0), RecoverError.InvalidSignatureS);\\n        }\\n\\n        // If the signature is valid (and not malleable), return the signer address\\n        address signer = ecrecover(hash, v, r, s);\\n        if (signer == address(0)) {\\n            return (address(0), RecoverError.InvalidSignature);\\n        }\\n\\n        return (signer, RecoverError.NoError);\\n    }\\n\\n    /**\\n     * @dev Overload of {ECDSA-recover} that receives the `v`,\\n     * `r` and `s` signature fields separately.\\n     */\\n    function recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {\\n        (address recovered, RecoverError error) = tryRecover(hash, v, r, s);\\n        _throwError(error);\\n        return recovered;\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Message, created from a `hash`. This\\n     * produces hash corresponding to the one signed with the\\n     * https://eth.wiki/json-rpc/API#eth_sign[`eth_sign`]\\n     * JSON-RPC method as part of EIP-191.\\n     *\\n     * See {recover}.\\n     */\\n    function toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32 message) {\\n        // 32 is the length in bytes of hash,\\n        // enforced by the type signature above\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            mstore(0x00, \\\"\\\\x19Ethereum Signed Message:\\\\n32\\\")\\n            mstore(0x1c, hash)\\n            message := keccak256(0x00, 0x3c)\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Message, created from `s`. This\\n     * produces hash corresponding to the one signed with the\\n     * https://eth.wiki/json-rpc/API#eth_sign[`eth_sign`]\\n     * JSON-RPC method as part of EIP-191.\\n     *\\n     * See {recover}.\\n     */\\n    function toEthSignedMessageHash(bytes memory s) internal pure returns (bytes32) {\\n        return keccak256(abi.encodePacked(\\\"\\\\x19Ethereum Signed Message:\\\\n\\\", Strings.toString(s.length), s));\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Typed Data, created from a\\n     * `domainSeparator` and a `structHash`. This produces hash corresponding\\n     * to the one signed with the\\n     * https://eips.ethereum.org/EIPS/eip-712[`eth_signTypedData`]\\n     * JSON-RPC method as part of EIP-712.\\n     *\\n     * See {recover}.\\n     */\\n    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32 data) {\\n        /// @solidity memory-safe-assembly\\n        assembly {\\n            let ptr := mload(0x40)\\n            mstore(ptr, \\\"\\\\x19\\\\x01\\\")\\n            mstore(add(ptr, 0x02), domainSeparator)\\n            mstore(add(ptr, 0x22), structHash)\\n            data := keccak256(ptr, 0x42)\\n        }\\n    }\\n\\n    /**\\n     * @dev Returns an Ethereum Signed Data with intended validator, created from a\\n     * `validator` and `data` according to the version 0 of EIP-191.\\n     *\\n     * See {recover}.\\n     */\\n    function toDataWithIntendedValidatorHash(address validator, bytes memory data) internal pure returns (bytes32) {\\n        return keccak256(abi.encodePacked(\\\"\\\\x19\\\\x00\\\", validator, data));\\n    }\\n}\\n\",\"keccak256\":\"0x809bc3edb4bcbef8263fa616c1b60ee0004b50a8a1bfa164d8f57fd31f520c58\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/cryptography/EIP712.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/cryptography/EIP712.sol)\\n\\npragma solidity ^0.8.8;\\n\\nimport \\\"./ECDSA.sol\\\";\\nimport \\\"../ShortStrings.sol\\\";\\nimport \\\"../../interfaces/IERC5267.sol\\\";\\n\\n/**\\n * @dev https://eips.ethereum.org/EIPS/eip-712[EIP 712] is a standard for hashing and signing of typed structured data.\\n *\\n * The encoding specified in the EIP is very generic, and such a generic implementation in Solidity is not feasible,\\n * thus this contract does not implement the encoding itself. Protocols need to implement the type-specific encoding\\n * they need in their contracts using a combination of `abi.encode` and `keccak256`.\\n *\\n * This contract implements the EIP 712 domain separator ({_domainSeparatorV4}) that is used as part of the encoding\\n * scheme, and the final step of the encoding to obtain the message digest that is then signed via ECDSA\\n * ({_hashTypedDataV4}).\\n *\\n * The implementation of the domain separator was designed to be as efficient as possible while still properly updating\\n * the chain id to protect against replay attacks on an eventual fork of the chain.\\n *\\n * NOTE: This contract implements the version of the encoding known as \\\"v4\\\", as implemented by the JSON RPC method\\n * https://docs.metamask.io/guide/signing-data.html[`eth_signTypedDataV4` in MetaMask].\\n *\\n * NOTE: In the upgradeable version of this contract, the cached values will correspond to the address, and the domain\\n * separator of the implementation contract. This will cause the `_domainSeparatorV4` function to always rebuild the\\n * separator from the immutable values, which is cheaper than accessing a cached version in cold storage.\\n *\\n * _Available since v3.4._\\n *\\n * @custom:oz-upgrades-unsafe-allow state-variable-immutable state-variable-assignment\\n */\\nabstract contract EIP712 is IERC5267 {\\n    using ShortStrings for *;\\n\\n    bytes32 private constant _TYPE_HASH =\\n        keccak256(\\\"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)\\\");\\n\\n    // Cache the domain separator as an immutable value, but also store the chain id that it corresponds to, in order to\\n    // invalidate the cached domain separator if the chain id changes.\\n    bytes32 private immutable _cachedDomainSeparator;\\n    uint256 private immutable _cachedChainId;\\n    address private immutable _cachedThis;\\n\\n    bytes32 private immutable _hashedName;\\n    bytes32 private immutable _hashedVersion;\\n\\n    ShortString private immutable _name;\\n    ShortString private immutable _version;\\n    string private _nameFallback;\\n    string private _versionFallback;\\n\\n    /**\\n     * @dev Initializes the domain separator and parameter caches.\\n     *\\n     * The meaning of `name` and `version` is specified in\\n     * https://eips.ethereum.org/EIPS/eip-712#definition-of-domainseparator[EIP 712]:\\n     *\\n     * - `name`: the user readable name of the signing domain, i.e. the name of the DApp or the protocol.\\n     * - `version`: the current major version of the signing domain.\\n     *\\n     * NOTE: These parameters cannot be changed except through a xref:learn::upgrading-smart-contracts.adoc[smart\\n     * contract upgrade].\\n     */\\n    constructor(string memory name, string memory version) {\\n        _name = name.toShortStringWithFallback(_nameFallback);\\n        _version = version.toShortStringWithFallback(_versionFallback);\\n        _hashedName = keccak256(bytes(name));\\n        _hashedVersion = keccak256(bytes(version));\\n\\n        _cachedChainId = block.chainid;\\n        _cachedDomainSeparator = _buildDomainSeparator();\\n        _cachedThis = address(this);\\n    }\\n\\n    /**\\n     * @dev Returns the domain separator for the current chain.\\n     */\\n    function _domainSeparatorV4() internal view returns (bytes32) {\\n        if (address(this) == _cachedThis && block.chainid == _cachedChainId) {\\n            return _cachedDomainSeparator;\\n        } else {\\n            return _buildDomainSeparator();\\n        }\\n    }\\n\\n    function _buildDomainSeparator() private view returns (bytes32) {\\n        return keccak256(abi.encode(_TYPE_HASH, _hashedName, _hashedVersion, block.chainid, address(this)));\\n    }\\n\\n    /**\\n     * @dev Given an already https://eips.ethereum.org/EIPS/eip-712#definition-of-hashstruct[hashed struct], this\\n     * function returns the hash of the fully encoded EIP712 message for this domain.\\n     *\\n     * This hash can be used together with {ECDSA-recover} to obtain the signer of a message. For example:\\n     *\\n     * ```solidity\\n     * bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(\\n     *     keccak256(\\\"Mail(address to,string contents)\\\"),\\n     *     mailTo,\\n     *     keccak256(bytes(mailContents))\\n     * )));\\n     * address signer = ECDSA.recover(digest, signature);\\n     * ```\\n     */\\n    function _hashTypedDataV4(bytes32 structHash) internal view virtual returns (bytes32) {\\n        return ECDSA.toTypedDataHash(_domainSeparatorV4(), structHash);\\n    }\\n\\n    /**\\n     * @dev See {EIP-5267}.\\n     *\\n     * _Available since v4.9._\\n     */\\n    function eip712Domain()\\n        public\\n        view\\n        virtual\\n        override\\n        returns (\\n            bytes1 fields,\\n            string memory name,\\n            string memory version,\\n            uint256 chainId,\\n            address verifyingContract,\\n            bytes32 salt,\\n            uint256[] memory extensions\\n        )\\n    {\\n        return (\\n            hex\\\"0f\\\", // 01111\\n            _name.toStringWithFallback(_nameFallback),\\n            _version.toStringWithFallback(_versionFallback),\\n            block.chainid,\\n            address(this),\\n            bytes32(0),\\n            new uint256[](0)\\n        );\\n    }\\n}\\n\",\"keccak256\":\"0x8432884527a7ad91e6eed1cfc5a0811ae2073e5bca107bd0ca442e9236b03dbd\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/math/Math.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/math/Math.sol)\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Standard math utilities missing in the Solidity language.\\n */\\nlibrary Math {\\n    enum Rounding {\\n        Down, // Toward negative infinity\\n        Up, // Toward infinity\\n        Zero // Toward zero\\n    }\\n\\n    /**\\n     * @dev Returns the largest of two numbers.\\n     */\\n    function max(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a > b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the smallest of two numbers.\\n     */\\n    function min(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a < b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the average of two numbers. The result is rounded towards\\n     * zero.\\n     */\\n    function average(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b) / 2 can overflow.\\n        return (a & b) + (a ^ b) / 2;\\n    }\\n\\n    /**\\n     * @dev Returns the ceiling of the division of two numbers.\\n     *\\n     * This differs from standard division with `/` in that it rounds up instead\\n     * of rounding down.\\n     */\\n    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b - 1) / b can overflow on addition, so we distribute.\\n        return a == 0 ? 0 : (a - 1) / b + 1;\\n    }\\n\\n    /**\\n     * @notice Calculates floor(x * y / denominator) with full precision. Throws if result overflows a uint256 or denominator == 0\\n     * @dev Original credit to Remco Bloemen under MIT license (https://xn--2-umb.com/21/muldiv)\\n     * with further edits by Uniswap Labs also under MIT license.\\n     */\\n    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {\\n        unchecked {\\n            // 512-bit multiply [prod1 prod0] = x * y. Compute the product mod 2^256 and mod 2^256 - 1, then use\\n            // use the Chinese Remainder Theorem to reconstruct the 512 bit result. The result is stored in two 256\\n            // variables such that product = prod1 * 2^256 + prod0.\\n            uint256 prod0; // Least significant 256 bits of the product\\n            uint256 prod1; // Most significant 256 bits of the product\\n            assembly {\\n                let mm := mulmod(x, y, not(0))\\n                prod0 := mul(x, y)\\n                prod1 := sub(sub(mm, prod0), lt(mm, prod0))\\n            }\\n\\n            // Handle non-overflow cases, 256 by 256 division.\\n            if (prod1 == 0) {\\n                // Solidity will revert if denominator == 0, unlike the div opcode on its own.\\n                // The surrounding unchecked block does not change this fact.\\n                // See https://docs.soliditylang.org/en/latest/control-structures.html#checked-or-unchecked-arithmetic.\\n                return prod0 / denominator;\\n            }\\n\\n            // Make sure the result is less than 2^256. Also prevents denominator == 0.\\n            require(denominator > prod1, \\\"Math: mulDiv overflow\\\");\\n\\n            ///////////////////////////////////////////////\\n            // 512 by 256 division.\\n            ///////////////////////////////////////////////\\n\\n            // Make division exact by subtracting the remainder from [prod1 prod0].\\n            uint256 remainder;\\n            assembly {\\n                // Compute remainder using mulmod.\\n                remainder := mulmod(x, y, denominator)\\n\\n                // Subtract 256 bit number from 512 bit number.\\n                prod1 := sub(prod1, gt(remainder, prod0))\\n                prod0 := sub(prod0, remainder)\\n            }\\n\\n            // Factor powers of two out of denominator and compute largest power of two divisor of denominator. Always >= 1.\\n            // See https://cs.stackexchange.com/q/138556/92363.\\n\\n            // Does not overflow because the denominator cannot be zero at this stage in the function.\\n            uint256 twos = denominator & (~denominator + 1);\\n            assembly {\\n                // Divide denominator by twos.\\n                denominator := div(denominator, twos)\\n\\n                // Divide [prod1 prod0] by twos.\\n                prod0 := div(prod0, twos)\\n\\n                // Flip twos such that it is 2^256 / twos. If twos is zero, then it becomes one.\\n                twos := add(div(sub(0, twos), twos), 1)\\n            }\\n\\n            // Shift in bits from prod1 into prod0.\\n            prod0 |= prod1 * twos;\\n\\n            // Invert denominator mod 2^256. Now that denominator is an odd number, it has an inverse modulo 2^256 such\\n            // that denominator * inv = 1 mod 2^256. Compute the inverse by starting with a seed that is correct for\\n            // four bits. That is, denominator * inv = 1 mod 2^4.\\n            uint256 inverse = (3 * denominator) ^ 2;\\n\\n            // Use the Newton-Raphson iteration to improve the precision. Thanks to Hensel's lifting lemma, this also works\\n            // in modular arithmetic, doubling the correct bits in each step.\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^8\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^16\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^32\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^64\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^128\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^256\\n\\n            // Because the division is now exact we can divide by multiplying with the modular inverse of denominator.\\n            // This will give us the correct result modulo 2^256. Since the preconditions guarantee that the outcome is\\n            // less than 2^256, this is the final result. We don't need to compute the high bits of the result and prod1\\n            // is no longer required.\\n            result = prod0 * inverse;\\n            return result;\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates x * y / denominator with full precision, following the selected rounding direction.\\n     */\\n    function mulDiv(uint256 x, uint256 y, uint256 denominator, Rounding rounding) internal pure returns (uint256) {\\n        uint256 result = mulDiv(x, y, denominator);\\n        if (rounding == Rounding.Up && mulmod(x, y, denominator) > 0) {\\n            result += 1;\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Returns the square root of a number. If the number is not a perfect square, the value is rounded down.\\n     *\\n     * Inspired by Henry S. Warren, Jr.'s \\\"Hacker's Delight\\\" (Chapter 11).\\n     */\\n    function sqrt(uint256 a) internal pure returns (uint256) {\\n        if (a == 0) {\\n            return 0;\\n        }\\n\\n        // For our first guess, we get the biggest power of 2 which is smaller than the square root of the target.\\n        //\\n        // We know that the \\\"msb\\\" (most significant bit) of our target number `a` is a power of 2 such that we have\\n        // `msb(a) <= a < 2*msb(a)`. This value can be written `msb(a)=2**k` with `k=log2(a)`.\\n        //\\n        // This can be rewritten `2**log2(a) <= a < 2**(log2(a) + 1)`\\n        // \\u2192 `sqrt(2**k) <= sqrt(a) < sqrt(2**(k+1))`\\n        // \\u2192 `2**(k/2) <= sqrt(a) < 2**((k+1)/2) <= 2**(k/2 + 1)`\\n        //\\n        // Consequently, `2**(log2(a) / 2)` is a good first approximation of `sqrt(a)` with at least 1 correct bit.\\n        uint256 result = 1 << (log2(a) >> 1);\\n\\n        // At this point `result` is an estimation with one bit of precision. We know the true value is a uint128,\\n        // since it is the square root of a uint256. Newton's method converges quadratically (precision doubles at\\n        // every iteration). We thus need at most 7 iteration to turn our partial result with one bit of precision\\n        // into the expected uint128 result.\\n        unchecked {\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            return min(result, a / result);\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates sqrt(a), following the selected rounding direction.\\n     */\\n    function sqrt(uint256 a, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = sqrt(a);\\n            return result + (rounding == Rounding.Up && result * result < a ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 128;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 64;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 32;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 16;\\n            }\\n            if (value >> 8 > 0) {\\n                value >>= 8;\\n                result += 8;\\n            }\\n            if (value >> 4 > 0) {\\n                value >>= 4;\\n                result += 4;\\n            }\\n            if (value >> 2 > 0) {\\n                value >>= 2;\\n                result += 2;\\n            }\\n            if (value >> 1 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log2(value);\\n            return result + (rounding == Rounding.Up && 1 << result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >= 10 ** 64) {\\n                value /= 10 ** 64;\\n                result += 64;\\n            }\\n            if (value >= 10 ** 32) {\\n                value /= 10 ** 32;\\n                result += 32;\\n            }\\n            if (value >= 10 ** 16) {\\n                value /= 10 ** 16;\\n                result += 16;\\n            }\\n            if (value >= 10 ** 8) {\\n                value /= 10 ** 8;\\n                result += 8;\\n            }\\n            if (value >= 10 ** 4) {\\n                value /= 10 ** 4;\\n                result += 4;\\n            }\\n            if (value >= 10 ** 2) {\\n                value /= 10 ** 2;\\n                result += 2;\\n            }\\n            if (value >= 10 ** 1) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log10(value);\\n            return result + (rounding == Rounding.Up && 10 ** result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 256, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     *\\n     * Adding one to the result gives the number of pairs of hex symbols needed to represent `value` as a hex string.\\n     */\\n    function log256(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 16;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 8;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 4;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 2;\\n            }\\n            if (value >> 8 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 256, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log256(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log256(value);\\n            return result + (rounding == Rounding.Up && 1 << (result << 3) < value ? 1 : 0);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xe4455ac1eb7fc497bb7402579e7b4d64d928b846fce7d2b6fde06d366f21c2b3\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/math/SignedMath.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/math/SignedMath.sol)\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Standard signed math utilities missing in the Solidity language.\\n */\\nlibrary SignedMath {\\n    /**\\n     * @dev Returns the largest of two signed numbers.\\n     */\\n    function max(int256 a, int256 b) internal pure returns (int256) {\\n        return a > b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the smallest of two signed numbers.\\n     */\\n    function min(int256 a, int256 b) internal pure returns (int256) {\\n        return a < b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the average of two signed numbers without overflow.\\n     * The result is rounded towards zero.\\n     */\\n    function average(int256 a, int256 b) internal pure returns (int256) {\\n        // Formula from the book \\\"Hacker's Delight\\\"\\n        int256 x = (a & b) + ((a ^ b) >> 1);\\n        return x + (int256(uint256(x) >> 255) & (a ^ b));\\n    }\\n\\n    /**\\n     * @dev Returns the absolute unsigned value of a signed value.\\n     */\\n    function abs(int256 n) internal pure returns (uint256) {\\n        unchecked {\\n            // must be unchecked in order to support `n = type(int256).min`\\n            return uint256(n >= 0 ? n : -n);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xf92515413956f529d95977adc9b0567d583c6203fc31ab1c23824c35187e3ddc\",\"license\":\"MIT\"},\"contracts/Common.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\n// A representation of an empty/uninitialized UID.\\nbytes32 constant EMPTY_UID = 0;\\n\\n// A zero expiration represents an non-expiring attestation.\\nuint64 constant NO_EXPIRATION_TIME = 0;\\n\\nerror AccessDenied();\\nerror DeadlineExpired();\\nerror InvalidEAS();\\nerror InvalidLength();\\nerror InvalidSignature();\\nerror NotFound();\\n\\n/// @notice A struct representing ECDSA signature data.\\nstruct Signature {\\n    uint8 v; // The recovery ID.\\n    bytes32 r; // The x-coordinate of the nonce R.\\n    bytes32 s; // The signature data.\\n}\\n\\n/// @notice A struct representing a single attestation.\\nstruct Attestation {\\n    bytes32 uid; // A unique identifier of the attestation.\\n    bytes32 schema; // The unique identifier of the schema.\\n    uint64 time; // The time when the attestation was created (Unix timestamp).\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    uint64 revocationTime; // The time when the attestation was revoked (Unix timestamp).\\n    bytes32 refUID; // The UID of the related attestation.\\n    address recipient; // The recipient of the attestation.\\n    address attester; // The attester/sender of the attestation.\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes data; // Custom attestation data.\\n}\\n\\n/// @notice A helper function to work with unchecked iterators in loops.\\nfunction uncheckedInc(uint256 i) pure returns (uint256 j) {\\n    unchecked {\\n        j = i + 1;\\n    }\\n}\\n\",\"keccak256\":\"0x957bd2e6d0d6d637f86208b135c29fbaf4412cb08e5e7a61ede16b80561bf685\",\"license\":\"MIT\"},\"contracts/IEAS.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaRegistry } from \\\"./ISchemaRegistry.sol\\\";\\nimport { Attestation, Signature } from \\\"./Common.sol\\\";\\n\\n/// @notice A struct representing the arguments of the attestation request.\\nstruct AttestationRequestData {\\n    address recipient; // The recipient of the attestation.\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes32 refUID; // The UID of the related attestation.\\n    bytes data; // Custom attestation data.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/// @notice A struct representing the full arguments of the attestation request.\\nstruct AttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the full delegated attestation request.\\nstruct DelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n    Signature signature; // The ECDSA signature data.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the multi attestation request.\\nstruct MultiAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi attestation request.\\nstruct MultiDelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation requests.\\n    Signature[] signatures; // The ECDSA signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the arguments of the revocation request.\\nstruct RevocationRequestData {\\n    bytes32 uid; // The UID of the attestation to revoke.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/// @notice A struct representing the full arguments of the revocation request.\\nstruct RevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n}\\n\\n/// @notice A struct representing the arguments of the full delegated revocation request.\\nstruct DelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n    Signature signature; // The ECDSA signature data.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the multi revocation request.\\nstruct MultiRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi revocation request.\\nstruct MultiDelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation requests.\\n    Signature[] signatures; // The ECDSA signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @title IEAS\\n/// @notice EAS - Ethereum Attestation Service interface.\\ninterface IEAS {\\n    /// @notice Emitted when an attestation has been made.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param attester The attesting account.\\n    /// @param uid The UID the revoked attestation.\\n    /// @param schemaUID The UID of the schema.\\n    event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);\\n\\n    /// @notice Emitted when an attestation has been revoked.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param attester The attesting account.\\n    /// @param schemaUID The UID of the schema.\\n    /// @param uid The UID the revoked attestation.\\n    event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);\\n\\n    /// @notice Emitted when a data has been timestamped.\\n    /// @param data The data.\\n    /// @param timestamp The timestamp.\\n    event Timestamped(bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /// @notice Emitted when a data has been revoked.\\n    /// @param revoker The address of the revoker.\\n    /// @param data The data.\\n    /// @param timestamp The timestamp.\\n    event RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /// @notice Returns the address of the global schema registry.\\n    /// @return The address of the global schema registry.\\n    function getSchemaRegistry() external view returns (ISchemaRegistry);\\n\\n    /// @notice Attests to a specific schema.\\n    /// @param request The arguments of the attestation request.\\n    /// @return The UID of the new attestation.\\n    ///\\n    /// Example:\\n    ///     attest({\\n    ///         schema: \\\"0facc36681cbe2456019c1b0d1e7bedd6d1d40f6f324bf3dd3a4cef2999200a0\\\",\\n    ///         data: {\\n    ///             recipient: \\\"0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf\\\",\\n    ///             expirationTime: 0,\\n    ///             revocable: true,\\n    ///             refUID: \\\"0x0000000000000000000000000000000000000000000000000000000000000000\\\",\\n    ///             data: \\\"0xF00D\\\",\\n    ///             value: 0\\n    ///         }\\n    ///     })\\n    function attest(AttestationRequest calldata request) external payable returns (bytes32);\\n\\n    /// @notice Attests to a specific schema via the provided ECDSA signature.\\n    /// @param delegatedRequest The arguments of the delegated attestation request.\\n    /// @return The UID of the new attestation.\\n    ///\\n    /// Example:\\n    ///     attestByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function attestByDelegation(\\n        DelegatedAttestationRequest calldata delegatedRequest\\n    ) external payable returns (bytes32);\\n\\n    /// @notice Attests to multiple schemas.\\n    /// @param multiRequests The arguments of the multi attestation requests. The requests should be grouped by distinct\\n    ///     schema ids to benefit from the best batching optimization.\\n    /// @return The UIDs of the new attestations.\\n    ///\\n    /// Example:\\n    ///     multiAttest([{\\n    ///         schema: '0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd',\\n    ///         data: [{\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 0,\\n    ///             revocable: false,\\n    ///             refUID: '0x480df4a039efc31b11bfdf491b383ca138b6bde160988222a2a3509c02cee174',\\n    ///             data: '0x00',\\n    ///             value: 0\\n    ///         }],\\n    ///     },\\n    ///     {\\n    ///         schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n    ///         data: [{\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 0,\\n    ///             revocable: true,\\n    ///             refUID: '0x75bf2ed8dca25a8190c50c52db136664de25b2449535839008ccfdab469b214f',\\n    ///             data: '0x12345678',\\n    ///             value: 0\\n    ///         },\\n    ///     }])\\n    function multiAttest(MultiAttestationRequest[] calldata multiRequests) external payable returns (bytes32[] memory);\\n\\n    /// @notice Attests to multiple schemas using via provided ECDSA signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi attestation requests. The requests should be\\n    ///     grouped by distinct schema ids to benefit from the best batching optimization.\\n    /// @return The UIDs of the new attestations.\\n    ///\\n    /// Example:\\n    ///     multiAttestByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         {\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 0,\\n    ///             revocable: false,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x00',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiAttestByDelegation(\\n        MultiDelegatedAttestationRequest[] calldata multiDelegatedRequests\\n    ) external payable returns (bytes32[] memory);\\n\\n    /// @notice Revokes an existing attestation to a specific schema.\\n    /// @param request The arguments of the revocation request.\\n    ///\\n    /// Example:\\n    ///     revoke({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             uid: '0x101032e487642ee04ee17049f99a70590c735b8614079fc9275f9dd57c00966d',\\n    ///             value: 0\\n    ///         }\\n    ///     })\\n    function revoke(RevocationRequest calldata request) external payable;\\n\\n    /// @notice Revokes an existing attestation to a specific schema via the provided ECDSA signature.\\n    /// @param delegatedRequest The arguments of the delegated revocation request.\\n    ///\\n    /// Example:\\n    ///     revokeByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 27,\\n    ///             r: '0xb593...7142',\\n    ///             s: '0x0f5b...2cce'\\n    ///         },\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function revokeByDelegation(DelegatedRevocationRequest calldata delegatedRequest) external payable;\\n\\n    /// @notice Revokes existing attestations to multiple schemas.\\n    /// @param multiRequests The arguments of the multi revocation requests. The requests should be grouped by distinct\\n    ///     schema ids to benefit from the best batching optimization.\\n    ///\\n    /// Example:\\n    ///     multiRevoke([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n    ///             value: 0\\n    ///         }],\\n    ///     },\\n    ///     {\\n    ///         schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n    ///         data: [{\\n    ///             uid: '0x053d42abce1fd7c8fcddfae21845ad34dae287b2c326220b03ba241bc5a8f019',\\n    ///             value: 0\\n    ///         },\\n    ///     }])\\n    function multiRevoke(MultiRevocationRequest[] calldata multiRequests) external payable;\\n\\n    /// @notice Revokes existing attestations to multiple schemas via provided ECDSA signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi revocation attestation requests. The requests\\n    ///     should be grouped by distinct schema ids to benefit from the best batching optimization.\\n    ///\\n    /// Example:\\n    ///     multiRevokeByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiRevokeByDelegation(\\n        MultiDelegatedRevocationRequest[] calldata multiDelegatedRequests\\n    ) external payable;\\n\\n    /// @notice Timestamps the specified bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was timestamped with.\\n    function timestamp(bytes32 data) external returns (uint64);\\n\\n    /// @notice Timestamps the specified multiple bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was timestamped with.\\n    function multiTimestamp(bytes32[] calldata data) external returns (uint64);\\n\\n    /// @notice Revokes the specified bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was revoked with.\\n    function revokeOffchain(bytes32 data) external returns (uint64);\\n\\n    /// @notice Revokes the specified multiple bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was revoked with.\\n    function multiRevokeOffchain(bytes32[] calldata data) external returns (uint64);\\n\\n    /// @notice Returns an existing attestation by UID.\\n    /// @param uid The UID of the attestation to retrieve.\\n    /// @return The attestation data members.\\n    function getAttestation(bytes32 uid) external view returns (Attestation memory);\\n\\n    /// @notice Checks whether an attestation exists.\\n    /// @param uid The UID of the attestation to retrieve.\\n    /// @return Whether an attestation exists.\\n    function isAttestationValid(bytes32 uid) external view returns (bool);\\n\\n    /// @notice Returns the timestamp that the specified data was timestamped with.\\n    /// @param data The data to query.\\n    /// @return The timestamp the data was timestamped with.\\n    function getTimestamp(bytes32 data) external view returns (uint64);\\n\\n    /// @notice Returns the timestamp that the specified data was timestamped with.\\n    /// @param data The data to query.\\n    /// @return The timestamp the data was timestamped with.\\n    function getRevokeOffchain(address revoker, bytes32 data) external view returns (uint64);\\n}\\n\",\"keccak256\":\"0xd5a192f0bcee5372b69b0bb746c26317a2691dd10bfa52adbd08a9b723a55036\",\"license\":\"MIT\"},\"contracts/ISchemaRegistry.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\n/// @notice A struct representing a record for a submitted schema.\\nstruct SchemaRecord {\\n    bytes32 uid; // The unique identifier of the schema.\\n    ISchemaResolver resolver; // Optional schema resolver.\\n    bool revocable; // Whether the schema allows revocations explicitly.\\n    string schema; // Custom specification of the schema (e.g., an ABI).\\n}\\n\\n/// @title ISchemaRegistry\\n/// @notice The interface of global attestation schemas for the Ethereum Attestation Service protocol.\\ninterface ISchemaRegistry {\\n    /// @notice Emitted when a new schema has been registered\\n    /// @param uid The schema UID.\\n    /// @param registerer The address of the account used to register the schema.\\n    /// @param schema The schema data.\\n    event Registered(bytes32 indexed uid, address indexed registerer, SchemaRecord schema);\\n\\n    /// @notice Submits and reserves a new schema\\n    /// @param schema The schema data schema.\\n    /// @param resolver An optional schema resolver.\\n    /// @param revocable Whether the schema allows revocations explicitly.\\n    /// @return The UID of the new schema.\\n    function register(string calldata schema, ISchemaResolver resolver, bool revocable) external returns (bytes32);\\n\\n    /// @notice Returns an existing schema by UID\\n    /// @param uid The UID of the schema to retrieve.\\n    /// @return The schema data members.\\n    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);\\n}\\n\",\"keccak256\":\"0x772b1ebcf3e5c93fecb53762e11bbdae75fcb667deea4ac21134fccfe78326e4\",\"license\":\"MIT\"},\"contracts/Semver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.4;\\n\\nimport { Strings } from \\\"@openzeppelin/contracts/utils/Strings.sol\\\";\\n\\n/// @title Semver\\n/// @notice A simple contract for managing contract versions.\\ncontract Semver {\\n    // Contract's major version number.\\n    uint256 private immutable _major;\\n\\n    // Contract's minor version number.\\n    uint256 private immutable _minor;\\n\\n    // Contract's patch version number.\\n    uint256 private immutable _path;\\n\\n    /// @dev Create a new Semver instance.\\n    /// @param major Major version number.\\n    /// @param minor Minor version number.\\n    /// @param patch Patch version number.\\n    constructor(uint256 major, uint256 minor, uint256 patch) {\\n        _major = major;\\n        _minor = minor;\\n        _path = patch;\\n    }\\n\\n    /// @notice Returns the full semver contract version.\\n    /// @return Semver contract version as a string.\\n    function version() external view returns (string memory) {\\n        return\\n            string(\\n                abi.encodePacked(Strings.toString(_major), \\\".\\\", Strings.toString(_minor), \\\".\\\", Strings.toString(_path))\\n            );\\n    }\\n}\\n\",\"keccak256\":\"0x5883c852730b00d73b10475f3b382afce8f30b89f337078ec03a66c463e048a8\",\"license\":\"MIT\"},\"contracts/eip712/proxy/EIP712Proxy.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\nimport { EIP712 } from \\\"@openzeppelin/contracts/utils/cryptography/EIP712.sol\\\";\\nimport { ECDSA } from \\\"@openzeppelin/contracts/utils/cryptography/ECDSA.sol\\\";\\n\\n// prettier-ignore\\nimport {\\n    AccessDenied,\\n    DeadlineExpired,\\n    Signature,\\n    InvalidEAS,\\n    InvalidLength,\\n    InvalidSignature,\\n    NotFound,\\n    NO_EXPIRATION_TIME,\\n    uncheckedInc\\n} from \\\"../../Common.sol\\\";\\n\\n// prettier-ignore\\nimport {\\n    AttestationRequest,\\n    AttestationRequestData,\\n    DelegatedAttestationRequest,\\n    DelegatedRevocationRequest,\\n    IEAS,\\n    MultiAttestationRequest,\\n    MultiDelegatedAttestationRequest,\\n    MultiDelegatedRevocationRequest,\\n    MultiRevocationRequest,\\n    RevocationRequest,\\n    RevocationRequestData\\n} from \\\"../../IEAS.sol\\\";\\n\\nimport { Semver } from \\\"../../Semver.sol\\\";\\n\\n/// @notice A struct representing the full arguments of the full delegated attestation request.\\nstruct DelegatedProxyAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n    Signature signature; // The EIP712 signature data.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi attestation request.\\nstruct MultiDelegatedProxyAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation requests.\\n    Signature[] signatures; // The EIP712 signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the arguments of the full delegated revocation request.\\nstruct DelegatedProxyRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n    Signature signature; // The EIP712 signature data.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi revocation request.\\nstruct MultiDelegatedProxyRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation requests.\\n    Signature[] signatures; // The EIP712 signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @title EIP712Proxy\\n/// @notice This utility contract an be used to aggregate delegated attestations without requiring a specific order via\\n///     nonces. The contract doesn't request nonces and implements replay protection by storing ***immalleable***\\n///     signatures.\\ncontract EIP712Proxy is Semver, EIP712 {\\n    error UsedSignature();\\n\\n    // The hash of the data type used to relay calls to the attest function. It's the value of\\n    // keccak256(\\\"Attest(bytes32 schema,address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value,uint64 deadline)\\\").\\n    bytes32 private constant ATTEST_PROXY_TYPEHASH = 0x9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f814567;\\n\\n    // The hash of the data type used to relay calls to the revoke function. It's the value of\\n    // keccak256(\\\"Revoke(bytes32 schema,bytes32 uid,uint256 value,uint64 deadline)\\\").\\n    bytes32 private constant REVOKE_PROXY_TYPEHASH = 0xd4e76f924411647a916bb4ae4631b3cf45c44e2da56ed1c63edb18ebc97ba5e4;\\n\\n    // The global EAS contract.\\n    IEAS private immutable _eas;\\n\\n    // The user readable name of the signing domain.\\n    string private _name;\\n\\n    // The global mapping between proxy attestations and their attesters, so that we can verify that only the original\\n    // attester is able to revert attestations by proxy.\\n    mapping(bytes32 uid => address attester) private _attesters;\\n\\n    // Replay protection signatures.\\n    mapping(bytes signature => bool used) private _signatures;\\n\\n    /// @dev Creates a new EIP1271Verifier instance.\\n    /// @param eas The address of the global EAS contract.\\n    /// @param name The user readable name of the signing domain.\\n    constructor(IEAS eas, string memory name) Semver(1, 2, 0) EIP712(name, \\\"1.2.0\\\") {\\n        if (address(eas) == address(0)) {\\n            revert InvalidEAS();\\n        }\\n\\n        _eas = eas;\\n        _name = name;\\n    }\\n\\n    /// @notice Returns the EAS.\\n    function getEAS() external view returns (IEAS) {\\n        return _eas;\\n    }\\n\\n    /// @notice Returns the domain separator used in the encoding of the signatures for attest, and revoke.\\n    function getDomainSeparator() external view returns (bytes32) {\\n        return _domainSeparatorV4();\\n    }\\n\\n    /// Returns the EIP712 type hash for the attest function.\\n    function getAttestTypeHash() external pure returns (bytes32) {\\n        return ATTEST_PROXY_TYPEHASH;\\n    }\\n\\n    /// Returns the EIP712 type hash for the revoke function.\\n    function getRevokeTypeHash() external pure returns (bytes32) {\\n        return REVOKE_PROXY_TYPEHASH;\\n    }\\n\\n    /// Returns the EIP712 name.\\n    function getName() external view returns (string memory) {\\n        return _name;\\n    }\\n\\n    /// Returns the attester for a given uid.\\n    function getAttester(bytes32 uid) external view returns (address) {\\n        return _attesters[uid];\\n    }\\n\\n    /// @notice Attests to a specific schema via the provided EIP712 signature.\\n    /// @param delegatedRequest The arguments of the delegated attestation request.\\n    /// @return The UID of the new attestation.\\n    ///\\n    /// Example:\\n    ///     attestByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function attestByDelegation(\\n        DelegatedProxyAttestationRequest calldata delegatedRequest\\n    ) public payable virtual returns (bytes32) {\\n        _verifyAttest(delegatedRequest);\\n\\n        bytes32 uid = _eas.attest{ value: msg.value }(\\n            AttestationRequest({ schema: delegatedRequest.schema, data: delegatedRequest.data })\\n        );\\n\\n        _attesters[uid] = delegatedRequest.attester;\\n\\n        return uid;\\n    }\\n\\n    /// @notice Attests to multiple schemas using via provided EIP712 signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi attestation requests. The requests should be\\n    ///     grouped by distinct schema ids to benefit from the best batching optimization.\\n    /// @return The UIDs of the new attestations.\\n    ///\\n    /// Example:\\n    ///     multiAttestByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         {\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 0,\\n    ///             revocable: false,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x00',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiAttestByDelegation(\\n        MultiDelegatedProxyAttestationRequest[] calldata multiDelegatedRequests\\n    ) public payable virtual returns (bytes32[] memory) {\\n        uint256 length = multiDelegatedRequests.length;\\n        MultiAttestationRequest[] memory multiRequests = new MultiAttestationRequest[](length);\\n\\n        for (uint256 i = 0; i < length; i = uncheckedInc(i)) {\\n            MultiDelegatedProxyAttestationRequest calldata multiDelegatedRequest = multiDelegatedRequests[i];\\n            AttestationRequestData[] calldata data = multiDelegatedRequest.data;\\n\\n            // Ensure that no inputs are missing.\\n            uint256 dataLength = data.length;\\n            if (dataLength == 0 || dataLength != multiDelegatedRequest.signatures.length) {\\n                revert InvalidLength();\\n            }\\n\\n            // Verify EIP712 signatures. Please note that the signatures are assumed to be signed with increasing nonces.\\n            for (uint256 j = 0; j < dataLength; j = uncheckedInc(j)) {\\n                _verifyAttest(\\n                    DelegatedProxyAttestationRequest({\\n                        schema: multiDelegatedRequest.schema,\\n                        data: data[j],\\n                        signature: multiDelegatedRequest.signatures[j],\\n                        attester: multiDelegatedRequest.attester,\\n                        deadline: multiDelegatedRequest.deadline\\n                    })\\n                );\\n            }\\n\\n            multiRequests[i] = MultiAttestationRequest({ schema: multiDelegatedRequest.schema, data: data });\\n        }\\n\\n        bytes32[] memory uids = _eas.multiAttest{ value: msg.value }(multiRequests);\\n\\n        // Store all attesters, according to the order of the attestation requests.\\n        uint256 uidCounter = 0;\\n\\n        for (uint256 i = 0; i < length; i = uncheckedInc(i)) {\\n            MultiDelegatedProxyAttestationRequest calldata multiDelegatedRequest = multiDelegatedRequests[i];\\n            AttestationRequestData[] calldata data = multiDelegatedRequest.data;\\n\\n            uint256 dataLength = data.length;\\n            for (uint256 j = 0; j < dataLength; j = uncheckedInc(j)) {\\n                _attesters[uids[uidCounter]] = multiDelegatedRequest.attester;\\n\\n                unchecked {\\n                    ++uidCounter;\\n                }\\n            }\\n        }\\n\\n        return uids;\\n    }\\n\\n    /// @notice Revokes an existing attestation to a specific schema via the provided EIP712 signature.\\n    /// @param delegatedRequest The arguments of the delegated revocation request.\\n    ///\\n    /// Example:\\n    ///     revokeByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 27,\\n    ///             r: '0xb593...7142',\\n    ///             s: '0x0f5b...2cce'\\n    ///         },\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function revokeByDelegation(DelegatedProxyRevocationRequest calldata delegatedRequest) public payable virtual {\\n        _verifyRevoke(delegatedRequest);\\n\\n        return\\n            _eas.revoke{ value: msg.value }(\\n                RevocationRequest({ schema: delegatedRequest.schema, data: delegatedRequest.data })\\n            );\\n    }\\n\\n    /// @notice Revokes existing attestations to multiple schemas via provided EIP712 signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi revocation attestation requests. The requests\\n    ///     should be grouped by distinct schema ids to benefit from the best batching optimization.\\n    ///\\n    /// Example:\\n    ///     multiRevokeByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiRevokeByDelegation(\\n        MultiDelegatedProxyRevocationRequest[] calldata multiDelegatedRequests\\n    ) public payable virtual {\\n        uint256 length = multiDelegatedRequests.length;\\n        MultiRevocationRequest[] memory multiRequests = new MultiRevocationRequest[](length);\\n\\n        for (uint256 i = 0; i < length; i = uncheckedInc(i)) {\\n            MultiDelegatedProxyRevocationRequest memory multiDelegatedRequest = multiDelegatedRequests[i];\\n            RevocationRequestData[] memory data = multiDelegatedRequest.data;\\n\\n            // Ensure that no inputs are missing.\\n            uint256 dataLength = data.length;\\n            if (dataLength == 0 || dataLength != multiDelegatedRequest.signatures.length) {\\n                revert InvalidLength();\\n            }\\n\\n            // Verify EIP712 signatures. Please note that the signatures are assumed to be signed with increasing nonces.\\n            for (uint256 j = 0; j < dataLength; j = uncheckedInc(j)) {\\n                RevocationRequestData memory requestData = data[j];\\n\\n                _verifyRevoke(\\n                    DelegatedProxyRevocationRequest({\\n                        schema: multiDelegatedRequest.schema,\\n                        data: requestData,\\n                        signature: multiDelegatedRequest.signatures[j],\\n                        revoker: multiDelegatedRequest.revoker,\\n                        deadline: multiDelegatedRequest.deadline\\n                    })\\n                );\\n            }\\n\\n            multiRequests[i] = MultiRevocationRequest({ schema: multiDelegatedRequest.schema, data: data });\\n        }\\n\\n        _eas.multiRevoke{ value: msg.value }(multiRequests);\\n    }\\n\\n    /// @dev Verifies delegated attestation request.\\n    /// @param request The arguments of the delegated attestation request.\\n    function _verifyAttest(DelegatedProxyAttestationRequest memory request) internal {\\n        if (request.deadline != NO_EXPIRATION_TIME && request.deadline < _time()) {\\n            revert DeadlineExpired();\\n        }\\n\\n        AttestationRequestData memory data = request.data;\\n        Signature memory signature = request.signature;\\n\\n        _verifyUnusedSignature(signature);\\n\\n        bytes32 digest = _hashTypedDataV4(\\n            keccak256(\\n                abi.encode(\\n                    ATTEST_PROXY_TYPEHASH,\\n                    request.schema,\\n                    data.recipient,\\n                    data.expirationTime,\\n                    data.revocable,\\n                    data.refUID,\\n                    keccak256(data.data),\\n                    data.value,\\n                    request.deadline\\n                )\\n            )\\n        );\\n\\n        if (ECDSA.recover(digest, signature.v, signature.r, signature.s) != request.attester) {\\n            revert InvalidSignature();\\n        }\\n    }\\n\\n    /// @dev Verifies delegated revocation request.\\n    /// @param request The arguments of the delegated revocation request.\\n    function _verifyRevoke(DelegatedProxyRevocationRequest memory request) internal {\\n        if (request.deadline != NO_EXPIRATION_TIME && request.deadline < _time()) {\\n            revert DeadlineExpired();\\n        }\\n\\n        RevocationRequestData memory data = request.data;\\n\\n        // Allow only original attesters to revoke their attestations.\\n        address attester = _attesters[data.uid];\\n        if (attester == address(0)) {\\n            revert NotFound();\\n        }\\n\\n        if (attester != msg.sender) {\\n            revert AccessDenied();\\n        }\\n\\n        Signature memory signature = request.signature;\\n\\n        _verifyUnusedSignature(signature);\\n\\n        bytes32 digest = _hashTypedDataV4(\\n            keccak256(abi.encode(REVOKE_PROXY_TYPEHASH, request.schema, data.uid, data.value, request.deadline))\\n        );\\n\\n        if (ECDSA.recover(digest, signature.v, signature.r, signature.s) != request.revoker) {\\n            revert InvalidSignature();\\n        }\\n    }\\n\\n    /// @dev Ensures that the provided EIP712 signature wasn't already used.\\n    /// @param signature The EIP712 signature data.\\n    function _verifyUnusedSignature(Signature memory signature) internal {\\n        bytes memory packedSignature = abi.encodePacked(signature.v, signature.r, signature.s);\\n\\n        if (_signatures[packedSignature]) {\\n            revert UsedSignature();\\n        }\\n\\n        _signatures[packedSignature] = true;\\n    }\\n\\n    /// @dev Returns the current's block timestamp. This method is overridden during tests and used to simulate the\\n    ///     current block time.\\n    function _time() internal view virtual returns (uint64) {\\n        return uint64(block.timestamp);\\n    }\\n}\\n\",\"keccak256\":\"0x0b0854f743bc2a2541552b9d70d52faa678a9c7cbd87190decf8ab8bde69ddb3\",\"license\":\"MIT\"},\"contracts/resolver/ISchemaResolver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { Attestation } from \\\"../Common.sol\\\";\\n\\n/// @title ISchemaResolver\\n/// @notice The interface of an optional schema resolver.\\ninterface ISchemaResolver {\\n    /// @notice Checks if the resolver can be sent ETH.\\n    /// @return Whether the resolver supports ETH transfers.\\n    function isPayable() external pure returns (bool);\\n\\n    /// @notice Processes an attestation and verifies whether it's valid.\\n    /// @param attestation The new attestation.\\n    /// @return Whether the attestation is valid.\\n    function attest(Attestation calldata attestation) external payable returns (bool);\\n\\n    /// @notice Processes multiple attestations and verifies whether they are valid.\\n    /// @param attestations The new attestations.\\n    /// @param values Explicit ETH amounts which were sent with each attestation.\\n    /// @return Whether all the attestations are valid.\\n    function multiAttest(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n\\n    /// @notice Processes an attestation revocation and verifies if it can be revoked.\\n    /// @param attestation The existing attestation to be revoked.\\n    /// @return Whether the attestation can be revoked.\\n    function revoke(Attestation calldata attestation) external payable returns (bool);\\n\\n    /// @notice Processes revocation of multiple attestation and verifies they can be revoked.\\n    /// @param attestations The existing attestations to be revoked.\\n    /// @param values Explicit ETH amounts which were sent with each revocation.\\n    /// @return Whether the attestations can be revoked.\\n    function multiRevoke(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n}\\n\",\"keccak256\":\"0xb74b64e20b90b35004750d2c78ceb114a304975d22d71bd9a2a9de0d483f0395\",\"license\":\"MIT\"}},\"version\":1}",
        "bytecode": "0x6101e06040523480156200001257600080fd5b5060405162002d7638038062002d7683398101604081905262000035916200022c565b6040805180820190915260058152640312e322e360dc1b60208201526001608052600260a052600060c0819052829190620000729083906200016b565b61018052620000838160016200016b565b6101a052815160208084019190912061014052815190820120610160524661010052620001146101405161016051604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f60208201529081019290925260608201524660808201523060a082015260009060c00160405160208183030381529060405280519060200120905090565b60e052505030610120526001600160a01b03821662000146576040516341bc07ff60e11b815260040160405180910390fd5b6001600160a01b0382166101c052600262000162828262000396565b505050620004bc565b60006020835110156200018b576200018383620001a4565b90506200019e565b8162000198848262000396565b5060ff90505b92915050565b600080829050601f81511115620001db578260405163305a27a960e01b8152600401620001d2919062000462565b60405180910390fd5b8051620001e88262000497565b179392505050565b634e487b7160e01b600052604160045260246000fd5b60005b838110156200022357818101518382015260200162000209565b50506000910152565b600080604083850312156200024057600080fd5b82516001600160a01b03811681146200025857600080fd5b60208401519092506001600160401b03808211156200027657600080fd5b818501915085601f8301126200028b57600080fd5b815181811115620002a057620002a0620001f0565b604051601f8201601f19908116603f01168101908382118183101715620002cb57620002cb620001f0565b81604052828152886020848701011115620002e557600080fd5b620002f883602083016020880162000206565b80955050505050509250929050565b600181811c908216806200031c57607f821691505b6020821081036200033d57634e487b7160e01b600052602260045260246000fd5b50919050565b601f8211156200039157600081815260208120601f850160051c810160208610156200036c5750805b601f850160051c820191505b818110156200038d5782815560010162000378565b5050505b505050565b81516001600160401b03811115620003b257620003b2620001f0565b620003ca81620003c3845462000307565b8462000343565b602080601f831160018114620004025760008415620003e95750858301515b600019600386901b1c1916600185901b1785556200038d565b600085815260208120601f198616915b82811015620004335788860151825594840194600190910190840162000412565b5085821015620004525787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b60208152600082518060208401526200048381604085016020870162000206565b601f01601f19169190910160400192915050565b805160208083015191908110156200033d5760001960209190910360031b1b16919050565b60805160a05160c05160e05161010051610120516101405161016051610180516101a0516101c0516128176200055f600039600081816101e4015281816104d1015281816105e901528181610a9d0152610c7e015260006107f8015260006107ce015260006113d9015260006113b10152600061130c0152600061133601526000611360015260006107760152600061074d0152600061072401526128176000f3fe6080604052600436106100c75760003560e01c806365c40b9c11610074578063a6d4dbc71161004e578063a6d4dbc714610250578063b83010d314610263578063ed24911d1461029657600080fd5b806365c40b9c146101d557806384b0196e14610208578063954115251461023057600080fd5b806317d7de7c116100a557806317d7de7c1461018b5780633c042715146101ad57806354fd4d50146101c057600080fd5b80630eabf660146100cc57806310d736d5146100e157806312b11a171461014e575b600080fd5b6100df6100da366004611a00565b6102ab565b005b3480156100ed57600080fd5b506101246100fc366004611a42565b60009081526003602052604090205473ffffffffffffffffffffffffffffffffffffffff1690565b60405173ffffffffffffffffffffffffffffffffffffffff90911681526020015b60405180910390f35b34801561015a57600080fd5b507f9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f8145675b604051908152602001610145565b34801561019757600080fd5b506101a0610540565b6040516101459190611ac9565b61017d6101bb366004611ae3565b6105d2565b3480156101cc57600080fd5b506101a061071d565b3480156101e157600080fd5b507f0000000000000000000000000000000000000000000000000000000000000000610124565b34801561021457600080fd5b5061021d6107c0565b6040516101459796959493929190611b1e565b61024361023e366004611a00565b610864565b6040516101459190611bdd565b6100df61025e366004611c21565b610c65565b34801561026f57600080fd5b507fd4e76f924411647a916bb4ae4631b3cf45c44e2da56ed1c63edb18ebc97ba5e461017d565b3480156102a257600080fd5b5061017d610d65565b8060008167ffffffffffffffff8111156102c7576102c7611c3a565b60405190808252806020026020018201604052801561030d57816020015b6040805180820190915260008152606060208201528152602001906001900390816102e55790505b50905060005b8281101561049357600085858381811061032f5761032f611c69565b90506020028101906103419190611c98565b61034a90611f05565b602081015180519192509080158061036757508260400151518114155b1561039e576040517f947d5a8400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60005b818110156104485760008382815181106103bd576103bd611c69565b6020026020010151905061043f6040518060a0016040528087600001518152602001838152602001876040015185815181106103fb576103fb611c69565b60200260200101518152602001876060015173ffffffffffffffffffffffffffffffffffffffff168152602001876080015167ffffffffffffffff16815250610d74565b506001016103a1565b506040518060400160405280846000015181526020018381525085858151811061047457610474611c69565b602002602001018190525050505061048c8160010190565b9050610313565b506040517f4cb7e9e500000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001690634cb7e9e5903490610508908590600401612000565b6000604051808303818588803b15801561052157600080fd5b505af1158015610535573d6000803e3d6000fd5b505050505050505050565b60606002805461054f906120cf565b80601f016020809104026020016040519081016040528092919081815260200182805461057b906120cf565b80156105c85780601f1061059d576101008083540402835291602001916105c8565b820191906000526020600020905b8154815290600101906020018083116105ab57829003601f168201915b5050505050905090565b60006105e56105e083612240565b610fb6565b60007f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663f17325e73460405180604001604052808760000135815260200187806020019061064991906122b9565b610652906122ed565b8152506040518363ffffffff1660e01b8152600401610671919061236c565b60206040518083038185885af115801561068f573d6000803e3d6000fd5b50505050506040513d601f19601f820116820180604052508101906106b49190612399565b90506106c660c0840160a085016123b2565b600082815260036020526040902080547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff9290921691909117905592915050565b60606107487f0000000000000000000000000000000000000000000000000000000000000000611189565b6107717f0000000000000000000000000000000000000000000000000000000000000000611189565b61079a7f0000000000000000000000000000000000000000000000000000000000000000611189565b6040516020016107ac939291906123cd565b604051602081830303815290604052905090565b6000606080828080836107f37f000000000000000000000000000000000000000000000000000000000000000083611247565b61081e7f00000000000000000000000000000000000000000000000000000000000000006001611247565b604080516000808252602082019092527f0f000000000000000000000000000000000000000000000000000000000000009b939a50919850469750309650945092509050565b60608160008167ffffffffffffffff81111561088257610882611c3a565b6040519080825280602002602001820160405280156108c857816020015b6040805180820190915260008152606060208201528152602001906001900390816108a05790505b50905060005b82811015610a9857368686838181106108e9576108e9611c69565b90506020028101906108fb9190611c98565b905036600061090d6020840184612443565b90925090508080158061092e575061092860408501856124ab565b90508114155b15610965576040517f947d5a8400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60005b81811015610a4657610a3e6040518060a001604052808760000135815260200186868581811061099a5761099a611c69565b90506020028101906109ac91906122b9565b6109b5906122ed565b81526020016109c760408901896124ab565b858181106109d7576109d7611c69565b9050606002018036038101906109ed9190612512565b8152602001610a026080890160608a016123b2565b73ffffffffffffffffffffffffffffffffffffffff168152602001610a2d60a0890160808a0161252e565b67ffffffffffffffff169052610fb6565b600101610968565b50604080518082019091528435815260208101610a638486612549565b815250868681518110610a7857610a78611c69565b602002602001018190525050505050610a918160010190565b90506108ce565b5060007f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff166344adc90e34846040518363ffffffff1660e01b8152600401610af591906125bd565b60006040518083038185885af1158015610b13573d6000803e3d6000fd5b50505050506040513d6000823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0168201604052610b5a91908101906126b0565b90506000805b84811015610c575736888883818110610b7b57610b7b611c69565b9050602002810190610b8d9190611c98565b9050366000610b9f6020840184612443565b90925090508060005b81811015610c4157610bc060808601606087016123b2565b600360008a8a81518110610bd657610bd6611c69565b6020026020010151815260200190815260200160002060006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550866001019650610c3a8160010190565b9050610ba8565b5050505050610c508160010190565b9050610b60565b509093505050505b92915050565b610c7c610c7736839003830183612741565b610d74565b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663469262673460405180604001604052808560000135815260200185602001803603810190610ce291906127ad565b90526040517fffffffff0000000000000000000000000000000000000000000000000000000060e085901b16815281516004820152602091820151805160248301529091015160448201526064016000604051808303818588803b158015610d4957600080fd5b505af1158015610d5d573d6000803e3d6000fd5b505050505050565b6000610d6f6112f2565b905090565b608081015167ffffffffffffffff1615801590610da857504267ffffffffffffffff16816080015167ffffffffffffffff16105b15610ddf576040517f1ab7da6b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60208082015180516000908152600390925260409091205473ffffffffffffffffffffffffffffffffffffffff1680610e44576040517fc5723b5100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff81163314610e93576040517f4ca8886700000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6040830151610ea18161142a565b835183516020808601516080880151604051600095610f2d95610f12957fd4e76f924411647a916bb4ae4631b3cf45c44e2da56ed1c63edb18ebc97ba5e495929491930194855260208501939093526040840191909152606083015267ffffffffffffffff16608082015260a00190565b60405160208183030381529060405280519060200120611538565b9050846060015173ffffffffffffffffffffffffffffffffffffffff16610f6282846000015185602001518660400151611580565b73ffffffffffffffffffffffffffffffffffffffff1614610faf576040517f8baa579f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050505050565b608081015167ffffffffffffffff1615801590610fea57504267ffffffffffffffff16816080015167ffffffffffffffff16105b15611021576040517f1ab7da6b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b602081015160408201516110348161142a565b60006111017f9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f81456760001b856000015185600001518660200151876040015188606001518960800151805190602001208a60a001518c60800151604051602001610f1299989796959493929190988952602089019790975273ffffffffffffffffffffffffffffffffffffffff95909516604088015267ffffffffffffffff9384166060880152911515608087015260a086015260c085015260e0840191909152166101008201526101200190565b9050836060015173ffffffffffffffffffffffffffffffffffffffff1661113682846000015185602001518660400151611580565b73ffffffffffffffffffffffffffffffffffffffff1614611183576040517f8baa579f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b50505050565b60606000611196836115a8565b600101905060008167ffffffffffffffff8111156111b6576111b6611c3a565b6040519080825280601f01601f1916602001820160405280156111e0576020820181803683370190505b5090508181016020015b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff017f3031323334353637383961626364656600000000000000000000000000000000600a86061a8153600a85049450846111ea57509392505050565b606060ff83146112615761125a8361168a565b9050610c5f565b81805461126d906120cf565b80601f0160208091040260200160405190810160405280929190818152602001828054611299906120cf565b80156112e65780601f106112bb576101008083540402835291602001916112e6565b820191906000526020600020905b8154815290600101906020018083116112c957829003601f168201915b50505050509050610c5f565b60003073ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001614801561135857507f000000000000000000000000000000000000000000000000000000000000000046145b1561138257507f000000000000000000000000000000000000000000000000000000000000000090565b610d6f604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f60208201527f0000000000000000000000000000000000000000000000000000000000000000918101919091527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260009060c00160405160208183030381529060405280519060200120905090565b8051602080830151604080850151905160f89490941b7fff00000000000000000000000000000000000000000000000000000000000000169284019290925260218301526041820152600090606101604051602081830303815290604052905060048160405161149a91906127c9565b9081526040519081900360200190205460ff16156114e4576040517fcce9a82400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60016004826040516114f691906127c9565b90815260405190819003602001902080549115157fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff009092169190911790555050565b6000610c5f6115456112f2565b836040517f19010000000000000000000000000000000000000000000000000000000000008152600281019290925260228201526042902090565b6000806000611591878787876116c9565b9150915061159e816117b8565b5095945050505050565b6000807a184f03e93ff9f4daa797ed6e38ed64bf6a1f01000000000000000083106115f1577a184f03e93ff9f4daa797ed6e38ed64bf6a1f010000000000000000830492506040015b6d04ee2d6d415b85acef8100000000831061161d576d04ee2d6d415b85acef8100000000830492506020015b662386f26fc10000831061163b57662386f26fc10000830492506010015b6305f5e1008310611653576305f5e100830492506008015b612710831061166757612710830492506004015b60648310611679576064830492506002015b600a8310610c5f5760010192915050565b6060600061169783611973565b604080516020808252818301909252919250600091906020820181803683375050509182525060208101929092525090565b6000807f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a083111561170057506000905060036117af565b6040805160008082526020820180845289905260ff881692820192909252606081018690526080810185905260019060a0016020604051602081039080840390855afa158015611754573d6000803e3d6000fd5b50506040517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015191505073ffffffffffffffffffffffffffffffffffffffff81166117a8576000600192509250506117af565b9150600090505b94509492505050565b60008160048111156117cc576117cc6127db565b036117d45750565b60018160048111156117e8576117e86127db565b03611854576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f45434453413a20696e76616c6964207369676e6174757265000000000000000060448201526064015b60405180910390fd5b6002816004811115611868576118686127db565b036118cf576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f45434453413a20696e76616c6964207369676e6174757265206c656e67746800604482015260640161184b565b60038160048111156118e3576118e36127db565b03611970576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202773272076616c60448201527f7565000000000000000000000000000000000000000000000000000000000000606482015260840161184b565b50565b600060ff8216601f811115610c5f576040517fb3512b0c00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60008083601f8401126119c657600080fd5b50813567ffffffffffffffff8111156119de57600080fd5b6020830191508360208260051b85010111156119f957600080fd5b9250929050565b60008060208385031215611a1357600080fd5b823567ffffffffffffffff811115611a2a57600080fd5b611a36858286016119b4565b90969095509350505050565b600060208284031215611a5457600080fd5b5035919050565b60005b83811015611a76578181015183820152602001611a5e565b50506000910152565b60008151808452611a97816020860160208601611a5b565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b602081526000611adc6020830184611a7f565b9392505050565b600060208284031215611af557600080fd5b813567ffffffffffffffff811115611b0c57600080fd5b820160e08185031215611adc57600080fd5b7fff00000000000000000000000000000000000000000000000000000000000000881681526000602060e081840152611b5a60e084018a611a7f565b8381036040850152611b6c818a611a7f565b6060850189905273ffffffffffffffffffffffffffffffffffffffff8816608086015260a0850187905284810360c0860152855180825283870192509083019060005b81811015611bcb57835183529284019291840191600101611baf565b50909c9b505050505050505050505050565b6020808252825182820181905260009190848201906040850190845b81811015611c1557835183529284019291840191600101611bf9565b50909695505050505050565b60006101008284031215611c3457600080fd5b50919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff61833603018112611ccc57600080fd5b9190910192915050565b60405160a0810167ffffffffffffffff81118282101715611cf957611cf9611c3a565b60405290565b60405160c0810167ffffffffffffffff81118282101715611cf957611cf9611c3a565b604051601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe016810167ffffffffffffffff81118282101715611d6957611d69611c3a565b604052919050565b600067ffffffffffffffff821115611d8b57611d8b611c3a565b5060051b60200190565b600060408284031215611da757600080fd5b6040516040810181811067ffffffffffffffff82111715611dca57611dca611c3a565b604052823581526020928301359281019290925250919050565b600060608284031215611df657600080fd5b6040516060810181811067ffffffffffffffff82111715611e1957611e19611c3a565b604052905080823560ff81168114611e3057600080fd5b8082525060208301356020820152604083013560408201525092915050565b600082601f830112611e6057600080fd5b81356020611e75611e7083611d71565b611d22565b82815260609283028501820192828201919087851115611e9457600080fd5b8387015b85811015611eb757611eaa8982611de4565b8452928401928101611e98565b5090979650505050505050565b803573ffffffffffffffffffffffffffffffffffffffff81168114611ee857600080fd5b919050565b803567ffffffffffffffff81168114611ee857600080fd5b600060a08236031215611f1757600080fd5b611f1f611cd6565b8235815260208084013567ffffffffffffffff80821115611f3f57600080fd5b9085019036601f830112611f5257600080fd5b8135611f60611e7082611d71565b81815260069190911b83018401908481019036831115611f7f57600080fd5b938501935b82851015611fa857611f963686611d95565b82528582019150604085019450611f84565b80868801525050506040860135925080831115611fc457600080fd5b5050611fd236828601611e4f565b604083015250611fe460608401611ec4565b6060820152611ff560808401611eed565b608082015292915050565b60006020808301818452808551808352604092508286019150828160051b8701018488016000805b848110156120c0578984037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0018652825180518552880151888501889052805188860181905290890190839060608701905b808310156120ab5761209782855180518252602090810151910152565b928b019260019290920191908a019061207a565b50978a01979550505091870191600101612028565b50919998505050505050505050565b600181811c908216806120e357607f821691505b602082108103611c34577f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b600082601f83011261212d57600080fd5b813567ffffffffffffffff81111561214757612147611c3a565b61217860207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f84011601611d22565b81815284602083860101111561218d57600080fd5b816020850160208301376000918101602001919091529392505050565b600060c082840312156121bc57600080fd5b6121c4611cff565b90506121cf82611ec4565b81526121dd60208301611eed565b6020820152604082013580151581146121f557600080fd5b604082015260608281013590820152608082013567ffffffffffffffff81111561221e57600080fd5b61222a8482850161211c565b60808301525060a082013560a082015292915050565b600060e0823603121561225257600080fd5b61225a611cd6565b82358152602083013567ffffffffffffffff81111561227857600080fd5b612284368286016121aa565b6020830152506122973660408501611de4565b60408201526122a860a08401611ec4565b6060820152611ff560c08401611eed565b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff41833603018112611ccc57600080fd5b6000610c5f36836121aa565b73ffffffffffffffffffffffffffffffffffffffff815116825267ffffffffffffffff6020820151166020830152604081015115156040830152606081015160608301526000608082015160c0608085015261235860c0850182611a7f565b60a093840151949093019390935250919050565b60208152815160208201526000602083015160408084015261239160608401826122f9565b949350505050565b6000602082840312156123ab57600080fd5b5051919050565b6000602082840312156123c457600080fd5b611adc82611ec4565b600084516123df818460208901611a5b565b80830190507f2e00000000000000000000000000000000000000000000000000000000000000808252855161241b816001850160208a01611a5b565b60019201918201528351612436816002840160208801611a5b565b0160020195945050505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261247857600080fd5b83018035915067ffffffffffffffff82111561249357600080fd5b6020019150600581901b36038213156119f957600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18436030181126124e057600080fd5b83018035915067ffffffffffffffff8211156124fb57600080fd5b60200191506060810236038213156119f957600080fd5b60006060828403121561252457600080fd5b611adc8383611de4565b60006020828403121561254057600080fd5b611adc82611eed565b6000612557611e7084611d71565b80848252602080830192508560051b85013681111561257557600080fd5b855b818110156125b157803567ffffffffffffffff8111156125975760008081fd5b6125a336828a016121aa565b865250938201938201612577565b50919695505050505050565b602080825282518282018190526000919060409081850190600581811b8701840188860187805b858110156126a0577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc08b85030187528251805185528901518985018990528051898601819052908a0190606081881b870181019190870190855b8181101561268a577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa08985030183526126788486516122f9565b948e01949350918d019160010161263e565b505050978a0197945050918801916001016125e4565b50919a9950505050505050505050565b600060208083850312156126c357600080fd5b825167ffffffffffffffff8111156126da57600080fd5b8301601f810185136126eb57600080fd5b80516126f9611e7082611d71565b81815260059190911b8201830190838101908783111561271857600080fd5b928401925b828410156127365783518252928401929084019061271d565b979650505050505050565b6000610100828403121561275457600080fd5b61275c611cd6565b8235815261276d8460208501611d95565b602082015261277f8460608501611de4565b604082015261279060c08401611ec4565b60608201526127a160e08401611eed565b60808201529392505050565b6000604082840312156127bf57600080fd5b611adc8383611d95565b60008251611ccc818460208701611a5b565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fdfea164736f6c6343000813000a",
        "deployedBytecode": "0x6080604052600436106100c75760003560e01c806365c40b9c11610074578063a6d4dbc71161004e578063a6d4dbc714610250578063b83010d314610263578063ed24911d1461029657600080fd5b806365c40b9c146101d557806384b0196e14610208578063954115251461023057600080fd5b806317d7de7c116100a557806317d7de7c1461018b5780633c042715146101ad57806354fd4d50146101c057600080fd5b80630eabf660146100cc57806310d736d5146100e157806312b11a171461014e575b600080fd5b6100df6100da366004611a00565b6102ab565b005b3480156100ed57600080fd5b506101246100fc366004611a42565b60009081526003602052604090205473ffffffffffffffffffffffffffffffffffffffff1690565b60405173ffffffffffffffffffffffffffffffffffffffff90911681526020015b60405180910390f35b34801561015a57600080fd5b507f9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f8145675b604051908152602001610145565b34801561019757600080fd5b506101a0610540565b6040516101459190611ac9565b61017d6101bb366004611ae3565b6105d2565b3480156101cc57600080fd5b506101a061071d565b3480156101e157600080fd5b507f0000000000000000000000000000000000000000000000000000000000000000610124565b34801561021457600080fd5b5061021d6107c0565b6040516101459796959493929190611b1e565b61024361023e366004611a00565b610864565b6040516101459190611bdd565b6100df61025e366004611c21565b610c65565b34801561026f57600080fd5b507fd4e76f924411647a916bb4ae4631b3cf45c44e2da56ed1c63edb18ebc97ba5e461017d565b3480156102a257600080fd5b5061017d610d65565b8060008167ffffffffffffffff8111156102c7576102c7611c3a565b60405190808252806020026020018201604052801561030d57816020015b6040805180820190915260008152606060208201528152602001906001900390816102e55790505b50905060005b8281101561049357600085858381811061032f5761032f611c69565b90506020028101906103419190611c98565b61034a90611f05565b602081015180519192509080158061036757508260400151518114155b1561039e576040517f947d5a8400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60005b818110156104485760008382815181106103bd576103bd611c69565b6020026020010151905061043f6040518060a0016040528087600001518152602001838152602001876040015185815181106103fb576103fb611c69565b60200260200101518152602001876060015173ffffffffffffffffffffffffffffffffffffffff168152602001876080015167ffffffffffffffff16815250610d74565b506001016103a1565b506040518060400160405280846000015181526020018381525085858151811061047457610474611c69565b602002602001018190525050505061048c8160010190565b9050610313565b506040517f4cb7e9e500000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001690634cb7e9e5903490610508908590600401612000565b6000604051808303818588803b15801561052157600080fd5b505af1158015610535573d6000803e3d6000fd5b505050505050505050565b60606002805461054f906120cf565b80601f016020809104026020016040519081016040528092919081815260200182805461057b906120cf565b80156105c85780601f1061059d576101008083540402835291602001916105c8565b820191906000526020600020905b8154815290600101906020018083116105ab57829003601f168201915b5050505050905090565b60006105e56105e083612240565b610fb6565b60007f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663f17325e73460405180604001604052808760000135815260200187806020019061064991906122b9565b610652906122ed565b8152506040518363ffffffff1660e01b8152600401610671919061236c565b60206040518083038185885af115801561068f573d6000803e3d6000fd5b50505050506040513d601f19601f820116820180604052508101906106b49190612399565b90506106c660c0840160a085016123b2565b600082815260036020526040902080547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff9290921691909117905592915050565b60606107487f0000000000000000000000000000000000000000000000000000000000000000611189565b6107717f0000000000000000000000000000000000000000000000000000000000000000611189565b61079a7f0000000000000000000000000000000000000000000000000000000000000000611189565b6040516020016107ac939291906123cd565b604051602081830303815290604052905090565b6000606080828080836107f37f000000000000000000000000000000000000000000000000000000000000000083611247565b61081e7f00000000000000000000000000000000000000000000000000000000000000006001611247565b604080516000808252602082019092527f0f000000000000000000000000000000000000000000000000000000000000009b939a50919850469750309650945092509050565b60608160008167ffffffffffffffff81111561088257610882611c3a565b6040519080825280602002602001820160405280156108c857816020015b6040805180820190915260008152606060208201528152602001906001900390816108a05790505b50905060005b82811015610a9857368686838181106108e9576108e9611c69565b90506020028101906108fb9190611c98565b905036600061090d6020840184612443565b90925090508080158061092e575061092860408501856124ab565b90508114155b15610965576040517f947d5a8400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60005b81811015610a4657610a3e6040518060a001604052808760000135815260200186868581811061099a5761099a611c69565b90506020028101906109ac91906122b9565b6109b5906122ed565b81526020016109c760408901896124ab565b858181106109d7576109d7611c69565b9050606002018036038101906109ed9190612512565b8152602001610a026080890160608a016123b2565b73ffffffffffffffffffffffffffffffffffffffff168152602001610a2d60a0890160808a0161252e565b67ffffffffffffffff169052610fb6565b600101610968565b50604080518082019091528435815260208101610a638486612549565b815250868681518110610a7857610a78611c69565b602002602001018190525050505050610a918160010190565b90506108ce565b5060007f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff166344adc90e34846040518363ffffffff1660e01b8152600401610af591906125bd565b60006040518083038185885af1158015610b13573d6000803e3d6000fd5b50505050506040513d6000823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0168201604052610b5a91908101906126b0565b90506000805b84811015610c575736888883818110610b7b57610b7b611c69565b9050602002810190610b8d9190611c98565b9050366000610b9f6020840184612443565b90925090508060005b81811015610c4157610bc060808601606087016123b2565b600360008a8a81518110610bd657610bd6611c69565b6020026020010151815260200190815260200160002060006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550866001019650610c3a8160010190565b9050610ba8565b5050505050610c508160010190565b9050610b60565b509093505050505b92915050565b610c7c610c7736839003830183612741565b610d74565b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663469262673460405180604001604052808560000135815260200185602001803603810190610ce291906127ad565b90526040517fffffffff0000000000000000000000000000000000000000000000000000000060e085901b16815281516004820152602091820151805160248301529091015160448201526064016000604051808303818588803b158015610d4957600080fd5b505af1158015610d5d573d6000803e3d6000fd5b505050505050565b6000610d6f6112f2565b905090565b608081015167ffffffffffffffff1615801590610da857504267ffffffffffffffff16816080015167ffffffffffffffff16105b15610ddf576040517f1ab7da6b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60208082015180516000908152600390925260409091205473ffffffffffffffffffffffffffffffffffffffff1680610e44576040517fc5723b5100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff81163314610e93576040517f4ca8886700000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6040830151610ea18161142a565b835183516020808601516080880151604051600095610f2d95610f12957fd4e76f924411647a916bb4ae4631b3cf45c44e2da56ed1c63edb18ebc97ba5e495929491930194855260208501939093526040840191909152606083015267ffffffffffffffff16608082015260a00190565b60405160208183030381529060405280519060200120611538565b9050846060015173ffffffffffffffffffffffffffffffffffffffff16610f6282846000015185602001518660400151611580565b73ffffffffffffffffffffffffffffffffffffffff1614610faf576040517f8baa579f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050505050565b608081015167ffffffffffffffff1615801590610fea57504267ffffffffffffffff16816080015167ffffffffffffffff16105b15611021576040517f1ab7da6b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b602081015160408201516110348161142a565b60006111017f9d3e80e7032dc16815a5f67aa94e851240ae3b24eed13a7431bdac738f81456760001b856000015185600001518660200151876040015188606001518960800151805190602001208a60a001518c60800151604051602001610f1299989796959493929190988952602089019790975273ffffffffffffffffffffffffffffffffffffffff95909516604088015267ffffffffffffffff9384166060880152911515608087015260a086015260c085015260e0840191909152166101008201526101200190565b9050836060015173ffffffffffffffffffffffffffffffffffffffff1661113682846000015185602001518660400151611580565b73ffffffffffffffffffffffffffffffffffffffff1614611183576040517f8baa579f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b50505050565b60606000611196836115a8565b600101905060008167ffffffffffffffff8111156111b6576111b6611c3a565b6040519080825280601f01601f1916602001820160405280156111e0576020820181803683370190505b5090508181016020015b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff017f3031323334353637383961626364656600000000000000000000000000000000600a86061a8153600a85049450846111ea57509392505050565b606060ff83146112615761125a8361168a565b9050610c5f565b81805461126d906120cf565b80601f0160208091040260200160405190810160405280929190818152602001828054611299906120cf565b80156112e65780601f106112bb576101008083540402835291602001916112e6565b820191906000526020600020905b8154815290600101906020018083116112c957829003601f168201915b50505050509050610c5f565b60003073ffffffffffffffffffffffffffffffffffffffff7f00000000000000000000000000000000000000000000000000000000000000001614801561135857507f000000000000000000000000000000000000000000000000000000000000000046145b1561138257507f000000000000000000000000000000000000000000000000000000000000000090565b610d6f604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f60208201527f0000000000000000000000000000000000000000000000000000000000000000918101919091527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260009060c00160405160208183030381529060405280519060200120905090565b8051602080830151604080850151905160f89490941b7fff00000000000000000000000000000000000000000000000000000000000000169284019290925260218301526041820152600090606101604051602081830303815290604052905060048160405161149a91906127c9565b9081526040519081900360200190205460ff16156114e4576040517fcce9a82400000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60016004826040516114f691906127c9565b90815260405190819003602001902080549115157fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff009092169190911790555050565b6000610c5f6115456112f2565b836040517f19010000000000000000000000000000000000000000000000000000000000008152600281019290925260228201526042902090565b6000806000611591878787876116c9565b9150915061159e816117b8565b5095945050505050565b6000807a184f03e93ff9f4daa797ed6e38ed64bf6a1f01000000000000000083106115f1577a184f03e93ff9f4daa797ed6e38ed64bf6a1f010000000000000000830492506040015b6d04ee2d6d415b85acef8100000000831061161d576d04ee2d6d415b85acef8100000000830492506020015b662386f26fc10000831061163b57662386f26fc10000830492506010015b6305f5e1008310611653576305f5e100830492506008015b612710831061166757612710830492506004015b60648310611679576064830492506002015b600a8310610c5f5760010192915050565b6060600061169783611973565b604080516020808252818301909252919250600091906020820181803683375050509182525060208101929092525090565b6000807f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a083111561170057506000905060036117af565b6040805160008082526020820180845289905260ff881692820192909252606081018690526080810185905260019060a0016020604051602081039080840390855afa158015611754573d6000803e3d6000fd5b50506040517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015191505073ffffffffffffffffffffffffffffffffffffffff81166117a8576000600192509250506117af565b9150600090505b94509492505050565b60008160048111156117cc576117cc6127db565b036117d45750565b60018160048111156117e8576117e86127db565b03611854576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f45434453413a20696e76616c6964207369676e6174757265000000000000000060448201526064015b60405180910390fd5b6002816004811115611868576118686127db565b036118cf576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f45434453413a20696e76616c6964207369676e6174757265206c656e67746800604482015260640161184b565b60038160048111156118e3576118e36127db565b03611970576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202773272076616c60448201527f7565000000000000000000000000000000000000000000000000000000000000606482015260840161184b565b50565b600060ff8216601f811115610c5f576040517fb3512b0c00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60008083601f8401126119c657600080fd5b50813567ffffffffffffffff8111156119de57600080fd5b6020830191508360208260051b85010111156119f957600080fd5b9250929050565b60008060208385031215611a1357600080fd5b823567ffffffffffffffff811115611a2a57600080fd5b611a36858286016119b4565b90969095509350505050565b600060208284031215611a5457600080fd5b5035919050565b60005b83811015611a76578181015183820152602001611a5e565b50506000910152565b60008151808452611a97816020860160208601611a5b565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b602081526000611adc6020830184611a7f565b9392505050565b600060208284031215611af557600080fd5b813567ffffffffffffffff811115611b0c57600080fd5b820160e08185031215611adc57600080fd5b7fff00000000000000000000000000000000000000000000000000000000000000881681526000602060e081840152611b5a60e084018a611a7f565b8381036040850152611b6c818a611a7f565b6060850189905273ffffffffffffffffffffffffffffffffffffffff8816608086015260a0850187905284810360c0860152855180825283870192509083019060005b81811015611bcb57835183529284019291840191600101611baf565b50909c9b505050505050505050505050565b6020808252825182820181905260009190848201906040850190845b81811015611c1557835183529284019291840191600101611bf9565b50909695505050505050565b60006101008284031215611c3457600080fd5b50919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff61833603018112611ccc57600080fd5b9190910192915050565b60405160a0810167ffffffffffffffff81118282101715611cf957611cf9611c3a565b60405290565b60405160c0810167ffffffffffffffff81118282101715611cf957611cf9611c3a565b604051601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe016810167ffffffffffffffff81118282101715611d6957611d69611c3a565b604052919050565b600067ffffffffffffffff821115611d8b57611d8b611c3a565b5060051b60200190565b600060408284031215611da757600080fd5b6040516040810181811067ffffffffffffffff82111715611dca57611dca611c3a565b604052823581526020928301359281019290925250919050565b600060608284031215611df657600080fd5b6040516060810181811067ffffffffffffffff82111715611e1957611e19611c3a565b604052905080823560ff81168114611e3057600080fd5b8082525060208301356020820152604083013560408201525092915050565b600082601f830112611e6057600080fd5b81356020611e75611e7083611d71565b611d22565b82815260609283028501820192828201919087851115611e9457600080fd5b8387015b85811015611eb757611eaa8982611de4565b8452928401928101611e98565b5090979650505050505050565b803573ffffffffffffffffffffffffffffffffffffffff81168114611ee857600080fd5b919050565b803567ffffffffffffffff81168114611ee857600080fd5b600060a08236031215611f1757600080fd5b611f1f611cd6565b8235815260208084013567ffffffffffffffff80821115611f3f57600080fd5b9085019036601f830112611f5257600080fd5b8135611f60611e7082611d71565b81815260069190911b83018401908481019036831115611f7f57600080fd5b938501935b82851015611fa857611f963686611d95565b82528582019150604085019450611f84565b80868801525050506040860135925080831115611fc457600080fd5b5050611fd236828601611e4f565b604083015250611fe460608401611ec4565b6060820152611ff560808401611eed565b608082015292915050565b60006020808301818452808551808352604092508286019150828160051b8701018488016000805b848110156120c0578984037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0018652825180518552880151888501889052805188860181905290890190839060608701905b808310156120ab5761209782855180518252602090810151910152565b928b019260019290920191908a019061207a565b50978a01979550505091870191600101612028565b50919998505050505050505050565b600181811c908216806120e357607f821691505b602082108103611c34577f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b600082601f83011261212d57600080fd5b813567ffffffffffffffff81111561214757612147611c3a565b61217860207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f84011601611d22565b81815284602083860101111561218d57600080fd5b816020850160208301376000918101602001919091529392505050565b600060c082840312156121bc57600080fd5b6121c4611cff565b90506121cf82611ec4565b81526121dd60208301611eed565b6020820152604082013580151581146121f557600080fd5b604082015260608281013590820152608082013567ffffffffffffffff81111561221e57600080fd5b61222a8482850161211c565b60808301525060a082013560a082015292915050565b600060e0823603121561225257600080fd5b61225a611cd6565b82358152602083013567ffffffffffffffff81111561227857600080fd5b612284368286016121aa565b6020830152506122973660408501611de4565b60408201526122a860a08401611ec4565b6060820152611ff560c08401611eed565b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff41833603018112611ccc57600080fd5b6000610c5f36836121aa565b73ffffffffffffffffffffffffffffffffffffffff815116825267ffffffffffffffff6020820151166020830152604081015115156040830152606081015160608301526000608082015160c0608085015261235860c0850182611a7f565b60a093840151949093019390935250919050565b60208152815160208201526000602083015160408084015261239160608401826122f9565b949350505050565b6000602082840312156123ab57600080fd5b5051919050565b6000602082840312156123c457600080fd5b611adc82611ec4565b600084516123df818460208901611a5b565b80830190507f2e00000000000000000000000000000000000000000000000000000000000000808252855161241b816001850160208a01611a5b565b60019201918201528351612436816002840160208801611a5b565b0160020195945050505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261247857600080fd5b83018035915067ffffffffffffffff82111561249357600080fd5b6020019150600581901b36038213156119f957600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18436030181126124e057600080fd5b83018035915067ffffffffffffffff8211156124fb57600080fd5b60200191506060810236038213156119f957600080fd5b60006060828403121561252457600080fd5b611adc8383611de4565b60006020828403121561254057600080fd5b611adc82611eed565b6000612557611e7084611d71565b80848252602080830192508560051b85013681111561257557600080fd5b855b818110156125b157803567ffffffffffffffff8111156125975760008081fd5b6125a336828a016121aa565b865250938201938201612577565b50919695505050505050565b602080825282518282018190526000919060409081850190600581811b8701840188860187805b858110156126a0577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc08b85030187528251805185528901518985018990528051898601819052908a0190606081881b870181019190870190855b8181101561268a577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa08985030183526126788486516122f9565b948e01949350918d019160010161263e565b505050978a0197945050918801916001016125e4565b50919a9950505050505050505050565b600060208083850312156126c357600080fd5b825167ffffffffffffffff8111156126da57600080fd5b8301601f810185136126eb57600080fd5b80516126f9611e7082611d71565b81815260059190911b8201830190838101908783111561271857600080fd5b928401925b828410156127365783518252928401929084019061271d565b979650505050505050565b6000610100828403121561275457600080fd5b61275c611cd6565b8235815261276d8460208501611d95565b602082015261277f8460608501611de4565b604082015261279060c08401611ec4565b60608201526127a160e08401611eed565b60808201529392505050565b6000604082840312156127bf57600080fd5b611adc8383611d95565b60008251611ccc818460208701611a5b565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fdfea164736f6c6343000813000a",
        "devdoc": {
          "events": {
            "EIP712DomainChanged()": {
              "details": "MAY be emitted to signal that the domain could have changed."
            }
          },
          "kind": "dev",
          "methods": {
            "attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address,uint64))": {
              "params": {
                "delegatedRequest": "The arguments of the delegated attestation request."
              },
              "returns": {
                "_0": "The UID of the new attestation. Example:     attestByDelegation({         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: {             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',             expirationTime: 1673891048,             revocable: true,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x1234',             value: 0         },         signature: {             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e',         deadline: 1673891048     })"
              }
            },
            "constructor": {
              "details": "Creates a new EIP1271Verifier instance.",
              "params": {
                "eas": "The address of the global EAS contract.",
                "name": "The user readable name of the signing domain."
              }
            },
            "eip712Domain()": {
              "details": "See {EIP-5267}. _Available since v4.9._"
            },
            "multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])": {
              "params": {
                "multiDelegatedRequests": "The arguments of the delegated multi attestation requests. The requests should be     grouped by distinct schema ids to benefit from the best batching optimization."
              },
              "returns": {
                "_0": "The UIDs of the new attestations. Example:     multiAttestByDelegation([{         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: [{             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',             expirationTime: 1673891048,             revocable: true,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x1234',             value: 0         },         {             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',             expirationTime: 0,             revocable: false,             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',             data: '0x00',             value: 0         }],         signatures: [{             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         {             v: 28,             r: '0x487s...67bb',             s: '0x12ad...2366'         }],         attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4',         deadline: 1673891048     }])"
              }
            },
            "multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])": {
              "params": {
                "multiDelegatedRequests": "The arguments of the delegated multi revocation attestation requests. The requests     should be grouped by distinct schema ids to benefit from the best batching optimization. Example:     multiRevokeByDelegation([{         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: [{             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',             value: 1000         },         {             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',             value: 0         }],         signatures: [{             v: 28,             r: '0x148c...b25b',             s: '0x5a72...be22'         },         {             v: 28,             r: '0x487s...67bb',             s: '0x12ad...2366'         }],         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',         deadline: 1673891048     }])"
              }
            },
            "revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address,uint64))": {
              "params": {
                "delegatedRequest": "The arguments of the delegated revocation request. Example:     revokeByDelegation({         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',         data: {             uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',             value: 0         },         signature: {             v: 27,             r: '0xb593...7142',             s: '0x0f5b...2cce'         },         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',         deadline: 1673891048     })"
              }
            },
            "version()": {
              "returns": {
                "_0": "Semver contract version as a string."
              }
            }
          },
          "title": "EIP712Proxy",
          "version": 1
        },
        "userdoc": {
          "kind": "user",
          "methods": {
            "attestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256),(uint8,bytes32,bytes32),address,uint64))": {
              "notice": "Attests to a specific schema via the provided EIP712 signature."
            },
            "getAttestTypeHash()": {
              "notice": "Returns the EIP712 type hash for the attest function."
            },
            "getAttester(bytes32)": {
              "notice": "Returns the attester for a given uid."
            },
            "getDomainSeparator()": {
              "notice": "Returns the domain separator used in the encoding of the signatures for attest, and revoke."
            },
            "getEAS()": {
              "notice": "Returns the EAS."
            },
            "getName()": {
              "notice": "Returns the EIP712 name."
            },
            "getRevokeTypeHash()": {
              "notice": "Returns the EIP712 type hash for the revoke function."
            },
            "multiAttestByDelegation((bytes32,(address,uint64,bool,bytes32,bytes,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])": {
              "notice": "Attests to multiple schemas using via provided EIP712 signatures."
            },
            "multiRevokeByDelegation((bytes32,(bytes32,uint256)[],(uint8,bytes32,bytes32)[],address,uint64)[])": {
              "notice": "Revokes existing attestations to multiple schemas via provided EIP712 signatures."
            },
            "revokeByDelegation((bytes32,(bytes32,uint256),(uint8,bytes32,bytes32),address,uint64))": {
              "notice": "Revokes an existing attestation to a specific schema via the provided EIP712 signature."
            },
            "version()": {
              "notice": "Returns the full semver contract version."
            }
          },
          "notice": "This utility contract an be used to aggregate delegated attestations without requiring a specific order via     nonces. The contract doesn't request nonces and implements replay protection by storing ***immalleable***     signatures.",
          "version": 1
        },
        "storageLayout": {
          "storage": [
            {
              "astId": 2559,
              "contract": "contracts/eip712/proxy/EIP712Proxy.sol:EIP712Proxy",
              "label": "_nameFallback",
              "offset": 0,
              "slot": "0",
              "type": "t_string_storage"
            },
            {
              "astId": 2561,
              "contract": "contracts/eip712/proxy/EIP712Proxy.sol:EIP712Proxy",
              "label": "_versionFallback",
              "offset": 0,
              "slot": "1",
              "type": "t_string_storage"
            },
            {
              "astId": 7337,
              "contract": "contracts/eip712/proxy/EIP712Proxy.sol:EIP712Proxy",
              "label": "_name",
              "offset": 0,
              "slot": "2",
              "type": "t_string_storage"
            },
            {
              "astId": 7341,
              "contract": "contracts/eip712/proxy/EIP712Proxy.sol:EIP712Proxy",
              "label": "_attesters",
              "offset": 0,
              "slot": "3",
              "type": "t_mapping(t_bytes32,t_address)"
            },
            {
              "astId": 7345,
              "contract": "contracts/eip712/proxy/EIP712Proxy.sol:EIP712Proxy",
              "label": "_signatures",
              "offset": 0,
              "slot": "4",
              "type": "t_mapping(t_bytes_memory_ptr,t_bool)"
            }
          ],
          "types": {
            "t_address": {
              "encoding": "inplace",
              "label": "address",
              "numberOfBytes": "20"
            },
            "t_bool": {
              "encoding": "inplace",
              "label": "bool",
              "numberOfBytes": "1"
            },
            "t_bytes32": {
              "encoding": "inplace",
              "label": "bytes32",
              "numberOfBytes": "32"
            },
            "t_bytes_memory_ptr": {
              "encoding": "bytes",
              "label": "bytes",
              "numberOfBytes": "32"
            },
            "t_mapping(t_bytes32,t_address)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => address)",
              "numberOfBytes": "32",
              "value": "t_address"
            },
            "t_mapping(t_bytes_memory_ptr,t_bool)": {
              "encoding": "mapping",
              "key": "t_bytes_memory_ptr",
              "label": "mapping(bytes => bool)",
              "numberOfBytes": "32",
              "value": "t_bool"
            },
            "t_string_storage": {
              "encoding": "bytes",
              "label": "string",
              "numberOfBytes": "32"
            }
          }
        }
      },
      Indexer: {
        "address": "0xaEF4103A04090071165F78D45D83A0C0782c2B2a",
        "abi": [
          {
            "inputs": [
              {
                "internalType": "contract IEAS",
                "name": "eas",
                "type": "address"
              }
            ],
            "stateMutability": "nonpayable",
            "type": "constructor"
          },
          {
            "inputs": [],
            "name": "InvalidAttestation",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidEAS",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "InvalidOffset",
            "type": "error"
          },
          {
            "anonymous": false,
            "inputs": [
              {
                "indexed": true,
                "internalType": "bytes32",
                "name": "uid",
                "type": "bytes32"
              }
            ],
            "name": "Indexed",
            "type": "event"
          },
          {
            "inputs": [],
            "name": "getEAS",
            "outputs": [
              {
                "internalType": "contract IEAS",
                "name": "",
                "type": "address"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              }
            ],
            "name": "getReceivedAttestationUIDCount",
            "outputs": [
              {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              },
              {
                "internalType": "uint256",
                "name": "start",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
              },
              {
                "internalType": "bool",
                "name": "reverseOrder",
                "type": "bool"
              }
            ],
            "name": "getReceivedAttestationUIDs",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              }
            ],
            "name": "getSchemaAttestationUIDCount",
            "outputs": [
              {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              },
              {
                "internalType": "uint256",
                "name": "start",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
              },
              {
                "internalType": "bool",
                "name": "reverseOrder",
                "type": "bool"
              }
            ],
            "name": "getSchemaAttestationUIDs",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              },
              {
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              }
            ],
            "name": "getSchemaAttesterRecipientAttestationUIDCount",
            "outputs": [
              {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              },
              {
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "start",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
              },
              {
                "internalType": "bool",
                "name": "reverseOrder",
                "type": "bool"
              }
            ],
            "name": "getSchemaAttesterRecipientAttestationUIDs",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              }
            ],
            "name": "getSentAttestationUIDCount",
            "outputs": [
              {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "address",
                "name": "attester",
                "type": "address"
              },
              {
                "internalType": "bytes32",
                "name": "schema",
                "type": "bytes32"
              },
              {
                "internalType": "uint256",
                "name": "start",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
              },
              {
                "internalType": "bool",
                "name": "reverseOrder",
                "type": "bool"
              }
            ],
            "name": "getSentAttestationUIDs",
            "outputs": [
              {
                "internalType": "bytes32[]",
                "name": "",
                "type": "bytes32[]"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "attestationUID",
                "type": "bytes32"
              }
            ],
            "name": "indexAttestation",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32[]",
                "name": "attestationUIDs",
                "type": "bytes32[]"
              }
            ],
            "name": "indexAttestations",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
          },
          {
            "inputs": [
              {
                "internalType": "bytes32",
                "name": "attestationUID",
                "type": "bytes32"
              }
            ],
            "name": "isAttestationIndexed",
            "outputs": [
              {
                "internalType": "bool",
                "name": "",
                "type": "bool"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [],
            "name": "version",
            "outputs": [
              {
                "internalType": "string",
                "name": "",
                "type": "string"
              }
            ],
            "stateMutability": "view",
            "type": "function"
          }
        ],
        "transactionHash": "0x8272fd4f3d0b93ad137c8ff76bf50631aaec0290482d58f1647e9a3300f19686",
        "receipt": {
          "to": null,
          "from": "0x6457B4DB9575DBc1bac391DaE4B239722c4000d0",
          "contractAddress": "0xaEF4103A04090071165F78D45D83A0C0782c2B2a",
          "transactionIndex": 18,
          "gasUsed": "981051",
          "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          "blockHash": "0xd89bc0a361e08e908c5d79f771228a52f9edd65d282bb27313d80ef1976e0f64",
          "transactionHash": "0x8272fd4f3d0b93ad137c8ff76bf50631aaec0290482d58f1647e9a3300f19686",
          "logs": [],
          "blockNumber": 4603907,
          "cumulativeGasUsed": "3183267",
          "status": 1,
          "byzantium": true
        },
        "args": [
          "0xC2679fBD37d54388Ce493F1DB75320D236e1815e"
        ],
        "numDeployments": 1,
        "solcInputHash": "363c8b5710f335e9a0bfd66216b6038c",
        "metadata": "{\"compiler\":{\"version\":\"0.8.19+commit.7dd6d404\"},\"language\":\"Solidity\",\"output\":{\"abi\":[{\"inputs\":[{\"internalType\":\"contract IEAS\",\"name\":\"eas\",\"type\":\"address\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"InvalidAttestation\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidEAS\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidOffset\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"uid\",\"type\":\"bytes32\"}],\"name\":\"Indexed\",\"type\":\"event\"},{\"inputs\":[],\"name\":\"getEAS\",\"outputs\":[{\"internalType\":\"contract IEAS\",\"name\":\"\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"}],\"name\":\"getReceivedAttestationUIDCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"start\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"length\",\"type\":\"uint256\"},{\"internalType\":\"bool\",\"name\":\"reverseOrder\",\"type\":\"bool\"}],\"name\":\"getReceivedAttestationUIDs\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"}],\"name\":\"getSchemaAttestationUIDCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"start\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"length\",\"type\":\"uint256\"},{\"internalType\":\"bool\",\"name\":\"reverseOrder\",\"type\":\"bool\"}],\"name\":\"getSchemaAttestationUIDs\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"}],\"name\":\"getSchemaAttesterRecipientAttestationUIDCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"start\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"length\",\"type\":\"uint256\"},{\"internalType\":\"bool\",\"name\":\"reverseOrder\",\"type\":\"bool\"}],\"name\":\"getSchemaAttesterRecipientAttestationUIDs\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"}],\"name\":\"getSentAttestationUIDCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"attester\",\"type\":\"address\"},{\"internalType\":\"bytes32\",\"name\":\"schema\",\"type\":\"bytes32\"},{\"internalType\":\"uint256\",\"name\":\"start\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"length\",\"type\":\"uint256\"},{\"internalType\":\"bool\",\"name\":\"reverseOrder\",\"type\":\"bool\"}],\"name\":\"getSentAttestationUIDs\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"attestationUID\",\"type\":\"bytes32\"}],\"name\":\"indexAttestation\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"attestationUIDs\",\"type\":\"bytes32[]\"}],\"name\":\"indexAttestations\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"attestationUID\",\"type\":\"bytes32\"}],\"name\":\"isAttestationIndexed\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"version\",\"outputs\":[{\"internalType\":\"string\",\"name\":\"\",\"type\":\"string\"}],\"stateMutability\":\"view\",\"type\":\"function\"}],\"devdoc\":{\"events\":{\"Indexed(bytes32)\":{\"params\":{\"uid\":\"The UID the attestation.\"}}},\"kind\":\"dev\",\"methods\":{\"constructor\":{\"details\":\"Creates a new Indexer instance.\",\"params\":{\"eas\":\"The address of the global EAS contract.\"}},\"getReceivedAttestationUIDCount(address,bytes32)\":{\"params\":{\"recipient\":\"The recipient of the attestation.\",\"schema\":\"The UID of the schema.\"},\"returns\":{\"_0\":\"The total number of attestations.\"}},\"getReceivedAttestationUIDs(address,bytes32,uint256,uint256,bool)\":{\"params\":{\"length\":\"The number of total members to retrieve.\",\"recipient\":\"The recipient of the attestation.\",\"reverseOrder\":\"Whether the offset starts from the end and the data is returned in reverse.\",\"schema\":\"The UID of the schema.\",\"start\":\"The offset to start from.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"getSchemaAttestationUIDCount(bytes32)\":{\"params\":{\"schema\":\"The UID of the schema.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"getSchemaAttestationUIDs(bytes32,uint256,uint256,bool)\":{\"params\":{\"length\":\"The number of total members to retrieve.\",\"reverseOrder\":\"Whether the offset starts from the end and the data is returned in reverse.\",\"schema\":\"The UID of the schema.\",\"start\":\"The offset to start from.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"getSchemaAttesterRecipientAttestationUIDCount(bytes32,address,address)\":{\"params\":{\"attester\":\"The attester of the attestation.\",\"recipient\":\"The recipient of the attestation.\",\"schema\":\"The UID of the schema.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"getSchemaAttesterRecipientAttestationUIDs(bytes32,address,address,uint256,uint256,bool)\":{\"params\":{\"attester\":\"The attester of the attestation.\",\"length\":\"The number of total members to retrieve.\",\"recipient\":\"The recipient of the attestation.\",\"reverseOrder\":\"Whether the offset starts from the end and the data is returned in reverse.\",\"schema\":\"The UID of the schema.\",\"start\":\"The offset to start from.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"getSentAttestationUIDCount(address,bytes32)\":{\"params\":{\"attester\":\"The attester of the attestation.\",\"schema\":\"The UID of the schema.\"},\"returns\":{\"_0\":\"The total number of attestations.\"}},\"getSentAttestationUIDs(address,bytes32,uint256,uint256,bool)\":{\"params\":{\"attester\":\"The attester of the attestation.\",\"length\":\"The number of total members to retrieve.\",\"reverseOrder\":\"Whether the offset starts from the end and the data is returned in reverse.\",\"schema\":\"The UID of the schema.\",\"start\":\"The offset to start from.\"},\"returns\":{\"_0\":\"An array of attestation UIDs.\"}},\"indexAttestation(bytes32)\":{\"params\":{\"attestationUID\":\"The UID of the attestation to index.\"}},\"indexAttestations(bytes32[])\":{\"params\":{\"attestationUIDs\":\"The UIDs of the attestations to index.\"}},\"isAttestationIndexed(bytes32)\":{\"params\":{\"attestationUID\":\"The UID of the attestation to check.\"},\"returns\":{\"_0\":\"Whether an attestation has been already indexed.\"}},\"version()\":{\"returns\":{\"_0\":\"Semver contract version as a string.\"}}},\"title\":\"Indexer\",\"version\":1},\"userdoc\":{\"events\":{\"Indexed(bytes32)\":{\"notice\":\"Emitted when an attestation has been indexed.\"}},\"kind\":\"user\",\"methods\":{\"getEAS()\":{\"notice\":\"Returns the EAS.\"},\"getReceivedAttestationUIDCount(address,bytes32)\":{\"notice\":\"Returns the total number of attestations to a specific schema which were attested to/received by a     specific recipient.\"},\"getReceivedAttestationUIDs(address,bytes32,uint256,uint256,bool)\":{\"notice\":\"Returns the UIDs of attestations to a specific schema which were attested to/received by a specific     recipient.\"},\"getSchemaAttestationUIDCount(bytes32)\":{\"notice\":\"Returns the total number of attestations to a specific schema.\"},\"getSchemaAttestationUIDs(bytes32,uint256,uint256,bool)\":{\"notice\":\"Returns the UIDs of attestations to a specific schema.\"},\"getSchemaAttesterRecipientAttestationUIDCount(bytes32,address,address)\":{\"notice\":\"Returns the total number of UIDs of attestations to a specific schema which were attested by a specific     attester to a specific recipient.\"},\"getSchemaAttesterRecipientAttestationUIDs(bytes32,address,address,uint256,uint256,bool)\":{\"notice\":\"Returns the UIDs of attestations to a specific schema which were attested by a specific attester to a     specific recipient.\"},\"getSentAttestationUIDCount(address,bytes32)\":{\"notice\":\"Returns the total number of attestations to a specific schema which were attested by a specific attester.\"},\"getSentAttestationUIDs(address,bytes32,uint256,uint256,bool)\":{\"notice\":\"Returns the UIDs of attestations to a specific schema which were attested by a specific attester.\"},\"indexAttestation(bytes32)\":{\"notice\":\"Indexes an existing attestation.\"},\"indexAttestations(bytes32[])\":{\"notice\":\"Indexes multiple existing attestations.\"},\"isAttestationIndexed(bytes32)\":{\"notice\":\"Returns whether an existing attestation has been already indexed.\"},\"version()\":{\"notice\":\"Returns the full semver contract version.\"}},\"notice\":\"Indexing Service for the Ethereum Attestation Service\",\"version\":1}},\"settings\":{\"compilationTarget\":{\"contracts/Indexer.sol\":\"Indexer\"},\"evmVersion\":\"paris\",\"libraries\":{},\"metadata\":{\"bytecodeHash\":\"none\",\"useLiteralContent\":true},\"optimizer\":{\"enabled\":true,\"runs\":1000000},\"remappings\":[]},\"sources\":{\"@openzeppelin/contracts/utils/Strings.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/Strings.sol)\\n\\npragma solidity ^0.8.0;\\n\\nimport \\\"./math/Math.sol\\\";\\nimport \\\"./math/SignedMath.sol\\\";\\n\\n/**\\n * @dev String operations.\\n */\\nlibrary Strings {\\n    bytes16 private constant _SYMBOLS = \\\"0123456789abcdef\\\";\\n    uint8 private constant _ADDRESS_LENGTH = 20;\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` decimal representation.\\n     */\\n    function toString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            uint256 length = Math.log10(value) + 1;\\n            string memory buffer = new string(length);\\n            uint256 ptr;\\n            /// @solidity memory-safe-assembly\\n            assembly {\\n                ptr := add(buffer, add(32, length))\\n            }\\n            while (true) {\\n                ptr--;\\n                /// @solidity memory-safe-assembly\\n                assembly {\\n                    mstore8(ptr, byte(mod(value, 10), _SYMBOLS))\\n                }\\n                value /= 10;\\n                if (value == 0) break;\\n            }\\n            return buffer;\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `int256` to its ASCII `string` decimal representation.\\n     */\\n    function toString(int256 value) internal pure returns (string memory) {\\n        return string(abi.encodePacked(value < 0 ? \\\"-\\\" : \\\"\\\", toString(SignedMath.abs(value))));\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(uint256 value) internal pure returns (string memory) {\\n        unchecked {\\n            return toHexString(value, Math.log256(value) + 1);\\n        }\\n    }\\n\\n    /**\\n     * @dev Converts a `uint256` to its ASCII `string` hexadecimal representation with fixed length.\\n     */\\n    function toHexString(uint256 value, uint256 length) internal pure returns (string memory) {\\n        bytes memory buffer = new bytes(2 * length + 2);\\n        buffer[0] = \\\"0\\\";\\n        buffer[1] = \\\"x\\\";\\n        for (uint256 i = 2 * length + 1; i > 1; --i) {\\n            buffer[i] = _SYMBOLS[value & 0xf];\\n            value >>= 4;\\n        }\\n        require(value == 0, \\\"Strings: hex length insufficient\\\");\\n        return string(buffer);\\n    }\\n\\n    /**\\n     * @dev Converts an `address` with fixed length of 20 bytes to its not checksummed ASCII `string` hexadecimal representation.\\n     */\\n    function toHexString(address addr) internal pure returns (string memory) {\\n        return toHexString(uint256(uint160(addr)), _ADDRESS_LENGTH);\\n    }\\n\\n    /**\\n     * @dev Returns true if the two strings are equal.\\n     */\\n    function equal(string memory a, string memory b) internal pure returns (bool) {\\n        return keccak256(bytes(a)) == keccak256(bytes(b));\\n    }\\n}\\n\",\"keccak256\":\"0x3088eb2868e8d13d89d16670b5f8612c4ab9ff8956272837d8e90106c59c14a0\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/math/Math.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.9.0) (utils/math/Math.sol)\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Standard math utilities missing in the Solidity language.\\n */\\nlibrary Math {\\n    enum Rounding {\\n        Down, // Toward negative infinity\\n        Up, // Toward infinity\\n        Zero // Toward zero\\n    }\\n\\n    /**\\n     * @dev Returns the largest of two numbers.\\n     */\\n    function max(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a > b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the smallest of two numbers.\\n     */\\n    function min(uint256 a, uint256 b) internal pure returns (uint256) {\\n        return a < b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the average of two numbers. The result is rounded towards\\n     * zero.\\n     */\\n    function average(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b) / 2 can overflow.\\n        return (a & b) + (a ^ b) / 2;\\n    }\\n\\n    /**\\n     * @dev Returns the ceiling of the division of two numbers.\\n     *\\n     * This differs from standard division with `/` in that it rounds up instead\\n     * of rounding down.\\n     */\\n    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {\\n        // (a + b - 1) / b can overflow on addition, so we distribute.\\n        return a == 0 ? 0 : (a - 1) / b + 1;\\n    }\\n\\n    /**\\n     * @notice Calculates floor(x * y / denominator) with full precision. Throws if result overflows a uint256 or denominator == 0\\n     * @dev Original credit to Remco Bloemen under MIT license (https://xn--2-umb.com/21/muldiv)\\n     * with further edits by Uniswap Labs also under MIT license.\\n     */\\n    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {\\n        unchecked {\\n            // 512-bit multiply [prod1 prod0] = x * y. Compute the product mod 2^256 and mod 2^256 - 1, then use\\n            // use the Chinese Remainder Theorem to reconstruct the 512 bit result. The result is stored in two 256\\n            // variables such that product = prod1 * 2^256 + prod0.\\n            uint256 prod0; // Least significant 256 bits of the product\\n            uint256 prod1; // Most significant 256 bits of the product\\n            assembly {\\n                let mm := mulmod(x, y, not(0))\\n                prod0 := mul(x, y)\\n                prod1 := sub(sub(mm, prod0), lt(mm, prod0))\\n            }\\n\\n            // Handle non-overflow cases, 256 by 256 division.\\n            if (prod1 == 0) {\\n                // Solidity will revert if denominator == 0, unlike the div opcode on its own.\\n                // The surrounding unchecked block does not change this fact.\\n                // See https://docs.soliditylang.org/en/latest/control-structures.html#checked-or-unchecked-arithmetic.\\n                return prod0 / denominator;\\n            }\\n\\n            // Make sure the result is less than 2^256. Also prevents denominator == 0.\\n            require(denominator > prod1, \\\"Math: mulDiv overflow\\\");\\n\\n            ///////////////////////////////////////////////\\n            // 512 by 256 division.\\n            ///////////////////////////////////////////////\\n\\n            // Make division exact by subtracting the remainder from [prod1 prod0].\\n            uint256 remainder;\\n            assembly {\\n                // Compute remainder using mulmod.\\n                remainder := mulmod(x, y, denominator)\\n\\n                // Subtract 256 bit number from 512 bit number.\\n                prod1 := sub(prod1, gt(remainder, prod0))\\n                prod0 := sub(prod0, remainder)\\n            }\\n\\n            // Factor powers of two out of denominator and compute largest power of two divisor of denominator. Always >= 1.\\n            // See https://cs.stackexchange.com/q/138556/92363.\\n\\n            // Does not overflow because the denominator cannot be zero at this stage in the function.\\n            uint256 twos = denominator & (~denominator + 1);\\n            assembly {\\n                // Divide denominator by twos.\\n                denominator := div(denominator, twos)\\n\\n                // Divide [prod1 prod0] by twos.\\n                prod0 := div(prod0, twos)\\n\\n                // Flip twos such that it is 2^256 / twos. If twos is zero, then it becomes one.\\n                twos := add(div(sub(0, twos), twos), 1)\\n            }\\n\\n            // Shift in bits from prod1 into prod0.\\n            prod0 |= prod1 * twos;\\n\\n            // Invert denominator mod 2^256. Now that denominator is an odd number, it has an inverse modulo 2^256 such\\n            // that denominator * inv = 1 mod 2^256. Compute the inverse by starting with a seed that is correct for\\n            // four bits. That is, denominator * inv = 1 mod 2^4.\\n            uint256 inverse = (3 * denominator) ^ 2;\\n\\n            // Use the Newton-Raphson iteration to improve the precision. Thanks to Hensel's lifting lemma, this also works\\n            // in modular arithmetic, doubling the correct bits in each step.\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^8\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^16\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^32\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^64\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^128\\n            inverse *= 2 - denominator * inverse; // inverse mod 2^256\\n\\n            // Because the division is now exact we can divide by multiplying with the modular inverse of denominator.\\n            // This will give us the correct result modulo 2^256. Since the preconditions guarantee that the outcome is\\n            // less than 2^256, this is the final result. We don't need to compute the high bits of the result and prod1\\n            // is no longer required.\\n            result = prod0 * inverse;\\n            return result;\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates x * y / denominator with full precision, following the selected rounding direction.\\n     */\\n    function mulDiv(uint256 x, uint256 y, uint256 denominator, Rounding rounding) internal pure returns (uint256) {\\n        uint256 result = mulDiv(x, y, denominator);\\n        if (rounding == Rounding.Up && mulmod(x, y, denominator) > 0) {\\n            result += 1;\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Returns the square root of a number. If the number is not a perfect square, the value is rounded down.\\n     *\\n     * Inspired by Henry S. Warren, Jr.'s \\\"Hacker's Delight\\\" (Chapter 11).\\n     */\\n    function sqrt(uint256 a) internal pure returns (uint256) {\\n        if (a == 0) {\\n            return 0;\\n        }\\n\\n        // For our first guess, we get the biggest power of 2 which is smaller than the square root of the target.\\n        //\\n        // We know that the \\\"msb\\\" (most significant bit) of our target number `a` is a power of 2 such that we have\\n        // `msb(a) <= a < 2*msb(a)`. This value can be written `msb(a)=2**k` with `k=log2(a)`.\\n        //\\n        // This can be rewritten `2**log2(a) <= a < 2**(log2(a) + 1)`\\n        // \\u2192 `sqrt(2**k) <= sqrt(a) < sqrt(2**(k+1))`\\n        // \\u2192 `2**(k/2) <= sqrt(a) < 2**((k+1)/2) <= 2**(k/2 + 1)`\\n        //\\n        // Consequently, `2**(log2(a) / 2)` is a good first approximation of `sqrt(a)` with at least 1 correct bit.\\n        uint256 result = 1 << (log2(a) >> 1);\\n\\n        // At this point `result` is an estimation with one bit of precision. We know the true value is a uint128,\\n        // since it is the square root of a uint256. Newton's method converges quadratically (precision doubles at\\n        // every iteration). We thus need at most 7 iteration to turn our partial result with one bit of precision\\n        // into the expected uint128 result.\\n        unchecked {\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            result = (result + a / result) >> 1;\\n            return min(result, a / result);\\n        }\\n    }\\n\\n    /**\\n     * @notice Calculates sqrt(a), following the selected rounding direction.\\n     */\\n    function sqrt(uint256 a, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = sqrt(a);\\n            return result + (rounding == Rounding.Up && result * result < a ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 128;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 64;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 32;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 16;\\n            }\\n            if (value >> 8 > 0) {\\n                value >>= 8;\\n                result += 8;\\n            }\\n            if (value >> 4 > 0) {\\n                value >>= 4;\\n                result += 4;\\n            }\\n            if (value >> 2 > 0) {\\n                value >>= 2;\\n                result += 2;\\n            }\\n            if (value >> 1 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 2, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log2(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log2(value);\\n            return result + (rounding == Rounding.Up && 1 << result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >= 10 ** 64) {\\n                value /= 10 ** 64;\\n                result += 64;\\n            }\\n            if (value >= 10 ** 32) {\\n                value /= 10 ** 32;\\n                result += 32;\\n            }\\n            if (value >= 10 ** 16) {\\n                value /= 10 ** 16;\\n                result += 16;\\n            }\\n            if (value >= 10 ** 8) {\\n                value /= 10 ** 8;\\n                result += 8;\\n            }\\n            if (value >= 10 ** 4) {\\n                value /= 10 ** 4;\\n                result += 4;\\n            }\\n            if (value >= 10 ** 2) {\\n                value /= 10 ** 2;\\n                result += 2;\\n            }\\n            if (value >= 10 ** 1) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 10, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log10(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log10(value);\\n            return result + (rounding == Rounding.Up && 10 ** result < value ? 1 : 0);\\n        }\\n    }\\n\\n    /**\\n     * @dev Return the log in base 256, rounded down, of a positive value.\\n     * Returns 0 if given 0.\\n     *\\n     * Adding one to the result gives the number of pairs of hex symbols needed to represent `value` as a hex string.\\n     */\\n    function log256(uint256 value) internal pure returns (uint256) {\\n        uint256 result = 0;\\n        unchecked {\\n            if (value >> 128 > 0) {\\n                value >>= 128;\\n                result += 16;\\n            }\\n            if (value >> 64 > 0) {\\n                value >>= 64;\\n                result += 8;\\n            }\\n            if (value >> 32 > 0) {\\n                value >>= 32;\\n                result += 4;\\n            }\\n            if (value >> 16 > 0) {\\n                value >>= 16;\\n                result += 2;\\n            }\\n            if (value >> 8 > 0) {\\n                result += 1;\\n            }\\n        }\\n        return result;\\n    }\\n\\n    /**\\n     * @dev Return the log in base 256, following the selected rounding direction, of a positive value.\\n     * Returns 0 if given 0.\\n     */\\n    function log256(uint256 value, Rounding rounding) internal pure returns (uint256) {\\n        unchecked {\\n            uint256 result = log256(value);\\n            return result + (rounding == Rounding.Up && 1 << (result << 3) < value ? 1 : 0);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xe4455ac1eb7fc497bb7402579e7b4d64d928b846fce7d2b6fde06d366f21c2b3\",\"license\":\"MIT\"},\"@openzeppelin/contracts/utils/math/SignedMath.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n// OpenZeppelin Contracts (last updated v4.8.0) (utils/math/SignedMath.sol)\\n\\npragma solidity ^0.8.0;\\n\\n/**\\n * @dev Standard signed math utilities missing in the Solidity language.\\n */\\nlibrary SignedMath {\\n    /**\\n     * @dev Returns the largest of two signed numbers.\\n     */\\n    function max(int256 a, int256 b) internal pure returns (int256) {\\n        return a > b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the smallest of two signed numbers.\\n     */\\n    function min(int256 a, int256 b) internal pure returns (int256) {\\n        return a < b ? a : b;\\n    }\\n\\n    /**\\n     * @dev Returns the average of two signed numbers without overflow.\\n     * The result is rounded towards zero.\\n     */\\n    function average(int256 a, int256 b) internal pure returns (int256) {\\n        // Formula from the book \\\"Hacker's Delight\\\"\\n        int256 x = (a & b) + ((a ^ b) >> 1);\\n        return x + (int256(uint256(x) >> 255) & (a ^ b));\\n    }\\n\\n    /**\\n     * @dev Returns the absolute unsigned value of a signed value.\\n     */\\n    function abs(int256 n) internal pure returns (uint256) {\\n        unchecked {\\n            // must be unchecked in order to support `n = type(int256).min`\\n            return uint256(n >= 0 ? n : -n);\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0xf92515413956f529d95977adc9b0567d583c6203fc31ab1c23824c35187e3ddc\",\"license\":\"MIT\"},\"contracts/Common.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\n// A representation of an empty/uninitialized UID.\\nbytes32 constant EMPTY_UID = 0;\\n\\n// A zero expiration represents an non-expiring attestation.\\nuint64 constant NO_EXPIRATION_TIME = 0;\\n\\nerror AccessDenied();\\nerror DeadlineExpired();\\nerror InvalidEAS();\\nerror InvalidLength();\\nerror InvalidSignature();\\nerror NotFound();\\n\\n/// @notice A struct representing ECDSA signature data.\\nstruct Signature {\\n    uint8 v; // The recovery ID.\\n    bytes32 r; // The x-coordinate of the nonce R.\\n    bytes32 s; // The signature data.\\n}\\n\\n/// @notice A struct representing a single attestation.\\nstruct Attestation {\\n    bytes32 uid; // A unique identifier of the attestation.\\n    bytes32 schema; // The unique identifier of the schema.\\n    uint64 time; // The time when the attestation was created (Unix timestamp).\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    uint64 revocationTime; // The time when the attestation was revoked (Unix timestamp).\\n    bytes32 refUID; // The UID of the related attestation.\\n    address recipient; // The recipient of the attestation.\\n    address attester; // The attester/sender of the attestation.\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes data; // Custom attestation data.\\n}\\n\\n/// @notice A helper function to work with unchecked iterators in loops.\\nfunction uncheckedInc(uint256 i) pure returns (uint256 j) {\\n    unchecked {\\n        j = i + 1;\\n    }\\n}\\n\",\"keccak256\":\"0x957bd2e6d0d6d637f86208b135c29fbaf4412cb08e5e7a61ede16b80561bf685\",\"license\":\"MIT\"},\"contracts/IEAS.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaRegistry } from \\\"./ISchemaRegistry.sol\\\";\\nimport { Attestation, Signature } from \\\"./Common.sol\\\";\\n\\n/// @notice A struct representing the arguments of the attestation request.\\nstruct AttestationRequestData {\\n    address recipient; // The recipient of the attestation.\\n    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).\\n    bool revocable; // Whether the attestation is revocable.\\n    bytes32 refUID; // The UID of the related attestation.\\n    bytes data; // Custom attestation data.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/// @notice A struct representing the full arguments of the attestation request.\\nstruct AttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the full delegated attestation request.\\nstruct DelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData data; // The arguments of the attestation request.\\n    Signature signature; // The ECDSA signature data.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the multi attestation request.\\nstruct MultiAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi attestation request.\\nstruct MultiDelegatedAttestationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    AttestationRequestData[] data; // The arguments of the attestation requests.\\n    Signature[] signatures; // The ECDSA signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address attester; // The attesting account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the arguments of the revocation request.\\nstruct RevocationRequestData {\\n    bytes32 uid; // The UID of the attestation to revoke.\\n    uint256 value; // An explicit ETH amount to send to the resolver. This is important to prevent accidental user errors.\\n}\\n\\n/// @notice A struct representing the full arguments of the revocation request.\\nstruct RevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n}\\n\\n/// @notice A struct representing the arguments of the full delegated revocation request.\\nstruct DelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData data; // The arguments of the revocation request.\\n    Signature signature; // The ECDSA signature data.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @notice A struct representing the full arguments of the multi revocation request.\\nstruct MultiRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation request.\\n}\\n\\n/// @notice A struct representing the full arguments of the delegated multi revocation request.\\nstruct MultiDelegatedRevocationRequest {\\n    bytes32 schema; // The unique identifier of the schema.\\n    RevocationRequestData[] data; // The arguments of the revocation requests.\\n    Signature[] signatures; // The ECDSA signatures data. Please note that the signatures are assumed to be signed with increasing nonces.\\n    address revoker; // The revoking account.\\n    uint64 deadline; // The deadline of the signature/request.\\n}\\n\\n/// @title IEAS\\n/// @notice EAS - Ethereum Attestation Service interface.\\ninterface IEAS {\\n    /// @notice Emitted when an attestation has been made.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param attester The attesting account.\\n    /// @param uid The UID the revoked attestation.\\n    /// @param schemaUID The UID of the schema.\\n    event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);\\n\\n    /// @notice Emitted when an attestation has been revoked.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param attester The attesting account.\\n    /// @param schemaUID The UID of the schema.\\n    /// @param uid The UID the revoked attestation.\\n    event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);\\n\\n    /// @notice Emitted when a data has been timestamped.\\n    /// @param data The data.\\n    /// @param timestamp The timestamp.\\n    event Timestamped(bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /// @notice Emitted when a data has been revoked.\\n    /// @param revoker The address of the revoker.\\n    /// @param data The data.\\n    /// @param timestamp The timestamp.\\n    event RevokedOffchain(address indexed revoker, bytes32 indexed data, uint64 indexed timestamp);\\n\\n    /// @notice Returns the address of the global schema registry.\\n    /// @return The address of the global schema registry.\\n    function getSchemaRegistry() external view returns (ISchemaRegistry);\\n\\n    /// @notice Attests to a specific schema.\\n    /// @param request The arguments of the attestation request.\\n    /// @return The UID of the new attestation.\\n    ///\\n    /// Example:\\n    ///     attest({\\n    ///         schema: \\\"0facc36681cbe2456019c1b0d1e7bedd6d1d40f6f324bf3dd3a4cef2999200a0\\\",\\n    ///         data: {\\n    ///             recipient: \\\"0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf\\\",\\n    ///             expirationTime: 0,\\n    ///             revocable: true,\\n    ///             refUID: \\\"0x0000000000000000000000000000000000000000000000000000000000000000\\\",\\n    ///             data: \\\"0xF00D\\\",\\n    ///             value: 0\\n    ///         }\\n    ///     })\\n    function attest(AttestationRequest calldata request) external payable returns (bytes32);\\n\\n    /// @notice Attests to a specific schema via the provided ECDSA signature.\\n    /// @param delegatedRequest The arguments of the delegated attestation request.\\n    /// @return The UID of the new attestation.\\n    ///\\n    /// Example:\\n    ///     attestByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         attester: '0xc5E8740aD971409492b1A63Db8d83025e0Fc427e',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function attestByDelegation(\\n        DelegatedAttestationRequest calldata delegatedRequest\\n    ) external payable returns (bytes32);\\n\\n    /// @notice Attests to multiple schemas.\\n    /// @param multiRequests The arguments of the multi attestation requests. The requests should be grouped by distinct\\n    ///     schema ids to benefit from the best batching optimization.\\n    /// @return The UIDs of the new attestations.\\n    ///\\n    /// Example:\\n    ///     multiAttest([{\\n    ///         schema: '0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd',\\n    ///         data: [{\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 0,\\n    ///             revocable: false,\\n    ///             refUID: '0x480df4a039efc31b11bfdf491b383ca138b6bde160988222a2a3509c02cee174',\\n    ///             data: '0x00',\\n    ///             value: 0\\n    ///         }],\\n    ///     },\\n    ///     {\\n    ///         schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n    ///         data: [{\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 0,\\n    ///             revocable: true,\\n    ///             refUID: '0x75bf2ed8dca25a8190c50c52db136664de25b2449535839008ccfdab469b214f',\\n    ///             data: '0x12345678',\\n    ///             value: 0\\n    ///         },\\n    ///     }])\\n    function multiAttest(MultiAttestationRequest[] calldata multiRequests) external payable returns (bytes32[] memory);\\n\\n    /// @notice Attests to multiple schemas using via provided ECDSA signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi attestation requests. The requests should be\\n    ///     grouped by distinct schema ids to benefit from the best batching optimization.\\n    /// @return The UIDs of the new attestations.\\n    ///\\n    /// Example:\\n    ///     multiAttestByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',\\n    ///             expirationTime: 1673891048,\\n    ///             revocable: true,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x1234',\\n    ///             value: 0\\n    ///         },\\n    ///         {\\n    ///             recipient: '0xdEADBeAFdeAdbEafdeadbeafDeAdbEAFdeadbeaf',\\n    ///             expirationTime: 0,\\n    ///             revocable: false,\\n    ///             refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',\\n    ///             data: '0x00',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         attester: '0x1D86495b2A7B524D747d2839b3C645Bed32e8CF4',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiAttestByDelegation(\\n        MultiDelegatedAttestationRequest[] calldata multiDelegatedRequests\\n    ) external payable returns (bytes32[] memory);\\n\\n    /// @notice Revokes an existing attestation to a specific schema.\\n    /// @param request The arguments of the revocation request.\\n    ///\\n    /// Example:\\n    ///     revoke({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             uid: '0x101032e487642ee04ee17049f99a70590c735b8614079fc9275f9dd57c00966d',\\n    ///             value: 0\\n    ///         }\\n    ///     })\\n    function revoke(RevocationRequest calldata request) external payable;\\n\\n    /// @notice Revokes an existing attestation to a specific schema via the provided ECDSA signature.\\n    /// @param delegatedRequest The arguments of the delegated revocation request.\\n    ///\\n    /// Example:\\n    ///     revokeByDelegation({\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: {\\n    ///             uid: '0xcbbc12102578c642a0f7b34fe7111e41afa25683b6cd7b5a14caf90fa14d24ba',\\n    ///             value: 0\\n    ///         },\\n    ///         signature: {\\n    ///             v: 27,\\n    ///             r: '0xb593...7142',\\n    ///             s: '0x0f5b...2cce'\\n    ///         },\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     })\\n    function revokeByDelegation(DelegatedRevocationRequest calldata delegatedRequest) external payable;\\n\\n    /// @notice Revokes existing attestations to multiple schemas.\\n    /// @param multiRequests The arguments of the multi revocation requests. The requests should be grouped by distinct\\n    ///     schema ids to benefit from the best batching optimization.\\n    ///\\n    /// Example:\\n    ///     multiRevoke([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n    ///             value: 0\\n    ///         }],\\n    ///     },\\n    ///     {\\n    ///         schema: '0x5ac273ce41e3c8bfa383efe7c03e54c5f0bff29c9f11ef6ffa930fc84ca32425',\\n    ///         data: [{\\n    ///             uid: '0x053d42abce1fd7c8fcddfae21845ad34dae287b2c326220b03ba241bc5a8f019',\\n    ///             value: 0\\n    ///         },\\n    ///     }])\\n    function multiRevoke(MultiRevocationRequest[] calldata multiRequests) external payable;\\n\\n    /// @notice Revokes existing attestations to multiple schemas via provided ECDSA signatures.\\n    /// @param multiDelegatedRequests The arguments of the delegated multi revocation attestation requests. The requests\\n    ///     should be grouped by distinct schema ids to benefit from the best batching optimization.\\n    ///\\n    /// Example:\\n    ///     multiRevokeByDelegation([{\\n    ///         schema: '0x8e72f5bc0a8d4be6aa98360baa889040c50a0e51f32dbf0baa5199bd93472ebc',\\n    ///         data: [{\\n    ///             uid: '0x211296a1ca0d7f9f2cfebf0daaa575bea9b20e968d81aef4e743d699c6ac4b25',\\n    ///             value: 1000\\n    ///         },\\n    ///         {\\n    ///             uid: '0xe160ac1bd3606a287b4d53d5d1d6da5895f65b4b4bab6d93aaf5046e48167ade',\\n    ///             value: 0\\n    ///         }],\\n    ///         signatures: [{\\n    ///             v: 28,\\n    ///             r: '0x148c...b25b',\\n    ///             s: '0x5a72...be22'\\n    ///         },\\n    ///         {\\n    ///             v: 28,\\n    ///             r: '0x487s...67bb',\\n    ///             s: '0x12ad...2366'\\n    ///         }],\\n    ///         revoker: '0x244934dd3e31bE2c81f84ECf0b3E6329F5381992',\\n    ///         deadline: 1673891048\\n    ///     }])\\n    function multiRevokeByDelegation(\\n        MultiDelegatedRevocationRequest[] calldata multiDelegatedRequests\\n    ) external payable;\\n\\n    /// @notice Timestamps the specified bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was timestamped with.\\n    function timestamp(bytes32 data) external returns (uint64);\\n\\n    /// @notice Timestamps the specified multiple bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was timestamped with.\\n    function multiTimestamp(bytes32[] calldata data) external returns (uint64);\\n\\n    /// @notice Revokes the specified bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was revoked with.\\n    function revokeOffchain(bytes32 data) external returns (uint64);\\n\\n    /// @notice Revokes the specified multiple bytes32 data.\\n    /// @param data The data to timestamp.\\n    /// @return The timestamp the data was revoked with.\\n    function multiRevokeOffchain(bytes32[] calldata data) external returns (uint64);\\n\\n    /// @notice Returns an existing attestation by UID.\\n    /// @param uid The UID of the attestation to retrieve.\\n    /// @return The attestation data members.\\n    function getAttestation(bytes32 uid) external view returns (Attestation memory);\\n\\n    /// @notice Checks whether an attestation exists.\\n    /// @param uid The UID of the attestation to retrieve.\\n    /// @return Whether an attestation exists.\\n    function isAttestationValid(bytes32 uid) external view returns (bool);\\n\\n    /// @notice Returns the timestamp that the specified data was timestamped with.\\n    /// @param data The data to query.\\n    /// @return The timestamp the data was timestamped with.\\n    function getTimestamp(bytes32 data) external view returns (uint64);\\n\\n    /// @notice Returns the timestamp that the specified data was timestamped with.\\n    /// @param data The data to query.\\n    /// @return The timestamp the data was timestamped with.\\n    function getRevokeOffchain(address revoker, bytes32 data) external view returns (uint64);\\n}\\n\",\"keccak256\":\"0xd5a192f0bcee5372b69b0bb746c26317a2691dd10bfa52adbd08a9b723a55036\",\"license\":\"MIT\"},\"contracts/ISchemaRegistry.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { ISchemaResolver } from \\\"./resolver/ISchemaResolver.sol\\\";\\n\\n/// @notice A struct representing a record for a submitted schema.\\nstruct SchemaRecord {\\n    bytes32 uid; // The unique identifier of the schema.\\n    ISchemaResolver resolver; // Optional schema resolver.\\n    bool revocable; // Whether the schema allows revocations explicitly.\\n    string schema; // Custom specification of the schema (e.g., an ABI).\\n}\\n\\n/// @title ISchemaRegistry\\n/// @notice The interface of global attestation schemas for the Ethereum Attestation Service protocol.\\ninterface ISchemaRegistry {\\n    /// @notice Emitted when a new schema has been registered\\n    /// @param uid The schema UID.\\n    /// @param registerer The address of the account used to register the schema.\\n    /// @param schema The schema data.\\n    event Registered(bytes32 indexed uid, address indexed registerer, SchemaRecord schema);\\n\\n    /// @notice Submits and reserves a new schema\\n    /// @param schema The schema data schema.\\n    /// @param resolver An optional schema resolver.\\n    /// @param revocable Whether the schema allows revocations explicitly.\\n    /// @return The UID of the new schema.\\n    function register(string calldata schema, ISchemaResolver resolver, bool revocable) external returns (bytes32);\\n\\n    /// @notice Returns an existing schema by UID\\n    /// @param uid The UID of the schema to retrieve.\\n    /// @return The schema data members.\\n    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);\\n}\\n\",\"keccak256\":\"0x772b1ebcf3e5c93fecb53762e11bbdae75fcb667deea4ac21134fccfe78326e4\",\"license\":\"MIT\"},\"contracts/Indexer.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity 0.8.19;\\n\\nimport { IEAS, AttestationRequest, AttestationRequestData, Attestation } from \\\"./IEAS.sol\\\";\\nimport { EMPTY_UID, uncheckedInc } from \\\"./Common.sol\\\";\\nimport { Semver } from \\\"./Semver.sol\\\";\\n\\n/// @title Indexer\\n/// @notice Indexing Service for the Ethereum Attestation Service\\ncontract Indexer is Semver {\\n    error InvalidEAS();\\n    error InvalidAttestation();\\n    error InvalidOffset();\\n\\n    /// @notice Emitted when an attestation has been indexed.\\n    /// @param uid The UID the attestation.\\n    event Indexed(bytes32 indexed uid);\\n\\n    /// A mapping between an account and its received attestations.\\n    mapping(address account => mapping(bytes32 => bytes32[] uids) receivedAttestations) private _receivedAttestations;\\n\\n    // A mapping between an account and its sent attestations.\\n    mapping(address account => mapping(bytes32 => bytes32[] uids) sentAttestations) private _sentAttestations;\\n\\n    // A mapping between a schema, attester, and recipient.\\n    mapping(bytes32 schemaUID => mapping(address attester => mapping(address recipient => bytes32[] uids)))\\n        private _schemaAttesterRecipientAttestations;\\n\\n    // A mapping between a schema and its attestations.\\n    mapping(bytes32 schemaUID => bytes32[] uids) private _schemaAttestations;\\n\\n    // The global mapping of attestation indexing status.\\n    mapping(bytes32 attestationUID => bool status) private _indexedAttestations;\\n\\n    // The address of the global EAS contract.\\n    IEAS private immutable _eas;\\n\\n    /// @dev Creates a new Indexer instance.\\n    /// @param eas The address of the global EAS contract.\\n    constructor(IEAS eas) Semver(1, 2, 0) {\\n        if (address(eas) == address(0)) {\\n            revert InvalidEAS();\\n        }\\n\\n        _eas = eas;\\n    }\\n\\n    /// @notice Returns the EAS.\\n    function getEAS() external view returns (IEAS) {\\n        return _eas;\\n    }\\n\\n    /// @notice Indexes an existing attestation.\\n    /// @param attestationUID The UID of the attestation to index.\\n    function indexAttestation(bytes32 attestationUID) external {\\n        _indexAttestation(attestationUID);\\n    }\\n\\n    /// @notice Indexes multiple existing attestations.\\n    /// @param attestationUIDs The UIDs of the attestations to index.\\n    function indexAttestations(bytes32[] calldata attestationUIDs) external {\\n        uint256 length = attestationUIDs.length;\\n        for (uint256 i = 0; i < length; i = uncheckedInc(i)) {\\n            _indexAttestation(attestationUIDs[i]);\\n        }\\n    }\\n\\n    /// @notice Returns whether an existing attestation has been already indexed.\\n    /// @param attestationUID The UID of the attestation to check.\\n    /// @return Whether an attestation has been already indexed.\\n    function isAttestationIndexed(bytes32 attestationUID) external view returns (bool) {\\n        return _indexedAttestations[attestationUID];\\n    }\\n\\n    /// @notice Returns the UIDs of attestations to a specific schema which were attested to/received by a specific\\n    ///     recipient.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param schema The UID of the schema.\\n    /// @param start The offset to start from.\\n    /// @param length The number of total members to retrieve.\\n    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.\\n    /// @return An array of attestation UIDs.\\n    function getReceivedAttestationUIDs(\\n        address recipient,\\n        bytes32 schema,\\n        uint256 start,\\n        uint256 length,\\n        bool reverseOrder\\n    ) external view returns (bytes32[] memory) {\\n        return _sliceUIDs(_receivedAttestations[recipient][schema], start, length, reverseOrder);\\n    }\\n\\n    /// @notice Returns the total number of attestations to a specific schema which were attested to/received by a\\n    ///     specific recipient.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param schema The UID of the schema.\\n    /// @return The total number of attestations.\\n    function getReceivedAttestationUIDCount(address recipient, bytes32 schema) external view returns (uint256) {\\n        return _receivedAttestations[recipient][schema].length;\\n    }\\n\\n    /// @notice Returns the UIDs of attestations to a specific schema which were attested by a specific attester.\\n    /// @param attester The attester of the attestation.\\n    /// @param schema The UID of the schema.\\n    /// @param start The offset to start from.\\n    /// @param length The number of total members to retrieve.\\n    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.\\n    /// @return An array of attestation UIDs.\\n    function getSentAttestationUIDs(\\n        address attester,\\n        bytes32 schema,\\n        uint256 start,\\n        uint256 length,\\n        bool reverseOrder\\n    ) external view returns (bytes32[] memory) {\\n        return _sliceUIDs(_sentAttestations[attester][schema], start, length, reverseOrder);\\n    }\\n\\n    /// @notice Returns the total number of attestations to a specific schema which were attested by a specific\\n    /// attester.\\n    /// @param attester The attester of the attestation.\\n    /// @param schema The UID of the schema.\\n    /// @return The total number of attestations.\\n    function getSentAttestationUIDCount(address attester, bytes32 schema) external view returns (uint256) {\\n        return _sentAttestations[attester][schema].length;\\n    }\\n\\n    /// @notice Returns the UIDs of attestations to a specific schema which were attested by a specific attester to a\\n    ///     specific recipient.\\n    /// @param schema The UID of the schema.\\n    /// @param attester The attester of the attestation.\\n    /// @param recipient The recipient of the attestation.\\n    /// @param start The offset to start from.\\n    /// @param length The number of total members to retrieve.\\n    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.\\n    /// @return An array of attestation UIDs.\\n    function getSchemaAttesterRecipientAttestationUIDs(\\n        bytes32 schema,\\n        address attester,\\n        address recipient,\\n        uint256 start,\\n        uint256 length,\\n        bool reverseOrder\\n    ) external view returns (bytes32[] memory) {\\n        return\\n            _sliceUIDs(_schemaAttesterRecipientAttestations[schema][attester][recipient], start, length, reverseOrder);\\n    }\\n\\n    /// @notice Returns the total number of UIDs of attestations to a specific schema which were attested by a specific\\n    ///     attester to a specific recipient.\\n    /// @param schema The UID of the schema.\\n    /// @param attester The attester of the attestation.\\n    /// @param recipient The recipient of the attestation.\\n    /// @return An array of attestation UIDs.\\n    function getSchemaAttesterRecipientAttestationUIDCount(\\n        bytes32 schema,\\n        address attester,\\n        address recipient\\n    ) external view returns (uint256) {\\n        return _schemaAttesterRecipientAttestations[schema][attester][recipient].length;\\n    }\\n\\n    /// @notice Returns the UIDs of attestations to a specific schema.\\n    /// @param schema The UID of the schema.\\n    /// @param start The offset to start from.\\n    /// @param length The number of total members to retrieve.\\n    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.\\n    /// @return An array of attestation UIDs.\\n    function getSchemaAttestationUIDs(\\n        bytes32 schema,\\n        uint256 start,\\n        uint256 length,\\n        bool reverseOrder\\n    ) external view returns (bytes32[] memory) {\\n        return _sliceUIDs(_schemaAttestations[schema], start, length, reverseOrder);\\n    }\\n\\n    /// @notice Returns the total number of attestations to a specific schema.\\n    /// @param schema The UID of the schema.\\n    /// @return An array of attestation UIDs.\\n    function getSchemaAttestationUIDCount(bytes32 schema) external view returns (uint256) {\\n        return _schemaAttestations[schema].length;\\n    }\\n\\n    /// @dev Indexes an existing attestation.\\n    /// @param attestationUID The UID of the attestation to index.\\n    function _indexAttestation(bytes32 attestationUID) private {\\n        // Skip already indexed attestations.\\n        if (_indexedAttestations[attestationUID]) {\\n            return;\\n        }\\n\\n        // Check if the attestation exists.\\n        Attestation memory attestation = _eas.getAttestation(attestationUID);\\n\\n        bytes32 uid = attestation.uid;\\n        if (uid == EMPTY_UID) {\\n            revert InvalidAttestation();\\n        }\\n\\n        // Index the attestation.\\n        address attester = attestation.attester;\\n        address recipient = attestation.recipient;\\n        bytes32 schema = attestation.schema;\\n\\n        _indexedAttestations[attestationUID] = true;\\n        _schemaAttestations[schema].push(attestationUID);\\n        _receivedAttestations[recipient][schema].push(attestationUID);\\n        _sentAttestations[attester][schema].push(attestationUID);\\n        _schemaAttesterRecipientAttestations[schema][attester][recipient].push(attestationUID);\\n\\n        emit Indexed({ uid: uid });\\n    }\\n\\n    /// @dev Returns a slice in an array of attestation UIDs.\\n    /// @param uids The array of attestation UIDs.\\n    /// @param start The offset to start from.\\n    /// @param length The number of total members to retrieve.\\n    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.\\n    /// @return An array of attestation UIDs.\\n    function _sliceUIDs(\\n        bytes32[] memory uids,\\n        uint256 start,\\n        uint256 length,\\n        bool reverseOrder\\n    ) private pure returns (bytes32[] memory) {\\n        uint256 attestationsLength = uids.length;\\n        if (attestationsLength == 0) {\\n            return new bytes32[](0);\\n        }\\n\\n        if (start >= attestationsLength) {\\n            revert InvalidOffset();\\n        }\\n\\n        unchecked {\\n            uint256 len = length;\\n            if (attestationsLength < start + length) {\\n                len = attestationsLength - start;\\n            }\\n\\n            bytes32[] memory res = new bytes32[](len);\\n\\n            for (uint256 i = 0; i < len; ++i) {\\n                res[i] = uids[reverseOrder ? attestationsLength - (start + i + 1) : start + i];\\n            }\\n\\n            return res;\\n        }\\n    }\\n}\\n\",\"keccak256\":\"0x8c0f19a79712ee67248f0f0d3f343daf4281da31ffa6319c67c8a7af38a660b0\",\"license\":\"MIT\"},\"contracts/Semver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.4;\\n\\nimport { Strings } from \\\"@openzeppelin/contracts/utils/Strings.sol\\\";\\n\\n/// @title Semver\\n/// @notice A simple contract for managing contract versions.\\ncontract Semver {\\n    // Contract's major version number.\\n    uint256 private immutable _major;\\n\\n    // Contract's minor version number.\\n    uint256 private immutable _minor;\\n\\n    // Contract's patch version number.\\n    uint256 private immutable _path;\\n\\n    /// @dev Create a new Semver instance.\\n    /// @param major Major version number.\\n    /// @param minor Minor version number.\\n    /// @param patch Patch version number.\\n    constructor(uint256 major, uint256 minor, uint256 patch) {\\n        _major = major;\\n        _minor = minor;\\n        _path = patch;\\n    }\\n\\n    /// @notice Returns the full semver contract version.\\n    /// @return Semver contract version as a string.\\n    function version() external view returns (string memory) {\\n        return\\n            string(\\n                abi.encodePacked(Strings.toString(_major), \\\".\\\", Strings.toString(_minor), \\\".\\\", Strings.toString(_path))\\n            );\\n    }\\n}\\n\",\"keccak256\":\"0x5883c852730b00d73b10475f3b382afce8f30b89f337078ec03a66c463e048a8\",\"license\":\"MIT\"},\"contracts/resolver/ISchemaResolver.sol\":{\"content\":\"// SPDX-License-Identifier: MIT\\n\\npragma solidity ^0.8.0;\\n\\nimport { Attestation } from \\\"../Common.sol\\\";\\n\\n/// @title ISchemaResolver\\n/// @notice The interface of an optional schema resolver.\\ninterface ISchemaResolver {\\n    /// @notice Checks if the resolver can be sent ETH.\\n    /// @return Whether the resolver supports ETH transfers.\\n    function isPayable() external pure returns (bool);\\n\\n    /// @notice Processes an attestation and verifies whether it's valid.\\n    /// @param attestation The new attestation.\\n    /// @return Whether the attestation is valid.\\n    function attest(Attestation calldata attestation) external payable returns (bool);\\n\\n    /// @notice Processes multiple attestations and verifies whether they are valid.\\n    /// @param attestations The new attestations.\\n    /// @param values Explicit ETH amounts which were sent with each attestation.\\n    /// @return Whether all the attestations are valid.\\n    function multiAttest(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n\\n    /// @notice Processes an attestation revocation and verifies if it can be revoked.\\n    /// @param attestation The existing attestation to be revoked.\\n    /// @return Whether the attestation can be revoked.\\n    function revoke(Attestation calldata attestation) external payable returns (bool);\\n\\n    /// @notice Processes revocation of multiple attestation and verifies they can be revoked.\\n    /// @param attestations The existing attestations to be revoked.\\n    /// @param values Explicit ETH amounts which were sent with each revocation.\\n    /// @return Whether the attestations can be revoked.\\n    function multiRevoke(\\n        Attestation[] calldata attestations,\\n        uint256[] calldata values\\n    ) external payable returns (bool);\\n}\\n\",\"keccak256\":\"0xb74b64e20b90b35004750d2c78ceb114a304975d22d71bd9a2a9de0d483f0395\",\"license\":\"MIT\"}},\"version\":1}",
        "bytecode": "0x61010060405234801561001157600080fd5b506040516111b13803806111b183398101604081905261003091610077565b6001608052600260a052600060c0526001600160a01b038116610066576040516341bc07ff60e11b815260040160405180910390fd5b6001600160a01b031660e0526100a7565b60006020828403121561008957600080fd5b81516001600160a01b03811681146100a057600080fd5b9392505050565b60805160a05160c05160e0516110ca6100e7600039600081816101ea01526108330152600061034c01526000610323015260006102fa01526110ca6000f3fe608060405234801561001057600080fd5b50600436106100df5760003560e01c8063715ecdf61161008c578063b616352a11610066578063b616352a1461026d578063bbbdc81814610282578063ea51994b14610295578063ec864cba146102e057600080fd5b8063715ecdf61461021457806389a82fbe14610227578063af288efe1461025a57600080fd5b806354fd4d50116100bd57806354fd4d501461019b57806363bbf81b146101b057806365c40b9c146101d057600080fd5b80632412e9cc146100e4578063288a0a7b146101385780632f45f90e1461017b575b600080fd5b6101256100f2366004610b38565b73ffffffffffffffffffffffffffffffffffffffff91909116600090815260208181526040808320938352929052205490565b6040519081526020015b60405180910390f35b610125610146366004610b38565b73ffffffffffffffffffffffffffffffffffffffff919091166000908152600160209081526040808320938352929052205490565b610125610189366004610b64565b60009081526003602052604090205490565b6101a36102f3565b60405161012f9190610ba1565b6101c36101be366004610c00565b610396565b60405161012f9190610c41565b60405173ffffffffffffffffffffffffffffffffffffffff7f000000000000000000000000000000000000000000000000000000000000000016815260200161012f565b6101c3610222366004610c85565b610410565b61024a610235366004610b64565b60009081526004602052604090205460ff1690565b604051901515815260200161012f565b6101c3610268366004610cec565b6104ad565b61028061027b366004610d42565b61053c565b005b610280610290366004610b64565b610577565b6101256102a3366004610db7565b600092835260026020908152604080852073ffffffffffffffffffffffffffffffffffffffff948516865282528085209290931684525290205490565b6101c36102ee366004610cec565b610583565b606061031e7f000000000000000000000000000000000000000000000000000000000000000061060a565b6103477f000000000000000000000000000000000000000000000000000000000000000061060a565b6103707f000000000000000000000000000000000000000000000000000000000000000061060a565b60405160200161038293929190610df9565b604051602081830303815290604052905090565b6060610405600360008781526020019081526020016000208054806020026020016040519081016040528092919081815260200182805480156103f857602002820191906000526020600020905b8154815260200190600101908083116103e4575b50505050508585856106c8565b90505b949350505050565b600086815260026020908152604080832073ffffffffffffffffffffffffffffffffffffffff808a168552908352818420908816845282529182902080548351818402810184019094528084526060936104a293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b979650505050505050565b73ffffffffffffffffffffffffffffffffffffffff8516600090815260208181526040808320878452825291829020805483518184028101840190945280845260609361053293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b9695505050505050565b8060005b818110156105715761056984848381811061055d5761055d610e6f565b905060200201356107e7565b600101610540565b50505050565b610580816107e7565b50565b73ffffffffffffffffffffffffffffffffffffffff85166000908152600160209081526040808320878452825291829020805483518184028101840190945280845260609361053293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b6060600061061783610a33565b600101905060008167ffffffffffffffff81111561063757610637610e9e565b6040519080825280601f01601f191660200182016040528015610661576020820181803683370190505b5090508181016020015b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff017f3031323334353637383961626364656600000000000000000000000000000000600a86061a8153600a850494508461066b57509392505050565b835160609060008190036106ec575050604080516000815260208101909152610408565b808510610725576040517f01da157200000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8385810182101561073557508481035b60008167ffffffffffffffff81111561075057610750610e9e565b604051908082528060200260200182016040528015610779578160200160208202803683370190505b50905060005b828110156107db5788866107955781890161079e565b81890160010185035b815181106107ae576107ae610e6f565b60200260200101518282815181106107c8576107c8610e6f565b602090810291909101015260010161077f565b50979650505050505050565b60008181526004602052604090205460ff16156108015750565b6040517fa3112a64000000000000000000000000000000000000000000000000000000008152600481018290526000907f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff169063a3112a6490602401600060405180830381865afa15801561088f573d6000803e3d6000fd5b505050506040513d6000823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01682016040526108d59190810190610fc6565b805190915080610911576040517fbd8ba84d00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60e082015160c0830151602080850151600087815260048352604080822080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001660019081179091558383526003855281832080548083018255908452858420018a905573ffffffffffffffffffffffffffffffffffffffff808716808552848752838520868652875283852080548085018255908652878620018c9055908816808552828752838520868652875283852080548085018255908652878620018c905585855260028752838520908552865282842090845285528183208054918201815583529382209093018890559151909185917f2178f435e9624d54115e1d50a7313c90518a363b292678118444c0a239f11cf99190a2505050505050565b6000807a184f03e93ff9f4daa797ed6e38ed64bf6a1f0100000000000000008310610a7c577a184f03e93ff9f4daa797ed6e38ed64bf6a1f010000000000000000830492506040015b6d04ee2d6d415b85acef81000000008310610aa8576d04ee2d6d415b85acef8100000000830492506020015b662386f26fc100008310610ac657662386f26fc10000830492506010015b6305f5e1008310610ade576305f5e100830492506008015b6127108310610af257612710830492506004015b60648310610b04576064830492506002015b600a8310610b10576001015b92915050565b73ffffffffffffffffffffffffffffffffffffffff8116811461058057600080fd5b60008060408385031215610b4b57600080fd5b8235610b5681610b16565b946020939093013593505050565b600060208284031215610b7657600080fd5b5035919050565b60005b83811015610b98578181015183820152602001610b80565b50506000910152565b6020815260008251806020840152610bc0816040850160208701610b7d565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169190910160400192915050565b801515811461058057600080fd5b60008060008060808587031215610c1657600080fd5b8435935060208501359250604085013591506060850135610c3681610bf2565b939692955090935050565b6020808252825182820181905260009190848201906040850190845b81811015610c7957835183529284019291840191600101610c5d565b50909695505050505050565b60008060008060008060c08789031215610c9e57600080fd5b863595506020870135610cb081610b16565b94506040870135610cc081610b16565b9350606087013592506080870135915060a0870135610cde81610bf2565b809150509295509295509295565b600080600080600060a08688031215610d0457600080fd5b8535610d0f81610b16565b94506020860135935060408601359250606086013591506080860135610d3481610bf2565b809150509295509295909350565b60008060208385031215610d5557600080fd5b823567ffffffffffffffff80821115610d6d57600080fd5b818501915085601f830112610d8157600080fd5b813581811115610d9057600080fd5b8660208260051b8501011115610da557600080fd5b60209290920196919550909350505050565b600080600060608486031215610dcc57600080fd5b833592506020840135610dde81610b16565b91506040840135610dee81610b16565b809150509250925092565b60008451610e0b818460208901610b7d565b80830190507f2e000000000000000000000000000000000000000000000000000000000000008082528551610e47816001850160208a01610b7d565b60019201918201528351610e62816002840160208801610b7d565b0160020195945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b604051610140810167ffffffffffffffff81118282101715610ef157610ef1610e9e565b60405290565b805167ffffffffffffffff81168114610f0f57600080fd5b919050565b8051610f0f81610b16565b8051610f0f81610bf2565b600082601f830112610f3b57600080fd5b815167ffffffffffffffff80821115610f5657610f56610e9e565b604051601f83017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0908116603f01168101908282118183101715610f9c57610f9c610e9e565b81604052838152866020858801011115610fb557600080fd5b610532846020830160208901610b7d565b600060208284031215610fd857600080fd5b815167ffffffffffffffff80821115610ff057600080fd5b90830190610140828603121561100557600080fd5b61100d610ecd565b825181526020830151602082015261102760408401610ef7565b604082015261103860608401610ef7565b606082015261104960808401610ef7565b608082015260a083015160a082015261106460c08401610f14565b60c082015261107560e08401610f14565b60e0820152610100611088818501610f1f565b9082015261012083810151838111156110a057600080fd5b6110ac88828701610f2a565b91830191909152509594505050505056fea164736f6c6343000813000a",
        "deployedBytecode": "0x608060405234801561001057600080fd5b50600436106100df5760003560e01c8063715ecdf61161008c578063b616352a11610066578063b616352a1461026d578063bbbdc81814610282578063ea51994b14610295578063ec864cba146102e057600080fd5b8063715ecdf61461021457806389a82fbe14610227578063af288efe1461025a57600080fd5b806354fd4d50116100bd57806354fd4d501461019b57806363bbf81b146101b057806365c40b9c146101d057600080fd5b80632412e9cc146100e4578063288a0a7b146101385780632f45f90e1461017b575b600080fd5b6101256100f2366004610b38565b73ffffffffffffffffffffffffffffffffffffffff91909116600090815260208181526040808320938352929052205490565b6040519081526020015b60405180910390f35b610125610146366004610b38565b73ffffffffffffffffffffffffffffffffffffffff919091166000908152600160209081526040808320938352929052205490565b610125610189366004610b64565b60009081526003602052604090205490565b6101a36102f3565b60405161012f9190610ba1565b6101c36101be366004610c00565b610396565b60405161012f9190610c41565b60405173ffffffffffffffffffffffffffffffffffffffff7f000000000000000000000000000000000000000000000000000000000000000016815260200161012f565b6101c3610222366004610c85565b610410565b61024a610235366004610b64565b60009081526004602052604090205460ff1690565b604051901515815260200161012f565b6101c3610268366004610cec565b6104ad565b61028061027b366004610d42565b61053c565b005b610280610290366004610b64565b610577565b6101256102a3366004610db7565b600092835260026020908152604080852073ffffffffffffffffffffffffffffffffffffffff948516865282528085209290931684525290205490565b6101c36102ee366004610cec565b610583565b606061031e7f000000000000000000000000000000000000000000000000000000000000000061060a565b6103477f000000000000000000000000000000000000000000000000000000000000000061060a565b6103707f000000000000000000000000000000000000000000000000000000000000000061060a565b60405160200161038293929190610df9565b604051602081830303815290604052905090565b6060610405600360008781526020019081526020016000208054806020026020016040519081016040528092919081815260200182805480156103f857602002820191906000526020600020905b8154815260200190600101908083116103e4575b50505050508585856106c8565b90505b949350505050565b600086815260026020908152604080832073ffffffffffffffffffffffffffffffffffffffff808a168552908352818420908816845282529182902080548351818402810184019094528084526060936104a293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b979650505050505050565b73ffffffffffffffffffffffffffffffffffffffff8516600090815260208181526040808320878452825291829020805483518184028101840190945280845260609361053293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b9695505050505050565b8060005b818110156105715761056984848381811061055d5761055d610e6f565b905060200201356107e7565b600101610540565b50505050565b610580816107e7565b50565b73ffffffffffffffffffffffffffffffffffffffff85166000908152600160209081526040808320878452825291829020805483518184028101840190945280845260609361053293909291908301828280156103f857602002820191906000526020600020908154815260200190600101908083116103e45750505050508585856106c8565b6060600061061783610a33565b600101905060008167ffffffffffffffff81111561063757610637610e9e565b6040519080825280601f01601f191660200182016040528015610661576020820181803683370190505b5090508181016020015b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff017f3031323334353637383961626364656600000000000000000000000000000000600a86061a8153600a850494508461066b57509392505050565b835160609060008190036106ec575050604080516000815260208101909152610408565b808510610725576040517f01da157200000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8385810182101561073557508481035b60008167ffffffffffffffff81111561075057610750610e9e565b604051908082528060200260200182016040528015610779578160200160208202803683370190505b50905060005b828110156107db5788866107955781890161079e565b81890160010185035b815181106107ae576107ae610e6f565b60200260200101518282815181106107c8576107c8610e6f565b602090810291909101015260010161077f565b50979650505050505050565b60008181526004602052604090205460ff16156108015750565b6040517fa3112a64000000000000000000000000000000000000000000000000000000008152600481018290526000907f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff169063a3112a6490602401600060405180830381865afa15801561088f573d6000803e3d6000fd5b505050506040513d6000823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01682016040526108d59190810190610fc6565b805190915080610911576040517fbd8ba84d00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60e082015160c0830151602080850151600087815260048352604080822080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001660019081179091558383526003855281832080548083018255908452858420018a905573ffffffffffffffffffffffffffffffffffffffff808716808552848752838520868652875283852080548085018255908652878620018c9055908816808552828752838520868652875283852080548085018255908652878620018c905585855260028752838520908552865282842090845285528183208054918201815583529382209093018890559151909185917f2178f435e9624d54115e1d50a7313c90518a363b292678118444c0a239f11cf99190a2505050505050565b6000807a184f03e93ff9f4daa797ed6e38ed64bf6a1f0100000000000000008310610a7c577a184f03e93ff9f4daa797ed6e38ed64bf6a1f010000000000000000830492506040015b6d04ee2d6d415b85acef81000000008310610aa8576d04ee2d6d415b85acef8100000000830492506020015b662386f26fc100008310610ac657662386f26fc10000830492506010015b6305f5e1008310610ade576305f5e100830492506008015b6127108310610af257612710830492506004015b60648310610b04576064830492506002015b600a8310610b10576001015b92915050565b73ffffffffffffffffffffffffffffffffffffffff8116811461058057600080fd5b60008060408385031215610b4b57600080fd5b8235610b5681610b16565b946020939093013593505050565b600060208284031215610b7657600080fd5b5035919050565b60005b83811015610b98578181015183820152602001610b80565b50506000910152565b6020815260008251806020840152610bc0816040850160208701610b7d565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169190910160400192915050565b801515811461058057600080fd5b60008060008060808587031215610c1657600080fd5b8435935060208501359250604085013591506060850135610c3681610bf2565b939692955090935050565b6020808252825182820181905260009190848201906040850190845b81811015610c7957835183529284019291840191600101610c5d565b50909695505050505050565b60008060008060008060c08789031215610c9e57600080fd5b863595506020870135610cb081610b16565b94506040870135610cc081610b16565b9350606087013592506080870135915060a0870135610cde81610bf2565b809150509295509295509295565b600080600080600060a08688031215610d0457600080fd5b8535610d0f81610b16565b94506020860135935060408601359250606086013591506080860135610d3481610bf2565b809150509295509295909350565b60008060208385031215610d5557600080fd5b823567ffffffffffffffff80821115610d6d57600080fd5b818501915085601f830112610d8157600080fd5b813581811115610d9057600080fd5b8660208260051b8501011115610da557600080fd5b60209290920196919550909350505050565b600080600060608486031215610dcc57600080fd5b833592506020840135610dde81610b16565b91506040840135610dee81610b16565b809150509250925092565b60008451610e0b818460208901610b7d565b80830190507f2e000000000000000000000000000000000000000000000000000000000000008082528551610e47816001850160208a01610b7d565b60019201918201528351610e62816002840160208801610b7d565b0160020195945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b604051610140810167ffffffffffffffff81118282101715610ef157610ef1610e9e565b60405290565b805167ffffffffffffffff81168114610f0f57600080fd5b919050565b8051610f0f81610b16565b8051610f0f81610bf2565b600082601f830112610f3b57600080fd5b815167ffffffffffffffff80821115610f5657610f56610e9e565b604051601f83017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0908116603f01168101908282118183101715610f9c57610f9c610e9e565b81604052838152866020858801011115610fb557600080fd5b610532846020830160208901610b7d565b600060208284031215610fd857600080fd5b815167ffffffffffffffff80821115610ff057600080fd5b90830190610140828603121561100557600080fd5b61100d610ecd565b825181526020830151602082015261102760408401610ef7565b604082015261103860608401610ef7565b606082015261104960808401610ef7565b608082015260a083015160a082015261106460c08401610f14565b60c082015261107560e08401610f14565b60e0820152610100611088818501610f1f565b9082015261012083810151838111156110a057600080fd5b6110ac88828701610f2a565b91830191909152509594505050505056fea164736f6c6343000813000a",
        "devdoc": {
          "events": {
            "Indexed(bytes32)": {
              "params": {
                "uid": "The UID the attestation."
              }
            }
          },
          "kind": "dev",
          "methods": {
            "constructor": {
              "details": "Creates a new Indexer instance.",
              "params": {
                "eas": "The address of the global EAS contract."
              }
            },
            "getReceivedAttestationUIDCount(address,bytes32)": {
              "params": {
                "recipient": "The recipient of the attestation.",
                "schema": "The UID of the schema."
              },
              "returns": {
                "_0": "The total number of attestations."
              }
            },
            "getReceivedAttestationUIDs(address,bytes32,uint256,uint256,bool)": {
              "params": {
                "length": "The number of total members to retrieve.",
                "recipient": "The recipient of the attestation.",
                "reverseOrder": "Whether the offset starts from the end and the data is returned in reverse.",
                "schema": "The UID of the schema.",
                "start": "The offset to start from."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "getSchemaAttestationUIDCount(bytes32)": {
              "params": {
                "schema": "The UID of the schema."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "getSchemaAttestationUIDs(bytes32,uint256,uint256,bool)": {
              "params": {
                "length": "The number of total members to retrieve.",
                "reverseOrder": "Whether the offset starts from the end and the data is returned in reverse.",
                "schema": "The UID of the schema.",
                "start": "The offset to start from."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "getSchemaAttesterRecipientAttestationUIDCount(bytes32,address,address)": {
              "params": {
                "attester": "The attester of the attestation.",
                "recipient": "The recipient of the attestation.",
                "schema": "The UID of the schema."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "getSchemaAttesterRecipientAttestationUIDs(bytes32,address,address,uint256,uint256,bool)": {
              "params": {
                "attester": "The attester of the attestation.",
                "length": "The number of total members to retrieve.",
                "recipient": "The recipient of the attestation.",
                "reverseOrder": "Whether the offset starts from the end and the data is returned in reverse.",
                "schema": "The UID of the schema.",
                "start": "The offset to start from."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "getSentAttestationUIDCount(address,bytes32)": {
              "params": {
                "attester": "The attester of the attestation.",
                "schema": "The UID of the schema."
              },
              "returns": {
                "_0": "The total number of attestations."
              }
            },
            "getSentAttestationUIDs(address,bytes32,uint256,uint256,bool)": {
              "params": {
                "attester": "The attester of the attestation.",
                "length": "The number of total members to retrieve.",
                "reverseOrder": "Whether the offset starts from the end and the data is returned in reverse.",
                "schema": "The UID of the schema.",
                "start": "The offset to start from."
              },
              "returns": {
                "_0": "An array of attestation UIDs."
              }
            },
            "indexAttestation(bytes32)": {
              "params": {
                "attestationUID": "The UID of the attestation to index."
              }
            },
            "indexAttestations(bytes32[])": {
              "params": {
                "attestationUIDs": "The UIDs of the attestations to index."
              }
            },
            "isAttestationIndexed(bytes32)": {
              "params": {
                "attestationUID": "The UID of the attestation to check."
              },
              "returns": {
                "_0": "Whether an attestation has been already indexed."
              }
            },
            "version()": {
              "returns": {
                "_0": "Semver contract version as a string."
              }
            }
          },
          "title": "Indexer",
          "version": 1
        },
        "userdoc": {
          "events": {
            "Indexed(bytes32)": {
              "notice": "Emitted when an attestation has been indexed."
            }
          },
          "kind": "user",
          "methods": {
            "getEAS()": {
              "notice": "Returns the EAS."
            },
            "getReceivedAttestationUIDCount(address,bytes32)": {
              "notice": "Returns the total number of attestations to a specific schema which were attested to/received by a     specific recipient."
            },
            "getReceivedAttestationUIDs(address,bytes32,uint256,uint256,bool)": {
              "notice": "Returns the UIDs of attestations to a specific schema which were attested to/received by a specific     recipient."
            },
            "getSchemaAttestationUIDCount(bytes32)": {
              "notice": "Returns the total number of attestations to a specific schema."
            },
            "getSchemaAttestationUIDs(bytes32,uint256,uint256,bool)": {
              "notice": "Returns the UIDs of attestations to a specific schema."
            },
            "getSchemaAttesterRecipientAttestationUIDCount(bytes32,address,address)": {
              "notice": "Returns the total number of UIDs of attestations to a specific schema which were attested by a specific     attester to a specific recipient."
            },
            "getSchemaAttesterRecipientAttestationUIDs(bytes32,address,address,uint256,uint256,bool)": {
              "notice": "Returns the UIDs of attestations to a specific schema which were attested by a specific attester to a     specific recipient."
            },
            "getSentAttestationUIDCount(address,bytes32)": {
              "notice": "Returns the total number of attestations to a specific schema which were attested by a specific attester."
            },
            "getSentAttestationUIDs(address,bytes32,uint256,uint256,bool)": {
              "notice": "Returns the UIDs of attestations to a specific schema which were attested by a specific attester."
            },
            "indexAttestation(bytes32)": {
              "notice": "Indexes an existing attestation."
            },
            "indexAttestations(bytes32[])": {
              "notice": "Indexes multiple existing attestations."
            },
            "isAttestationIndexed(bytes32)": {
              "notice": "Returns whether an existing attestation has been already indexed."
            },
            "version()": {
              "notice": "Returns the full semver contract version."
            }
          },
          "notice": "Indexing Service for the Ethereum Attestation Service",
          "version": 1
        },
        "storageLayout": {
          "storage": [
            {
              "astId": 6193,
              "contract": "contracts/Indexer.sol:Indexer",
              "label": "_receivedAttestations",
              "offset": 0,
              "slot": "0",
              "type": "t_mapping(t_address,t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage))"
            },
            {
              "astId": 6200,
              "contract": "contracts/Indexer.sol:Indexer",
              "label": "_sentAttestations",
              "offset": 0,
              "slot": "1",
              "type": "t_mapping(t_address,t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage))"
            },
            {
              "astId": 6209,
              "contract": "contracts/Indexer.sol:Indexer",
              "label": "_schemaAttesterRecipientAttestations",
              "offset": 0,
              "slot": "2",
              "type": "t_mapping(t_bytes32,t_mapping(t_address,t_mapping(t_address,t_array(t_bytes32)dyn_storage)))"
            },
            {
              "astId": 6214,
              "contract": "contracts/Indexer.sol:Indexer",
              "label": "_schemaAttestations",
              "offset": 0,
              "slot": "3",
              "type": "t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage)"
            },
            {
              "astId": 6218,
              "contract": "contracts/Indexer.sol:Indexer",
              "label": "_indexedAttestations",
              "offset": 0,
              "slot": "4",
              "type": "t_mapping(t_bytes32,t_bool)"
            }
          ],
          "types": {
            "t_address": {
              "encoding": "inplace",
              "label": "address",
              "numberOfBytes": "20"
            },
            "t_array(t_bytes32)dyn_storage": {
              "base": "t_bytes32",
              "encoding": "dynamic_array",
              "label": "bytes32[]",
              "numberOfBytes": "32"
            },
            "t_bool": {
              "encoding": "inplace",
              "label": "bool",
              "numberOfBytes": "1"
            },
            "t_bytes32": {
              "encoding": "inplace",
              "label": "bytes32",
              "numberOfBytes": "32"
            },
            "t_mapping(t_address,t_array(t_bytes32)dyn_storage)": {
              "encoding": "mapping",
              "key": "t_address",
              "label": "mapping(address => bytes32[])",
              "numberOfBytes": "32",
              "value": "t_array(t_bytes32)dyn_storage"
            },
            "t_mapping(t_address,t_mapping(t_address,t_array(t_bytes32)dyn_storage))": {
              "encoding": "mapping",
              "key": "t_address",
              "label": "mapping(address => mapping(address => bytes32[]))",
              "numberOfBytes": "32",
              "value": "t_mapping(t_address,t_array(t_bytes32)dyn_storage)"
            },
            "t_mapping(t_address,t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage))": {
              "encoding": "mapping",
              "key": "t_address",
              "label": "mapping(address => mapping(bytes32 => bytes32[]))",
              "numberOfBytes": "32",
              "value": "t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage)"
            },
            "t_mapping(t_bytes32,t_array(t_bytes32)dyn_storage)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => bytes32[])",
              "numberOfBytes": "32",
              "value": "t_array(t_bytes32)dyn_storage"
            },
            "t_mapping(t_bytes32,t_bool)": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => bool)",
              "numberOfBytes": "32",
              "value": "t_bool"
            },
            "t_mapping(t_bytes32,t_mapping(t_address,t_mapping(t_address,t_array(t_bytes32)dyn_storage)))": {
              "encoding": "mapping",
              "key": "t_bytes32",
              "label": "mapping(bytes32 => mapping(address => mapping(address => bytes32[])))",
              "numberOfBytes": "32",
              "value": "t_mapping(t_address,t_mapping(t_address,t_array(t_bytes32)dyn_storage))"
            }
          }
        }
      }
    },
  } as const;
  
  

export default externalContracts satisfies GenericContractsDeclaration;
