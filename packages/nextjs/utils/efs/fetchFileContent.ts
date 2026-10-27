import { ethers } from "ethers";
import type { Abi, PublicClient } from "viem";
import { type TransportType, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";

export interface FetchedFile {
  bytes: Uint8Array;
  contentType: string | null;
  source: "onchain" | "mirror";
  /**
   * Resolved transport for the file. For on-chain SSTORE2 bodies this is
   * `"onchain"`; for external mirrors it is the transport detected from the
   * delegated URI (ipfs / arweave / https / magnet / unknown). The caller uses
   * this to drive its transport badge identically to the prior inline logic.
   */
  transport: TransportType;
}

export interface FetchFileArgs {
  /** Selected chain for cache isolation. If absent and the client has no chain metadata, the read is not cached. */
  chainId?: number | string | bigint;
  routerAddress: `0x${string}`;
  routerAbi: Abi;
  publicClient: PublicClient;
  lensAddresses: string[];
  /** Full router resource path to the file, e.g. [...currentPathNames, fileName]. */
  resourcePath: string[];
  /**
   * Optional hard byte cap. When set, the mirror branch rejects an oversized
   * `Content-Length` and otherwise streams with an early abort, and the on-chain
   * branch stops accumulating once the cap is exceeded — so a caller that loads
   * automatically (the Overview pane) never downloads an arbitrarily large body
   * just to decide it's too large. Exceeding it throws `FileTooLargeError`.
   */
  maxBytes?: number;
}

/** Thrown by `fetchFileContent` when a `maxBytes` cap is exceeded. */
export class FileTooLargeError extends Error {
  public readonly size: number;

  constructor(size: number) {
    super(`File exceeds the ${size}-byte render cap`);
    this.name = "FileTooLargeError";
    this.size = size;
  }
}

/**
 * Thrown when the router resolves the path to a 404 — the anchor doesn't exist,
 * or it exists but no active lens has content there. Distinct from a transport
 * error so callers probing an optional file (the Overview pane) can treat it as
 * "absent" rather than a failure.
 */
export class FileNotFoundError extends Error {
  public readonly path: string;

  constructor(path: string) {
    super(`No file at ${path}`);
    this.name = "FileNotFoundError";
    this.path = path;
  }
}

const MAX_CACHE_ENTRIES = 50;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_CACHE_ITEM_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 60 * 1000;

let cacheBytes = 0;
let cacheEpoch = 0;
const fileContentCache = new Map<string, { file: FetchedFile; storedAt: number }>();

function cloneFetchedFile(file: FetchedFile): FetchedFile {
  return {
    ...file,
    bytes: file.bytes.slice(),
  };
}

function enforceMaxBytes(file: FetchedFile, maxBytes?: number) {
  if (maxBytes != null && file.bytes.length > maxBytes) throw new FileTooLargeError(file.bytes.length);
}

function cacheKeyFor(args: FetchFileArgs): string | null {
  const chainId = args.chainId ?? (args.publicClient as { chain?: { id?: number | string | bigint } }).chain?.id;
  if (chainId == null) return null;
  return JSON.stringify([
    String(chainId),
    args.routerAddress.toLowerCase(),
    args.lensAddresses.map(lens => lens.toLowerCase()),
    args.resourcePath,
  ]);
}

function getCachedFile(key: string): FetchedFile | null {
  const cached = fileContentCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.storedAt > MAX_CACHE_AGE_MS) {
    cacheBytes -= cached.file.bytes.length;
    fileContentCache.delete(key);
    return null;
  }
  fileContentCache.delete(key);
  fileContentCache.set(key, cached);
  return cached.file;
}

