/**
 * Tier-1 layered `multiAttest` submitter for the debug UI.
 *
 * This mirrors the SDK fallback strategy without importing the unpublished SDK:
 * build a dependency-ordered attestation plan, submit one EAS `multiAttest` per
 * layer, then thread mined UIDs into later layers. It works with plain injected
 * wallets, including MetaMask, because each layer is a normal contract write.
 */
import { decodeEventLog, encodeAbiParameters, parseAbiItem, parseEventLogs } from "viem";
import type { Account, Chain } from "viem";

export type SymbolicRef = { readonly ref: string };
export type RefOrUID = `0x${string}` | SymbolicRef;

export function isSymbolicRef(ref: RefOrUID): ref is SymbolicRef {
  return typeof ref === "object" && ref !== null && "ref" in ref;
}

export interface PlannedAttestation {
  readonly ref: string;
  readonly layer: number;
  readonly schema: `0x${string}`;
  readonly data: `0x${string}`;
  readonly revocable: boolean;
  readonly refUID: RefOrUID;
  readonly recipient?: `0x${string}`;
  readonly pinDefinitionRef?: RefOrUID;
}

export interface SubmitLayeredCtx {
  readonly walletClient: {
    writeContract(args: {
      address: `0x${string}`;
      abi: typeof EAS_MULTIATTEST_ABI;
      functionName: "multiAttest";
      args: readonly [
        readonly {
          schema: `0x${string}`;
          data: readonly {
            recipient: `0x${string}`;
            expirationTime: bigint;
            revocable: boolean;
            refUID: `0x${string}`;
            data: `0x${string}`;
            value: bigint;
          }[];
        }[],
      ];
      value: bigint;
      account: Account | `0x${string}` | null | undefined;
      chain?: Chain;
    }): Promise<`0x${string}`>;
  };
  readonly publicClient: {
    waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
      status?: "success" | "reverted";
      logs: readonly {
        address: string;
        data: `0x${string}`;
        topics: readonly `0x${string}`[];
      }[];
    }>;
  };
  readonly easAddress: `0x${string}`;
  readonly account: Account | `0x${string}` | null | undefined;
  readonly chain?: Chain;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (message: string) => void;
  readonly onBeforeLayer?: (event: { readonly layer: number; readonly refs: readonly string[] }) => void;
  readonly onLayer?: (event: {
    readonly layer: number;
    readonly txHash: `0x${string}`;
    readonly minted: readonly { readonly ref: string; readonly uid: `0x${string}` }[];
  }) => void;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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

export class LayeredWriteError extends Error {
  readonly layer: number;
  readonly landed: ReadonlyMap<string, `0x${string}`>;
  readonly txHash?: `0x${string}`;
  readonly cancelled: boolean;

  constructor(
    layer: number,
    landed: ReadonlyMap<string, `0x${string}`>,
    message: string,
    txHash?: `0x${string}`,
    cancelled = false,
  ) {
    super(message);
    this.name = "LayeredWriteError";
    this.layer = layer;
    this.landed = landed;
    this.txHash = txHash;
    this.cancelled = cancelled;
  }
}

function resolveRef(ref: RefOrUID, resolved: ReadonlyMap<string, `0x${string}`>, context: string): `0x${string}` {
  if (!isSymbolicRef(ref)) return ref;
  const uid = resolved.get(ref.ref);
  if (!uid) {
    throw new Error(`submitLayered: unresolved symbolic ref '${ref.ref}' while building ${context}.`);
  }
  return uid;
}

function materialize(
  att: PlannedAttestation,
  resolved: ReadonlyMap<string, `0x${string}`>,
): { refUID: `0x${string}`; data: `0x${string}` } {
  const refUID = resolveRef(att.refUID, resolved, `${att.ref} refUID`);
  if (att.pinDefinitionRef === undefined) return { refUID, data: att.data };
  const definition = resolveRef(att.pinDefinitionRef, resolved, `${att.ref} PIN definition`);
  return {
    refUID,
    data: encodeAbiParameters(PIN_DEFINITION_PARAMS, [definition]),
  };
}

