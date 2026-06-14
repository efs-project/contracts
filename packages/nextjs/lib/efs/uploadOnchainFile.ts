/**
 * uploadOnchainFile — SDK SEAM (plain async, no React).
 * ============================================================================
 *
 * This is the SDK seam for the on-chain file-upload path: a single plain async
 * function that performs the full in-browser on-chain file upload. It is a
 * FAITHFUL ADDITIVE COPY of the proven File-upload branch of
 * `components/explorer/CreateItemModal.tsx`'s `handleSubmit` (~lines 873–1276),
 * lifted out of the React component so an editor / future SDK can call it
 * without a component mounted. CreateItemModal is intentionally left UNCHANGED;
 * the two are deduped in a later follow-up.
 *
 * WHY `attest` IS INJECTED: in CreateItemModal, `attest` is the handle returned
 * by `useScaffoldWriteContract({ contractName: "EAS" })` — a React hook handle
 * that CANNOT be called inside a plain function. So this helper takes `attest`
 * as a parameter; callers (which ARE components/hooks) pass their hook handle in.
 * No React hook is called inside this file.
 *
 * ⚠️ NON-ATOMIC: a single upload is ~8–10 separate transactions (N SSTORE2
 * chunks + manager deploy + ANCHOR + DATA + contentType×3 + MIRROR + PIN +
 * ancestor TAGs). There is NO atomic wrapper. If the wallet rejects or a tx
 * fails mid-sequence, already-broadcast txs still settle: orphaned SSTORE2
 * chunks, an orphaned manager contract, or an orphaned DATA become permanent
 * on-chain but are harmless (unreferenced, unreachable). Re-saving the same
 * (parent, name) REUSES the existing file ANCHOR and SUPERSEDES the placement
 * PIN in O(1) (ADR-0041), so a retry cleanly converges — only the orphaned
 * intermediate artifacts from the failed attempt linger.
 */
import { CHUNK_SIZE, MAX_CHUNKS, MAX_ONCHAIN_SIZE, MOCK_CHUNKED_FILE_ABI, MOCK_CHUNKED_FILE_BYTECODE } from "./sstore2";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  parseAbiItem,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import type { Abi, PublicClient, TransactionReceipt, WalletClient } from "viem";
import { computeContentHash } from "~~/utils/efs/transports";

/**
 * Injected attest handle. Structurally a subset of the `writeContractAsync`
 * returned by `useScaffoldWriteContract({ contractName: "EAS" })`: it accepts
 * the `attest` functionName + a loosely-typed `args` tuple and the scaffold
 * `{ silent }` option, returning the tx hash (or undefined).
 *
 * The scaffold handle is NOT directly assignable: its `args` is a strongly-typed
 * ABI tuple, and a function parameter is contravariant, so a `readonly unknown[]`
 * param can't accept it without widening. Callers bridge the gap with a single
 * documented `as unknown as AttestFn` cast at the injection site.
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

  attest: AttestFn;

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

  /** Checked between txs; if it returns true we throw the cancel sentinel. */
  isCancelled?: () => boolean;
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

/** Thrown when `isCancelled()` flips true at a tx boundary. */
export const UPLOAD_CANCELLED = "__UPLOAD_CANCELLED__";

const MAX_ANCHOR_DEPTH = 32;

// Inlined from CreateItemModal.tsx ~lines 351–369. Extracts the UID emitted by
// the EAS `Attested` event from a tx receipt.
function extractUIDFromReceipt(receipt: TransactionReceipt): `0x${string}` | undefined {
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: [
          parseAbiItem(
            "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
          ),
        ],
        data: log.data,
        topics: log.topics,
      });
      return (event.args as { uid: `0x${string}` }).uid;
    } catch {
      // not our event
    }
  }
  return undefined;
}

