export type PathItem = {
  uid: string;
  /**
   * Display label for this path node. For the head of a container walk this
   * is the resolved human-friendly name (ENS, short hex, or the raw name);
   * for interior walk steps it's the decoded URL segment. Consumers building
   * URLs must prefer `urlSegment` over this field when it's present, because
   * `name` can be a shortened hex like `0x8626…1199` that doesn't round-trip
   * through the top-level container classifier.
   */
  name: string;
  /**
   * Verbatim URL segment for this path node, already URL-safe (NOT re-encoded
   * by the caller). Set for the head of address/schema/attestation container
   * walks (the raw segment the user typed, e.g. `vitalik.eth` or the full
   * 42-char `0x…`) and for each interior segment (the encoded URL text). When
   * unset, callers should fall back to `encodeURIComponent(name)` — used for
   * the root-anchor head, which is skipped from URLs entirely.
   */
  urlSegment?: string;
};
