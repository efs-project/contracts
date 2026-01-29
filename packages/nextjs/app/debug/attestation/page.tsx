"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { decodeAbiParameters, hexToString, parseAbiParameters, zeroHash } from "viem";
import { useReadContract } from "wagmi";
import { Address } from "~~/components/scaffold-eth";
import { SCHEMA_DEFS, useSchemaRegistry } from "~~/hooks/efs/useSchemaRegistry";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

// Minimal EAS ABI for getAttestation
const EAS_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "refUID", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "revocable", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "data", type: "bytes" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default function AttestationDebugPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center p-10">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      }
    >
      <AttestationDebuggerContent />
    </Suspense>
  );
}

function AttestationDebuggerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryUid = searchParams.get("uid");

  const [uid, setUid] = useState<string>(queryUid || "");
  const [inputUid, setInputUid] = useState(queryUid || "");

  const registry = useSchemaRegistry();

  useEffect(() => {
    if (queryUid) {
      setUid(queryUid);
      setInputUid(queryUid);
    }
  }, [queryUid]);

  const navigateToUid = (target: string) => {
    router.push(`/debug/attestation?uid=${target}`);
  };

  if (!registry.schemas || !registry.easAddress || !registry.indexerAddress) {
    return (
      <div className="flex justify-center p-10">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 md:p-8">
      <h1 className="text-3xl font-bold mb-6">Attestation Debugger</h1>

      <div className="join w-full max-w-2xl mb-8">
        <input
          className="input input-bordered join-item w-full font-mono"
          placeholder="Enter Attestation UID (0x...)"
          value={inputUid}
          onChange={e => setInputUid(e.target.value)}
          onKeyDown={e => e.key === "Enter" && navigateToUid(inputUid)}
        />
        <button className="btn btn-primary join-item" onClick={() => navigateToUid(inputUid)}>
          Go
        </button>
      </div>

      {uid && <AttestationDetails uid={uid} onNavigate={navigateToUid} registry={registry} />}
    </div>
  );
}

function AttestationDetails({
  uid,
  onNavigate,
  registry,
}: {
  uid: string;
  onNavigate: (uid: string) => void;
  registry: ReturnType<typeof useSchemaRegistry>;
}) {
  const {
    data: attestation,
    isLoading,
    error,
  } = useReadContract({
    address: registry.easAddress as `0x${string}`,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [uid as `0x${string}`],
    query: {
      enabled: !!uid && uid.length === 66,
    },
  });

  if (!uid || uid.length !== 66) {
    return <div className="alert alert-warning">Invalid UID format</div>;
  }

  if (isLoading) return <span className="loading loading-spinner loading-lg"></span>;
  if (error) return <div className="alert alert-error">Error fetching attestation: {error.message}</div>;
  if (!attestation || attestation.uid === zeroHash)
    return <div className="alert alert-error">Attestation not found (returned zero UID)</div>;

  const isRoot = attestation.uid === registry.rootTopicUid;

  // Identify Schema
  const schemaName =
    Object.entries(registry.schemas || {}).find(([, val]) => val === attestation.schema)?.[0] || "UNKNOWN";

  return (
    <div className="flex flex-col gap-6">
      {/* Main Details Card */}
      <div className="card bg-base-100 shadow-xl overflow-visible">
        <div className="card-body">
          <h2 className="card-title text-2xl flex items-center gap-2">
            <span className="badge badge-lg badge-primary">{schemaName}</span>
            <span className="font-mono text-sm opacity-50 break-all">{uid}</span>
            {isRoot && <span className="badge badge-secondary">ROOT TOPIC</span>}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <DetailRow label="Attester" value={<Address address={attestation.attester} />} />
            <DetailRow
              label="Recipient"
              value={
                attestation.recipient === "0x0000000000000000000000000000000000000000" ? (
                  "None"
                ) : (
                  <Address address={attestation.recipient} />
                )
              }
            />
            <DetailRow label="Time" value={new Date(Number(attestation.time) * 1000).toLocaleString()} />
            <DetailRow
              label="Expiration"
              value={
                attestation.expirationTime === 0n
                  ? "Never"
                  : new Date(Number(attestation.expirationTime) * 1000).toLocaleString()
              }
            />
            <DetailRow label="Revocable" value={attestation.revocable ? "Yes" : "No"} />

            <div className="md:col-span-2">
              <span className="font-bold text-sm block mb-1">RefUID</span>
              {attestation.refUID === zeroHash ? (
                <span className="opacity-50 italic">No parent reference</span>
              ) : (
                <button className="link link-primary font-mono text-sm" onClick={() => onNavigate(attestation.refUID)}>
                  {attestation.refUID}
                </button>
              )}
            </div>
          </div>

          <div className="divider">Data</div>

          <DecodedData schemaUID={attestation.schema} data={attestation.data} schemas={registry.schemas} />

          <div className="collapse collapse-arrow bg-base-200 mt-2">
            <input type="checkbox" />
            <div className="collapse-title text-sm font-medium">Raw Hex Data</div>
            <div className="collapse-content">
              <p className="font-mono text-xs break-all bg-base-300 p-2 rounded">{attestation.data}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Referencing Attestations (Children) */}
      <ReferencingAttestations uid={uid} onNavigate={onNavigate} registry={registry} />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs font-bold opacity-70 uppercase">{label}</span>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function DecodedData({ schemaUID, data, schemas }: { schemaUID: string; data: string; schemas: any }) {
  try {
    if (!schemas) return <div className="text-sm italic opacity-60">Schemas loading...</div>;

    if (schemaUID === schemas.TAG) {
      const [val] = decodeAbiParameters(parseAbiParameters("bytes32"), data as `0x${string}`);
      let text = "";
      try {
        text = hexToString(val, { size: 32 }).replace(/\0/g, "");
      } catch {}
      return (
        <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
          <div className="text-xs font-bold uppercase mb-1">Tag</div>
          <div className="text-lg font-bold">{text}</div>
          <div className="text-xs font-mono opacity-50">{val}</div>
        </div>
      );
    }
    if (schemaUID === schemas.PROPERTY) {
      const [val] = decodeAbiParameters(parseAbiParameters("string"), data as `0x${string}`);
      return (
        <div className="p-4 bg-secondary/10 rounded-lg border border-secondary/20">
          <div className="text-xs font-bold uppercase mb-1">Property Value</div>
          <div className="text-lg">{val}</div>
        </div>
      );
    }
    if (schemaUID === schemas.FILE) {
      const [type, cid] = decodeAbiParameters(parseAbiParameters("uint8, string"), data as `0x${string}`);
      return (
        <div className="p-4 bg-accent/10 rounded-lg border border-accent/20">
          <div className="text-xs font-bold uppercase mb-1">File</div>
          <div className="flex gap-4 items-center">
            <div className="badge badge-neutral">Type: {type}</div>
            <div className="font-mono bg-base-100 p-1 rounded">{cid}</div>
          </div>
        </div>
      );
    }
    if (schemaUID === schemas.BLOB) {
      const [content, contentType] = decodeAbiParameters(parseAbiParameters("bytes, string"), data as `0x${string}`);
      const isText = contentType.includes("text") || contentType.includes("json") || contentType.includes("javascript");
      let displayText = content;
      if (isText) {
        try {
          displayText = hexToString(content) as any;
        } catch {}
      }
      return (
        <div className="p-4 bg-info/10 rounded-lg border border-info/20">
          <div className="text-xs font-bold uppercase mb-1">Blob ({contentType})</div>
          {isText ? (
            <pre className="text-xs overflow-auto max-h-[300px] p-2 bg-base-100 rounded">{displayText}</pre>
          ) : (
            <div className="text-xs italic opacity-70">{Number(content.length) / 2 - 1} bytes of binary data</div>
          )}
        </div>
      );
    }
  } catch (e) {
    return <div className="alert alert-warning text-xs">Failed to decode: {(e as Error).message}</div>;
  }

  return <div className="text-sm italic opacity-60">No decoder for this schema.</div>;
}

