"use client";

import { useEffect, useState } from "react";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  hexToString,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useSchemaRegistry } from "~~/hooks/efs/useSchemaRegistry";
import { useScaffoldReadContract, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

// Minimal EAS ABI (standard, doesn't change per deployment)
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
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: true, internalType: "address", name: "attester", type: "address" },
      { indexed: false, internalType: "bytes32", name: "uid", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "schemaUID", type: "bytes32" },
    ],
    name: "Attested",
    type: "event",
  },
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    // Tuple order matches EAS `Attestation` struct in Common.sol exactly:
    // uid, schema, time, expirationTime, revocationTime, refUID, recipient,
    // attester, revocable, data. Reordering breaks viem decoding.
    outputs: [
      {
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
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default function DebugSchemas() {
  const { writeContractAsync, isPending } = useWriteContract();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const registry = useSchemaRegistry();

  // State for forms
  const [pinRef, setPinRef] = useState("");
  const [pinDef, setPinDef] = useState("");

  const [tagRef, setTagRef] = useState("");
  const [tagDef, setTagDef] = useState("");
  const [tagWeight, setTagWeight] = useState("1");

  const [propRef, setPropRef] = useState("");
  const [propName, setPropName] = useState("");
  const [propVal, setPropVal] = useState("");

  // DATA is an empty schema (ADR-0049) — no contentHash/size form inputs.

  const [anchorRef, setAnchorRef] = useState("");
  const [anchorName, setAnchorName] = useState("");

  // BLOB schema was dropped (ADR-0049) — no blob form state.

  const [lastTxHash, setLastTxHash] = useState("");

  // Initialize/Update form refs when rootTopicUid loads
  useEffect(() => {
    if (registry.rootTopicUid && registry.rootTopicUid !== zeroHash) {
      if (!pinRef || pinRef === zeroHash) setPinRef(registry.rootTopicUid);
      if (!tagRef || tagRef === zeroHash) setTagRef(registry.rootTopicUid);
      if (!propRef || propRef === zeroHash) setPropRef(registry.rootTopicUid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry.rootTopicUid]);

  const attestWithArgs = async (args: any): Promise<string | null> => {
    if (!registry.easAddress) {
      notification.error("EAS Address not found");
      return null;
    }
    try {
      const tx = await writeContractAsync({
        // Guard: writes go to the selected network (reads already do) — wagmi throws
        // ChainMismatchError if the wallet is on a different chain.
        chainId: targetNetwork.id,
        address: registry.easAddress as `0x${string}`,
        abi: EAS_ABI,
        functionName: "attest",
        args: [args],
      });
      setLastTxHash(tx);
      notification.info("Attestation submitted. Waiting for confirmation...");

      if (!publicClient) return null;

      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // Find the Attested event
      let uid = "";
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: EAS_ABI,
            eventName: "Attested",
            data: log.data,
            topics: log.topics,
          });
          if (decoded.args.uid) {
            uid = decoded.args.uid;
            break;
          }
        } catch {
          // Not the right event
        }
      }

      if (uid) {
        notification.success("Attestation successful!");
        return uid;
      }
      return null;
    } catch (e) {
      console.error("Attestation failed", e);
      notification.error("Attestation failed. Check console.");
      return null;
    }
  };

  const attest = async (schemaUID: string, refUID: string, data: `0x${string}`, revocable: boolean = true) => {
    return attestWithArgs({
      schema: schemaUID as `0x${string}`,
      data: {
        recipient: zeroAddress,
        expirationTime: 0n,
        revocable: revocable,
        refUID: (refUID || zeroHash) as `0x${string}`,
        data: data,
        value: 0n,
      },
    });
  };

  if (!registry.schemas || !registry.easAddress || !registry.indexerAddress) {
    return (
      <div className="flex justify-center p-10">
        <span className="loading loading-spinner loading-lg"></span>
        <div className="ml-4">Loading Schema Registry...</div>
      </div>
    );
  }

  // Extract guarded constants for type safety in callbacks
  const schemas = registry.schemas;
  const rootTopicUid = registry.rootTopicUid as unknown as string;
  const easAddress = registry.easAddress as unknown as string;

  return (
    <div className="flex flex-col items-center justify-center py-8 gap-8">
      <h1 className="text-4xl font-bold">Debug Schemas</h1>

      <div className="text-xs font-mono opacity-50 flex flex-col items-center gap-1">
        <div>Root Anchor: {rootTopicUid}</div>
        <div>EAS: {easAddress}</div>
        <div>Indexer: {registry.indexerAddress}</div>
      </div>

      {lastTxHash && (
        <div className="alert alert-success max-w-2xl">
          <span>Success! Tx: {lastTxHash}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-4 justify-center">
        {/* ANCHOR FORM */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Anchor Schema</h2>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Parent)</span>
              </label>
              <input
                type="text"
                className="input input-bordered"
                placeholder="e.g. 0x... (Empty for Root)"
                value={anchorRef}
                onChange={e => setAnchorRef(e.target.value)}
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Name (String)</span>
              </label>
              <input
                type="text"
                className="input input-bordered"
                placeholder="e.g. 'root' or 'docs'"
                value={anchorName}
                onChange={e => setAnchorName(e.target.value)}
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  if (!anchorName) {
                    notification.error("Name is required");
                    return;
                  }
                  attest(
                    schemas.ANCHOR,
                    anchorRef,
                    encodeAbiParameters(parseAbiParameters("string, bytes32"), [anchorName, zeroHash]),
                    false, // revocable
                  );
                }}
              >
                Attest Anchor
              </button>
            </div>
          </div>
        </div>

        {/* PIN FORM (cardinality 1, ADR-0041) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Pin Schema</h2>
            <div className="text-xs opacity-50 mb-2">
              Cardinality 1 — re-attesting at the same (attester, definition, targetSchema) supersedes the prior PIN in
              O(1). Removal is via eas.revoke().
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Target)</span>
              </label>
              <input
                type="text"
                value={pinRef}
                onChange={e => setPinRef(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Definition (Anchor or Schema UID)</span>
              </label>
              <input
                type="text"
                value={pinDef}
                onChange={e => setPinDef(e.target.value)}
                className="input input-bordered"
                placeholder="0x... (anchor UID or schema UID — ADR-0041)"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  try {
                    let defBytes;
                    if (pinDef.startsWith("0x")) {
                      defBytes = pinDef as `0x${string}`;
                    } else {
                      defBytes = stringToHex(pinDef, { size: 32 });
                    }
                    // Schema: bytes32 definition (via EdgeResolver, ADR-0041)
                    const pinSchema = (schemas as any).PIN as string | undefined;
                    if (!pinSchema) {
                      notification.error("PIN schema not available.");
                      return;
                    }
                    const encoded = encodeAbiParameters(parseAbiParameters("bytes32"), [defBytes]);
                    attest(pinSchema, pinRef, encoded);
                  } catch (e) {
                    console.error(e);
                    notification.error("Encoding failed");
                  }
                }}
              >
                Attest Pin
              </button>
            </div>
          </div>
        </div>

        {/* TAG FORM (cardinality N, ADR-0041) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Tag Schema</h2>
            <div className="text-xs opacity-50 mb-2">
              Cardinality N — entries accumulate at the same (attester, definition, targetSchema) slot. Each carries an
              int256 weight as opaque sort/score/ranking metadata for consumers (overlays, subgraphs). The weight has no
              kernel-level meaning — it does not assert/supersede. Removal is via eas.revoke().
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Target)</span>
              </label>
              <input
                type="text"
                value={tagRef}
                onChange={e => setTagRef(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Definition (String/Hex)</span>
              </label>
              <input
                type="text"
                value={tagDef}
                onChange={e => setTagDef(e.target.value)}
                className="input input-bordered"
                placeholder="e.g. 'verified'"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Weight (Int256)</span>
              </label>
              <input
                type="number"
                value={tagWeight}
                onChange={e => setTagWeight(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  try {
                    let defBytes;
                    if (tagDef.startsWith("0x")) {
                      defBytes = tagDef as `0x${string}`;
                    } else {
                      defBytes = stringToHex(tagDef, { size: 32 });
                    }
                    let weight: bigint;
                    try {
                      weight = BigInt(tagWeight);
                    } catch {
                      notification.error("Weight must be a valid integer");
                      return;
                    }
                    // Schema: bytes32 definition, int256 weight (via EdgeResolver, ADR-0041)
                    const tagSchema = (schemas as any).TAG as string | undefined;
                    if (!tagSchema) {
                      notification.error("TAG schema not available.");
                      return;
                    }
                    const encoded = encodeAbiParameters(parseAbiParameters("bytes32, int256"), [defBytes, weight]);
                    attest(tagSchema, tagRef, encoded);
                  } catch (e) {
                    console.error(e);
                    notification.error("Encoding failed");
                  }
                }}
              >
                Attest Tag
              </button>
            </div>
          </div>
        </div>

        {/* PROPERTY FORM — 3-step: key anchor + free-floating PROPERTY + PIN binding (ADR-0041) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Property Schema</h2>
            <div className="text-xs opacity-50 mb-2">
              3 txns: Anchor(key) → PROPERTY(value, standalone) → PIN(binding). Per ADR-0041.
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Container UID (refUID of key anchor)</span>
              </label>
              <input
                type="text"
                value={propRef}
                onChange={e => setPropRef(e.target.value)}
                className="input input-bordered font-mono text-xs"
                placeholder="0x… (DATA / anchor / address-as-bytes32)"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Key (anchor name, e.g. &ldquo;contentType&rdquo;)</span>
              </label>
              <input
                type="text"
                value={propName}
                onChange={e => setPropName(e.target.value)}
                className="input input-bordered"
                placeholder="e.g. contentType, name, description"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Value (string)</span>
              </label>
              <input
                type="text"
                value={propVal}
                onChange={e => setPropVal(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={async () => {
                  if (!propName) {
                    notification.error("Key name required");
                    return;
                  }
                  const pinSchemaUID = (schemas as any).PIN as string | undefined;
                  if (!pinSchemaUID) {
                    notification.error("PIN schema not available.");
                    return;
                  }

                  // Step 1: Create key anchor (Anchor<PROPERTY> under container).
                  // schemaUID field = PROPERTY_SCHEMA_UID to mark it as a PROPERTY key anchor.
                  notification.info("Step 1/3: Creating key anchor...");
                  const anchorArgs = {
                    schema: schemas.ANCHOR as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: false,
                      refUID: (propRef || zeroHash) as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("string, bytes32"), [
                        propName,
                        (schemas.PROPERTY || zeroHash) as `0x${string}`,
                      ]),
                      value: 0n,
                    },
                  };
                  const keyAnchorUID = await attestWithArgs(anchorArgs);
                  if (!keyAnchorUID) return;

                  // Step 2: Create free-floating PROPERTY (refUID=0x0, standalone).
                  notification.info("Step 2/3: Creating PROPERTY value...");
                  const propArgs = {
                    schema: (schemas.PROPERTY || zeroHash) as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: false,
                      refUID: zeroHash as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("string"), [propVal]),
                      value: 0n,
                    },
                  };
                  const propertyUID = await attestWithArgs(propArgs);
                  if (!propertyUID) return;

                  // Step 3: Create PIN binding (definition=keyAnchorUID, refUID=propertyUID).
                  // Cardinality-1 per ADR-0041: re-PINning the same (attester, keyAnchor, schema)
                  // slot supersedes the prior binding in O(1).
                  notification.info("Step 3/3: Creating PIN binding...");
                  const pinArgs = {
                    schema: pinSchemaUID as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: true,
                      refUID: propertyUID as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("bytes32"), [keyAnchorUID as `0x${string}`]),
                      value: 0n,
                    },
                  };
                  await attestWithArgs(pinArgs);
                  notification.success("PROPERTY bound. Key anchor → PROPERTY → PIN all created.");
                }}
              >
                Attest Property (3 steps)
              </button>
            </div>
          </div>
        </div>

        {/* DATA FORM — standalone, non-revocable, EMPTY schema (pure identity, ADR-0049) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Data Schema</h2>
            <div className="text-xs opacity-50 mb-2">
              Standalone, non-revocable, empty schema — pure content identity (ADR-0049). refUID=0x0, no inline fields.
              contentHash / size are reserved-key PROPERTYs bound to the DATA UID (future PROPERTY/SDK work).
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  if (!schemas.DATA) {
                    notification.error("DATA schema not available.");
                    return;
                  }
                  // DATA is an empty schema (ADR-0049) — zero-length payload.
                  attest(schemas.DATA, zeroHash, "0x", false);
                }}
              >
                Attest Data (empty)
              </button>
            </div>
          </div>
        </div>

        {/* BLOB schema was dropped (ADR-0049) — no BLOB form. */}
      </div>

      {/* VIEWER SECTION */}
      <div className="w-full max-w-4xl divider">Attestation Viewer</div>
      <AttestationViewer rootUid={rootTopicUid} schemas={schemas} easAddress={easAddress} />
    </div>
  );
}

