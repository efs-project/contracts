/**
 * submitLayered — Tier-1 layered `multiAttest` engine for the debug UI.
 * ============================================================================
 *
 * Executes a dependency-ordered set of EAS attestations as **one
 * `EAS.multiAttest` per DAG layer**, threading the real mined UIDs from each
 * layer's receipt into the symbolic references of the next. This is a faithful,
 * self-contained port of the SDK's `submitLayeredTier1`
 * (`packages/sdk/src/writes/submit.ts`) — deliberately NOT importing `@efs/sdk`
 * (unpublished, cross-repo; this debug UI is Ephemeral), but shaped so a later
 * swap to the SDK is a drop-in.
 *
 * ## Why layer-by-layer (the UID-threading problem)
 *
 * A fresh attestation's EAS UID embeds `block.timestamp` (`EAS.sol::_getUID`), so
 * it is unknowable until mined — UIDs CANNOT be precomputed. When attestation B
 * must carry attestation A's UID (B's `refUID`, or a PIN's in-`data` `definition`),
 * B cannot be sent in the same tx as A. So dependent attestations are split across
 * layers: each layer is one `multiAttest`; within a layer nothing references a
 * same-layer sibling. After a layer mines we read its `Attested` events and feed
 * the real UIDs into the next layer.
 *
 * This collapses what the debug UI does today — one `attest` per wallet popup,
 * fully serialized — into one popup per dependency layer (a file write's ~11
 * attestations become 3–4 `multiAttest` calls).
 *
 * ## Extracting UIDs — submission-order zip
 *
 * `EAS.multiAttest` emits exactly one `Attested(recipient, attester, uid,
 * schemaUID)` per attestation, in the flattened order it iterates the requests:
 * `requests[0].data[0..]`, then `requests[1].data[0..]`, … viem's `parseEventLogs`
 * returns logs in receipt order, which is that emission order. We keep a parallel
 * flat array of `ref`s captured at request-build time (grouping-by-schema reorders
 * entries, so the flat refs must follow the grouped order, NOT the input plan
 * order) and zip it against the parsed UIDs.
 *
 * ## Partial-write boundary
 *
 * Each layer is one tx and its own atomic unit (a resolver revert reverts the whole
 * layer). If layer K reverts, layers < K already mined — the file is half-written
 * (e.g. DATA + anchors exist but the placement PIN never landed, so it is not yet
 * visible). The caller's existing retry/supersede semantics converge: re-running
 * reuses the file ANCHOR and supersedes the placement PIN in O(1) (ADR-0041). This
 * is strictly fewer partial-failure surfaces than today's ~11 independent txs.
 */
import { decodeEventLog, encodeAbiParameters, parseAbiItem, parseEventLogs } from "viem";
import type { Account, Chain, Log, PublicClient, TransactionReceipt, WalletClient } from "viem";

/** A reference to a UID minted earlier in the same write (resolved at submit time). */
export type SymbolicRef = { readonly ref: string };
/** Either a concrete on-chain UID or a {@link SymbolicRef} to a same-write sibling. */
export type RefOrUID = `0x${string}` | SymbolicRef;

export function isSymbolicRef(r: RefOrUID): r is SymbolicRef {
  return typeof r === "object" && r !== null && "ref" in r;
}

/**
 * One planned attestation. `ref` is the key its minted UID is recorded under (so
 * later layers can point at it). `refUID` and the optional PIN `definitionRef` may
 * be symbolic — they are resolved against the accumulated UID map just before the
 * layer is sent.
 */
export interface PlannedAttestation {
  /** Unique key for this attestation's minted UID (e.g. "DATA", "fileAnchor"). */
  readonly ref: string;
  /** 1-based dependency layer. Lower layers mine first; their UIDs feed higher ones. */
  readonly layer: number;
  readonly schema: `0x${string}`;
  /**
   * Pre-encoded attestation data. For a PIN whose `definition` is a same-write
   * sibling, leave this as a placeholder and set {@link definitionRef}; the engine
   * (re)encodes `data` once the definition UID is known.
   */
  readonly data: `0x${string}`;
  readonly revocable: boolean;
  /** Concrete UID, a symbolic ref to a prior layer, or 0x0 for standalone. */
  readonly refUID: RefOrUID;
  /** Defaults to the zero address; only an ADDR-mode LIST_ENTRY overrides it. */
  readonly recipient?: `0x${string}`;
  /**
   * For a PIN: the `definition` field (a `bytes32` anchor UID) when it references a
   * same-write sibling. When set, the engine encodes `data` as
   * `abi.encode(bytes32 definition)` with the resolved UID, ignoring {@link data}.
   */
  readonly definitionRef?: RefOrUID;
}