function setCachedFile(key: string, file: FetchedFile) {
  if (file.bytes.length > MAX_CACHE_ITEM_BYTES) return;

  const prior = fileContentCache.get(key);
  if (prior) cacheBytes -= prior.file.bytes.length;

  const cached = cloneFetchedFile(file);
  fileContentCache.delete(key);
  fileContentCache.set(key, { file: cached, storedAt: Date.now() });
  cacheBytes += cached.bytes.length;

  while (fileContentCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = fileContentCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = fileContentCache.get(oldestKey);
    if (oldest) cacheBytes -= oldest.file.bytes.length;
    fileContentCache.delete(oldestKey);
  }
}

export function clearFetchFileContentCache() {
  cacheEpoch += 1;
  fileContentCache.clear();
  cacheBytes = 0;
}

/**
 * Pure router-fetch for a single file's bytes. Mirrors the read flow documented
 * in `specs/overview.md` § Read flow:
 *   EFSRouter.request([...path], [{key:"lenses",...}, {key:"chunk",...}]) via the
 *   wagmi publicClient, reassembling on-chain SSTORE2 chunks through EIP-7617
 *   `web3-next-chunk` header pagination, and for external mirrors following the
 *   `message/external-body` Content-Type → resolveGatewayUrl → fetch.
 *
 * Holds ONLY the fetch logic — no React state, no cancellation. The caller owns
 * its own staleness/cancellation guard and maps the returned bytes onto state.
 *
 * Signature is shaped toward the planned SDK `fetch(ref, opts)` (holistic-review
 * DX-2): a parameterized async function returning raw bytes + content metadata.
 */