function ReferencingAttestations({
  uid,
  onNavigate,
  registry,
}: {
  uid: string;
  onNavigate: (uid: string) => void;
  registry: ReturnType<typeof useSchemaRegistry>;
}) {
  if (!registry.schemas) return null;

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl font-bold px-1">Referencing Attestations</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <ReferencingList
          title="Tags"
          schema={registry.schemas.TAG}
          target={uid}
          onNavigate={onNavigate}
          registry={registry}
        />
        <ReferencingList
          title="Properties"
          schema={registry.schemas.PROPERTY}
          target={uid}
          onNavigate={onNavigate}
          registry={registry}
        />
        <ReferencingList
          title="Files"
          schema={registry.schemas.FILE}
          target={uid}
          onNavigate={onNavigate}
          registry={registry}
        />
        <ReferencingList
          title="Blobs"
          schema={registry.schemas.BLOB}
          target={uid}
          onNavigate={onNavigate}
          registry={registry}
        />
      </div>
    </div>
  );
}

function ReferencingList({
  title,
  schema,
  target,
  onNavigate,
  registry,
}: {
  title: string;
  schema: string;
  target: string;
  onNavigate: (uid: string) => void;
  registry: ReturnType<typeof useSchemaRegistry>;
}) {
  const { data: uids, isLoading } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getReferencingAttestationUIDs",
    args: [target as `0x${string}`, schema as `0x${string}`, 0n, 50n, true], // fetch last 50, reversed
  });

  return (
    <div className="card bg-base-200 shadow-sm border border-base-300">
      <div className="card-body p-4">
        <h4 className="card-title text-sm">
          {title} {isLoading && <span className="loading loading-spinner loading-xs"></span>}
        </h4>

        <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto">
          {!uids || uids.length === 0 ? (
            <p className="text-xs opacity-50 italic">None found</p>
          ) : (
            uids.map(u => (
              <button
                key={u}
                className="btn btn-xs btn-ghost justify-start font-mono overflow-hidden text-ellipsis w-full"
                onClick={() => onNavigate(u)}
                title={u}
              >
                {u.substring(0, 6)}...{u.substring(u.length - 4)}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
