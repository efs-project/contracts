import { AbiCoder, Contract, Interface, ZeroAddress, getAddress } from "ethers";
import {
  CHAIN_ID,
  CONTRACTS,
  EAS_ABI,
  EXPECTED_SIGNER,
  SCHEMAS,
  TRANSPORTS,
  ZERO_BYTES32,
} from "./constants.js";
import { efsContentHashValue, manifestDigest } from "./manifest.js";

const coder = AbiCoder.defaultAbiCoder();
const easInterface = new Interface(EAS_ABI);

function attestation({ recipient = ZeroAddress, revocable, refUID = ZERO_BYTES32, data = "0x" }) {
  return {
    recipient,
    expirationTime: 0n,
    revocable,
    refUID,
    data,
    value: 0n,
  };
}

function request(schema, data) {
  return { schema, data };
}

export function buildStage1(manifest) {
  return [
    request(SCHEMAS.data, [attestation({ revocable: false })]),
    request(SCHEMAS.property, [
      attestation({
        revocable: false,
        data: coder.encode(["string"], [efsContentHashValue(manifest)]),
      }),
      attestation({
        revocable: false,
        data: coder.encode(["string"], [String(manifest.artifactByteLength)]),
      }),
      attestation({
        revocable: false,
        data: coder.encode(["string"], [manifest.ipfsCid]),
      }),
    ]),
  ];
}

export function buildStage2(manifest, signer, stage1) {
  const anchor = (name, forSchema, recipient = ZeroAddress, refUID = stage1.dataUid) =>
    attestation({
      recipient,
      revocable: false,
      refUID,
      data: coder.encode(["string", "bytes32"], [name, forSchema]),
    });
  const mirror = (transportDefinition, uri) =>
    attestation({
      revocable: true,
      refUID: stage1.dataUid,
      data: coder.encode(["bytes32", "string"], [transportDefinition, uri]),
    });

  return [
    request(SCHEMAS.anchor, [
      anchor("contentHash", SCHEMAS.property),
      anchor("size", SCHEMAS.property),
      anchor("cid", SCHEMAS.property),
      anchor(manifest.artifactName, SCHEMAS.data, getAddress(signer), ZERO_BYTES32),
    ]),
    request(SCHEMAS.mirror, [
      mirror(TRANSPORTS.ipfs, `ipfs://${manifest.ipfsCid}`),
      mirror(TRANSPORTS.arweave, `ar://${manifest.arweaveId}`),
    ]),
  ];
}

export function buildStage3(stage1, stage2) {
  const pin = (targetUid, definitionUid) =>
    attestation({
      revocable: true,
      refUID: targetUid,
      data: coder.encode(["bytes32"], [definitionUid]),
    });
  return [
    request(SCHEMAS.pin, [
      pin(stage1.properties.contentHash, stage2.anchors.contentHash),
      pin(stage1.properties.size, stage2.anchors.size),
      pin(stage1.properties.cid, stage2.anchors.cid),
      pin(stage1.dataUid, stage2.fileAnchorUid),
    ]),
  ];
}

export function parseAttestedEvents(receipt) {
  const events = [];
  for (const log of receipt.logs) {
    if (!log.address || getAddress(log.address) !== getAddress(CONTRACTS.eas)) continue;
    try {
      const parsed = easInterface.parseLog(log);
      if (parsed?.name === "Attested") {
        events.push({
          recipient: getAddress(parsed.args.recipient),
          attester: getAddress(parsed.args.attester),
          uid: parsed.args.uid,
          schema: parsed.args.schema,
        });
      }
    } catch {
      // Ignore logs from schema resolvers.
    }
  }
  return events;
}

function eventsFor(events, schema, expected) {
  const matches = events.filter(event => event.schema.toLowerCase() === schema.toLowerCase());
  if (matches.length !== expected) {
    throw new Error(`Expected ${expected} ${schema} attestations, received ${matches.length}`);
  }
  return matches;
}

export function interpretStage1(receipt) {
  const events = parseAttestedEvents(receipt);
  const [data] = eventsFor(events, SCHEMAS.data, 1);
  const properties = eventsFor(events, SCHEMAS.property, 3);
  return {
    dataUid: data.uid,
    properties: {
      contentHash: properties[0].uid,
      size: properties[1].uid,
      cid: properties[2].uid,
    },
    transactionHash: receipt.hash,
  };
}

export function interpretStage2(receipt) {
  const events = parseAttestedEvents(receipt);
  const anchors = eventsFor(events, SCHEMAS.anchor, 4);
  const mirrors = eventsFor(events, SCHEMAS.mirror, 2);
  return {
    anchors: {
      contentHash: anchors[0].uid,
      size: anchors[1].uid,
      cid: anchors[2].uid,
    },
    fileAnchorUid: anchors[3].uid,
    mirrors: {
      ipfs: mirrors[0].uid,
      arweave: mirrors[1].uid,
    },
    transactionHash: receipt.hash,
  };
}

export function interpretStage3(receipt) {
  const pins = eventsFor(parseAttestedEvents(receipt), SCHEMAS.pin, 4);
  return {
    pins: {
      contentHash: pins[0].uid,
      size: pins[1].uid,
      cid: pins[2].uid,
      file: pins[3].uid,
    },
    transactionHash: receipt.hash,
  };
}

export function makeProof({ manifest, signature, signer, stage1, stage2, stage3 }) {
  return {
    format: "efs-walk-away-proof-result/v0",
    manifestDigest: manifestDigest(manifest),
    signature,
    signer: getAddress(signer),
    efs: {
      chainId: CHAIN_ID,
      contracts: CONTRACTS,
      dataUid: stage1.dataUid,
      properties: {
        contentHash: {
          value: efsContentHashValue(manifest),
          valueUid: stage1.properties.contentHash,
          keyAnchorUid: stage2.anchors.contentHash,
          pinUid: stage3.pins.contentHash,
        },
        size: {
          value: String(manifest.artifactByteLength),
          valueUid: stage1.properties.size,
          keyAnchorUid: stage2.anchors.size,
          pinUid: stage3.pins.size,
        },
        cid: {
          value: manifest.ipfsCid,
          valueUid: stage1.properties.cid,
          keyAnchorUid: stage2.anchors.cid,
          pinUid: stage3.pins.cid,
        },
      },
      mirrors: {
        ipfs: {
          uid: stage2.mirrors.ipfs,
          transportDefinition: TRANSPORTS.ipfs,
          uri: `ipfs://${manifest.ipfsCid}`,
        },
        arweave: {
          uid: stage2.mirrors.arweave,
          transportDefinition: TRANSPORTS.arweave,
          uri: `ar://${manifest.arweaveId}`,
        },
      },
      file: {
        name: manifest.artifactName,
        anchorUid: stage2.fileAnchorUid,
        pinUid: stage3.pins.file,
      },
      transactions: {
        stage1: stage1.transactionHash,
        stage2: stage2.transactionHash,
        stage3: stage3.transactionHash,
      },
    },
  };
}

export function assertExpectedSigner(address) {
  const normalized = getAddress(address);
  if (normalized !== getAddress(EXPECTED_SIGNER)) {
    throw new Error(`Connected ${normalized}; expected ${getAddress(EXPECTED_SIGNER)}`);
  }
  return normalized;
}

export function easContract(signer) {
  return new Contract(CONTRACTS.eas, EAS_ABI, signer);
}
