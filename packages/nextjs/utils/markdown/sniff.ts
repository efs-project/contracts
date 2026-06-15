export type SniffResult = "text" | "binary";

// Leading magic-number signatures for common binary types we must NOT render inline.
const MAGIC: ReadonlyArray<readonly number[]> = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x50, 0x4b, 0x03, 0x04], // ZIP / docx / xlsx
  [0x1f, 0x8b], // gzip
];

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/**
 * Classify fetched bytes as renderable text or binary, purely from the bytes —
 * NEVER trusting an external/attester-supplied contentType. Conservative:
 * a known binary magic number, any NUL byte, or a failed strict UTF-8 decode
 * over the head all mean "binary".
 */
export function sniffContent(bytes: Uint8Array): SniffResult {
  for (const sig of MAGIC) if (startsWith(bytes, sig)) return "binary";
  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  for (let i = 0; i < head.length; i++) if (head[i] === 0x00) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
  } catch {
    return "binary";
  }
  return "text";
}