function AttestationViewer({ rootUid, schemas, easAddress }: { rootUid: string; schemas: any; easAddress: string }) {
  const [targetUID, setTargetUID] = useState(rootUid);
  const [inputUID, setInputUID] = useState(rootUid);

  useEffect(() => {
    if (rootUid && rootUid !== zeroHash) {
      setTargetUID(rootUid);
      setInputUID(rootUid);
    }
  }, [rootUid]);

  return (
    <div className="flex flex-col gap-6 w-full max-w-6xl">
      <div className="flex flex-col gap-2">
        <label className="text-lg font-bold">Target Anchor UID</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={inputUID}
            onChange={e => setInputUID(e.target.value)}
            className="input input-bordered w-full font-mono"
          />
          <button className="btn btn-primary" onClick={() => setTargetUID(inputUID)}>
            Load
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        {/* Added Anchors Column */}
        <SchemaList
          title="Anchors"
          schemaUID={schemas.ANCHOR}
          targetRef={targetUID}
          easAddress={easAddress}
          onFocus={setTargetUID}
        />
        <SchemaList
          title="Pins"
          schemaUID={(schemas as any).PIN}
          targetRef={targetUID}
          easAddress={easAddress}
          onFocus={setTargetUID}
        />
        <SchemaList
          title="Tags"
          schemaUID={(schemas as any).TAG}
          targetRef={targetUID}
          easAddress={easAddress}
          onFocus={setTargetUID}
        />
        <SchemaList
          title="Properties"
          schemaUID={schemas.PROPERTY}
          targetRef={targetUID}
          easAddress={easAddress}
          onFocus={setTargetUID}
        />
        <SchemaList
          title="Data"
          schemaUID={schemas.DATA}
          targetRef={targetUID}
          easAddress={easAddress}
          onFocus={setTargetUID}
        />
        {/* BLOB schema was dropped (ADR-0049) — no Blobs column. */}
      </div>
    </div>
  );
}