export interface SubmitLayeredCtx {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  readonly easAddress: `0x${string}`;
  /** Required by viem's writeContract unless bound on the client. */
  readonly account: Account;
  readonly chain?: Chain;
  /** Checked BEFORE each layer's irreversible multiAttest (never mid-flight). */
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (msg: string) => void;
  readonly onLayer?: (e: {
    readonly layer: number;
    readonly txHash: `0x${string}`;
    readonly minted: readonly { readonly ref: string; readonly uid: `0x${string}` }[];
  }) => void;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_UID = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Thrown when a caller's `isCancelled()` trips at a layer boundary. The value
 * matches the upload seam's `UPLOAD_CANCELLED` sentinel (re-exported there) so the
 * UI's cancel check (`e.message === sentinel`) treats a between-layer Stop as a
 * graceful cancellation, NOT a failed write.
 */
export const SUBMIT_CANCELLED = "__UPLOAD_CANCELLED__";

/** Minimal EAS surface: the batched-attest entrypoint + its event. Kept local so
 * this engine doesn't depend on deployedContracts' generated ABI shape. */
const EAS_MULTIATTEST_ABI = [
  {
    type: "function",
    name: "multiAttest",
    stateMutability: "payable",
    inputs: [
      {
        name: "multiRequests",
        type: "tuple[]",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  parseAbiItem(
    "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
  ),
] as const;

const PIN_DEFINITION_PARAMS = [{ name: "definition", type: "bytes32" }] as const;

/** Thrown when a layer's multiAttest reverts (or its receipt can't be confirmed).
 * Carries the layer and the UIDs that DID land in earlier layers, mirroring the
 * SDK's WriteRevertedError so callers can reason about the partial write. */
export class LayeredWriteError extends Error {
  readonly layer: number;
  readonly landed: ReadonlyMap<string, `0x${string}`>;
  readonly txHash?: `0x${string}`;
  constructor(layer: number, landed: ReadonlyMap<string, `0x${string}`>, message: string, txHash?: `0x${string}`) {
    super(message);
    this.name = "LayeredWriteError";
    this.layer = layer;
    this.landed = landed;
    this.txHash = txHash;
  }
}

function resolveRef(ref: RefOrUID, resolved: ReadonlyMap<string, `0x${string}`>, ctx: string): `0x${string}` {
  if (!isSymbolicRef(ref)) return ref;
  const uid = resolved.get(ref.ref);
  if (uid === undefined) {
    throw new Error(
      `submitLayered: unresolved symbolic ref '${ref.ref}' while building ${ctx} (malformed layer order).`,
    );
  }
  return uid;
}

/** Produce the concrete (refUID, data) for a planned attestation, substituting a
 * symbolic refUID and re-encoding a PIN's `definition` when it's a sibling ref. */
function materialize(
  att: PlannedAttestation,
  resolved: ReadonlyMap<string, `0x${string}`>,
): { refUID: `0x${string}`; data: `0x${string}` } {
  const refUID = resolveRef(att.refUID, resolved, `${att.ref} refUID`);
  if (att.definitionRef === undefined) return { refUID, data: att.data };
  const definition = resolveRef(att.definitionRef, resolved, `${att.ref} definition`);
  return { refUID, data: encodeAbiParameters(PIN_DEFINITION_PARAMS, [definition]) };
}

/** Group a layer into MultiAttestationRequest[] (one per schema, first-seen order)
 * and capture the flat ref order EAS will emit Attested events in. */
function buildLayerRequests(atts: readonly PlannedAttestation[], resolved: ReadonlyMap<string, `0x${string}`>) {
  const order: `0x${string}`[] = [];
  const bySchema = new Map<
    `0x${string}`,
    {
      refs: string[];
      data: {
        recipient: `0x${string}`;
        expirationTime: bigint;
        revocable: boolean;
        refUID: `0x${string}`;
        data: `0x${string}`;
        value: bigint;
      }[];
    }
  >();

  for (const att of atts) {
    const { refUID, data } = materialize(att, resolved);
    let bucket = bySchema.get(att.schema);
    if (!bucket) {
      bucket = { refs: [], data: [] };
      bySchema.set(att.schema, bucket);
      order.push(att.schema);
    }
    bucket.refs.push(att.ref);
    bucket.data.push({
      recipient: att.recipient ?? ZERO_ADDRESS,
      expirationTime: 0n,
      revocable: att.revocable,
      refUID,
      data,
      value: 0n,
    });
  }

  const requests = order.map(schema => ({ schema, data: bySchema.get(schema)!.data }));
  const flatRefs = order.flatMap(schema => bySchema.get(schema)!.refs);
  return { requests, flatRefs };
}

/** Parse Attested UIDs out of a receipt, in emission order, filtered to EAS. */
function extractMintedUIDs(receipt: TransactionReceipt, easAddress: `0x${string}`, expected: number): `0x${string}`[] {
  const easLower = easAddress.toLowerCase();
  // parseEventLogs returns logs in receipt (= emission) order.
  const logs = parseEventLogs({ abi: EAS_MULTIATTEST_ABI, eventName: "Attested", logs: receipt.logs as Log[] });
  const uids = logs.filter(l => l.address.toLowerCase() === easLower).map(l => (l.args as { uid: `0x${string}` }).uid);
  if (uids.length !== expected) {
    // Fallback: decode by hand as a guard if parseEventLogs under-matches.
    const manual: `0x${string}`[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== easLower) continue;
      try {
        const ev = decodeEventLog({ abi: EAS_MULTIATTEST_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "Attested") manual.push((ev.args as { uid: `0x${string}` }).uid);
      } catch {
        /* not our event */
      }
    }
    if (manual.length === expected) return manual;
    throw new Error(
      `submitLayered: expected ${expected} Attested event(s) from EAS, found ${uids.length}. Receipt does not match the multiAttest.`,
    );
  }
  return uids;
}

/**
 * Execute a layered attestation plan as one `multiAttest` per layer, returning the
 * full `ref → minted UID` map. Throws {@link LayeredWriteError} on a layer revert,
 * carrying which earlier UIDs already landed.
 */
export async function submitLayered(
  plan: readonly PlannedAttestation[],
  ctx: SubmitLayeredCtx,
): Promise<Map<string, `0x${string}`>> {
  const resolved = new Map<string, `0x${string}`>();

  // Guard: ref keys must be unique — they key the minted-UID map, and a duplicate
  // would silently overwrite a sibling's UID and misthread every later reference.
  const seen = new Set<string>();
  for (const a of plan) {
    if (seen.has(a.ref)) throw new Error(`submitLayered: duplicate plan ref '${a.ref}' (refs must be unique).`);
    seen.add(a.ref);
  }

  const layers = [...new Set(plan.map(a => a.layer))].sort((a, b) => a - b);

  for (const layer of layers) {
    const layerAtts = plan.filter(a => a.layer === layer);
    if (layerAtts.length === 0) continue;

    // Cancellation between layers is a graceful Stop, not a write failure: throw the
    // shared cancel sentinel so the UI shows "Cancelled" rather than a red error.
    if (ctx.isCancelled?.()) throw new Error(SUBMIT_CANCELLED);

    const { requests, flatRefs } = buildLayerRequests(layerAtts, resolved);
    ctx.onProgress?.(`Submitting layer ${layer} (${flatRefs.length} attestation${flatRefs.length === 1 ? "" : "s"})…`);

    let txHash: `0x${string}`;
    try {
      txHash = await ctx.walletClient.writeContract({
        address: ctx.easAddress,
        abi: EAS_MULTIATTEST_ABI,
        functionName: "multiAttest",
        args: [requests],
        value: 0n,
        account: ctx.account,
        chain: ctx.chain,
      });
    } catch (cause) {
      // No tx broadcast → safe to retry; nothing landed in this layer.
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} was not sent (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (cause) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} receipt was not confirmed (tx ${txHash}): ${
          cause instanceof Error ? cause.message : String(cause)
        }.`,
        txHash,
      );
    }
    if (receipt.status === "reverted") {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} reverted (tx ${txHash}).`,
        txHash,
      );
    }

    let uids: `0x${string}`[];
    try {
      uids = extractMintedUIDs(receipt, ctx.easAddress, flatRefs.length);
    } catch (cause) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} mined but UID extraction failed (tx ${txHash}): ${
          cause instanceof Error ? cause.message : String(cause)
        }.`,
        txHash,
      );
    }
    const minted = flatRefs.map((ref, i) => {
      const uid = uids[i] ?? ZERO_UID;
      resolved.set(ref, uid);
      return { ref, uid };
    });
    ctx.onLayer?.({ layer, txHash, minted });
  }

  return resolved;
}