/**
 * Plain async on-chain file upload. Re-parameterized copy of CreateItemModal's
 * File branch — see header. Throws `UPLOAD_CANCELLED` if `isCancelled()` trips.
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
    attest,
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
    isCancelled,
    onProgress,
    beforePlacement,
  } = args;

  const log = (msg: string) => onProgress?.(msg);
  const checkCancelled = () => {
    if (isCancelled?.()) throw new Error(UPLOAD_CANCELLED);
  };

  const account = walletClient.account;
  if (!account) throw new Error("walletClient has no account");

  if (bytes.length === 0) throw new Error("Cannot upload an empty file.");
  // Reject up front, before any chunk is paid for: the MockChunkedFile
  // constructor stores every chunk address in one tx and would out-of-gas past
  // MAX_CHUNKS (see sstore2.ts). The byte cap == MAX_CHUNKS * CHUNK_SIZE, so
  // these are equivalent — both stated for clarity at the failure site.
  if (bytes.length > MAX_ONCHAIN_SIZE || Math.ceil(bytes.length / CHUNK_SIZE) > MAX_CHUNKS) {
    throw new Error(
      `File too large for on-chain upload (${Math.round(bytes.length / 1024 / 1024)}MB). ` +
        `Maximum is ~${MAX_ONCHAIN_SIZE / 1_000_000}MB (${MAX_CHUNKS} chunks). Use IPFS or Arweave for large files.`,
    );
  }

  // ── Resolve the /transports/onchain anchor (inlined resolveTransportAnchor,
  //    CreateItemModal ~lines 371–396, parameterized by indexer + publicClient). ──
  const resolveTransportAnchor = async (transportName: string): Promise<`0x${string}` | null> => {
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
    } catch {
      return null;
    }
  };

  // ── SSTORE2 chunk deploy + manager (CreateItemModal ~lines 897–944) ──
  const contentHash = computeContentHash(bytes);
  const fileSize = BigInt(bytes.length);

  const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE) || 1;
  log(
    `Uploading ${Math.round(bytes.length / 1024) || 1}KB in ${totalChunks} chunk${totalChunks > 1 ? "s" : ""} via SSTORE2...`,
  );
  const chunkAddresses: `0x${string}`[] = [];

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    checkCancelled();
    const chunk = bytes.slice(i, i + CHUNK_SIZE);
    const chunkHex = toHex(chunk);
    const sizeTotal = chunk.length + 1;
    const sizeHex = sizeTotal.toString(16).padStart(4, "0");
    // SSTORE2 deploy bytecode: PUSH2 <size> DUP1 PUSH1 0a RETURNDATASIZE CODECOPY
    // RETURNDATASIZE RETURN STOP <chunk> — prefixes the data with a 0x00 STOP guard byte.
    const bytecode = `0x61${sizeHex}80600a3d393df300${chunkHex.slice(2)}`;

    const hash = await walletClient.sendTransaction({
      data: bytecode as `0x${string}`,
      account,
      chain: walletClient.chain,
    });
    const chunkReceipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!chunkReceipt.contractAddress) throw new Error("Chunk deployment failed");
    chunkAddresses.push(chunkReceipt.contractAddress);
    log(`Deployed chunk ${chunkAddresses.length} of ${totalChunks}`);
  }
  checkCancelled();

  log("Deploying chunk manager...");
  const deployData = encodeDeployData({
    abi: MOCK_CHUNKED_FILE_ABI,
    bytecode: MOCK_CHUNKED_FILE_BYTECODE as `0x${string}`,
    args: [chunkAddresses as readonly `0x${string}`[]],
  });
  const managerHash = await walletClient.sendTransaction({
    data: deployData,
    account,
    chain: walletClient.chain,
  });
  const managerReceipt = await publicClient.waitForTransactionReceipt({ hash: managerHash });
  if (!managerReceipt.contractAddress) throw new Error("Manager deployment failed");
  checkCancelled();

  const mirrorUri = `web3://${managerReceipt.contractAddress}:${chainId}`;
  const transportName = "onchain";
  log(`File URI: ${mirrorUri}`);

  // ── File ANCHOR (reuse existing via resolveAnchor, CreateItemModal ~lines 841–988) ──
  // encodedName binds the filename to the DATA schema UID as the anchorType.
  const encodedName = encodeAbiParameters(
    [
      { name: "name", type: "string" },
      { name: "schemaUID", type: "bytes32" },
    ],
    [name, dataSchemaUID],
  );

  let fileAnchorUID: `0x${string}` | undefined;
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
    // anchor doesn't exist yet — create below
  }

  // NOTE: anchor CREATION is deliberately deferred to just before the placement
  // PIN (see below), not done here. Creating the file-slot ANCHOR sets
  // `_containsAttestations[anchorUID][attester]` in EFSIndexer, which makes the
  // slot appear in `getDirectoryPageFiltered` phase 1 immediately — before any
  // placement PIN exists, so the `system`-tag exclusion (which reaches the DATA
  // via the PIN) can't yet hide it. Creating the anchor last shrinks that
  // visible-but-unhidden window from ~6 txs to ~1 (Codex P2). The window can't be
  // fully closed: EAS UIDs aren't precomputable, so the anchor and the PIN that
  // references it can't be batched atomically. The read-only reuse check above
  // stays here (it sets no on-chain state).

  // ── DATA attestation (CreateItemModal ~lines 990–1032) ──
  // DEDUP NOTE: we read dataByContentKey for the log but STILL create a fresh
  // DATA. This is intentional — for README / file re-saves we WANT a new DATA so
  // the placement PIN supersedes the previous one cleanly (ADR-0041). Reusing the
  // canonical DATA would re-point the PIN at unchanged content; a fresh DATA keeps
  // each save independently revocable. (Matches CreateItemModal's behavior.)
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
      // non-fatal
    }
  }

  log("Creating DATA attestation...");
  const encodedData = encodeAbiParameters(
    [
      { name: "contentHash", type: "bytes32" },
      { name: "size", type: "uint64" },
    ],
    [contentHash, fileSize],
  );
  const dataTxHash = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: dataSchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: zeroHash,
            data: encodedData,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!dataTxHash) throw new Error("DATA attestation failed.");
  const dataReceipt = await publicClient.waitForTransactionReceipt({ hash: dataTxHash });
  const dataUID = extractUIDFromReceipt(dataReceipt);
  if (!dataUID) throw new Error("Could not extract DATA UID");
  log(`DATA created: ${dataUID.slice(0, 10)}...`);
  checkCancelled();

  // ── contentType PROPERTY: key ANCHOR + free PROPERTY + PIN bind
  //    (CreateItemModal ~lines 1034–1130, ADR-0035/ADR-0041) ──
  log("Creating contentType key anchor...");
  let contentTypeKeyAnchorUID = (await publicClient.readContract({
    address: indexerAddress,
    abi: indexerAbi,
    functionName: "resolveAnchor",
    args: [dataUID, "contentType", propertySchemaUID],
  })) as `0x${string}`;

  if (!contentTypeKeyAnchorUID || contentTypeKeyAnchorUID === zeroHash) {
    const encodedKey = encodeAbiParameters(
      [
        { name: "name", type: "string" },
        { name: "schemaUID", type: "bytes32" },
      ],
      ["contentType", propertySchemaUID],
    );
    const keyTx = await attest(
      {
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: dataUID,
              data: encodedKey,
              value: 0n,
            },
          },
        ],
      },
      { silent: true },
    );
    if (!keyTx) throw new Error("contentType key anchor attestation failed.");
    const keyReceipt = await publicClient.waitForTransactionReceipt({ hash: keyTx });
    const extracted = extractUIDFromReceipt(keyReceipt);
    if (!extracted) throw new Error("Could not extract contentType key anchor UID");
    contentTypeKeyAnchorUID = extracted;
  }

  log("Attesting content type PROPERTY...");
  const encodedProperty = encodeAbiParameters([{ name: "value", type: "string" }], [contentType]);
  const propTxHash = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: propertySchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: zeroHash,
            data: encodedProperty,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!propTxHash) throw new Error("contentType PROPERTY attestation failed.");
  const propReceipt = await publicClient.waitForTransactionReceipt({ hash: propTxHash });
  const contentTypePropertyUID = extractUIDFromReceipt(propReceipt);
  if (!contentTypePropertyUID) throw new Error("Could not extract contentType PROPERTY UID");

  log("Binding contentType PROPERTY via PIN...");
  // PROPERTY value binding is a PIN under ADR-0041 (cardinality 1). Re-binding at
  // the same key anchor supersedes the prior PIN in O(1).
  const encodedContentTypePin = encodeAbiParameters(
    [{ name: "definition", type: "bytes32" }],
    [contentTypeKeyAnchorUID],
  );
  const contentTypePinTxHash = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: pinSchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: contentTypePropertyUID,
            data: encodedContentTypePin,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!contentTypePinTxHash) throw new Error("contentType PIN attestation did not return a transaction hash.");
  await publicClient.waitForTransactionReceipt({ hash: contentTypePinTxHash });
  checkCancelled();

  // ── MIRROR (refUID=DATA, /transports/onchain anchor, uri) (CreateItemModal ~lines 1132–1167) ──
  const transportAnchorUID = await resolveTransportAnchor(transportName);
  if (!transportAnchorUID) {
    throw new Error(`Transport anchor '/transports/${transportName}' not found. Aborting upload.`);
  }
  log("Creating On-chain mirror...");
  const encodedMirror = encodeAbiParameters(
    [
      { name: "transport", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    [transportAnchorUID, mirrorUri],
  );
  const mirrorTxHash = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: mirrorSchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: dataUID,
            data: encodedMirror,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!mirrorTxHash) throw new Error("MIRROR attestation did not return a transaction hash.");
  await publicClient.waitForTransactionReceipt({ hash: mirrorTxHash });
  checkCancelled();

  // ── Pre-placement hook: apply any descriptive tag (e.g. `system`) on the DATA
  // BEFORE the file becomes reachable, so a cancelled/failed tag can't leave a
  // visible, untagged file in the directory (Codex P2). If it throws, the
  // placement PIN below never runs — the DATA is orphaned (harmless) and nothing
  // reachable leaks.
  if (beforePlacement) {
    log("Tagging item before placement...");
    await beforePlacement(dataUID);
    checkCancelled();
  }

  // ── File ANCHOR (created LAST, immediately before placement) ──
  // Deferred here from the reuse check above so the slot is reachable in the
  // listing for the shortest possible window before its placement PIN hides it
  // (Codex P2 — see the note at the reuse check). The DATA is already
  // system-tagged at this point (beforePlacement), so the instant the PIN below
  // lands, the file is hidden.
  if (!fileAnchorUID) {
    // The component's `anchorParent()` carve-out (refUID=0 + recipient=addr for
    // direct children of an Address-container root) is NOT reachable here: the
    // editor seam always places under a resolved attestation anchor parent, so the
    // standard (refUID=parent, recipient=0) path applies.
    const anchorTxHash = await attest(
      {
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: parentAnchorUID,
              data: encodedName,
              value: 0n,
            },
          },
        ],
      },
      { silent: true },
    );
    if (!anchorTxHash) throw new Error("No txHash returned for file ANCHOR creation.");
    const anchorReceipt = await publicClient.waitForTransactionReceipt({ hash: anchorTxHash });
    fileAnchorUID = extractUIDFromReceipt(anchorReceipt);
    if (!fileAnchorUID) throw new Error("Could not extract file Anchor UID");
    log("File anchor created.");
    checkCancelled();
  }

  // ── Placement PIN (definition=fileAnchorUID, refUID=DATA) (CreateItemModal ~lines 1170–1194) ──
  log("Placing file in folder via PIN...");
  // File placement is a PIN under ADR-0041 (cardinality 1). Re-uploading a
  // different DATA at the same file anchor supersedes the prior PIN in O(1).
  const encodedPin = encodeAbiParameters([{ name: "definition", type: "bytes32" }], [fileAnchorUID]);
  const pinTxHash = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: pinSchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: dataUID,
            data: encodedPin,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!pinTxHash) throw new Error("Placement PIN attestation did not return a transaction hash.");
  await publicClient.waitForTransactionReceipt({ hash: pinTxHash });
  checkCancelled();

  // ── Ancestor-walk visibility TAGs (CreateItemModal ~lines 1196–1276, ADR-0038/ADR-0041) ──
  // A folder appears in a lens listing iff at least one lens attester has an
  // active TAG(definition=dataSchemaUID, refUID=folder). Emit that TAG at every
  // generic-folder ancestor from the immediate parent up to (excluding) root.
  // Skip already-tagged ancestors. Best-effort: failures here don't fail the
  // upload (the file is already placed), they only leave some ancestors hidden.
  //
  // INVARIANT (AGENT-NOTE, Codex P2): `parentAnchorUID` MUST be a generic folder
  // (anchorType == bytes32(0)). The walk tags `current` with definition=dataSchemaUID
  // starting at `parentAnchorUID`; if that were a FILE anchor it would be mis-tagged
  // as a visible folder and could re-surface via phase-0 folder visibility after its
  // placement PIN is revoked. This is enforced by construction — the sole caller
  // (OverviewEditorModal) passes `currentAnchorUID`, which is always the current
  // folder/container (clicking a file opens a preview, it never becomes
  // currentAnchorUID) — so the file-anchor case is not reachable. A runtime guard
  // would have to read each node's anchorType; EFSIndexer can't expose a getter for
  // it (its address is baked into the schema UIDs — kernel immutability), so the
  // guard would need a client-side EAS getAttestation + decode. Deferred unless a
  // per-file Overview is ever added (then guard: skip tagging any node whose decoded
  // anchorType != bytes32(0)). See docs/FUTURE_WORK.md.
  try {
    const rootUID = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "rootAnchorUID",
    })) as `0x${string}`;

    const attester = account.address;
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
        log(`Tagging ancestor folder ${current.slice(0, 10)}... for visibility`);
        const encodedVisTag = encodeAbiParameters(
          [
            { name: "definition", type: "bytes32" },
            { name: "weight", type: "int256" },
          ],
          [dataSchemaUID, 1n],
        );
        const visTxHash = await attest(
          {
            functionName: "attest",
            args: [
              {
                schema: tagSchemaUID,
                data: {
                  recipient: zeroAddress,
                  expirationTime: 0n,
                  revocable: true,
                  refUID: current,
                  data: encodedVisTag,
                  value: 0n,
                },
              },
            ],
          },
          { silent: true },
        );
        if (visTxHash) await publicClient.waitForTransactionReceipt({ hash: visTxHash });
      }

      const parent = (await publicClient.readContract({
        address: indexerAddress,
        abi: indexerAbi,
        functionName: "getParent",
        args: [current],
      })) as `0x${string}`;
      current = parent;
      walked += 1;
      checkCancelled();
    }
  } catch (e) {
    if (e instanceof Error && e.message === UPLOAD_CANCELLED) throw e;
    log("Ancestor-walk visibility tagging failed; some ancestors may stay hidden.");
  }

  return { dataUID, fileAnchorUID };
}
