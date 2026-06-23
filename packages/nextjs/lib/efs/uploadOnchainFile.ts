/**
 * uploadOnchainFile — SDK SEAM (plain async, no React).
 * ============================================================================
 *
 * The SDK seam for the on-chain file-upload path: a single plain async function
 * that performs the full in-browser on-chain file upload. Lifted out of the
 * File-upload branch of `components/explorer/CreateItemModal.tsx` so an editor /
 * future SDK can call it without a component mounted.
 *
 * ## Minimal-clicks (layered multiAttest)
 *
 * The write's ~11 attestations form a dependency DAG (later attestations carry
 * earlier siblings' UIDs in `refUID`/`definition`). EAS UIDs embed
 * `block.timestamp`, so they can't be precomputed — but a later attestation CAN
 * reference one minted in a PRIOR transaction. So instead of one `attest` per
 * wallet popup (the old path: ~11 sequential signatures + a block wait between
 * each), this seam submits **one `EAS.multiAttest` per DAG layer** via
 * `submitLayered`, threading the mined UIDs forward. A typical new file is now
 * 3–4 attestation popups instead of ~11; a re-save (file ANCHOR reused) is fewer.
 * SSTORE2 chunk deploys are also **pipelined** — fired back-to-back without a
 * receipt wait between them, so N chunks mine in ~1–2 blocks instead of N×12s.
 *
 * The layering mirrors the SDK's `submitLayeredTier1` so this is a drop-in swap
 * for `@efs/sdk` once published. User stays the attester throughout (lenses key
 * on it); no relayer, no contract change, works on plain MetaMask.
 *
 * ⚠️ NON-ATOMIC across layers: each layer is its own atomic tx, but the layers are
 * sequential. If a later layer reverts, earlier layers already mined (e.g. DATA +
 * anchors exist but the placement PIN never landed, so the file is not yet
 * visible). Re-saving the same (parent, name) reuses the file ANCHOR and supersedes
 * the placement PIN in O(1) (ADR-0041), so a retry cleanly converges — only the
 * orphaned intermediate artifacts from the failed attempt linger. This is strictly
 * fewer partial-failure surfaces than the old ~11-independent-tx path.
 */
import { CHUNK_SIZE, MAX_CHUNKS, MAX_ONCHAIN_SIZE, MOCK_CHUNKED_FILE_ABI, MOCK_CHUNKED_FILE_BYTECODE } from "./sstore2";
import type { PlannedAttestation } from "./submitLayered";
import { SUBMIT_CANCELLED, submitLayered } from "./submitLayered";
import { encodeAbiParameters, encodeDeployData, toHex, zeroHash } from "viem";
import type { Abi, PublicClient, WalletClient } from "viem";
import { computeContentHash, detectTransport } from "~~/utils/efs/transports";

/**
 * Injected attest handle (kept for back-compat: `beforePlacement` callers wire
 * their own `attest` into `applySystemTag`). The main file-write DAG no longer
 * uses it — it flows through `submitLayered` (one `multiAttest` per layer). A
 * subset of the `writeContractAsync` returned by
 * `useScaffoldWriteContract({ contractName: "EAS" })`.
 */
export type AttestFn = (
  args: { functionName: "attest"; args: readonly unknown[] },
  opts?: { silent?: boolean },
) => Promise<`0x${string}` | undefined>;

export interface UploadOnchainFileArgs {
  name: string;
  bytes: Uint8Array;
  contentType: string;
  parentAnchorUID: `0x${string}`;

  walletClient: WalletClient;
  publicClient: PublicClient;
  chainId: number;

  /** EAS contract address — the target of every `multiAttest`. */
  easAddress: `0x${string}`;

  indexerAddress: `0x${string}`;
  indexerAbi: Abi;

  anchorSchemaUID: `0x${string}`;
  dataSchemaUID: `0x${string}`;
  propertySchemaUID: `0x${string}`;
  pinSchemaUID: `0x${string}`;
  tagSchemaUID: `0x${string}`;
  mirrorSchemaUID: `0x${string}`;

