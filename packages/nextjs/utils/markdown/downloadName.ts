/**
 * Make an attacker-controlled file name safe for a download attribute. Strips
 * bidi/zero-width codepoints (RTL-override disguise), control chars, and path
 * separators; clamps to a conservative charset + length; falls back to a neutral
 * name when nothing usable remains. The blob itself MUST also use a neutral MIME
 * (application/octet-stream) and be download-only, never navigated to.
 */
export function safeDownloadName(name: string): string {
  const noBidi = name.replace(/[‪-‮⁦-⁩​-‏﻿]/g, "");
  const noControl = noBidi.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const flattened = noControl.replace(/[\\/]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_");
  const clamped = flattened.replace(/^[._]+/, "").slice(0, 80);
  return clamped.length > 0 ? clamped : "download.bin";
}
