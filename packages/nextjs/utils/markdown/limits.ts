/**
 * Hard byte cap before we even attempt to decode/parse (DoS guard). The 1 MiB
 * ceiling also bounds the parsed tree: every hast node costs several input
 * bytes, so capping input size caps node count and nesting depth without a
 * separate post-parse structural pass.
 */
export const MAX_RENDER_BYTES = 1_048_576; // 1 MiB
