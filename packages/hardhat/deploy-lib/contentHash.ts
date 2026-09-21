import { ethers } from "ethers";

/**
 * The canonical `contentHash` of some bytes: `f1220` + the sha2-256 digest in lowercase
 * hex — a multibase-base16 multihash (specs/10 §2.3, ADR-0064).
 *
 * `f` = base16, `12` = sha2-256, `20` = 32-byte digest. The label is the point: a bare
 * `0x…` digest does not say which algorithm made it, so readers (the SDK) report it as
 * `malformed-claim` and its fail-closed reads throw. PROPERTY values are non-revocable,
 * so a wrong form is permanent — this is why every seed/simulation writer must go through
 * here rather than `ethers.keccak256(...)`, which is what they used before specs/10 §8.
 *
 * Only claim a hash for bytes you actually serve. A hash of a placeholder label, attached
 * to a mirror that serves different bytes, reads back as `mismatch` — worse than no claim.
 */
export function canonicalContentHash(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? ethers.toUtf8Bytes(content) : content;
  return `f1220${ethers.sha256(bytes).slice(2)}`;
}

/** The byte length a `size` PROPERTY must carry for `content` — UTF-8 bytes, not
 * JS string length (they differ for any non-ASCII text, e.g. emoji). */
export function contentSize(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? ethers.toUtf8Bytes(content) : content;
  return bytes.length.toString();
}
