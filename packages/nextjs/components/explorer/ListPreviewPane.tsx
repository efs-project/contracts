"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { encodeAbiParameters, zeroAddress, zeroHash } from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  PencilSquareIcon,
  PlusIcon,
  QueueListIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Address, AddressInput } from "~~/components/scaffold-eth";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { notification } from "~~/utils/scaffold-eth";

// ── ABIs ────────────────────────────────────────────────────────────────────

const LIST_READER_ABI = [
  {
    inputs: [{ name: "listUID", type: "bytes32" }],
    name: "getMode",
    outputs: [
      {
        name: "m",
        type: "tuple",
        components: [
          { name: "exists", type: "bool" },
          { name: "curator", type: "address" },
          { name: "allowsDuplicates", type: "bool" },
          { name: "appendOnly", type: "bool" },
          { name: "targetType", type: "uint8" },
          { name: "targetSchema", type: "bytes32" },
          { name: "maxEntries", type: "uint32" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "listUID", type: "bytes32" },
      { name: "attester", type: "address" },
      { name: "start", type: "uint256" },
      { name: "len", type: "uint256" },
    ],
    name: "entries",
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "entryUID", type: "bytes32" },
          { name: "targetType", type: "uint8" },
          { name: "identityKey", type: "bytes32" },
          { name: "weight", type: "int256" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "LIST_ENTRY_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "schema", type: "bytes32" },
          {
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
            name: "data",
            type: "tuple",
          },
        ],
        name: "attest",
        type: "tuple",
      },
    ],
    name: "attest",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "schema", type: "bytes32" },
          {
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" },
            ],
            name: "data",
            type: "tuple",
          },
        ],
        name: "revocationRequest",
        type: "tuple",
      },
    ],
    name: "revoke",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── Constants ───────────────────────────────────────────────────────────────

const MODE = { ANY: 0, ADDR: 1, SCHEMA: 2 } as const;
const RANK_STEP = 1_000_000n;
const MAX_ITEM_BYTES = 31; // bytes32 string idiom (one byte reserved as a trailing terminator)

const MODE_META: Record<number, { noun: string; verb: string; placeholder: string; blurb: string }> = {
  0: {
    noun: "items",
    verb: "Add item",
    placeholder: "Add an item…",
    blurb: "A free-text list — groceries, todos, anything.",
  },
  1: {
    noun: "addresses",
    verb: "Add address",
    placeholder: "0x… or name.eth",
    blurb: "A ranked roster of Ethereum addresses.",
  },
  2: {
    noun: "attestations",
    verb: "Add attestation",
    placeholder: "Attestation UID (0x…)",
    blurb: "A curated set of attestations of one schema.",
  },
};

// ── Encoding helpers ──────────────────────────────────────────────────────────

const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Pack a short UTF-8 string into a right-padded bytes32 (Solidity string idiom). */
function packText(text: string): `0x${string}` {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) throw new Error("Item cannot be empty");
  if (bytes.length > MAX_ITEM_BYTES) throw new Error(`Item too long (max ${MAX_ITEM_BYTES} bytes)`);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return ("0x" + hex.padEnd(64, "0")) as `0x${string}`;
}

/** Decode a packed bytes32 back to text, or null if it isn't printable text (legacy/opaque key). */
function unpackText(key: string): string | null {
  const hex = key.slice(2).replace(/(00)+$/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Reject any control char (C0 minus tab/newline, or DEL) ⇒ legacy keccak/opaque key, not text
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) return null;
    }
    return text;
  } catch {
    return null;
  }
}

const addrFromKey = (key: string): `0x${string}` => ("0x" + key.slice(-40)) as `0x${string}`;
const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const toBig = (w: unknown) => (typeof w === "bigint" ? w : BigInt(String(w)));

// ── Types ─────────────────────────────────────────────────────────────────────

