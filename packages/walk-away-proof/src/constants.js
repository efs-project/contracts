export const CHAIN_ID = 11155111;
export const CHAIN_HEX = "0xaa36a7";
export const EXPECTED_SIGNER = "0xaCf4C2950107eF9b1C37faA1F9a866C8F0da88b9";
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export const CONTRACTS = Object.freeze({
  eas: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
  indexer: "0xc4DeaBB482C2FA74690629eEa662efb166BD658a",
  edgeResolver: "0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1",
  mirrorResolver: "0xd4991Ced6D460A3794E9120dC6C19975092982b9",
});

export const SCHEMAS = Object.freeze({
  anchor: "0xf818abd74da70345c8acd7087e6ce69fd48eaf4e79c1931e5c6b08fb148c921a",
  property: "0xa1f54f2d395c24077e374d9a2d835a2d2fcb3b4c3e019f63525bee3424f1c246",
  data: "0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c",
  pin: "0x5aaabaea19accff34c604f6f1b0dd2361a0a9ba64f7746ea6b3ed95d4047d878",
  mirror: "0x9573ea8100bda88cc09ba275d8307b309c42ae82cca7f96ccf0e3eef4b5ea58d",
});

export const TRANSPORTS = Object.freeze({
  root: "0x936fb4c60e82d645bda043b6b7d6a20643c503d4a86450f0d348383e02878cc3",
  ipfs: "0x6a4b8fe8bc24a1de569f5ab2d46d83db9cd87ff234a6976b57e9cd4156a363ee",
  arweave: "0xca1596777bbeca44eb28d78df6e2c7c664c7d6de062f8530f84b188e44093336",
});

export const EAS_ABI = [
  "function multiAttest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiRequests) payable returns (bytes32[])",
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
];

export const EDGE_RESOLVER_ABI = [
  "function getActivePin(bytes32 definition,address attester,bytes32 targetSchema) view returns (bytes32)",
  "function getActivePinTarget(bytes32 definition,address attester,bytes32 targetSchema) view returns (bytes32)",
];

export const EIP712_DOMAIN = Object.freeze({
  name: "EFS Walk-Away Proof",
  version: "0",
  chainId: CHAIN_ID,
  verifyingContract: CONTRACTS.eas,
});

export const EIP712_TYPES = Object.freeze({
  WalkAwayManifest: [{ name: "manifestDigest", type: "bytes32" }],
});

export const DEFAULT_ENDPOINTS = Object.freeze({
  sepoliaRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  ipfsGateway: "https://w3s.link/ipfs/",
  arweaveGateway: "https://arweave.net/",
});
