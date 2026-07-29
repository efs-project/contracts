import * as raw from "multiformats/codecs/raw";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export async function rawFileCid(bytes) {
  const digest = await sha256.digest(bytes);
  return CID.createV1(raw.code, digest).toString();
}