interface Entry {
  entryUID: `0x${string}`;
  targetType: number;
  identityKey: `0x${string}`;
  weight: bigint;
}
interface Props {
  uid: string;
  name: string;
  attester: string;
  onClose: () => void;
  connectedAddress?: `0x${string}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const DragDots = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="5" cy="4" r="1.4" />
    <circle cx="11" cy="4" r="1.4" />
    <circle cx="5" cy="8" r="1.4" />
    <circle cx="11" cy="8" r="1.4" />
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="11" cy="12" r="1.4" />
  </svg>
);

/** A SCHEMA-mode row: fetch the target attestation and summarize it. */
const AttestationLabel = ({ uid, easAddress }: { uid: `0x${string}`; easAddress?: `0x${string}` }) => {
  const { data: att } = useReadContract({
    address: easAddress,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [uid],
    query: { enabled: !!easAddress },
  });
  const revoked = att && toBig(att.revocationTime) > 0n;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="font-mono text-xs truncate">{shortHex(uid)}</span>
      {att && att.attester !== zeroAddress ? (
        <span className="flex items-center gap-1 text-[10px] text-base-content/45">
          <span className="badge badge-ghost badge-xs font-mono">{shortHex(att.schema)}</span>
          {revoked && <span className="text-error">revoked</span>}
        </span>
      ) : (
        <span className="text-[10px] text-base-content/30">not found on this chain</span>
      )}
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const ListPreviewPane = ({ uid, name, attester: listAttester, onClose, connectedAddress }: Props) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo({ contractName: "ListReader" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const easAddress = (easInfo as any)?.address as `0x${string}` | undefined;

  const publicClient = usePublicClient();
  const ops = useBackgroundOps();
  const { writeContractAsync } = useWriteContract();

  const listUID = uid as `0x${string}`;
  const lens = connectedAddress ?? zeroAddress;

  const { data: mode } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "getMode",
    args: [listUID],
    query: { enabled: !!listReaderAddress },
  });
  const { data: rawEntries, refetch: refetchEntries } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "entries",
    args: [listUID, lens, 0n, 100n],
    query: { enabled: !!listReaderAddress },
  });
  const { data: entrySchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  const targetType = mode ? Number(mode.targetType) : MODE.ANY;
  const meta = MODE_META[targetType] ?? MODE_META[0];
  const curator = mode?.exists ? mode.curator : (listAttester as `0x${string}`);
  const canEdit = !!connectedAddress && !mode?.appendOnly;

  // Display order — synced from chain (sorted by weight asc), mutated optimistically.
  const [items, setItems] = useState<Entry[]>([]);
  const sortedFromChain = useMemo(() => {
    if (!rawEntries) return [];
    return [...(rawEntries as unknown as Entry[])]
      .map(e => ({ ...e, weight: toBig(e.weight) }))
      .sort((a, b) => (a.weight < b.weight ? -1 : a.weight > b.weight ? 1 : a.entryUID < b.entryUID ? -1 : 1));
  }, [rawEntries]);
  useEffect(() => setItems(sortedFromChain), [sortedFromChain]);
  useEffect(() => setItems([]), [uid]);

  const [busy, setBusy] = useState(false);

  // ── On-chain primitives ─────────────────────────────────────────────────────

  const encodeEntry = (target: `0x${string}`, weight: bigint) =>
    encodeAbiParameters(
      [
        { name: "listUID", type: "bytes32" },
        { name: "target", type: "bytes32" },
        { name: "weight", type: "int256" },
      ],
      [listUID, target, weight],
    );

  /** Reconstruct the recipient/target for an entry from its identity + mode. */
  const entryFields = (e: Pick<Entry, "targetType" | "identityKey">) => {
    if (e.targetType === MODE.ADDR) return { recipient: addrFromKey(e.identityKey), target: zeroHash as `0x${string}` };
    return { recipient: zeroAddress, target: e.identityKey };
  };

  const attestEntry = async (recipient: `0x${string}`, target: `0x${string}`, weight: bigint) => {
    const hash = await writeContractAsync({
      address: easAddress!,
      abi: EAS_ABI,
      functionName: "attest",
      args: [
        {
          schema: entrySchemaUID as `0x${string}`,
          data: {
            recipient,
            expirationTime: 0n,
            revocable: true,
            refUID: zeroHash,
            data: encodeEntry(target, weight),
            value: 0n,
          },
        },
      ],
    });
    await publicClient!.waitForTransactionReceipt({ hash });
    return hash;
  };

  const revokeEntry = async (e: Entry) => {
    const hash = await writeContractAsync({
      address: easAddress!,
      abi: EAS_ABI,
      functionName: "revoke",
      args: [{ schema: entrySchemaUID as `0x${string}`, data: { uid: e.entryUID, value: 0n } }],
    });
    await publicClient!.waitForTransactionReceipt({ hash });
    return hash;
  };

  const ready = !!easAddress && !!entrySchemaUID && !!publicClient;

  // ── Add ───────────────────────────────────────────────────────────────────

  const [draft, setDraft] = useState("");
  const draftBytes = targetType === MODE.ANY ? byteLen(draft) : 0;
  const draftTooLong = targetType === MODE.ANY && draftBytes > MAX_ITEM_BYTES;

  // SCHEMA mode: validate the pasted attestation UID against the list's required schema
  // BEFORE the user pays gas. Saves a guaranteed-to-revert transaction.
  const schemaDraftIsUID = targetType === MODE.SCHEMA && draft.trim().startsWith("0x") && draft.trim().length === 66;
  const { data: draftAtt } = useReadContract({
    address: easAddress,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [draft.trim() as `0x${string}`],
    query: { enabled: schemaDraftIsUID && !!easAddress },
  });
  const draftAttExists = !!draftAtt && draftAtt.attester !== zeroAddress;
  const requiredSchema = mode?.targetSchema;
  const draftSchemaMatches =
    draftAttExists &&
    (!requiredSchema || requiredSchema === zeroHash || draftAtt.schema.toLowerCase() === requiredSchema.toLowerCase());
  const schemaAddBlocked =
    targetType === MODE.SCHEMA && schemaDraftIsUID && draftAtt !== undefined && !draftSchemaMatches;

  const nextWeight = () => (items.length ? items[items.length - 1].weight + RANK_STEP : RANK_STEP);

  const handleAdd = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || !draft.trim() || busy) return;
    let recipient = zeroAddress as `0x${string}`;
    let target = zeroHash as `0x${string}`;
    try {
      if (targetType === MODE.ADDR) {
        const v = draft.trim();
        if (!v.startsWith("0x") || v.length !== 42) return notification.error("Enter a resolved 0x address");
        recipient = v as `0x${string}`;
      } else if (targetType === MODE.SCHEMA) {
        const v = draft.trim();
        if (!v.startsWith("0x") || v.length !== 66) return notification.error("Enter an attestation UID (0x + 64 hex)");
        target = v as `0x${string}`;
      } else {
        target = packText(draft.trim());
      }
    } catch (err: any) {
      return notification.error(err?.message ?? "Invalid item");
    }

    const opId = ops.start(`Add ${meta.noun.replace(/s$/, "")} to “${name}”`);
    setBusy(true);
    try {
      await attestEntry(recipient, target, nextWeight());
      ops.complete(opId, "Added");
      setDraft("");
      await refetchEntries();
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Failed to add";
      ops.fail(opId, msg);
      notification.error(/DuplicateIdentity/.test(msg) ? "That item is already in the list" : msg);
    } finally {
      setBusy(false);
    }
  };

  // ── Remove ──────────────────────────────────────────────────────────────────

  const handleRemove = async (entry: Entry) => {
    if (!ready || busy) return;
    const opId = ops.start(`Remove from “${name}”`);
    setBusy(true);
    setItems(prev => prev.filter(e => e.entryUID !== entry.entryUID)); // optimistic
    try {
      await revokeEntry(entry);
      ops.complete(opId, "Removed");
      await refetchEntries();
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed to remove");
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Edit (ANY text — revoke + re-attest, same rank) ──────────────────────────

  const [editingUID, setEditingUID] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const startEdit = (e: Entry, current: string) => {
    setEditingUID(e.entryUID);
    setEditValue(current);
  };
  const cancelEdit = () => {
    setEditingUID(null);
    setEditValue("");
  };

  const handleEditSave = async (entry: Entry) => {
    if (!ready || busy) return;
    const next = editValue.trim();
    const current = unpackText(entry.identityKey) ?? "";
    if (!next || next === current) return cancelEdit();
    let target: `0x${string}`;
    try {
      target = packText(next);
    } catch (err: any) {
      return notification.error(err?.message ?? "Invalid item");
    }
    const opId = ops.start(`Edit item in “${name}”`);
    setBusy(true);
    cancelEdit();
    try {
      await revokeEntry(entry);
      await attestEntry(zeroAddress, target, entry.weight); // keep rank
      ops.complete(opId, "Saved");
      await refetchEntries();
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed to edit");
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Reorder (drag → revoke + re-attest moved item with midpoint weight) ──────

  const dragSrc = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const handleDrop = async (destIndex: number) => {
    const src = dragSrc.current;
    dragSrc.current = null;
    setDragOver(null);
    if (src === null || src === destIndex || !ready || busy) return;

    // The drop indicator is a line at the TOP of the hovered row → "insert above row destIndex".
    // After removing src, every index above destIndex shifts down by one, so when dragging
    // downward (src < destIndex) the insertion point is destIndex - 1.
    const insertAt = src < destIndex ? destIndex - 1 : destIndex;
    const reordered = [...items];
    const [moved] = reordered.splice(src, 1);
    reordered.splice(insertAt, 0, moved);
    setItems(reordered); // optimistic

    const left = reordered[insertAt - 1]?.weight;
    const right = reordered[insertAt + 1]?.weight;
    let newWeight: bigint;
    if (left === undefined) newWeight = (right ?? 0n) - RANK_STEP;
    else if (right === undefined) newWeight = left + RANK_STEP;
    else newWeight = (left + right) / 2n;

    const opId = ops.start(`Reorder “${name}”`);
    setBusy(true);
    try {
      ops.log(opId, "Clearing old position…");
      await revokeEntry(moved);
      ops.log(opId, "Writing new position…");
      const { recipient, target } = entryFields(moved);
      await attestEntry(recipient, target, newWeight);
      ops.complete(opId, "Reordered");
      await refetchEntries();
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed to reorder");
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderContent = (e: Entry) => {
    if (e.targetType === MODE.ADDR) {
      return <Address address={addrFromKey(e.identityKey)} size="sm" onlyEnsOrAddress />;
    }
    if (e.targetType === MODE.SCHEMA) {
      return <AttestationLabel uid={e.identityKey} easAddress={easAddress} />;
    }
    const text = unpackText(e.identityKey);
    if (editingUID === e.entryUID) {
      return (
        <input
          autoFocus
          className="input input-xs w-full bg-base-100 border-primary/40"
          value={editValue}
          maxLength={64}
          onChange={ev => setEditValue(ev.target.value)}
          onKeyDown={ev => {
            if (ev.key === "Enter") handleEditSave(e);
            if (ev.key === "Escape") cancelEdit();
          }}
          onBlur={() => handleEditSave(e)}
        />
      );
    }
    return text !== null ? (
      <span className="text-sm leading-snug break-words">{text}</span>
    ) : (
      <span className="font-mono text-xs text-base-content/50" title="Opaque key (not text)">
        {shortHex(e.identityKey)}
      </span>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="preview-pane absolute inset-0 z-10 max-lg:bg-base-200 lg:static lg:w-[380px] lg:flex-shrink-0 flex flex-col overflow-hidden border-l border-base-300 bg-gradient-to-b from-base-100 to-base-200/40">
      {/* Purple spine */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b from-purple-500/80 via-purple-500/30 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-base-300">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="mt-0.5 w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center flex-shrink-0">
              <QueueListIcon className="w-4.5 h-4.5 text-purple-400" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-base leading-tight truncate tracking-tight">{name}</h3>
              <p className="text-[11px] text-base-content/45 leading-tight mt-0.5">{meta.blurb}</p>
            </div>
          </div>
          <button className="btn btn-ghost btn-xs btn-circle -mr-1 -mt-1" onClick={onClose}>
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-base-content/40">
          <span className="font-medium text-base-content/60">{items.length}</span>
          <span>{meta.noun}</span>
          {mode?.maxEntries ? <span>· cap {mode.maxEntries}</span> : null}
          {mode?.appendOnly ? <span className="text-amber-500/80">· 🔒 append-only</span> : null}
          {curator && (
            <span className="ml-auto flex items-center gap-1">
              by <Address address={curator} size="xs" onlyEnsOrAddress disableAddressLink />
            </span>
          )}
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {mode && !mode.exists && (
          <div className="px-4 py-6 text-sm text-warning">List not found — wrong UID or schema.</div>
        )}

        {mode?.exists && items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-base-content/25 px-6 text-center">
            <QueueListIcon className="w-10 h-10" />
            <span className="text-sm">
              {canEdit ? `Empty — add your first ${meta.noun.replace(/s$/, "")} below` : "No items yet"}
            </span>
          </div>
        )}

        <ul className="py-1">
          {items.map((e, i) => {
            const top3 = i < 3;
            return (
              <li
                key={e.entryUID}
                draggable={canEdit && editingUID !== e.entryUID}
                onDragStart={() => (dragSrc.current = i)}
                onDragOver={ev => {
                  ev.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver(d => (d === i ? null : d))}
                onDrop={() => handleDrop(i)}
                onDragEnd={() => {
                  dragSrc.current = null;
                  setDragOver(null);
                }}
                className={[
                  "group flex items-center gap-2.5 pl-3 pr-2 py-2 transition-colors",
                  dragOver === i ? "shadow-[inset_0_2px_0_0_theme(colors.purple.500)]" : "",
                  "hover:bg-base-content/[0.04]",
                  dragSrc.current === i ? "opacity-40" : "",
                ].join(" ")}
              >
                {/* Rank + drag handle (handle overlays rank on hover) */}
                <div className="relative w-6 flex-shrink-0 flex items-center justify-center">
                  <span
                    className={`tabular-nums text-xs font-medium transition-opacity ${canEdit ? "group-hover:opacity-0" : ""} ${top3 ? "text-purple-400" : "text-base-content/35"}`}
                  >
                    {i + 1}
                  </span>
                  {canEdit && (
                    <span
                      className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 text-base-content/30 cursor-grab active:cursor-grabbing"
                      title="Drag to reorder (writes on-chain)"
                    >
                      <DragDots />
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">{renderContent(e)}</div>

                {/* Row actions */}
                {canEdit && editingUID !== e.entryUID && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    {e.targetType === MODE.ANY && unpackText(e.identityKey) !== null && (
                      <button
                        className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
                        disabled={busy}
                        onClick={() => startEdit(e, unpackText(e.identityKey) ?? "")}
                        title="Edit"
                      >
                        <PencilSquareIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {e.targetType === MODE.SCHEMA && (
                      <a
                        className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
                        href={`/easexplorer?uid=${e.identityKey}`}
                        target="_blank"
                        rel="noreferrer"
                        title="View attestation"
                      >
                        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button
                      className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
                      disabled={busy}
                      onClick={() => handleRemove(e)}
                      title="Remove"
                    >
                      <XMarkIcon className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {editingUID === e.entryUID && (
                  <button
                    className="btn btn-ghost btn-xs btn-square text-success flex-shrink-0"
                    onMouseDown={ev => ev.preventDefault()}
                    onClick={() => handleEditSave(e)}
                    title="Save"
                  >
                    <CheckIcon className="w-4 h-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Add bar */}
      {canEdit && mode?.exists && (
        <form onSubmit={handleAdd} className="shrink-0 border-t border-base-300 p-3 bg-base-100/60">
          {targetType === MODE.ADDR ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <AddressInput value={draft} onChange={setDraft} placeholder={meta.placeholder} disabled={busy} />
              </div>
              <button
                type="submit"
                className="btn btn-sm btn-primary btn-square flex-shrink-0"
                disabled={busy || !draft.trim()}
              >
                {busy ? <span className="loading loading-spinner loading-xs" /> : <PlusIcon className="w-4 h-4" />}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  className={`input input-sm w-full bg-base-200 border-transparent focus:bg-base-100 ${draftTooLong ? "border-error focus:border-error" : "focus:border-base-300"} ${targetType === MODE.SCHEMA ? "font-mono text-xs" : ""}`}
                  placeholder={meta.placeholder}
                  value={draft}
                  onChange={ev => setDraft(ev.target.value)}
                  disabled={busy}
                  autoComplete="off"
                />
                {targetType === MODE.ANY && draft.length > 0 && (
                  <span
                    className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] tabular-nums ${draftTooLong ? "text-error" : "text-base-content/35"}`}
                  >
                    {draftBytes}/{MAX_ITEM_BYTES}
                  </span>
                )}
              </div>
              <button
                type="submit"
                className="btn btn-sm btn-primary btn-square flex-shrink-0"
                disabled={busy || !draft.trim() || draftTooLong || schemaAddBlocked}
              >
                {busy ? <span className="loading loading-spinner loading-xs" /> : <PlusIcon className="w-4 h-4" />}
              </button>
            </div>
          )}
          {targetType === MODE.ANY && draftTooLong && (
            <p className="text-[10px] text-error mt-1.5">
              Too long for on-chain storage. Keep it under {MAX_ITEM_BYTES} bytes.
            </p>
          )}
          {targetType === MODE.SCHEMA && schemaDraftIsUID && (
            <p className="text-[10px] mt-1.5 flex items-center gap-1">
              {draftAtt === undefined ? (
                <span className="text-base-content/40">Checking attestation…</span>
              ) : !draftAttExists ? (
                <span className="text-error">No attestation with that UID on this chain.</span>
              ) : !draftSchemaMatches ? (
                <span className="text-error">
                  Wrong schema — this list only accepts {shortHex(requiredSchema ?? zeroHash)}.
                </span>
              ) : (
                <span className="text-success flex items-center gap-1">
                  <CheckIcon className="w-3 h-3" /> Matches the list schema.
                </span>
              )}
            </p>
          )}
        </form>
      )}

      {!connectedAddress && (
        <div className="shrink-0 border-t border-base-300 px-4 py-3 text-xs text-base-content/40">
          Connect a wallet to edit this list.
        </div>
      )}
    </div>
  );
};
