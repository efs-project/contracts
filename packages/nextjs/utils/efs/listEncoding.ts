import { getAddress, keccak256, toBytes } from "viem";

/**
 * Pure helpers for the EFS Lists editor (ADR-0044, ADR-0046). Extracted from
 * `ListPreviewPane.tsx` so the encoding and ordering logic — the parts where
 * correctness bugs hide — can be unit-tested without React.
 *
 * See `listEncoding.test.ts`.
 */

/**
 * Rank weights are spaced far apart so midpoint-insertion (reorder) effectively
 * never exhausts the integer gap between two neighbours. int256 holds this with
 * vast headroom.
 *
 * Since ADR-0046 the rank no longer lives in the LIST_ENTRY schema; it is stored
 * as a decimal-string `"weight"` PROPERTY on the (now stable) entry UID. The
 * fractional-rank math is unchanged — only where the value is persisted moved.
 */
export const RANK_STEP = 1_000_000_000_000_000n; // 1e15

/**
 * Derive the ANY-mode `target` member key for a free-text item (ADR-0046).
 *
 * Under ADR-0044 free text was packed into the 32-byte `target`, capping labels
 * at 31 bytes. ADR-0046 removes that cap: the human-readable text now lives in a
 * `name` PROPERTY on the entry UID, and `target` becomes an opaque, fixed-width
 * keccak fingerprint of the (trimmed) text. This is the value the resolver dedups
 * on for no-duplicates lists, so the SAME text always maps to the SAME key. It is
 * always nonzero, satisfying the resolver's `target != 0` requirement.
 */
export function memberKeyForText(text: string): `0x${string}` {
  return keccak256(toBytes(text.trim()));
}

/**
 * Decode a packed bytes32 back to text, or `null` if it isn't printable text.
 *
 * LEGACY display fallback only (ADR-0046): new ANY-mode entries store their text
 * in a `name` PROPERTY and use a keccak `target`, for which this returns `null`.
 * Pre-ADR-0046 entries packed short text into `target`; this still unpacks those
 * for display. Callers fall back to a short-hex display for `null`.
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