export async function fetchFileContent(args: FetchFileArgs): Promise<FetchedFile> {
  const { routerAddress, routerAbi, publicClient, lensAddresses, resourcePath, maxBytes } = args;
  const startingCacheEpoch = cacheEpoch;
  const cacheKey = cacheKeyFor(args);
  if (cacheKey) {
    const cached = getCachedFile(cacheKey);
    if (cached) {
      enforceMaxBytes(cached, maxBytes);
      return cloneFetchedFile(cached);
    }
  }

  const result: number[] = [];
  let contentTypeStr = "text/plain";
  let source: "onchain" | "mirror" = "onchain";
  let transport: TransportType = "onchain";

  let hasMoreChunks = true;
  let currentChunkHeader = "";

  while (hasMoreChunks) {
    const queryParams: any[] = [];
    if (lensAddresses.length > 0) {
      queryParams.push({ key: "lenses", value: lensAddresses.join(",") });
    }

    // Chunk pagination: after the first response, the `web3-next-chunk` header
    // carries the next chunk as a leading-slash relative URL. The router emits a
    // path- and lens-preserving form (`/<path>?lenses=…&chunk=N`); a bare
    // EFSBytesStore emits `/?chunk=N`. Extract the `chunk=` value from anywhere in
    // the URL (not `split("=")[1]`, which grabs the wrong segment when other params
    // precede it). `lenses` is re-sent above each call, so we only need the index.
    if (currentChunkHeader) {
      const chunkIndex = currentChunkHeader.match(/[?&]chunk=(\d+)/)?.[1];
      if (chunkIndex !== undefined) {
        queryParams.push({ key: "chunk", value: chunkIndex });
      }
    }

    const callArgs: any[] = [[...resourcePath], queryParams];

    const response = (await publicClient.readContract({
      address: routerAddress,
      abi: routerAbi,
      functionName: "request",
      args: callArgs as any,
    })) as any;

    if (response[0] === 200n || response[0] === 200) {
      const outHeaders = response[2] as any[];
      const ctHeaders = outHeaders.filter((h: any) => h.key.toLowerCase() === "content-type");

      // Detect external-body delegation (IPFS, Arweave, HTTPS mirrors)
      const externalHeader = ctHeaders.find((h: any) => h.value.includes("message/external-body"));
      if (externalHeader) {
        // Extract the original URI from: message/external-body; access-type=URL; URL="ipfs://..."
        const urlMatch = externalHeader.value.match(/URL="([^"]+)"/);
        const externalUri = urlMatch?.[1];
        // Extract the actual MIME type from the content-type= parameter in the
        // message/external-body header (router embeds it as a quoted parameter).
        const ctParam = externalHeader.value.match(/content-type="([^"]+)"/);
        if (ctParam?.[1]) contentTypeStr = ctParam[1];

        if (externalUri) {
          transport = detectTransport(externalUri);
          // `data:` mirrors are inline bytes stored in the MIRROR attestation
          // itself. Treat them as editable EFS-managed content, unlike external
          // IPFS/Arweave/HTTPS/etc. redirects.
          source = transport === "data" ? "onchain" : "mirror";
          const gatewayUrl = resolveGatewayUrl(externalUri);
          if (gatewayUrl) {
            // Fetch from gateway
            const gatewayResp = await globalThis.fetch(gatewayUrl);
            if (!gatewayResp.ok) throw new Error(`Gateway returned ${gatewayResp.status} for ${gatewayUrl}`);
            if (maxBytes != null) {
              // Reject a declared oversized body before reading it…
              const declared = Number(gatewayResp.headers.get("content-length"));
              if (Number.isFinite(declared) && declared > maxBytes) throw new FileTooLargeError(declared);
              // …and stream the rest with an early abort in case Content-Length
              // was absent or lied (the Overview auto-loads on navigation).
              const reader = gatewayResp.body?.getReader();
              if (reader) {
                let total = 0;
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  total += value.length;
                  if (total > maxBytes) {
                    await reader.cancel();
                    throw new FileTooLargeError(total);
                  }
                  for (let i = 0; i < value.length; i++) result.push(value[i]);
                }
              } else {
                const bytes = new Uint8Array(await gatewayResp.arrayBuffer());
                if (bytes.length > maxBytes) throw new FileTooLargeError(bytes.length);
                for (let i = 0; i < bytes.length; i++) result.push(bytes[i]);
              }
            } else {
              const bytes = new Uint8Array(await gatewayResp.arrayBuffer());
              for (let i = 0; i < bytes.length; i++) result.push(bytes[i]);
            }
            // Use gateway content-type as fallback if we didn't get one from the contract
            if (contentTypeStr === "text/plain") {
              const gwCt = gatewayResp.headers.get("content-type");
              if (gwCt) contentTypeStr = gwCt.split(";")[0].trim();
            }
          }
          hasMoreChunks = false;
          break;
        }
      }

      // On-chain body
      const bodyHex = response[1] as `0x${string}`;
      if (bodyHex && bodyHex !== "0x") {
        const bodyBytes = ethers.getBytes(bodyHex);
        for (let i = 0; i < bodyBytes.length; i++) {
          result.push(bodyBytes[i]);
        }
        if (maxBytes != null && result.length > maxBytes) throw new FileTooLargeError(result.length);
      }
      // Use first content-type header for on-chain responses
      if (ctHeaders.length > 0) contentTypeStr = ctHeaders[0].value;

      // Check for next chunk
      const nextChunkHeader = outHeaders.find((h: any) => h.key.toLowerCase() === "web3-next-chunk");
      if (nextChunkHeader) {
        currentChunkHeader = nextChunkHeader.value;
      } else {
        hasMoreChunks = false;
      }
    } else {
      const status = Number(response[0]);
      // 404 = path/anchor doesn't exist OR no content for the active lens. For a
      // caller probing an optional file (the Overview pane) that's "absent", not
      // an error — surface it distinctly so it can render an empty state.
      if (status === 404) throw new FileNotFoundError(resourcePath.join("/"));
      throw new Error(`Router returned HTTP ${status}`);
    }
  }

  const fetched = {
    bytes: new Uint8Array(result),
    contentType: contentTypeStr,
    source,
    transport,
  };
  if (cacheKey && startingCacheEpoch === cacheEpoch) setCachedFile(cacheKey, fetched);
  return cloneFetchedFile(fetched);
}
