import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
  sha256,
} from "ethers";
import {
  CHAIN_ID,
  CONTRACTS,
  DEFAULT_ENDPOINTS,
  EAS_ABI,
  EDGE_RESOLVER_ABI,
  EXPECTED_SIGNER,
  SCHEMAS,
  TRANSPORTS,
  ZERO_BYTES32,
} from "./constants.js";
import { digestJson } from "./canonical.js";
import { parseAttestedEvents } from "./efs.js";
import { rawFileCid } from "./ipfs-cid.js";
import {
  efsContentHashValue,
  manifestDigest,
  recoverManifestSigner,
  validateManifest,
} from "./manifest.js";

const coder = AbiCoder.defaultAbiCoder();

export class ProofError extends Error {
  constructor(outcome, message) {
    super(message);
    this.name = "ProofError";
    this.outcome = outcome;
  }
}

function invalid(message) {
  throw new ProofError("INVALID", message);
}

function normalizeAttestation(attestation) {
  return {
    uid: attestation.uid ?? attestation[0],
    schema: attestation.schema ?? attestation[1],
    expirationTime: Number(attestation.expirationTime ?? attestation[3]),
    revocationTime: Number(attestation.revocationTime ?? attestation[4]),
    refUID: attestation.refUID ?? attestation[5],
    recipient: getAddress(attestation.recipient ?? attestation[6]),
    attester: getAddress(attestation.attester ?? attestation[7]),
    revocable: attestation.revocable ?? attestation[8],
    data: attestation.data ?? attestation[9],
  };
}

function assertAttestation(attestation, expected) {
  const actual = normalizeAttestation(attestation);
  if (actual.uid.toLowerCase() !== expected.uid.toLowerCase()) invalid(`UID mismatch for ${expected.label}`);
  if (actual.schema.toLowerCase() !== expected.schema.toLowerCase()) invalid(`Schema mismatch for ${expected.label}`);
  if (actual.attester !== getAddress(expected.attester)) invalid(`Attester mismatch for ${expected.label}`);
  if (actual.refUID.toLowerCase() !== expected.refUID.toLowerCase()) invalid(`refUID mismatch for ${expected.label}`);
  if (actual.recipient !== getAddress(expected.recipient ?? ZeroAddress)) {
    invalid(`Recipient mismatch for ${expected.label}`);
  }
  if (actual.revocable !== expected.revocable) invalid(`Revocability mismatch for ${expected.label}`);
  if (actual.expirationTime !== 0) invalid(`Unexpected expiration for ${expected.label}`);
  if (actual.revocationTime !== 0) invalid(`${expected.label} has been revoked`);
  return actual;
}

function decodeString(data, label) {
  try {
    return coder.decode(["string"], data)[0];
  } catch {
    invalid(`Cannot decode ${label} string`);
  }
}

function decodeAnchor(data, label) {
  try {
    const [name, forSchema] = coder.decode(["string", "bytes32"], data);
    return { name, forSchema };
  } catch {
    invalid(`Cannot decode ${label} anchor`);
  }
}

function decodePin(data, label) {
  try {
    return coder.decode(["bytes32"], data)[0];
  } catch {
    invalid(`Cannot decode ${label} PIN`);
  }
}

function decodeMirror(data, label) {
  try {
    const [transportDefinition, uri] = coder.decode(["bytes32", "string"], data);
    return { transportDefinition, uri };
  } catch {
    invalid(`Cannot decode ${label} MIRROR`);
  }
}

export function verifySignature(manifest, proof, expectedSigner = EXPECTED_SIGNER) {
  validateManifest(manifest);
  if (expectedSigner && getAddress(manifest.signer) !== getAddress(expectedSigner)) {
    invalid(`Manifest signer does not match expected signer ${getAddress(expectedSigner)}`);
  }
  if (proof.manifestDigest !== manifestDigest(manifest)) invalid("Manifest digest does not match proof");
  const recovered = getAddress(recoverManifestSigner(manifest, proof.signature));
  if (recovered !== getAddress(manifest.signer)) invalid("Manifest signature does not match signer");
  if (getAddress(proof.signer) !== recovered) invalid("Proof signer does not match recovered signer");
  return recovered;
}