  /** EdgeResolver — used for the ancestor-walk visibility TAG dedup check. */
  edgeResolverAddress: `0x${string}`;
  edgeResolverAbi: Abi;

  /**
   * The file ANCHOR's parent reference + recipient. Defaults to
   * `{ refUID: parentAnchorUID, recipient: 0x0 }`. For a file placed directly under
   * an **Address-container root**, `parentAnchorUID` is a synthetic `bytes32(addr)`,
   * NOT a real EAS attestation — EAS rejects it as a non-zero `refUID` (`NotFound`).
   * The caller passes the address-root carve-out `{ refUID: 0x0, recipient: addr }`
   * (the file ANCHOR becomes a root-level anchor scoped to that address). When the
   * carve-out applies (`fileAnchorRefUID === 0x0`) the ancestor-walk visibility TAGs
   * are skipped — an address root has no generic-folder ancestors to tag.
   */
  fileAnchorRefUID?: `0x${string}`;
  fileAnchorRecipient?: `0x${string}`;
  /**
   * Optional caller-owned result of a read-only `resolveAnchor(parent, name, dataSchemaUID)`.
   * `undefined` means "not checked / check again"; `null` means "checked and absent";
   * a UID means "checked and reuse this existing file ANCHOR". This lets UI preflight
   * warnings avoid a duplicate RPC read without weakening retry safety.
   */
  knownFileAnchorUID?: `0x${string}` | null;

  /** Checked between layers; if it returns true we throw the cancel sentinel. */
  isCancelled?: () => boolean;
  /**
   * Called when the app-level Stop button should change availability. `false`
   * marks the anchor→PIN commit boundary: the wallet may still reject a prompt,
   * but the app must not request another cancellation checkpoint.
   */
  onCanCancelChange?: (canCancel: boolean) => void;
  /** Optional progress log. */
  onProgress?: (msg: string) => void;
  /**
   * Optional hook run on the freshly-attested DATA *immediately before* the
   * placement PIN — the write that makes the file reachable in the directory.
   * Use it to apply a descriptive tag (e.g. `system`) that must be active the
   * instant the file appears, so a cancelled/failed tag can't leave a visible,
   * untagged file. If it throws (including the cancel sentinel), placement is
   * skipped — the DATA is orphaned (harmless; content-addressed, reused on retry)
   * and nothing reachable leaks.
   */
  beforePlacement?: (dataUID: `0x${string}`) => Promise<void>;
}

export interface UploadOnchainFileResult {
  dataUID: `0x${string}`;
  fileAnchorUID: `0x${string}`;
}

/** Thrown when `isCancelled()` flips true at a layer/tx boundary. Shared with the
 * layered engine's `SUBMIT_CANCELLED` so a Stop anywhere (chunk loop OR between
 * attestation layers) surfaces as the same graceful-cancel sentinel the UI checks. */
export const UPLOAD_CANCELLED = SUBMIT_CANCELLED;

const MAX_ANCHOR_DEPTH = 32;

// MirrorResolver caps the final UTF-8 URI bytes at 8192. Keep a cheap raw-byte
// prefilter so large files never pay the base64 cost, then check the exact URI
// byte length before choosing the inline path.
const MIRROR_MAX_URI_BYTES = 8192;
const DATA_URI_MAX_BYTES = 4096;

