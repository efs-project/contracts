import { getAddress } from "viem";

/**
 * Pure helpers for the EFS Lists editor (ADR-0044). Extracted from
 * `ListPreviewPane.tsx` so the encoding and ordering logic — the parts where
 * correctness bugs hide — can be unit-tested without React.
 *
 * See `listEncoding.test.ts`.
 */

/** ANY-mode items: ≤31 UTF-8 bytes so the packed value never fills all 32 bytes of the slot. */
export const MAX_ITEM_BYTES = 31;

/**
 * Rank weights are spaced far apart so midpoint-insertion (reorder) effectively
 * never exhausts the integer gap between two neighbours. int256 holds this with
 * vast headroom.
 */
export const RANK_STEP = 1_000_000_000_000_000n; // 1e15

/** UTF-8 byte length of a string (the limit is in bytes, not code points). */
export const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Pack a short UTF-8 string into a right-padded bytes32 (Solidity string idiom).
 * Throws on empty or >31-byte input. The result is always nonzero for nonempty
 * text, satisfying the resolver's `target != 0` requirement for ANY-mode entries.
 */
export function packText(text: string): `0x${string}` {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) throw new Error("Item cannot be empty");
  if (bytes.length > MAX_ITEM_BYTES) throw new Error(`Item too long (max ${MAX_ITEM_BYTES} bytes)`);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return ("0x" + hex.padEnd(64, "0")) as `0x${string}`;
}

/**
 * Decode a packed bytes32 back to text, or `null` if it isn't printable text
 * (a legacy keccak member key or an opaque ADDR/SCHEMA key) — callers fall back
 * to a short-hex display for `null`.
 */
export function unpackText(key: string): string | null {
  const hex = key.slice(2).replace(/(00)+$/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Reject any control char (C0 minus tab/newline, or DEL) ⇒ not human text.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) return null;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * Inverse of the resolver's `bytes32(uint256(uint160(recipient)))`: take the low
 * 20 bytes of the identity key, then EIP-55 checksum so `<Address>` never sees a
 * raw-lowercase value.
 */
export const addrFromKey = (key: string): `0x${string}` => getAddress(("0x" + key.slice(-40)) as `0x${string}`);

/** Short display form for an address or bytes32. */
export const shortHex = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;

/**
 * Compute the rank weight for an item dropped between two neighbours during a
 * reorder. `left`/`right` are the weights of the items immediately above/below
 * the insertion point in the new order (either may be `undefined` at an edge).
 *
 * Returns `{ collision: true }` when there is no integer room between the
 * neighbours (adjacent weights) — the caller must abort the reorder BEFORE
 * revoking, so a no-room drop can never destroy the moved item.
 */
export function computeInsertWeight(
  left: bigint | undefined,
  right: bigint | undefined,
  step: bigint = RANK_STEP,
): { weight: bigint } | { collision: true } {
  let weight: bigint;
  if (left === undefined) weight = (right ?? 0n) - step;
  else if (right === undefined) weight = left + step;
  else weight = (left + right) / 2n; // bigint division truncates toward zero

  if ((left !== undefined && weight <= left) || (right !== undefined && weight >= right)) {
    return { collision: true };
  }
  return { weight };
}
