/** Hard byte cap before we even attempt to decode/parse (DoS guard). */
export const MAX_RENDER_BYTES = 1_048_576; // 1 MiB

/** Post-parse structural guards against amplification under the byte cap. */
export const MAX_HAST_NODES = 50_000;
export const MAX_NEST_DEPTH = 32; // mirrors ADR-0021 MAX_ANCHOR_DEPTH