/** Base64-encode bytes for a `data:` URI (binary-safe, chunked so a large array
 * never blows the call stack via spread). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Schema encoders (ABI parameter shapes for each EFS schema's data field).
const NAME_PARAMS = [
  { name: "name", type: "string" },
  { name: "schemaUID", type: "bytes32" },
] as const;
const KEY_ANCHOR_PARAMS = [
  { name: "name", type: "string" },
  { name: "forSchema", type: "bytes32" },
] as const;
const PROPERTY_PARAMS = [{ name: "value", type: "string" }] as const;
const MIRROR_PARAMS = [
  { name: "transport", type: "bytes32" },
  { name: "uri", type: "string" },
] as const;
const VIS_TAG_PARAMS = [
  { name: "definition", type: "bytes32" },
  { name: "weight", type: "int256" },
] as const;

type FileRecordWithMirrorArgs = Pick<
  UploadOnchainFileArgs,
  | "name"
  | "contentType"
  | "parentAnchorUID"
  | "walletClient"
  | "publicClient"
  | "chainId"
  | "easAddress"
  | "indexerAddress"
  | "indexerAbi"
  | "anchorSchemaUID"
  | "dataSchemaUID"
  | "propertySchemaUID"
  | "pinSchemaUID"
  | "tagSchemaUID"
  | "mirrorSchemaUID"
  | "edgeResolverAddress"
  | "edgeResolverAbi"
  | "fileAnchorRefUID"
  | "fileAnchorRecipient"
  | "knownFileAnchorUID"
  | "isCancelled"
  | "onCanCancelChange"
  | "onProgress"
  | "beforePlacement"
> & {
  mirrorUri: string;
  transportAnchorUID: `0x${string}`;
  contentHash?: `0x${string}`;
  fileSize?: bigint;
};

export interface CreateExternalFileReferenceArgs
  extends Pick<
    UploadOnchainFileArgs,
    | "name"
    | "contentType"
    | "parentAnchorUID"
    | "walletClient"
    | "publicClient"
    | "chainId"
    | "easAddress"
    | "indexerAddress"
    | "indexerAbi"
    | "anchorSchemaUID"
    | "dataSchemaUID"
    | "propertySchemaUID"
    | "pinSchemaUID"
    | "tagSchemaUID"
    | "mirrorSchemaUID"
    | "edgeResolverAddress"
    | "edgeResolverAbi"
    | "fileAnchorRefUID"
    | "fileAnchorRecipient"
    | "knownFileAnchorUID"
    | "isCancelled"
    | "onCanCancelChange"
    | "onProgress"
    | "beforePlacement"
  > {
  mirrorUri: string;
  transportName: string;
  contentHash?: `0x${string}`;
  fileSize?: bigint;
}

async function resolveTransportAnchor(args: {
  publicClient: PublicClient;
  indexerAddress: `0x${string}`;
  indexerAbi: Abi;
  transportName: string;
  onProgress?: (msg: string) => void;
}): Promise<`0x${string}` | null> {
  const { publicClient, indexerAddress, indexerAbi, transportName, onProgress } = args;
  try {
    const rootUID = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "rootAnchorUID",
    })) as `0x${string}`;
    const transportsUID = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "resolvePath",
      args: [rootUID, "transports"],
    })) as `0x${string}`;
    if (!transportsUID || transportsUID === zeroHash) return null;
    const uid = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "resolvePath",
      args: [transportsUID, transportName],
    })) as `0x${string}`;
    return uid && uid !== zeroHash ? uid : null;
  } catch (e) {
    // A genuinely-absent anchor returns null via the path above (no throw); this
    // catch only fires on a real read error (RPC timeout/rate-limit/etc). Surface
    // it so a transient failure that silently downgrades the path is debuggable
    // rather than masquerading as "anchor not seeded".
    onProgress?.(
      `Transport anchor '/transports/${transportName}' lookup errored (${e instanceof Error ? e.message : String(e)}); treating as unavailable.`,
    );
    return null;
  }
}

async function submitFileRecordWithMirror(args: FileRecordWithMirrorArgs): Promise<UploadOnchainFileResult> {
  const {
    name,
    mirrorUri,
    transportAnchorUID,
    contentType,
    parentAnchorUID,
    walletClient,
    publicClient,
    chainId,
    easAddress,
    indexerAddress,
    indexerAbi,
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi,
    fileAnchorRefUID,
    fileAnchorRecipient,
    knownFileAnchorUID,
    isCancelled,
    onCanCancelChange,
    onProgress,
    beforePlacement,
  } = args;
  const contentHash = args.contentHash ?? zeroHash;
  const fileSize = args.fileSize ?? 0n;

  if (walletClient.chain?.id !== chainId) {
    throw new Error(
      `Wallet is on the wrong network (chain ${walletClient.chain?.id ?? "unknown"}); expected ${chainId}. Switch your wallet and retry.`,
    );
  }
  if (!mirrorUri) throw new Error("File URI is required.");
  if (fileSize < 0n) throw new Error("File size cannot be negative.");

  const log = (msg: string) => onProgress?.(msg);
  const checkCancelled = () => {
    if (isCancelled?.()) throw new Error(UPLOAD_CANCELLED);
  };

  const account = walletClient.account;
  if (!account) throw new Error("walletClient has no account");
  const chain = walletClient.chain;

  log(`File URI: ${mirrorUri.length > 64 ? mirrorUri.slice(0, 64) + "…" : mirrorUri}`);

  // ── Resolve file-ANCHOR reuse (read-only; creation is deferred to stage B). ──
  let fileAnchorUID: `0x${string}` | undefined = knownFileAnchorUID ?? undefined;
  if (fileAnchorUID) {
    log("File anchor already exists; reusing.");
  } else if (knownFileAnchorUID === undefined) {
    try {
      const existing = (await publicClient.readContract({
        address: indexerAddress,
        abi: indexerAbi,
        functionName: "resolveAnchor",
        args: [parentAnchorUID, name, dataSchemaUID],
      })) as `0x${string}`;
      if (existing && existing !== zeroHash) {
        fileAnchorUID = existing;
        log("File anchor already exists; reusing.");
      }
    } catch {
      /* anchor doesn't exist yet — created in stage B */
    }
  }

  // DEDUP NOTE: we read dataByContentKey for the log but STILL mint a fresh DATA.
  // Intentional — for re-saves we WANT a new DATA so the placement PIN supersedes
  // the previous one cleanly (ADR-0041); reusing the canonical DATA would re-point
  // the PIN at unchanged content. Matches CreateItemModal's behavior.
  if (contentHash !== zeroHash) {
    try {
      const canonical = (await publicClient.readContract({
        address: indexerAddress,
        abi: indexerAbi,
        functionName: "dataByContentKey",
        args: [contentHash],
      })) as `0x${string}`;
      if (canonical && canonical !== zeroHash) {
        log("Note: DATA for this content already exists. A new one will still be created and tagged.");
      }
    } catch {
      /* non-fatal */
    }
  }

  // ── Reserved keys: contentType (always); contentHash/size only when real. ──
  // Each is a key ANCHOR + free PROPERTY + binding PIN. Because DATA is minted
  // fresh every upload (see DEDUP NOTE), its key anchors are keyed under a not-yet-
  // existent DATA UID and so are always fresh too — no reuse probe needed.
  const reservedKeys: { key: string; value: string }[] = [{ key: "contentType", value: contentType }];
  if (contentHash !== zeroHash) reservedKeys.push({ key: "contentHash", value: contentHash });
  if (fileSize > 0n) reservedKeys.push({ key: "size", value: fileSize.toString() });

  // ── STAGE A: content layers (DATA, MIRROR, key ANCHORs, PROPERTYs). ──
  // L1: DATA (empty identity). L2: everything that refs only DATA / pre-existing.
  const stageA: PlannedAttestation[] = [
    { ref: "DATA", layer: 1, schema: dataSchemaUID, data: "0x", revocable: false, refUID: zeroHash },
    {
      ref: "MIRROR",
      layer: 2,
      schema: mirrorSchemaUID,
      data: encodeAbiParameters(MIRROR_PARAMS, [transportAnchorUID, mirrorUri]),
      revocable: true,
      refUID: { ref: "DATA" },
    },
  ];
  for (const { key, value } of reservedKeys) {
    stageA.push({
      ref: `keyAnchor:${key}`,
      layer: 2,
      schema: anchorSchemaUID,
      data: encodeAbiParameters(KEY_ANCHOR_PARAMS, [key, propertySchemaUID]),
      revocable: false,
      refUID: { ref: "DATA" },
    });
    stageA.push({
      ref: `prop:${key}`,
      layer: 2,
      schema: propertySchemaUID,
      data: encodeAbiParameters(PROPERTY_PARAMS, [value]),
      revocable: false,
      refUID: zeroHash,
    });
  }

  // ── STAGE A (cancellable): content layers. Submit, threading mined UIDs. ──
  const resolved = await submitLayered(stageA, {
    walletClient,
    publicClient,
    easAddress,
    account,
    chain,
    isCancelled,
    onProgress,
  });

  const dataUID = resolved.get("DATA");
  if (!dataUID) throw new Error("Could not extract DATA UID");

  // Last safe abort point. After this, the file-ANCHOR → placement-PIN layers run
  // WITHOUT a cancellation checkpoint, so a Stop / modal-close can never leave a
  // directory child (the file ANCHOR) without its placement PIN — matching the
  // original sequential path, which minted the anchor immediately before the PIN
  // with no checkpoint between them (Codex P2). EAS UIDs aren't precomputable, so
  // anchor and PIN must be separate layers; making the commit stage uncancellable
  // is what closes the orphan-slot window.
  checkCancelled();

  // Optional pre-placement hook (e.g. the system TAG) — must be active before the
  // placement PIN makes the file reachable, so a stopped/failed tag can't leave a
  // visible, untagged file. If it throws, the commit stage never runs (DATA is
  // orphaned — harmless, content-addressed) and nothing reachable leaks.
  if (beforePlacement) {
    log("Tagging item before placement…");
    await beforePlacement(dataUID);
    checkCancelled(); // still safe — the file ANCHOR is not created yet
  }
  onCanCancelChange?.(false);

  // ── COMMIT STAGE (NOT cancellable): file-ANCHOR (L1) → placement + binding PINs
  //    (L2), using CONCRETE UIDs from stage A. file-ANCHOR is deferred to here so
  //    the slot is visible for the shortest window; isCancelled is intentionally
  //    NOT passed, so the anchor→PIN gap can't be interrupted. ──
  const commit: PlannedAttestation[] = [];
  if (!fileAnchorUID) {
    commit.push({
      ref: "fileAnchor",
      layer: 1,
      schema: anchorSchemaUID,
      data: encodeAbiParameters(NAME_PARAMS, [name, dataSchemaUID]),
      revocable: false,
      // Address-root carve-out: refUID=0x0 + recipient=addr when the parent is a
      // synthetic address container (EAS rejects a non-zero non-attestation refUID).
      refUID: fileAnchorRefUID ?? parentAnchorUID,
      ...(fileAnchorRecipient ? { recipient: fileAnchorRecipient } : {}),
    });
  }
  commit.push({
    ref: "placePin",
    layer: 2,
    schema: pinSchemaUID,
    data: "0x",
    revocable: true,
    refUID: dataUID,
    definitionRef: fileAnchorUID ?? { ref: "fileAnchor" },
  });
  for (const { key } of reservedKeys) {
    const propUID = resolved.get(`prop:${key}`);
    if (!propUID) throw new Error(`Could not extract ${key} PROPERTY UID`);
    commit.push({
      ref: `bindPin:${key}`,
      layer: 2,
      schema: pinSchemaUID,
      data: "0x",
      revocable: true,
      refUID: propUID,
      definitionRef: resolved.get(`keyAnchor:${key}`)!,
    });
  }
  const mapCommit = await submitLayered(commit, {
    walletClient,
    publicClient,
    easAddress,
    account,
    chain,
    // NO isCancelled — commit-critical: never interrupt the anchor→PIN sequence.
    onProgress,
  });
  for (const [k, v] of mapCommit) resolved.set(k, v);

  if (!fileAnchorUID) {
    fileAnchorUID = resolved.get("fileAnchor");
    if (!fileAnchorUID) throw new Error("Could not extract file Anchor UID");
  }

  // COMMIT POINT: the placement PIN has landed; the file is saved. Cancellation
  // from here on must NOT propagate as a failure (callers skip their success
  // path otherwise). The ancestor walk below is best-effort and swallows cancel.

  // ── Ancestor-walk visibility TAGs (ADR-0038/ADR-0041), batched into one
  //    multiAttest. A folder appears in a lens listing iff the attester has an
  //    active TAG(definition=dataSchemaUID, refUID=folder). Tag every untagged
  //    generic-folder ancestor from the immediate parent up to root exclusive.
  //    Best-effort: failures here don't fail the upload.
  //    Skipped for the address-root carve-out: `parentAnchorUID` is then a synthetic
  //    bytes32(addr), not a real folder anchor, so there is nothing to tag (and a
  //    TAG against it would revert). ──
  if (fileAnchorRefUID === zeroHash) return { dataUID, fileAnchorUID };
  try {
    const rootUID = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "rootAnchorUID",
    })) as `0x${string}`;

    const attester = account.address;
    const visTags: PlannedAttestation[] = [];
    let current = parentAnchorUID;
    let walked = 0;
    while (
      walked < MAX_ANCHOR_DEPTH &&
      current &&
      current !== zeroHash &&
      current.toLowerCase() !== rootUID.toLowerCase()
    ) {
      const tagged = (await publicClient.readContract({
        address: edgeResolverAddress,
        abi: edgeResolverAbi,
        functionName: "isActiveEdge",
        args: [attester, current, dataSchemaUID, tagSchemaUID],
      })) as boolean;
      if (!tagged) {
        visTags.push({
          ref: `visTag:${current}`,
          layer: 1,
          schema: tagSchemaUID,
          data: encodeAbiParameters(VIS_TAG_PARAMS, [dataSchemaUID, 1n]),
          revocable: true,
          refUID: current,
        });
      }
      const parent = (await publicClient.readContract({
        address: indexerAddress,
        abi: indexerAbi,
        functionName: "getParent",
        args: [current],
      })) as `0x${string}`;
      // bytes32(uint160(addr)): top 12 bytes are zero, bottom 20 encode a non-zero address.
      // EAS has no attestation for this synthetic UID; a TAG against it would revert.
      // Check the parent before advancing — the current node is always a real anchor.
      if (/^0x0{24}[0-9a-fA-F]{40}$/.test(parent) && parent !== zeroHash) break;
      current = parent;
      walked += 1;
    }
    if (visTags.length > 0) {
      log(`Tagging ${visTags.length} ancestor folder${visTags.length === 1 ? "" : "s"} for visibility…`);
      await submitLayered(visTags, { walletClient, publicClient, easAddress, account, chain, onProgress });
    }
  } catch (e) {
    if (e instanceof Error && e.message === UPLOAD_CANCELLED) {
      log("Upload cancelled after placement; some ancestors may stay hidden.");
    } else {
      log("Ancestor-walk visibility tagging failed; some ancestors may stay hidden.");
    }
  }

  return { dataUID, fileAnchorUID };
}

