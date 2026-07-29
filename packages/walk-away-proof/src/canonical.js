import { sha256, toUtf8Bytes } from "ethers";
import { canonicalize } from "json-canonicalize";

export function canonicalJson(value) {
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError("Value cannot be canonicalized as JSON");
  return result;
}

export function canonicalBytes(value) {
  return toUtf8Bytes(canonicalJson(value));
}

export function digestJson(value) {
  return sha256(canonicalBytes(value));
}

export function stripHexPrefix(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}