function SchemaList({
  title,
  schemaUID,
  targetRef,
  easAddress,
  onFocus,
}: {
  title: string;
  schemaUID: string;
  targetRef: string;
  easAddress: string;
  onFocus: (uid: string) => void;
}) {
  // Fetch UIDs
  const { data: uids } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getReferencingAttestations",
    args: [targetRef as `0x${string}`, schemaUID as `0x${string}`, 0n, 10n, false, false],
  });

  return (
    <div className="card bg-base-200 shadow-lg">
      <div className="card-body p-4">
        <h3 className="card-title text-sm">{title}</h3>
        {!uids || uids.length === 0 ? (
          <p className="text-xs opacity-50">No attestations found.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {
              // @ts-ignore
              uids.map(uid => (
                <AttestationItem key={uid} uid={uid} title={title} easAddress={easAddress} onFocus={onFocus} />
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
}

function AttestationItem({
  uid,
  title,
  easAddress,
  onFocus,
}: {
  uid: string;
  title: string;
  easAddress: string;
  onFocus: (uid: string) => void;
}) {
  const { data: attestation } = useReadContract({
    address: easAddress as `0x${string}`,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [uid as `0x${string}`],
  });

  if (!attestation) return <div className="loading loading-spinner loading-xs"></div>;

  let decodedValue = <span className="break-all">{attestation.data}</span>;

  try {
    if (title === "Tags") {
      // bytes32 labelUID, int256 weight
      const [val, weight] = decodeAbiParameters(parseAbiParameters("bytes32, int256"), attestation.data);
      try {
        const asString = hexToString(val, { size: 32 }).replace(/\0/g, "");
        decodedValue = (
          <div className="flex flex-col">
            <span className="font-bold">{asString}</span>
            <span className="text-xs opacity-50">Weight: {weight.toString()}</span>
          </div>
        );
      } catch {
        decodedValue = <span className="font-mono">{val}</span>;
      }
    } else if (title === "Properties") {
      // string value
      const [val] = decodeAbiParameters(parseAbiParameters("string"), attestation.data);
      decodedValue = <span>{val}</span>;
    } else if (title === "Data") {
      // DATA is an empty schema — pure identity (ADR-0049). No inline fields to decode.
      decodedValue = <span className="text-xs italic opacity-60">empty — pure identity (ADR-0049)</span>;
    } else if (title === "Pins") {
      // bytes32 definition (cardinality-1 edge, ADR-0041)
      const [definition] = decodeAbiParameters(parseAbiParameters("bytes32"), attestation.data);
      try {
        const asString = hexToString(definition, { size: 32 }).replace(/\0/g, "");
        decodedValue = (
          <div className="flex flex-col gap-1">
            <span className="font-bold">{asString || definition.slice(0, 14) + "…"}</span>
            <span className="text-xs opacity-50 font-mono">{definition.slice(0, 14)}…</span>
          </div>
        );
      } catch {
        decodedValue = <span className="font-mono text-xs">{definition.slice(0, 14)}…</span>;
      }
    } else if (title === "Anchors") {
      // string name, bytes32 schemaUID
      const [name, anchorSchema] = decodeAbiParameters(parseAbiParameters("string, bytes32"), attestation.data);
      decodedValue = (
        <div className="flex flex-col gap-1 w-full">
          <div className="flex justify-between items-center w-full">
            <span className="font-bold text-lg">{name}</span>
            <button className="btn btn-xs btn-outline" onClick={() => onFocus(uid)}>
              Focus
            </button>
          </div>
          <div className="text-xs opacity-50 font-mono">
            Type: {anchorSchema === zeroHash ? "Generic" : anchorSchema}
          </div>
        </div>
      );
    }
  } catch (e) {
    console.error("Decode error for", title, uid, e);
  }

  return (
    <div className="bg-base-100 p-2 rounded text-xs shadow-sm border border-base-200">
      <div className="flex justify-between items-center mb-1">
        <div className="font-mono font-bold text-xxs opacity-50" title={uid}>
          {uid.slice(0, 6)}...{uid.slice(-4)}
        </div>
      </div>
      <div className="font-semibold text-primary">{decodedValue}</div>
    </div>
  );
}