/**
 * Create an EFS file record that mirrors an already-external URI (IPFS, Arweave,
 * HTTPS, magnet, web3, etc.) without deploying storage bytes. Uses the same
 * layered DATA→MIRROR→PROPERTY→placement path as `uploadOnchainFile`.
 */
export async function createExternalFileReference(
  args: CreateExternalFileReferenceArgs,
): Promise<UploadOnchainFileResult> {
  const { mirrorUri, transportName, onProgress } = args;
  const detected = detectTransport(mirrorUri);
  if (detected === "data" || transportName === "data") {
    throw new Error("Inline data: URIs aren't a paste-link target — upload the file instead.");
  }
  if (detected === "unknown") {
    throw new Error("Unsupported URI scheme. Supported: web3://, ipfs://, ar://, https://, magnet:");
  }
  if (detected !== transportName) {
    throw new Error(`URI scheme does not match transport '${transportName}' (detected '${detected}').`);
  }

  const transportAnchorUID = await resolveTransportAnchor({
    publicClient: args.publicClient,
    indexerAddress: args.indexerAddress,
    indexerAbi: args.indexerAbi,
    transportName,
    onProgress,
  });
  if (!transportAnchorUID) {
    throw new Error(`Transport anchor '/transports/${transportName}' not found. Aborting upload.`);
  }

  return submitFileRecordWithMirror({
    ...args,
    transportAnchorUID,
    contentHash: args.contentHash ?? zeroHash,
    fileSize: args.fileSize ?? 0n,
  });
}