function buildLayerRequests(atts: readonly PlannedAttestation[], resolved: ReadonlyMap<string, `0x${string}`>) {
  const schemaOrder: `0x${string}`[] = [];
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
      schemaOrder.push(att.schema);
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

  return {
    requests: schemaOrder.map(schema => ({ schema, data: bySchema.get(schema)!.data })),
    flatRefs: schemaOrder.flatMap(schema => bySchema.get(schema)!.refs),
  };
}

function extractMintedUIDs(
  receipt: {
    logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
  },
  easAddress: `0x${string}`,
  expected: number,
): `0x${string}`[] {
  const easLower = easAddress.toLowerCase();
  const logs = parseEventLogs({
    abi: EAS_MULTIATTEST_ABI,
    eventName: "Attested",
    logs: receipt.logs as never,
  });
  const uids = logs.filter(log => log.address.toLowerCase() === easLower).map(log => log.args.uid as `0x${string}`);
  if (uids.length === expected) return uids;

  const manual: `0x${string}`[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== easLower) continue;
    try {
      const event = decodeEventLog({
        abi: EAS_MULTIATTEST_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (event.eventName === "Attested") manual.push(event.args.uid as `0x${string}`);
    } catch {
      // Not an EAS Attested log.
    }
  }
  if (manual.length === expected) return manual;

  throw new Error(`submitLayered: expected ${expected} Attested event(s) from EAS, found ${uids.length}.`);
}

export async function submitLayered(
  plan: readonly PlannedAttestation[],
  ctx: SubmitLayeredCtx,
): Promise<Map<string, `0x${string}`>> {
  const resolved = new Map<string, `0x${string}`>();
  const layers = [...new Set(plan.map(att => att.layer))].sort((a, b) => a - b);

  for (const layer of layers) {
    const layerAtts = plan.filter(att => att.layer === layer);
    if (layerAtts.length === 0) continue;

    if (ctx.isCancelled?.()) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: cancelled before layer ${layer}.`,
        undefined,
        true,
      );
    }

    const { requests, flatRefs } = buildLayerRequests(layerAtts, resolved);
    ctx.onBeforeLayer?.({ layer, refs: flatRefs });
    ctx.onProgress?.(
      `Submitting layer ${layer} (${flatRefs.length} attestation${flatRefs.length === 1 ? "" : "s"})...`,
    );

    let txHash: `0x${string}`;
    try {
      txHash = await ctx.walletClient.writeContract({
        address: ctx.easAddress,
        abi: EAS_MULTIATTEST_ABI,
        functionName: "multiAttest",
        args: [requests],
        value: 0n,
        account: ctx.account,
        ...(ctx.chain ? { chain: ctx.chain } : {}),
      });
    } catch (cause) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} was not sent (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }

    let receipt: Awaited<ReturnType<SubmitLayeredCtx["publicClient"]["waitForTransactionReceipt"]>>;
    try {
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (cause) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} was sent but not confirmed (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        txHash,
      );
    }
    if (receipt.status === "reverted") {
      throw new LayeredWriteError(layer, new Map(resolved), `submitLayered: layer ${layer} reverted.`, txHash);
    }

    let uids: `0x${string}`[];
    try {
      uids = extractMintedUIDs(receipt, ctx.easAddress, flatRefs.length);
    } catch (cause) {
      throw new LayeredWriteError(
        layer,
        new Map(resolved),
        `submitLayered: layer ${layer} was confirmed but UIDs could not be extracted (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        txHash,
      );
    }
    const minted = flatRefs.map((ref, index) => {
      const uid = uids[index]!;
      resolved.set(ref, uid);
      return { ref, uid };
    });
    ctx.onLayer?.({ layer, txHash, minted });
  }

  return resolved;
}