export async function verifyEfs(manifest, proof, provider, expectedSigner = EXPECTED_SIGNER) {
  const signer = verifySignature(manifest, proof, expectedSigner);
  if (proof.efs.chainId !== CHAIN_ID) invalid(`Wrong EFS chain: ${proof.efs.chainId}`);
  for (const [name, address] of Object.entries(CONTRACTS)) {
    if (getAddress(proof.efs.contracts[name]) !== getAddress(address)) {
      invalid(`Wrong ${name} contract`);
    }
  }

  const eas = new Contract(CONTRACTS.eas, EAS_ABI, provider);
  const edgeResolver = new Contract(CONTRACTS.edgeResolver, EDGE_RESOLVER_ABI, provider);
  const get = async uid => normalizeAttestation(await eas.getAttestation(uid));

  const data = assertAttestation(await get(proof.efs.dataUid), {
    label: "DATA",
    uid: proof.efs.dataUid,
    schema: SCHEMAS.data,
    attester: signer,
    refUID: ZERO_BYTES32,
    revocable: false,
  });
  if (data.data !== "0x") invalid("DATA payload must be empty");

  for (const key of ["contentHash", "size", "cid"]) {
    const record = proof.efs.properties[key];
    const value = assertAttestation(await get(record.valueUid), {
      label: `${key} PROPERTY`,
      uid: record.valueUid,
      schema: SCHEMAS.property,
      attester: signer,
      refUID: ZERO_BYTES32,
      revocable: false,
    });
    if (decodeString(value.data, key) !== record.value) invalid(`${key} PROPERTY value mismatch`);

    const anchor = assertAttestation(await get(record.keyAnchorUid), {
      label: `${key} key anchor`,
      uid: record.keyAnchorUid,
      schema: SCHEMAS.anchor,
      attester: signer,
      refUID: proof.efs.dataUid,
      revocable: false,
    });
    const decodedAnchor = decodeAnchor(anchor.data, key);
    if (decodedAnchor.name !== key || decodedAnchor.forSchema.toLowerCase() !== SCHEMAS.property.toLowerCase()) {
      invalid(`${key} key anchor mismatch`);
    }

    const pin = assertAttestation(await get(record.pinUid), {
      label: `${key} PIN`,
      uid: record.pinUid,
      schema: SCHEMAS.pin,
      attester: signer,
      refUID: record.valueUid,
      revocable: true,
    });
    if (decodePin(pin.data, key).toLowerCase() !== record.keyAnchorUid.toLowerCase()) {
      invalid(`${key} PIN definition mismatch`);
    }
  }

  const expectedProperties = {
    contentHash: efsContentHashValue(manifest),
    size: String(manifest.artifactByteLength),
    cid: manifest.ipfsCid,
  };
  for (const [key, expected] of Object.entries(expectedProperties)) {
    if (proof.efs.properties[key].value !== expected) invalid(`${key} proof value mismatch`);
    const record = proof.efs.properties[key];
    const [activePin, activeTarget] = await Promise.all([
      edgeResolver.getActivePin(record.keyAnchorUid, signer, SCHEMAS.property),
      edgeResolver.getActivePinTarget(record.keyAnchorUid, signer, SCHEMAS.property),
    ]);
    if (
      activePin.toLowerCase() !== record.pinUid.toLowerCase() ||
      activeTarget.toLowerCase() !== record.valueUid.toLowerCase()
    ) {
      invalid(`${key} PIN is not the active EFS binding`);
    }
  }

  for (const carrier of ["ipfs", "arweave"]) {
    const record = proof.efs.mirrors[carrier];
    const expectedTransport = TRANSPORTS[carrier];
    const expectedUri =
      carrier === "ipfs" ? `ipfs://${manifest.ipfsCid}` : `ar://${manifest.arweaveId}`;
    if (
      record.transportDefinition.toLowerCase() !== expectedTransport.toLowerCase() ||
      record.uri !== expectedUri
    ) {
      invalid(`${carrier} proof locator does not match manifest`);
    }
    const mirror = assertAttestation(await get(record.uid), {
      label: `${carrier} MIRROR`,
      uid: record.uid,
      schema: SCHEMAS.mirror,
      attester: signer,
      refUID: proof.efs.dataUid,
      revocable: true,
    });
    const decoded = decodeMirror(mirror.data, carrier);
    if (
      decoded.transportDefinition.toLowerCase() !== record.transportDefinition.toLowerCase() ||
      decoded.uri !== record.uri
    ) {
      invalid(`${carrier} MIRROR mismatch`);
    }
  }

  const fileAnchor = assertAttestation(await get(proof.efs.file.anchorUid), {
    label: "file anchor",
    uid: proof.efs.file.anchorUid,
    schema: SCHEMAS.anchor,
    attester: signer,
    refUID: ZERO_BYTES32,
    recipient: signer,
    revocable: false,
  });
  const decodedFile = decodeAnchor(fileAnchor.data, "file");
  if (
    decodedFile.name !== manifest.artifactName ||
    decodedFile.forSchema.toLowerCase() !== SCHEMAS.data.toLowerCase()
  ) {
    invalid("File anchor mismatch");
  }
  const filePin = assertAttestation(await get(proof.efs.file.pinUid), {
    label: "file PIN",
    uid: proof.efs.file.pinUid,
    schema: SCHEMAS.pin,
    attester: signer,
    refUID: proof.efs.dataUid,
    revocable: true,
  });
  if (decodePin(filePin.data, "file").toLowerCase() !== proof.efs.file.anchorUid.toLowerCase()) {
    invalid("File PIN definition mismatch");
  }
  const [activeFilePin, activeFileTarget] = await Promise.all([
    edgeResolver.getActivePin(proof.efs.file.anchorUid, signer, SCHEMAS.data),
    edgeResolver.getActivePinTarget(proof.efs.file.anchorUid, signer, SCHEMAS.data),
  ]);
  if (
    activeFilePin.toLowerCase() !== proof.efs.file.pinUid.toLowerCase() ||
    activeFileTarget.toLowerCase() !== proof.efs.dataUid.toLowerCase()
  ) {
    invalid("File PIN is not the active EFS binding");
  }

  const transactionEntries = Object.entries(proof.efs.transactions);
  if (new Set(transactionEntries.map(([, hash]) => hash.toLowerCase())).size !== transactionEntries.length) {
    invalid("Stage transaction hashes must be distinct");
  }
  for (const [stage, transactionHash] of transactionEntries) {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(transactionHash),
      provider.getTransactionReceipt(transactionHash),
    ]);
    if (!transaction || !receipt || receipt.status !== 1) invalid(`${stage} transaction was not successful`);
    if (getAddress(transaction.from) !== signer) invalid(`${stage} transaction sender mismatch`);
    if (!transaction.to || getAddress(transaction.to) !== getAddress(CONTRACTS.eas)) {
      invalid(`${stage} transaction target mismatch`);
    }
    if (transaction.value !== 0n) invalid(`${stage} transaction transferred ETH`);

    const expectedUids = {
      stage1: [
        proof.efs.dataUid,
        ...Object.values(proof.efs.properties).map(record => record.valueUid),
      ],
      stage2: [
        ...Object.values(proof.efs.properties).map(record => record.keyAnchorUid),
        proof.efs.file.anchorUid,
        ...Object.values(proof.efs.mirrors).map(record => record.uid),
      ],
      stage3: [
        ...Object.values(proof.efs.properties).map(record => record.pinUid),
        proof.efs.file.pinUid,
      ],
    }[stage];
    if (!expectedUids) invalid(`Unknown transaction stage ${stage}`);
    const receiptUids = parseAttestedEvents(receipt).map(event => event.uid.toLowerCase());
    if (
      receiptUids.length !== expectedUids.length ||
      expectedUids.some(uid => !receiptUids.includes(uid.toLowerCase()))
    ) {
      invalid(`${stage} receipt does not contain the claimed attestations`);
    }
  }
}

