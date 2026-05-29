"use client";

import { useEffect, useRef, useState } from "react";
import { QueueListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { encodeAbiParameters, keccak256, toHex, zeroAddress, zeroHash } from "viem";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const LIST_READER_ABI = [
  {
    inputs: [{ name: "listUID", type: "bytes32" }],
    name: "getMode",
    outputs: [{
      name: "m", type: "tuple",
      components: [
        { name: "exists", type: "bool" },
        { name: "curator", type: "address" },
        { name: "allowsDuplicates", type: "bool" },
        { name: "appendOnly", type: "bool" },
        { name: "targetType", type: "uint8" },
        { name: "targetSchema", type: "bytes32" },
        { name: "maxEntries", type: "uint32" },
      ],
    }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [{ name: "listUID", type: "bytes32" }, { name: "attester", type: "address" }],
    name: "length",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [{ name: "listUID", type: "bytes32" }, { name: "attester", type: "address" }, { name: "start", type: "uint256" }, { name: "len", type: "uint256" }],
    name: "entries",
    outputs: [{
      name: "", type: "tuple[]",
      components: [
        { name: "entryUID", type: "bytes32" },
        { name: "targetType", type: "uint8" },
        { name: "identityKey", type: "bytes32" },
        { name: "weight", type: "int256" },
      ],
    }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [],
    name: "LIST_ENTRY_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view", type: "function",
  },
] as const;

const EAS_ABI = [
  {
    inputs: [{ components: [{ name: "schema", type: "bytes32" }, { components: [{ name: "recipient", type: "address" }, { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" }, { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" }], name: "data", type: "tuple" }], name: "attest", type: "tuple" }],
    name: "attest", outputs: [{ name: "", type: "bytes32" }], stateMutability: "payable", type: "function",
  },
  {
    inputs: [{ components: [{ name: "schema", type: "bytes32" }, { components: [{ name: "uid", type: "bytes32" }, { name: "value", type: "uint256" }], name: "data", type: "tuple" }], name: "revocationRequest", type: "tuple" }],
    name: "revoke", outputs: [], stateMutability: "payable", type: "function",
  },
] as const;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Entry {
  entryUID: string;
  identityKey: string;
  weight: bigint;
}

interface ListPreviewPaneProps {
  uid: string;
  name: string;
  attester: string;
  onClose: () => void;
  connectedAddress?: `0x${string}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Short display for an address or bytes32 */
const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/**
 * For ANY-type lists we hash the text label → bytes32 so it fits the schema.
 * The mapping text↔hash is kept in memory; items added in earlier sessions
 * fall back to the short hex form.
 */
const labelToKey = (text: string): `0x${string}` => keccak256(toHex(text));

// ── Drag handle SVG ────────────────────────────────────────────────────────────

const DragHandle = () => (
  <svg className="w-4 h-4 text-base-content/25 flex-shrink-0 cursor-grab active:cursor-grabbing" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
    <circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" />
    <circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="12" r="1.5" />
  </svg>
);

// ── Component ──────────────────────────────────────────────────────────────────

export const ListPreviewPane = ({ uid, name, attester: _attester, onClose, connectedAddress }: ListPreviewPaneProps) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo({ contractName: "ListReader" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const easAddress = (easInfo as any)?.address as `0x${string}` | undefined;

  const lensAddress = connectedAddress ?? zeroAddress;
  const listUID = uid as `0x${string}`;

  const { data: mode } = useReadContract({
    address: listReaderAddress, abi: LIST_READER_ABI, functionName: "getMode",
    args: [listUID], query: { enabled: !!listReaderAddress },
  });
  const { data: rawEntries, refetch: refetchEntries } = useReadContract({
    address: listReaderAddress, abi: LIST_READER_ABI, functionName: "entries",
    args: [listUID, lensAddress, 0n, 50n], query: { enabled: !!listReaderAddress },
  });
  const { data: listEntrySchemaUID } = useReadContract({
    address: listReaderAddress, abi: LIST_READER_ABI, functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  // Pending tx
  const { writeContractAsync, isPending } = useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const { data: txReceipt } = useWaitForTransactionReceipt({ hash: pendingTxHash });
  useEffect(() => {
    if (txReceipt) { refetchEntries(); setPendingTxHash(undefined); }
  }, [txReceipt, refetchEntries]);

  const isBusy = isPending || !!pendingTxHash;
  const targetType = mode ? Number(mode.targetType) : 0;
  const isAddrList = targetType === 1;

  // Map: identityKey → human label (for ANY-type lists)
  const labelMapRef = useRef<Map<string, string>>(new Map());

  // Ordered entries for display — initialized from contract data, mutated by drag
  const [displayEntries, setDisplayEntries] = useState<Entry[]>([]);

  // Sync when chain data arrives, sorted by weight
  useEffect(() => {
    if (!rawEntries) return;
    const sorted = [...(rawEntries as unknown as Entry[])].sort((a, b) => {
      const wa = typeof a.weight === "bigint" ? a.weight : BigInt(String(a.weight));
      const wb = typeof b.weight === "bigint" ? b.weight : BigInt(String(b.weight));
      return wa < wb ? -1 : wa > wb ? 1 : 0;
    });
    setDisplayEntries(sorted);
  }, [rawEntries]);

  // Reset order when list changes
  useEffect(() => { setDisplayEntries([]); }, [uid]);

  // ── Drag-and-drop ────────────────────────────────────────────────────────────

  const dragSrcIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const onDragStart = (i: number) => { dragSrcIndex.current = i; };
  const onDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIndex(i); };
  const onDragLeave = () => setDragOverIndex(null);
  const onDrop = (e: React.DragEvent, destIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    const src = dragSrcIndex.current;
    if (src === null || src === destIndex) return;
    setDisplayEntries(prev => {
      const next = [...prev];
      const [moved] = next.splice(src, 1);
      next.splice(destIndex, 0, moved);
      return next;
    });
    dragSrcIndex.current = null;
  };
  const onDragEnd = () => { setDragOverIndex(null); dragSrcIndex.current = null; };

  // ── Display label for an entry ───────────────────────────────────────────────

  const getLabel = (entry: Entry): string => {
    if (isAddrList) {
      // ADDR list: identityKey encodes address
      try {
        const addr = `0x${entry.identityKey.slice(-40)}`;
        return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
      } catch { return shortHex(entry.identityKey); }
    }
    // ANY/SCHEMA list: look up in label map, fall back to short hex
    return labelMapRef.current.get(entry.identityKey) ?? shortHex(entry.identityKey);
  };

  // ── Add entry ────────────────────────────────────────────────────────────────

  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!listEntrySchemaUID || !easAddress || !inputValue.trim()) return;

    const text = inputValue.trim();
    let recipient: `0x${string}` = zeroAddress;
    let target: `0x${string}` = zeroHash as `0x${string}`;

    if (isAddrList) {
      if (!text.startsWith("0x") || text.length !== 42) {
        notification.error("Enter a valid Ethereum address (0x…)");
        return;
      }
      recipient = text as `0x${string}`;
    } else {
      // ANY/SCHEMA: hash the text to a deterministic bytes32 key
      const key = labelToKey(text);
      labelMapRef.current.set(key, text);
      target = key;
    }

    const data = encodeAbiParameters(
      [{ name: "listUID", type: "bytes32" }, { name: "target", type: "bytes32" }, { name: "weight", type: "int256" }],
      [listUID, target, 0n],
    );
    try {
      const tx = await writeContractAsync({
        address: easAddress, abi: EAS_ABI, functionName: "attest",
        args: [{ schema: listEntrySchemaUID, data: { recipient, expirationTime: 0n, revocable: true, refUID: zeroHash, data, value: 0n } }],
      });
      setPendingTxHash(tx);
      setInputValue("");
      inputRef.current?.focus();
    } catch (err: any) {
      notification.error(err?.shortMessage ?? err?.message ?? "Failed to add item");
    }
  };

  const handleRemove = async (entryUID: `0x${string}`) => {
    if (!listEntrySchemaUID || !easAddress) return;
    try {
      const tx = await writeContractAsync({
        address: easAddress, abi: EAS_ABI, functionName: "revoke",
        args: [{ schema: listEntrySchemaUID, data: { uid: entryUID, value: 0n } }],
      });
      setPendingTxHash(tx);
    } catch (err: any) {
      notification.error(err?.shortMessage ?? err?.message ?? "Failed to remove item");
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const canEdit = !!connectedAddress && !mode?.appendOnly;
  const placeholder = isAddrList ? "Add address (0x…)" : "Add item…";

  return (
    <div className="preview-pane absolute inset-0 z-10 max-lg:bg-base-200 lg:static lg:w-[360px] lg:flex-shrink-0 border-l border-base-300 flex flex-col overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <QueueListIcon className="w-4.5 h-4.5 text-purple-500 flex-shrink-0" />
          <h3 className="font-semibold text-sm truncate">{name}</h3>
          {displayEntries.length > 0 && (
            <span className="badge badge-sm badge-ghost opacity-60">{displayEntries.length}</span>
          )}
        </div>
        <button className="btn btn-ghost btn-xs btn-circle" onClick={onClose}>
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Append-only notice */}
      {mode?.appendOnly && (
        <div className="px-4 py-2 text-xs text-base-content/50 border-b border-base-300 shrink-0 flex items-center gap-1.5">
          <span>🔒</span> Read-only — entries cannot be removed
        </div>
      )}

      {/* Item list */}
      <div className="flex-1 overflow-y-auto">
        {displayEntries.length === 0 && mode?.exists && (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-base-content/30">
            <QueueListIcon className="w-8 h-8" />
            <span className="text-sm">No items yet</span>
          </div>
        )}

        <ul className="py-1">
          {displayEntries.map((entry, i) => (
            <li
              key={entry.entryUID}
              draggable={canEdit}
              onDragStart={() => onDragStart(i)}
              onDragOver={e => onDragOver(e, i)}
              onDragLeave={onDragLeave}
              onDrop={e => onDrop(e, i)}
              onDragEnd={onDragEnd}
              className={`flex items-center gap-2 px-3 py-2.5 group hover:bg-base-200 transition-colors
                ${dragOverIndex === i ? "border-t-2 border-primary" : "border-t border-transparent"}`}
            >
              {/* Drag handle — only shown when editable */}
              {canEdit ? (
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <DragHandle />
                </span>
              ) : (
                <span className="w-4 flex-shrink-0" />
              )}

              {/* Label */}
              <span className="flex-1 text-sm leading-snug break-all select-none">
                {getLabel(entry)}
              </span>

              {/* Remove button */}
              {canEdit && (
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-error hover:bg-error/10"
                  disabled={isBusy}
                  onClick={() => handleRemove(entry.entryUID as `0x${string}`)}
                  title="Remove"
                >
                  <XMarkIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Add item */}
      {canEdit && (
        <form
          onSubmit={handleAdd}
          className="px-3 py-3 border-t border-base-300 shrink-0 flex items-center gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            className="input input-sm flex-1 bg-base-200 border-transparent focus:border-base-300 focus:bg-base-100"
            placeholder={placeholder}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            disabled={isBusy}
            autoComplete="off"
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary btn-square"
            disabled={isBusy || !inputValue.trim()}
          >
            {isBusy
              ? <span className="loading loading-spinner loading-xs" />
              : <span className="text-lg leading-none">+</span>}
          </button>
        </form>
      )}

      {!connectedAddress && (
        <div className="px-4 py-2.5 border-t border-base-300 shrink-0 text-xs text-base-content/40">
          Connect wallet to add items
        </div>
      )}
    </div>
  );
};