/**
 * Plain async on-chain file upload via layered `multiAttest`. Throws
 * `UPLOAD_CANCELLED` if `isCancelled()` trips at a layer boundary.
 */
export async function uploadOnchainFile(args: UploadOnchainFileArgs): Promise<UploadOnchainFileResult> {
  const {
    name,
    bytes,
    contentType,
    parentAnchorUID,
    walletClient,
    publicClient,
    chainId,
    easAddress,
    indexerAddress,
    indexerAbi,
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi,
    fileAnchorRefUID,
    fileAnchorRecipient,
    knownFileAnchorUID,
    isCancelled,
    onCanCancelChange,
    onProgress,
    beforePlacement,
  } = args;

  if (walletClient.chain?.id !== chainId) {
    throw new Error(
      `Wallet is on the wrong network (chain ${walletClient.chain?.id ?? "unknown"}); expected ${chainId}. Switch your wallet and retry.`,
    );
  }

  const log = (msg: string) => onProgress?.(msg);
  const checkCancelled = () => {
    if (isCancelled?.()) throw new Error(UPLOAD_CANCELLED);
  };

  const account = walletClient.account;
  if (!account) throw new Error("walletClient has no account");
  const chain = walletClient.chain;

  if (bytes.length === 0) throw new Error("Cannot upload an empty file.");
  if (bytes.length > MAX_ONCHAIN_SIZE || Math.ceil(bytes.length / CHUNK_SIZE) > MAX_CHUNKS) {
    throw new Error(
      `File too large for on-chain upload (${Math.round(bytes.length / 1024 / 1024)}MB). ` +
        `Maximum is ~${MAX_ONCHAIN_SIZE / 1_000_000}MB (${MAX_CHUNKS} chunks). Use IPFS or Arweave for large files.`,
    );
  }

  const contentHash = computeContentHash(bytes);
  const fileSize = BigInt(bytes.length);

  // ── Store the bytes and resolve the MIRROR uri + transport anchor. ──
  // Small files ride INLINE in the MIRROR attestation as an RFC-2397 `data:` URI
  // (zero storage deploys) when the `/transports/data` anchor is seeded; otherwise
  // we fall back to on-chain SSTORE2. The data: path makes a tiny file (markdown
  // overview, small upload) cost only its attestation layers — no chunk/manager
  // deploys at all.
  let mirrorUri: string;
  let transportAnchorUID: `0x${string}` | null;

  // Transport anchors are shared Schelling points: after the UID exists, its
  // creator has no continuing authority over mirrors. Seeded defaults should
  // exist on fresh chains, and older chains simply fall back when the anchor is
  // absent.
  const candidateDataUri =
    bytes.length <= DATA_URI_MAX_BYTES ? `data:${contentType};base64,${bytesToBase64(bytes)}` : null;
  const dataUri =
    candidateDataUri && utf8ByteLength(candidateDataUri) <= MIRROR_MAX_URI_BYTES ? candidateDataUri : null;
  const dataTransportUID = dataUri
    ? await resolveTransportAnchor({
        publicClient,
        indexerAddress,
        indexerAbi,
        transportName: "data",
        onProgress,
      })
    : null;
  if (dataTransportUID && dataUri) {
    log(`Inlining ${bytes.length}B as a data: URI mirror (no SSTORE2 deploys)…`);
    mirrorUri = dataUri;
    transportAnchorUID = dataTransportUID;
  } else {
    // On-chain SSTORE2. The chunk deploys are independent, so we fire them back-to-
    // back (one wallet popup each, sequential confirmations) and await all receipts
    // in PARALLEL — N chunks mine in ~1–2 blocks instead of N×~12s of sequential
    // receipt waits.
    // AGENT-NOTE: pipelining assumes the wallet preserves SUBMISSION nonce order
    // (MetaMask serializes eth_sendTransaction approvals + assigns sequential nonces,
    // and chunk addresses are collected in submission order = the order the manager
    // needs). A signer that reorders/fee-bumps a middle tx could strand later nonces;
    // a future non-MetaMask SDK port should revisit this.
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE) || 1;
    log(
      `Uploading ${Math.round(bytes.length / 1024) || 1}KB in ${totalChunks} chunk${totalChunks > 1 ? "s" : ""} via SSTORE2…`,
    );

    const chunkHashes: `0x${string}`[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      checkCancelled();
      const chunk = bytes.slice(i, i + CHUNK_SIZE);
      const chunkHex = toHex(chunk);
      const sizeTotal = chunk.length + 1;
      const sizeHex = sizeTotal.toString(16).padStart(4, "0");
      // SSTORE2 deploy bytecode: prefixes the data with a 0x00 STOP guard byte.
      const bytecode = `0x61${sizeHex}80600a3d393df300${chunkHex.slice(2)}` as `0x${string}`;
      const hash = await walletClient.sendTransaction({ data: bytecode, account, chain });
      chunkHashes.push(hash);
      log(`Broadcast chunk ${chunkHashes.length} of ${totalChunks}`);
    }
    checkCancelled();
    log(`Confirming ${totalChunks} chunk${totalChunks > 1 ? "s" : ""}…`);
    const chunkReceipts = await Promise.all(chunkHashes.map(hash => publicClient.waitForTransactionReceipt({ hash })));
    const chunkAddresses: `0x${string}`[] = chunkReceipts.map(r => {
      if (!r.contractAddress) throw new Error("Chunk deployment failed");
      return r.contractAddress;
    });
    checkCancelled();

    log("Deploying chunk manager…");
    const deployData = encodeDeployData({
      abi: MOCK_CHUNKED_FILE_ABI,
      bytecode: MOCK_CHUNKED_FILE_BYTECODE as `0x${string}`,
      args: [chunkAddresses as readonly `0x${string}`[]],
    });
    const managerHash = await walletClient.sendTransaction({ data: deployData, account, chain });
    const managerReceipt = await publicClient.waitForTransactionReceipt({ hash: managerHash });
    if (!managerReceipt.contractAddress) throw new Error("Manager deployment failed");
    checkCancelled();

    mirrorUri = `web3://${managerReceipt.contractAddress}:${chainId}`;
    transportAnchorUID = await resolveTransportAnchor({
      publicClient,
      indexerAddress,
      indexerAbi,
      transportName: "onchain",
      onProgress,
    });
    if (!transportAnchorUID) throw new Error("Transport anchor '/transports/onchain' not found. Aborting upload.");
  }

  return submitFileRecordWithMirror({
    name,
    mirrorUri,
    transportAnchorUID,
    contentType,
    contentHash,
    fileSize,
    parentAnchorUID,
    walletClient,
    publicClient,
    chainId,
    easAddress,
    indexerAddress,
    indexerAbi,
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi,
    fileAnchorRefUID,
    fileAnchorRecipient,
    knownFileAnchorUID,
    isCancelled,
    onCanCancelChange,
    onProgress,
    beforePlacement,
  });
}