function carrierUrl(manifest, carrier, endpoints) {
  if (carrier === "ipfs") return `${endpoints.ipfsGateway}${manifest.ipfsCid}`;
  if (carrier === "arweave") return `${endpoints.arweaveGateway}${manifest.arweaveId}`;
  throw new TypeError(`Unknown carrier: ${carrier}`);
}

export async function retrieveAndVerify(manifest, carrier, options = {}) {
  validateManifest(manifest);
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(carrierUrl(manifest, carrier, endpoints), {
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    throw new ProofError("UNAVAILABLE", `${carrier} retrieval failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new ProofError("UNAVAILABLE", `${carrier} returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== manifest.artifactByteLength) {
    invalid(`${carrier} byte length ${bytes.length} does not match ${manifest.artifactByteLength}`);
  }
  const actualSha = sha256(bytes).slice(2);
  if (actualSha !== manifest.artifactSha256) invalid(`${carrier} SHA-256 mismatch`);
  if (carrier === "ipfs" && (await rawFileCid(bytes)) !== manifest.ipfsCid) {
    invalid("IPFS CID does not match retrieved bytes");
  }
  return { byteLength: bytes.length, sha256: actualSha, url: carrierUrl(manifest, carrier, endpoints) };
}

function unavailableInfrastructure(error) {
  return (
    ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"].includes(error?.code) ||
    /fetch failed|network|timeout|timed out|rate.?limit|ECONN|ENOTFOUND/i.test(error?.message ?? "")
  );
}

export async function verifyProof(manifest, proof, options = {}) {
  try {
    const provider = options.provider ?? new JsonRpcProvider(
      options.endpoints?.sepoliaRpc ?? DEFAULT_ENDPOINTS.sepoliaRpc,
      CHAIN_ID,
      { staticNetwork: true },
    );
    if (options.verifyEfs !== false) {
      await verifyEfs(manifest, proof, provider, options.expectedSigner);
    } else {
      verifySignature(manifest, proof, options.expectedSigner);
    }
    const retrieval = await retrieveAndVerify(manifest, options.carrier ?? "ipfs", options);
    return { outcome: "VERIFIED", retrieval, manifestDigest: digestJson(manifest) };
  } catch (error) {
    if (error instanceof ProofError) return { outcome: error.outcome, error: error.message };
    if (unavailableInfrastructure(error)) return { outcome: "UNAVAILABLE", error: error.message };
    return { outcome: "INVALID", error: error.message };
  }
}
