"use client";

import { Fragment, useEffect, useState } from "react";
import { decodeAbiParameters, getAddress, zeroHash } from "viem";
import { usePublicClient } from "wagmi";
import type { ClassifiedContainer, ContainerKind } from "~~/utils/efs/containers";

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
  {
    inputs: [],
    name: "getSchemaRegistry",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

type AttestationRow = {
  uid: `0x${string}`;
  schema: `0x${string}`;
  refUID: `0x${string}`;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  revocable: boolean;
  recipient: `0x${string}`;
  attester: `0x${string}`;
  data: `0x${string}`;
};

type SchemaRow = {
  uid: `0x${string}`;
  resolver: `0x${string}`;
  revocable: boolean;
  schema: string;
};

function shortHex(hex: string): string {
  if (!hex) return "";
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

function truncateBytes(hex: string, max = 200): string {
  if (!hex) return "";
  return hex.length > max ? `${hex.slice(0, max)}…` : hex;
}

function formatUnixTime(t: bigint): string {
  if (t === 0n) return "never";
  try {
    const ms = Number(t) * 1000;
    const d = new Date(ms);
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  } catch {
    return String(t);
  }
}

/** Try to decode EAS attestation data against a schema string like "bytes32 refUID,string name". */
function tryDecodeSchemaData(schema: string, data: `0x${string}`): { name: string; value: string }[] | null {
  try {
    // Strip annotations like `indexed`; EAS schema strings use simple `type name` pairs.
    const parts = schema
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const components = parts.map(part => {
      const tokens = part.split(/\s+/).filter(Boolean);
      const type = tokens[0];
      const name = tokens[tokens.length - 1] ?? "";
      return { type, name };
    });
    const values = decodeAbiParameters(components as any, data) as readonly unknown[];
    return components.map((c, i) => {
      const v = values[i];
      let rendered: string;
      if (typeof v === "bigint") rendered = v.toString();
      else if (typeof v === "boolean") rendered = v ? "true" : "false";
      else if (typeof v === "string") rendered = v;
      else if (v === null || v === undefined) rendered = "";
      else rendered = JSON.stringify(v, (_k, vv) => (typeof vv === "bigint" ? vv.toString() : vv));
      return { name: c.name || c.type, value: rendered };
    });
  } catch {
    return null;
  }
}

const KIND_META: Record<ContainerKind, { typeLine: string }> = {
  anchor: { typeLine: "anchor" },
  address: { typeLine: "address" },
  schema: { typeLine: "schema" },
  attestation: { typeLine: "attestation" },
};

export type ContainerInfoPanelProps = {
  container: ClassifiedContainer | null;
  currentAnchorUID: string | null;
  connectedAddress?: string;
  easAddress?: `0x${string}`;
  pathName?: string;
  /**
   * Resolved display name for the container (ADR-0034 `name` PROPERTY / ENS
   * / persona label). Overrides the primary label row when set.
   */
  containerDisplayName?: string | null;
  /** External expanded state (driven by the ItemButton in PathBar). */
  expanded: boolean;
};

export const ContainerInfoPanel = ({
  container,
  currentAnchorUID,
  connectedAddress,
  easAddress,
  pathName,
  containerDisplayName,
  expanded,
}: ContainerInfoPanelProps) => {
  const publicClient = usePublicClient();
  const [ensName, setEnsName] = useState<string | null>(null);
  const [schemaInfo, setSchemaInfo] = useState<SchemaRow | null>(null);
  const [attestationInfo, setAttestationInfo] = useState<AttestationRow | null>(null);
  const [attestationSchema, setAttestationSchema] = useState<SchemaRow | null>(null);

  const kind: ContainerKind = container?.kind ?? "anchor";

  useEffect(() => {
    setEnsName(null);
    if (kind !== "address" || !container?.address || !publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const name = await publicClient.getEnsName({ address: container.address as `0x${string}` });
        if (!cancelled) setEnsName(name ?? null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, container?.address, publicClient]);

  useEffect(() => {
    setSchemaInfo(null);
    if (kind !== "schema" || !container?.uid || !publicClient || !easAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const registry = (await publicClient.readContract({
          address: easAddress,
          abi: EAS_ABI,
          functionName: "getSchemaRegistry",
        })) as `0x${string}`;
        const row = (await publicClient.readContract({
          address: registry,
          abi: SCHEMA_REGISTRY_ABI,
          functionName: "getSchema",
          args: [container.uid as `0x${string}`],
        })) as SchemaRow;
        if (!cancelled && row && row.uid !== zeroHash) setSchemaInfo(row);
      } catch (e) {
        console.warn("SchemaRegistry lookup failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, container?.uid, publicClient, easAddress]);

  useEffect(() => {
    setAttestationInfo(null);
    setAttestationSchema(null);
    if (kind !== "attestation" || !container?.uid || !publicClient || !easAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const row = (await publicClient.readContract({
          address: easAddress,
          abi: EAS_ABI,
          functionName: "getAttestation",
          args: [container.uid as `0x${string}`],
        })) as AttestationRow;
        if (cancelled || !row || row.uid === zeroHash) return;
        setAttestationInfo(row);
        // Also fetch the schema string so we can decode `data`.
        try {
          const registry = (await publicClient.readContract({
            address: easAddress,
            abi: EAS_ABI,
            functionName: "getSchemaRegistry",
          })) as `0x${string}`;
          const sch = (await publicClient.readContract({
            address: registry,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "getSchema",
            args: [row.schema],
          })) as SchemaRow;
          if (!cancelled && sch && sch.uid !== zeroHash) setAttestationSchema(sch);
        } catch {
          /* ignore — decoded data just won't render */
        }
      } catch (e) {
        console.warn("EAS getAttestation failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, container?.uid, publicClient, easAddress]);

  if (!expanded) return null;

  // Nothing to render for a root anchor with no resolved item.
  if (kind === "anchor" && !currentAnchorUID) return null;

  const meta = KIND_META[kind];

  const isYou =
    kind === "address" &&
    connectedAddress &&
    container?.address &&
    connectedAddress.toLowerCase() === container.address.toLowerCase();

  const primaryName = (() => {
    if (kind === "address") {
      return containerDisplayName || ensName || container?.displayName || container?.address || "—";
    }
    if (kind === "schema") {
      return containerDisplayName || schemaInfo?.schema || shortHex(container?.uid ?? "");
    }
    if (kind === "attestation") return containerDisplayName || shortHex(container?.uid ?? "");
    return pathName ?? "—";
  })();

  return (
    <div className="w-full rounded-lg border border-base-content/20 bg-base-200 mb-2 overflow-hidden">
      {/* Header band */}
      <div className="flex items-baseline gap-3 px-4 py-2.5 bg-base-300 border-b border-base-content/10">
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wider opacity-60">{meta.typeLine}</span>
          <span className="font-semibold truncate text-base">{primaryName}</span>
        </div>
        {isYou && <span className="badge badge-sm badge-success self-center">You</span>}
        <div className="ml-auto text-xs opacity-40 italic self-center">
          {/* Reserved for future `description` PROPERTY on any container. */}
          No description
        </div>
      </div>

      {/* Body — field rows */}
      <div className="px-4 py-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
        {kind === "anchor" && currentAnchorUID && (
          <>
            <Label>Name</Label>
            <Value>{pathName ?? "—"}</Value>
            <Label>UID</Label>
            <Mono>{currentAnchorUID}</Mono>
          </>
        )}

        {kind === "address" && container?.address && (
          <>
            {ensName && (
              <>
                <Label>ENS</Label>
                <Value>{ensName}</Value>
              </>
            )}
            <Label>Address</Label>
            <Mono>{getAddress(container.address)}</Mono>
            <Label>As bytes32</Label>
            <Mono>{container.uid}</Mono>
          </>
        )}

        {kind === "schema" && (
          <>
            <Label>UID</Label>
            <Mono>{container?.uid ?? ""}</Mono>
            {schemaInfo && (
              <>
                <Label>Schema</Label>
                <Mono>{schemaInfo.schema}</Mono>
                <Label>Resolver</Label>
                <Mono>{schemaInfo.resolver}</Mono>
                <Label>Revocable</Label>
                <Value>{schemaInfo.revocable ? "Yes" : "No"}</Value>
              </>
            )}
            {!schemaInfo && (
              <>
                <Label>Schema</Label>
                <Value className="italic opacity-60">loading…</Value>
              </>
            )}
          </>
        )}

        {kind === "attestation" && (
          <>
            <Label>UID</Label>
            <Mono>{container?.uid ?? ""}</Mono>
            {attestationInfo && (
              <>
                <Label>Schema</Label>
                <Mono>{attestationInfo.schema}</Mono>
                <Label>Attester</Label>
                <Mono>{attestationInfo.attester}</Mono>
                <Label>Recipient</Label>
                <Mono>{attestationInfo.recipient}</Mono>
                {attestationInfo.refUID !== zeroHash && (
                  <>
                    <Label>Ref UID</Label>
                    <Mono>{attestationInfo.refUID}</Mono>
                  </>
                )}
                <Label>Created</Label>
                <Value>{formatUnixTime(attestationInfo.time)}</Value>
                <Label>Expires</Label>
                <Value>{formatUnixTime(attestationInfo.expirationTime)}</Value>
                <Label>Revocable</Label>
                <Value>{attestationInfo.revocable ? "Yes" : "No"}</Value>
                <Label>Revoked</Label>
                <Value>
                  {attestationInfo.revocationTime > 0n ? formatUnixTime(attestationInfo.revocationTime) : "No"}
                </Value>
                <DecodedData row={attestationInfo} schema={attestationSchema} />
              </>
            )}
            {!attestationInfo && (
              <>
                <Label>Attester</Label>
                <Value className="italic opacity-60">loading…</Value>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

function Label({ children }: { children: React.ReactNode }) {
  return <div className="opacity-60 uppercase tracking-wider text-[10px] self-center">{children}</div>;
}

function Value({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`break-all ${className}`}>{children}</div>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <div className="font-mono break-all">{children}</div>;
}

function DecodedData({ row, schema }: { row: AttestationRow; schema: SchemaRow | null }) {
  if (!row.data || row.data === "0x") {
    return (
      <>
        <Label>Data</Label>
        <Value className="italic opacity-60">empty</Value>
      </>
    );
  }
  if (!schema) {
    return (
      <>
        <Label>Data (hex)</Label>
        <Mono>{truncateBytes(row.data)}</Mono>
      </>
    );
  }
  const fields = tryDecodeSchemaData(schema.schema, row.data);
  if (!fields) {
    return (
      <>
        <Label>Data (hex)</Label>
        <Mono>{truncateBytes(row.data)}</Mono>
      </>
    );
  }
  return (
    <>
      {fields.map((f, i) => (
        <Fragment key={`${i}-${f.name}`}>
          <Label>{f.name}</Label>
          <Mono>{f.value || <span className="italic opacity-50">empty</span>}</Mono>
        </Fragment>
      ))}
    </>
  );
}
