"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { encodeAbiParameters, zeroAddress, zeroHash } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

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
        name: "revocationRequest",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    name: "revoke",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

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

const TARGET_TYPE_LABELS = ["ANY", "ADDR", "SCHEMA"];

export default function ListDetailPage() {
  const pathname = usePathname();
  const listUID = pathname?.split("/").filter(Boolean).pop() as `0x${string}` | undefined;

  const { address: connectedAddress } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo("ListReader" as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;

  // Use the deployed EAS contract address (matches the fork — no hardcoding).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: easInfo } = useDeployedContractInfo("EAS" as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const easAddress = (easInfo as any)?.address as `0x${string}` | undefined;

  const lensAddress = connectedAddress ?? zeroAddress;

  const { data: mode } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "getMode",
    args: listUID ? [listUID] : undefined,
    query: { enabled: !!listReaderAddress && !!listUID },
  });

  const { data: listLen, refetch: refetchLength } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "length",
    args: listUID ? [listUID, lensAddress] : undefined,
    query: { enabled: !!listReaderAddress && !!listUID },
  });

  // Paginate ALL entries. A single `entries` read is bounded by its `len` arg, and lists may
  // be uncapped or capped above one page — a fixed [0, 50) window silently hid (and made
  // unremovable) every entry past the 50th. Loop the reader cursor until a short page, mirroring
  // ListPreviewPane.refetchEntries, with a safety bound for the debug UI.
  type EntryRow = { entryUID: `0x${string}`; identityKey: `0x${string}` };
  const publicClient = usePublicClient();
  const [entries, setEntries] = useState<readonly EntryRow[] | undefined>(undefined);
  const refetchEntries = useCallback(async () => {
    if (!publicClient || !listReaderAddress || !listUID) return;
    const PAGE = 200n;
    const SAFETY = 10000; // far beyond any hand-curated list; bounds a runaway read
    const all: EntryRow[] = [];
    try {
      for (let start = 0n; ; start += PAGE) {
        const page = (await publicClient.readContract({
          address: listReaderAddress,
          abi: LIST_READER_ABI,
          functionName: "entries",
          args: [listUID, lensAddress, start, PAGE],
        })) as unknown as EntryRow[];
        all.push(...page);
        if (BigInt(page.length) < PAGE || all.length >= SAFETY) break;
      }
      setEntries(all);
    } catch (e) {
      console.error("[lists] failed to read entries", e);
    }
  }, [publicClient, listReaderAddress, listUID, lensAddress]);
  useEffect(() => {
    void refetchEntries();
  }, [refetchEntries]);

  const { data: listEntrySchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  // Pending tx hash — watched by useWaitForTransactionReceipt to trigger refetch.
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const { data: txReceipt } = useWaitForTransactionReceipt({ hash: pendingTxHash });

  // Refetch both length and entries once the pending tx confirms.
  useEffect(() => {
    if (txReceipt) {
      refetchLength();
      refetchEntries();
      setPendingTxHash(undefined);
    }
  }, [txReceipt, refetchLength, refetchEntries]);

  // ADD ENTRY form
  const [entryTarget, setEntryTarget] = useState("");
  const [entryRecipient, setEntryRecipient] = useState("");

  const targetType = mode ? Number(mode.targetType) : 0;

  const handleAddEntry = async () => {
    if (!listUID || !listEntrySchemaUID || !easAddress) {
      notification.error("List UID, schema, or EAS address not available");
      return;
    }

    let recipient: `0x${string}` = zeroAddress;
    let target: `0x${string}` = zeroHash as `0x${string}`;

    if (targetType === 1 /* ADDR */) {
      if (!entryRecipient.startsWith("0x")) {
        notification.error("ADDR mode requires a valid address");
        return;
      }
      recipient = entryRecipient as `0x${string}`;
    } else {
      if (!entryTarget.startsWith("0x")) {
        notification.error("Target must be a 0x bytes32");
        return;
      }
      target = entryTarget as `0x${string}`;
    }

    // ADR-0046: LIST_ENTRY is pure identity (listUID, target) — no weight field.
    // Order/labels are PROPERTYs on the entry UID (managed in the explorer's
    // ListPreviewPane); this low-level page just adds/removes membership.
    const data = encodeAbiParameters(
      [
        { name: "listUID", type: "bytes32" },
        { name: "target", type: "bytes32" },
      ],
      [listUID, target],
    );

    try {
      const tx = await writeContractAsync({
        address: easAddress,
        abi: EAS_ABI,
        functionName: "attest",
        args: [
          {
            schema: listEntrySchemaUID,
            data: {
              recipient: recipient,
              expirationTime: 0n,
              revocable: true,
              refUID: zeroHash,
              data,
              value: 0n,
            },
          },
        ],
      });
      notification.success("Entry submitted — waiting for confirmation…");
      setPendingTxHash(tx);
      setEntryTarget("");
      setEntryRecipient("");
    } catch (e) {
      console.error(e);
      notification.error("Failed to add entry. Check console.");
    }
  };

  const handleRemoveEntry = async (entryUID: `0x${string}`) => {
    if (!listEntrySchemaUID || !easAddress) return;
    try {
      const tx = await writeContractAsync({
        address: easAddress,
        abi: EAS_ABI,
        functionName: "revoke",
        args: [{ schema: listEntrySchemaUID, data: { uid: entryUID, value: 0n } }],
      });
      notification.success("Revoke submitted — waiting for confirmation…");
      setPendingTxHash(tx);
    } catch (e) {
      console.error(e);
      notification.error("Revoke failed. Check console.");
    }
  };

  if (!listUID) {
    return <div className="flex justify-center p-10">Loading…</div>;
  }

  if (!listReaderAddress) {
    return (
      <div className="flex justify-center p-10 flex-col items-center gap-4">
        <div className="text-warning">ListReader not deployed. Run `yarn deploy` first.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-8 gap-6 px-4">
      <h1 className="text-3xl font-bold">List Detail</h1>

      <div className="text-xs font-mono opacity-50 break-all text-center max-w-xl">{listUID}</div>

      {/* MODE INFO */}
      {mode && (
        <div className="card w-full max-w-xl bg-base-100 shadow border border-base-200">
          <div className="card-body">
            <h2 className="card-title text-lg">Mode</h2>
            {!mode.exists ? (
              <div className="text-error">List not found (wrong UID or schema)</div>
            ) : (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="opacity-60">Curator</div>
                <div className="font-mono text-xs break-all">{mode.curator}</div>
                <div className="opacity-60">Target Type</div>
                <div className="badge badge-outline">{TARGET_TYPE_LABELS[Number(mode.targetType)] ?? "?"}</div>
                <div className="opacity-60">Allows Duplicates</div>
                <div>{mode.allowsDuplicates ? "✓" : "✗"}</div>
                <div className="opacity-60">Append Only</div>
                <div>{mode.appendOnly ? "✓" : "✗"}</div>
                <div className="opacity-60">Max Entries</div>
                <div>{mode.maxEntries === 0 ? "unlimited" : mode.maxEntries.toString()}</div>
                {mode.targetSchema !== zeroHash && (
                  <>
                    <div className="opacity-60">Target Schema</div>
                    <div className="font-mono text-xs break-all">{mode.targetSchema}</div>
                  </>
                )}
                <div className="opacity-60">Length (your lens)</div>
                <div>{listLen?.toString() ?? "—"}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* APPEND-ONLY BANNER */}
      {mode?.appendOnly && (
        <div className="alert alert-info w-full max-w-xl text-sm py-2">
          🔒 Append-only — entries cannot be removed once added.
        </div>
      )}

      {/* ENTRIES */}
      {entries && entries.length > 0 && (
        <div className="card w-full max-w-xl bg-base-100 shadow border border-base-200">
          <div className="card-body">
            <h2 className="card-title text-lg">Entries ({entries.length})</h2>
            <div className="overflow-x-auto">
              <table className="table table-xs">
                <thead>
                  <tr>
                    <th>Entry UID</th>
                    <th>Identity Key</th>
                    {!mode?.appendOnly && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.entryUID}>
                      <td className="font-mono text-xs">
                        {e.entryUID.slice(0, 8)}…{e.entryUID.slice(-6)}
                      </td>
                      <td className="font-mono text-xs">
                        {e.identityKey.slice(0, 8)}…{e.identityKey.slice(-6)}
                      </td>
                      {!mode?.appendOnly && (
                        <td>
                          <button
                            className="btn btn-xs btn-error btn-outline"
                            disabled={isPending || !!pendingTxHash}
                            onClick={() => handleRemoveEntry(e.entryUID as `0x${string}`)}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {entries && entries.length === 0 && mode?.exists && (
        <div className="opacity-50 text-sm">No entries in your lens yet.</div>
      )}

      {/* ADD ENTRY */}
      {mode?.exists && (
        <div className="card w-full max-w-xl bg-base-100 shadow border border-base-200">
          <div className="card-body">
            <h2 className="card-title text-lg">Add Entry</h2>
            <p className="text-xs opacity-60">
              Mode: <span className="badge badge-sm badge-outline">{TARGET_TYPE_LABELS[targetType]}</span>
              {targetType === 1 && " — put the address in Recipient; target stays 0x0"}
              {targetType === 2 && " — put the attestation UID in Target; recipient stays 0x0"}
              {targetType === 0 && " — put any opaque nonzero bytes32 key in Target"}
            </p>

            {targetType === 1 ? (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Recipient (address)</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered font-mono text-xs"
                  placeholder="0x..."
                  value={entryRecipient}
                  onChange={e => setEntryRecipient(e.target.value)}
                />
              </div>
            ) : (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Target (bytes32)</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered font-mono text-xs"
                  placeholder="0x..."
                  value={entryTarget}
                  onChange={e => setEntryTarget(e.target.value)}
                />
              </div>
            )}

            <div className="card-actions justify-end mt-2">
              <button
                className="btn btn-primary"
                disabled={isPending || !!pendingTxHash || !connectedAddress}
                onClick={handleAddEntry}
              >
                {isPending || !!pendingTxHash ? <span className="loading loading-spinner" /> : "Add Entry"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
