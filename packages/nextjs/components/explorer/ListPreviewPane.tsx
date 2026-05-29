"use client";

import { useEffect, useState } from "react";
import { QueueListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { encodeAbiParameters, zeroAddress, zeroHash } from "viem";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

const TARGET_TYPE_LABELS = ["Anything", "Addresses", "EFS Files"] as const;

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
    ],
    name: "length",
    outputs: [{ name: "", type: "uint256" }],
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

const EAS_ATTEST_ABI = [
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
            components: [{ name: "uid", type: "bytes32" }, { name: "value", type: "uint256" }],
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
] as const;

interface ListPreviewPaneProps {
  uid: string;
  name: string;
  attester: string;
  onClose: () => void;
  connectedAddress?: `0x${string}`;
}

export const ListPreviewPane = ({ uid, name, attester, onClose, connectedAddress }: ListPreviewPaneProps) => {
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
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "getMode",
    args: [listUID],
    query: { enabled: !!listReaderAddress },
  });

  const { data: listLen, refetch: refetchLen } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "length",
    args: [listUID, lensAddress],
    query: { enabled: !!listReaderAddress },
  });

  const { data: entries, refetch: refetchEntries } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "entries",
    args: [listUID, lensAddress, 0n, 50n],
    query: { enabled: !!listReaderAddress },
  });

  const { data: listEntrySchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  const { writeContractAsync, isPending } = useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const { data: txReceipt } = useWaitForTransactionReceipt({ hash: pendingTxHash });

  useEffect(() => {
    if (txReceipt) {
      refetchLen();
      refetchEntries();
      setPendingTxHash(undefined);
    }
  }, [txReceipt, refetchLen, refetchEntries]);

  // Add entry form
  const [entryTarget, setEntryTarget] = useState("");
  const [entryRecipient, setEntryRecipient] = useState("");
  const [entryWeight, setEntryWeight] = useState("0");

  const targetType = mode ? Number(mode.targetType) : 0;
  const isBusy = isPending || !!pendingTxHash;

  const handleAddEntry = async () => {
    if (!listEntrySchemaUID || !easAddress) {
      notification.error("Contracts not ready");
      return;
    }
    let recipient: `0x${string}` = zeroAddress;
    let target: `0x${string}` = zeroHash as `0x${string}`;
    let weight: bigint;
    try {
      weight = BigInt(entryWeight);
    } catch {
      notification.error("Weight must be a valid integer");
      return;
    }
    if (targetType === 1 /* ADDR */) {
      if (!entryRecipient.startsWith("0x") || entryRecipient.length !== 42) {
        notification.error("Enter a valid 0x address");
        return;
      }
      recipient = entryRecipient as `0x${string}`;
    } else {
      if (!entryTarget.startsWith("0x") || entryTarget.length !== 66) {
        notification.error("Target must be a 0x bytes32 (66 chars)");
        return;
      }
      target = entryTarget as `0x${string}`;
    }
    const data = encodeAbiParameters(
      [{ name: "listUID", type: "bytes32" }, { name: "target", type: "bytes32" }, { name: "weight", type: "int256" }],
      [listUID, target, weight],
    );
    try {
      const tx = await writeContractAsync({
        address: easAddress,
        abi: EAS_ATTEST_ABI,
        functionName: "attest",
        args: [{ schema: listEntrySchemaUID, data: { recipient, expirationTime: 0n, revocable: true, refUID: zeroHash, data, value: 0n } }],
      });
      notification.success("Entry submitted…");
      setPendingTxHash(tx);
      setEntryTarget("");
      setEntryRecipient("");
      setEntryWeight("0");
    } catch (e: any) {
      notification.error(e?.shortMessage ?? e?.message ?? "Transaction failed");
    }
  };

  const handleRemove = async (entryUID: `0x${string}`) => {
    if (!listEntrySchemaUID || !easAddress) return;
    try {
      const tx = await writeContractAsync({
        address: easAddress,
        abi: EAS_ATTEST_ABI,
        functionName: "revoke",
        args: [{ schema: listEntrySchemaUID, data: { uid: entryUID, value: 0n } }],
      });
      notification.success("Revoke submitted…");
      setPendingTxHash(tx);
    } catch (e: any) {
      notification.error(e?.shortMessage ?? e?.message ?? "Revoke failed");
    }
  };

  const shortHex = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

  return (
    <div className="preview-pane absolute inset-0 z-10 max-lg:bg-base-200 lg:static lg:w-[400px] lg:flex-shrink-0 border-l border-base-300 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <QueueListIcon className="w-5 h-5 text-purple-500 flex-shrink-0" />
          <h3 className="font-bold text-sm truncate">{name}</h3>
        </div>
        <button className="btn btn-ghost btn-sm btn-circle" onClick={onClose} title="Close">
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-0 divide-y divide-base-300">
        {/* Mode metadata */}
        {mode?.exists && (
          <div className="px-4 py-3 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <span className="opacity-60">Type</span>
              <span className="badge badge-sm badge-outline">{TARGET_TYPE_LABELS[targetType] ?? "?"}</span>
              <span className="opacity-60">Curator</span>
              <span className="font-mono text-xs truncate" title={attester}>{shortHex(attester)}</span>
              <span className="opacity-60">Entries (your lens)</span>
              <span>{listLen?.toString() ?? "…"}</span>
              {mode.maxEntries > 0 && (
                <>
                  <span className="opacity-60">Cap</span>
                  <span>{mode.maxEntries.toString()}</span>
                </>
              )}
              {mode.allowsDuplicates && (
                <>
                  <span className="opacity-60">Duplicates</span>
                  <span>allowed</span>
                </>
              )}
            </div>
            {mode.appendOnly && (
              <div className="text-xs text-info flex items-center gap-1 mt-1">
                🔒 Append-only — entries cannot be removed
              </div>
            )}
          </div>
        )}

        {!mode?.exists && listReaderAddress && (
          <div className="px-4 py-4 text-sm text-warning">List not found — wrong UID or schema mismatch.</div>
        )}

        {/* Entries */}
        {entries && entries.length > 0 && (
          <div className="px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-50 mb-2">
              Entries ({entries.length}{Number(listLen ?? 0) > 50 ? "+" : ""})
            </div>
            <div className="overflow-x-auto">
              <table className="table table-xs w-full">
                <thead>
                  <tr>
                    <th>Identity key</th>
                    <th>Weight</th>
                    {!mode?.appendOnly && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {(entries as any[]).map((e: any) => (
                    <tr key={e.entryUID} className="hover">
                      <td className="font-mono text-xs" title={e.identityKey}>
                        {shortHex(e.identityKey)}
                      </td>
                      <td>{e.weight.toString()}</td>
                      {!mode?.appendOnly && (
                        <td>
                          <button
                            className="btn btn-xs btn-error btn-outline"
                            disabled={isBusy || !connectedAddress}
                            onClick={() => handleRemove(e.entryUID as `0x${string}`)}
                            title="Remove entry"
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {entries && entries.length === 0 && mode?.exists && (
          <div className="px-4 py-3 text-sm opacity-50">No entries in your lens yet.</div>
        )}

        {/* Add entry form */}
        {mode?.exists && connectedAddress && (
          <div className="px-4 py-3 flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-50">Add entry</div>

            {targetType === 1 ? (
              <div className="form-control">
                <label className="label py-0.5">
                  <span className="label-text text-xs">Address (recipient)</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered input-sm font-mono text-xs"
                  placeholder="0x…"
                  value={entryRecipient}
                  onChange={e => setEntryRecipient(e.target.value)}
                  disabled={isBusy}
                />
              </div>
            ) : (
              <div className="form-control">
                <label className="label py-0.5">
                  <span className="label-text text-xs">
                    {targetType === 2 ? "Attestation UID (bytes32)" : "Key (bytes32)"}
                  </span>
                </label>
                <input
                  type="text"
                  className="input input-bordered input-sm font-mono text-xs"
                  placeholder="0x…"
                  value={entryTarget}
                  onChange={e => setEntryTarget(e.target.value)}
                  disabled={isBusy}
                />
              </div>
            )}

            <div className="flex gap-2 items-end">
              <div className="form-control flex-1">
                <label className="label py-0.5">
                  <span className="label-text text-xs">Weight (int256)</span>
                </label>
                <input
                  type="number"
                  className="input input-bordered input-sm"
                  value={entryWeight}
                  onChange={e => setEntryWeight(e.target.value)}
                  disabled={isBusy}
                />
              </div>
              <button
                className="btn btn-sm btn-primary"
                disabled={isBusy}
                onClick={handleAddEntry}
              >
                {isBusy ? <span className="loading loading-spinner loading-xs" /> : "Add"}
              </button>
            </div>
          </div>
        )}

        {!connectedAddress && mode?.exists && (
          <div className="px-4 py-3 text-xs opacity-50">Connect wallet to add entries.</div>
        )}
      </div>
    </div>
  );
};
