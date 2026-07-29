import { getAddress, verifyTypedData } from "ethers";
import { EIP712_DOMAIN, EIP712_TYPES } from "./constants.js";
import { digestJson, stripHexPrefix } from "./canonical.js";

const REQUIRED_STRING_FIELDS = [
  "format",
  "artifactName",
  "artifactSha256",
  "builderCommit",
  "compressor",
  "configSha256",
  "sourceRepository",
  "sourceCommit",
  "tarSha256",
  "signer",
  "ipfsCid",
  "arweaveId",
];

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Manifest must be a JSON object");
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      throw new TypeError(`Manifest field ${field} must be a non-empty string`);
    }
  }
  if (manifest.format !== "efs-walk-away-proof/v0") {
    throw new TypeError(`Unsupported manifest format: ${manifest.format}`);
  }
  for (const field of ["artifactSha256", "configSha256", "tarSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(manifest[field])) {
      throw new TypeError(`${field} must be 64 lowercase hexadecimal characters`);
    }
  }
  if (!Number.isSafeInteger(manifest.artifactByteLength) || manifest.artifactByteLength < 0) {
    throw new TypeError("artifactByteLength must be a non-negative safe integer");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit hash");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.builderCommit)) {
    throw new TypeError("builderCommit must be a full lowercase Git commit hash");
  }
  getAddress(manifest.signer);
  return manifest;
}

export function manifestDigest(manifest) {
  validateManifest(manifest);
  return digestJson(manifest);
}

export function typedManifest(manifest) {
  return {
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    message: { manifestDigest: manifestDigest(manifest) },
  };
}

export function recoverManifestSigner(manifest, signature) {
  const typed = typedManifest(manifest);
  return verifyTypedData(typed.domain, typed.types, typed.message, signature);
}

export function efsContentHashValue(manifest) {
  validateManifest(manifest);
  return `f1220${stripHexPrefix(manifest.artifactSha256)}`;
}
