"use client";

import { useState } from "react";
import Link from "next/link";
import { encodeAbiParameters, zeroAddress, zeroHash } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

// Minimal EAS ABI for attest + Attested event
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
] as const;

const LIST_READER_ABI = [
  {
    inputs: [],
    name: "LIST_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
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

// targetType values
const TARGET_TYPES = ["ANY (0)", "ADDR (1)", "SCHEMA (2)"];

export default function ListsPage() {
  const { address: connectedAddress } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  // Get ListReader address from deployed contracts (populated after yarn deploy with 09_lists.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo("ListReader" as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;

  // Read schema UIDs from ListReader
  const { data: listSchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });
  const { data: listEntrySchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  // CREATE LIST form state
  const [allowsDuplicates, setAllowsDuplicates] = useState(false);
  const [appendOnly, setAppendOnly] = useState(false);
  const [targetType, setTargetType] = useState(0); // 0=ANY, 1=ADDR, 2=SCHEMA
  const [targetSchema, setTargetSchema] = useState("");
  const [maxEntries, setMaxEntries] = useState("0");

  // Lookup form state
  const [lookupUID, setLookupUID] = useState("");
  const [lastCreatedUID, setLastCreatedUID] = useState("");

  // EAS address from hardcoded Sepolia (same as deploy scripts)
  const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

  const handleCreateList = async () => {
    if (!listSchemaUID) {
      notification.error("LIST_SCHEMA_UID not available. Is ListReader deployed?");
      return;
    }
    if (targetType === 2 && !targetSchema.startsWith("0x")) {
      notification.error("SCHEMA mode requires a valid targetSchema UID (0x...)");
      return;
    }
    let maxE: number;
    try {
      maxE = parseInt(maxEntries, 10);
      if (isNaN(maxE) || maxE < 0) throw new Error();
    } catch {
      notification.error("maxEntries must be a non-negative integer");
      return;
    }

    const schemaBytes = (targetType === 2 ? targetSchema : zeroHash) as `0x${string}`;

    const data = encodeAbiParameters(
      [
        { name: "allowsDuplicates", type: "bool" },
        { name: "appendOnly", type: "bool" },
        { name: "targetType", type: "uint8" },
        { name: "targetSchema", type: "bytes32" },
        { name: "maxEntries", type: "uint32" },
      ],
      [allowsDuplicates, appendOnly, targetType, schemaBytes, maxE],
    );

    try {
      const tx = await writeContractAsync({
        address: EAS_ADDRESS,
        abi: EAS_ABI,
        functionName: "attest",
        args: [
          {
            schema: listSchemaUID,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: false, // LIST is non-revocable
              refUID: zeroHash,
              data,
              value: 0n,
            },
          },
        ],
      });
      notification.success(`List attested! Tx: ${tx.slice(0, 10)}…`);
      setLastCreatedUID(tx); // tx hash — real UID shown after confirmation
    } catch (e) {
      console.error(e);
      notification.error("Failed to create list. Check console.");
    }
  };

  return (
    <div className="flex flex-col items-center py-8 gap-6 px-4">
      <h1 className="text-4xl font-bold">Lists Debug</h1>
      <p className="text-sm opacity-60 max-w-xl text-center">
        EFS Lists primitive (ADR-0044). Curated, shape-enforced collections over EAS attestations.
      </p>

      {/* Contract info */}
      <div className="text-xs font-mono opacity-50 flex flex-col items-center gap-1">
        <div>ListReader: {listReaderAddress ?? "not deployed"}</div>
        <div>LIST_SCHEMA_UID: {listSchemaUID ?? "—"}</div>
        <div>LIST_ENTRY_SCHEMA_UID: {listEntrySchemaUID ?? "—"}</div>
        {!listReaderAddress && <div className="text-warning mt-1">Run `yarn deploy` to deploy Lists contracts.</div>}
      </div>

      <div className="flex flex-wrap gap-6 justify-center w-full max-w-5xl">
        {/* CREATE LIST */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Create List</h2>
            <p className="text-xs opacity-60">
              Attests a LIST (non-revocable). The UID returned is your list&rsquo;s permanent identity.
            </p>

            <div className="form-control">
              <label className="label cursor-pointer">
                <span className="label-text">Allows Duplicates</span>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={allowsDuplicates}
                  onChange={e => setAllowsDuplicates(e.target.checked)}
                />
              </label>
            </div>

            <div className="form-control">
              <label className="label cursor-pointer">
                <span className="label-text">Append Only</span>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={appendOnly}
                  onChange={e => setAppendOnly(e.target.checked)}
                />
              </label>
            </div>

            <div className="form-control">
              <label className="label">
                <span className="label-text">Target Type</span>
              </label>
              <select
                className="select select-bordered"
                value={targetType}
                onChange={e => setTargetType(Number(e.target.value))}
              >
                {TARGET_TYPES.map((t, i) => (
                  <option key={i} value={i}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {targetType === 2 && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Target Schema UID</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered font-mono text-xs"
                  placeholder="0x..."
                  value={targetSchema}
                  onChange={e => setTargetSchema(e.target.value)}
                />
              </div>
            )}

            <div className="form-control">
              <label className="label">
                <span className="label-text">Max Entries (0 = unlimited)</span>
              </label>
              <input
                type="number"
                className="input input-bordered"
                value={maxEntries}
                min={0}
                onChange={e => setMaxEntries(e.target.value)}
              />
            </div>

            <div className="card-actions justify-end mt-2">
              <button
                className="btn btn-primary"
                disabled={isPending || !listSchemaUID || !connectedAddress}
                onClick={handleCreateList}
              >
                {isPending ? <span className="loading loading-spinner" /> : "Create List"}
              </button>
            </div>

            {lastCreatedUID && (
              <div className="text-xs mt-2 opacity-60">
                Tx submitted: {lastCreatedUID.slice(0, 12)}… (find UID in EAS explorer)
              </div>
            )}
          </div>
        </div>

        {/* LOOK UP LIST */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Look Up List</h2>
            <div className="form-control">
              <label className="label">
                <span className="label-text">List UID (bytes32)</span>
              </label>
              <input
                type="text"
                className="input input-bordered font-mono text-xs"
                placeholder="0x..."
                value={lookupUID}
                onChange={e => setLookupUID(e.target.value)}
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <Link
                href={lookupUID.startsWith("0x") ? `/lists/${lookupUID}` : "#"}
                className={`btn btn-secondary ${!lookupUID.startsWith("0x") ? "btn-disabled" : ""}`}
              >
                View List →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
