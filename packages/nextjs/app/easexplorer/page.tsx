"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CopyToClipboard from "react-copy-to-clipboard";
import {
  CheckCircleIcon,
  DocumentDuplicateIcon,
  ArrowTopRightOnSquareIcon
} from "@heroicons/react/24/outline";
import { useReadContract, usePublicClient } from "wagmi";
import { isAddress, maxUint256, zeroHash } from "viem";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { EAS, SchemaEncoder, SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { Address } from "~~/components/scaffold-eth";
import Link from "next/link";
import { decodeAbiParameters, parseAbiParameters, toHex } from 'viem'

// Minimal ABI for EAS and SchemaRegistry
const EAS_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "uint64", name: "time", type: "uint64" },
          { internalType: "uint64", name: "expirationTime", type: "uint64" },
          { internalType: "uint64", name: "revocationTime", type: "uint64" },
          { internalType: "bytes32", name: "refUID", type: "bytes32" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "bytes", name: "data", type: "bytes" },
        ],
        internalType: "struct Attestation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSchemaRegistry",
    outputs: [{ internalType: "contract ISchemaRegistry", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "address", name: "resolver", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "string", name: "schema", type: "string" },
        ],
        internalType: "struct SchemaRecord",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default function EASExplorer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const uidParam = searchParams.get("uid");

  const [uid, setUid] = useState(uidParam || "");
  const [activeTab, setActiveTab] = useState("human");
  const [decodedData, setDecodedData] = useState<any[]>([]);

  useEffect(() => {
    if (uidParam) {
      setUid(uidParam);
    }
  }, [uidParam]);

  // 1. Get EAS Address from Indexer
  const { data: easAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getEAS",
  });

  // 2. Fetch Attestation
  const { data: attestation, isError: isAttestationError, isLoading: isAttestationLoading } = useReadContract({
    address: easAddress as `0x${string}` | undefined,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: uidParam ? [uidParam as `0x${string}`] : undefined,
    query: {
      enabled: !!uidParam && !!easAddress && uidParam.length === 66,
    },
  });

  // Check if attestation is valid (non-empty UID)
  const isAttestationFound = attestation && attestation.uid !== zeroHash;

  // 3. Get SchemaRegistry Address (only if we found an attestation or we want to try fetching schema)
  const { data: schemaRegistryAddress } = useReadContract({
    address: easAddress as `0x${string}` | undefined,
    abi: EAS_ABI,
    functionName: "getSchemaRegistry",
    query: {
      enabled: !!easAddress
    }
  });

  // 4. Fetch Schema (if attestation found, fetch its schema; else try fetching schema by UID)
  const schemaUidToFetch = isAttestationFound ? attestation.schema : uidParam;

  const { data: schemaRecord, isLoading: isSchemaLoading } = useReadContract({
    address: schemaRegistryAddress,
    abi: SCHEMA_REGISTRY_ABI,
    functionName: "getSchema",
    args: schemaUidToFetch ? [schemaUidToFetch as `0x${string}`] : undefined,
    query: {
      enabled: !!schemaRegistryAddress && !!schemaUidToFetch && schemaUidToFetch.length === 66,
    },
  });

  // 5. Fetch Related Attestations (Indexer)
  const relevantSchema = isAttestationFound ? attestation.schema : (schemaRecord?.uid === uidParam ? uidParam : undefined);

  // References to this Attestation (replies)
  const { data: referencingAttestations } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getReferencingAttestations",
    args: [
      (uidParam as `0x${string}`) || zeroHash,
      (relevantSchema as `0x${string}`) || zeroHash,
      0n,
      20n,
      true
    ],
    query: {
      enabled: !!isAttestationFound && !!relevantSchema && !!uidParam
    }
  });

  // Attestations using this Schema (if viewing Schema)
  // Attestations using this Schema (if viewing Schema)
  // Note: getSchemaAttestations not currently implemented in Indexer
  const { data: schemaAttestations } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getEAS", // Dummy call to avoid crashing, or just null
    query: {
      enabled: false
    }
  });


  // Decode Data
  useEffect(() => {
    if (attestation && schemaRecord && attestation.schema === schemaRecord.uid) {
      try {
        const schemaEncoder = new SchemaEncoder(schemaRecord.schema);
        const decoded = schemaEncoder.decodeData(attestation.data);
        setDecodedData(decoded);
      } catch (e) {
        console.error("Error decoding data:", e);
        setDecodedData([]);
      }
    }
  }, [attestation, schemaRecord]);

  const handleSearch = () => {
    if (uid) {
      router.push(`/easexplorer?uid=${uid}`);
    }
  };

  const renderDataDisplay = () => {
    if (activeTab === "raw") {
      return (
        <div className="mockup-code bg-base-300 text-sm">
          <pre data-prefix=">"><code>{attestation?.data}</code></pre>
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {decodedData.map((item, i) => {
              const renderValue = (val: any): string => {
                if (Array.isArray(val)) {
                  return `[${val.map(v => renderValue(v)).join(", ")}]`;
                }
                if (typeof val === "object" && val !== null) {
                  if (val.value !== undefined) {
                    return renderValue(val.value);
                  }
                  if (val.hex) {
                    return val.hex;
                  }
                  return JSON.stringify(val, (key, value) =>
                    typeof value === 'bigint' ? value.toString() : value
                  );
                }
                return String(val);
              };

              return (
                <tr key={i}>
                  <td className="font-bold">{item.name}</td>
                  <td>{item.type}</td>
                  <td>{renderValue(item.value)}</td>
                </tr>
              );
            })}
            {decodedData.length === 0 && (
              <tr><td colSpan={3}>No decoded data or unable to decode.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  const renderAttestationList = (uids: readonly `0x${string}`[] | undefined, title: string) => {
    if (!uids || uids.length === 0) return null;
    return (
      <div className="mt-8">
        <h3 className="text-xl font-bold mb-4">{title}</h3>
        <div className="flex flex-col gap-2">
          {uids.map((u) => (
            <Link key={u} href={`/easexplorer?uid=${u}`} className="link link-primary font-mono block">
              {u}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // Determine State
  const isLoading = !easAddress || isAttestationLoading || isSchemaLoading;
  const isSchemaView = !isAttestationFound && schemaRecord && schemaRecord.uid === uidParam;

  // Render
  return (
    <div className="container mx-auto p-10">
      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold">EAS Explorer</h1>

        {/* Search Bar */}
        <div className="flex gap-2 items-center bg-base-100 p-4 rounded-xl shadow-md">
          <input
            type="text"
            placeholder="Enter Attestation or Schema UID"
            className="input input-bordered w-full font-mono"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button className="btn btn-primary" onClick={handleSearch}>
            Go
          </button>
        </div>

        {isLoading && <span className="loading loading-spinner loading-lg mx-auto"></span>}

        {!isLoading && uidParam && !isAttestationFound && !isSchemaView && (
          <div className="alert alert-warning">UID not found (neither Attestation nor Schema)</div>
        )}

        {/* Attestation View */}
        {isAttestationFound && attestation && (
          <div className="bg-base-100 rounded-xl shadow-md p-6">
            <div className="flex justify-between items-start mb-6">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                Attestation
                <div className="badge badge-secondary">{attestation.revocable ? "Revocable" : "Irrevocable"}</div>
              </h2>
              <div className="flex items-center gap-2">
                <CopyToClipboard text={attestation.uid}>
                  <button className="btn btn-ghost btn-xs" title="Copy UID">
                    <DocumentDuplicateIcon className="h-4 w-4" />
                  </button>
                </CopyToClipboard>
                <span className="text-sm opacity-50 font-mono break-all">{attestation.uid}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <span className="font-bold block">Attester</span>
                <Address address={attestation.attester} />
              </div>
              <div>
                <span className="font-bold block">Recipient</span>
                <Address address={attestation.recipient} />
              </div>
              <div className="md:col-span-2">
                <span className="font-bold block">Schema</span>
                <div className="flex items-center gap-1">
                  <CopyToClipboard text={attestation.schema}>
                    <button className="btn btn-ghost btn-xs" title="Copy Schema UID">
                      <DocumentDuplicateIcon className="h-3 w-3" />
                    </button>
                  </CopyToClipboard>
                  <Link href={`/easexplorer?uid=${attestation.schema}`} className="link link-primary font-mono text-xs break-all">
                    {attestation.schema}
                  </Link>
                </div>
              </div>
              <div className="md:col-span-2">
                <span className="font-bold block">RefUID</span>
                {attestation.refUID === zeroHash ? (
                  <span className="text-xs opacity-50 font-mono">None</span>
                ) : (
                  <Link href={`/easexplorer?uid=${attestation.refUID}`} className="link link-primary font-mono text-xs break-all">
                    {attestation.refUID}
                  </Link>
                )}
              </div>
              <div>
                <span className="font-bold block">Time</span>
                <span>{new Date(Number(attestation.time) * 1000).toLocaleString()}</span>
              </div>
              <div>
                <span className="font-bold block">Expiration</span>
                <span>{Number(attestation.expirationTime) === 0 ? "Never" : new Date(Number(attestation.expirationTime) * 1000).toLocaleString()}</span>
              </div>
            </div>

            <div role="tablist" className="tabs tabs-lifted">
              <a role="tab" className={`tab ${activeTab === "human" ? "tab-active" : ""}`} onClick={() => setActiveTab("human")}>Human Readable</a>
              <a role="tab" className={`tab ${activeTab === "raw" ? "tab-active" : ""}`} onClick={() => setActiveTab("raw")}>Raw Data</a>
            </div>
            <div className="bg-base-100 border-base-300 rounded-b-box border p-6">
              {renderDataDisplay()}
            </div>

            {renderAttestationList(referencingAttestations, "Referencing Attestations (Same Schema)")}
          </div>
        )}

        {/* Schema View */}
        {isSchemaView && schemaRecord && (
          <div className="bg-base-100 rounded-xl shadow-md p-6">
            <div className="flex justify-between items-start mb-6">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                Schema
                <div className="badge badge-accent">Schema</div>
              </h2>
              <div className="flex items-center gap-2">
                <CopyToClipboard text={schemaRecord.uid}>
                  <button className="btn btn-ghost btn-xs" title="Copy UID">
                    <DocumentDuplicateIcon className="h-4 w-4" />
                  </button>
                </CopyToClipboard>
                <span className="text-sm opacity-50 font-mono break-all">{schemaRecord.uid}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <span className="font-bold block">Resolver</span>
                <Address address={schemaRecord.resolver} />
              </div>
              <div>
                <span className="font-bold block">Revocable</span>
                <span>{schemaRecord.revocable ? "Yes" : "No"}</span>
              </div>
            </div>

            <div className="mb-6">
              <span className="font-bold block mb-2">Schema String</span>
              <div className="bg-base-200 p-4 rounded-xl font-mono text-sm overflow-x-auto">
                {schemaRecord.schema}
              </div>
            </div>

            {renderAttestationList(schemaAttestations as unknown as `0x${string}`[], "Recent Attestations")}
          </div>
        )}

      </div>
    </div>
  );
}
