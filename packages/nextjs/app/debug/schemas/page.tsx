"use client";

import { useEffect, useState } from "react";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  hexToString,
  parseAbiParameters,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useSchemaRegistry } from "~~/hooks/efs/useSchemaRegistry";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
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

export default function DebugSchemas() {
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const registry = useSchemaRegistry();

  // State for forms
  const [tagRef, setTagRef] = useState("");
  const [tagDef, setTagDef] = useState("");
  const [tagWeight, setTagWeight] = useState("1");

  const [propRef, setPropRef] = useState("");
  const [propName, setPropName] = useState("");
  const [propVal, setPropVal] = useState("");

  const [dataRef, setDataRef] = useState("");
  const [dataName, setDataName] = useState("");
  const [dataBlobUID, setDataBlobUID] = useState("");

  const [dataFileMode, setDataFileMode] = useState("100644"); // Default file mode

  const [blobRef, setBlobRef] = useState("");
  const [blobType, setBlobType] = useState("text/plain");
  const [blobData, setBlobData] = useState("");

  const [lastTxHash, setLastTxHash] = useState("");

  // Initialize/Update form refs when rootTopicUid loads
  useEffect(() => {
    if (registry.rootTopicUid && registry.rootTopicUid !== zeroHash) {
      if (!tagRef || tagRef === zeroHash) setTagRef(registry.rootTopicUid);
      if (!propRef || propRef === zeroHash) setPropRef(registry.rootTopicUid);
      if (!dataRef || dataRef === zeroHash) setDataRef(registry.rootTopicUid);
      if (!blobRef || blobRef === zeroHash) setBlobRef(registry.rootTopicUid);
    }
  }, [registry.rootTopicUid]);

  const attestWithArgs = async (args: any): Promise<string | null> => {
    if (!registry.easAddress) {
      notification.error("EAS Address not found");
      return null;
    }
    try {
      const tx = await writeContractAsync({
        address: registry.easAddress as `0x${string}`,
        abi: EAS_ABI,
        functionName: "attest",
        args: [args],
      });
      setLastTxHash(tx);
      console.log("Attested!", tx);
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
        } catch (e) {
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
                id="anchor-ref-input"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Recipient (Address)</span>
              </label>
              <input
                type="text"
                className="input input-bordered"
                placeholder="e.g. 0x... (Optional)"
                id="anchor-recipient-input"
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
                id="anchor-name-input"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  const nameInput = document.getElementById("anchor-name-input") as HTMLInputElement;
                  const refInput = document.getElementById("anchor-ref-input") as HTMLInputElement;
                  const name = nameInput.value;
                  const ref = refInput.value;

                  if (!name) {
                    notification.error("Name is required");
                    return;
                  }
                  // Schema: string name
                  // RefUID provided or zeroHash
                  // Revocable: FALSE
                  attest(
                    schemas.ANCHOR,
                    ref,
                    encodeAbiParameters(parseAbiParameters("string"), [name]),
                    false // revocable
                  );
                }}
              >
                Attest Anchor
              </button>
            </div>
          </div>
        </div>

        {/* TAG FORM */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Tag Schema</h2>
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
                <span className="label-text">Label (String/Hex)</span>
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
                    let labelBytes;
                    if (tagDef.startsWith("0x")) {
                      labelBytes = tagDef as `0x${string}`;
                    } else {
                      labelBytes = stringToHex(tagDef, { size: 32 });
                    }
                    // Schema: bytes32 labelUID, int256 weight
                    const encoded = encodeAbiParameters(
                      parseAbiParameters("bytes32, int256"),
                      [labelBytes, BigInt(tagWeight)]
                    );
                    attest(schemas.TAG, tagRef, encoded);
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

        {/* PROPERTY FORM (Smart) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Property Schema</h2>
            <div className="text-xs opacity-50 mb-2">Creates Anchor(Name) -&gt; Property(Value)</div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Target)</span>
              </label>
              <input
                type="text"
                value={propRef}
                onChange={e => setPropRef(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Name (New Anchor)</span>
              </label>
              <input
                type="text"
                value={propName}
                onChange={e => setPropName(e.target.value)}
                className="input input-bordered"
                placeholder="e.g. 'age' or 'title'"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Value (String)</span>
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
                  if (!propName) { notification.error("Name required"); return; }

                  // Step 1: Create Anchor
                  notification.info("Step 1/2: Creating Anchor...");
                  const anchorArgs = {
                    schema: schemas.ANCHOR as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: false,
                      refUID: (propRef || zeroHash) as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("string"), [propName]),
                      value: 0n,
                    },
                  };

                  const anchorUID = await attestWithArgs(anchorArgs);
                  if (!anchorUID) return;

                  // Step 2: Create Property
                  notification.info("Step 2/2: Creating Property...");
                  const propArgs = {
                    schema: schemas.PROPERTY as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: true,
                      refUID: anchorUID as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("string"), [propVal]),
                      value: 0n,
                    },
                  };
                  await attestWithArgs(propArgs);
                }}
              >
                Attest Property
              </button>
            </div>
          </div>
        </div>

        {/* DATA FORM (Smart) */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Data Schema</h2>
            <div className="text-xs opacity-50 mb-2">Creates Anchor(Name) -&gt; Data(Blob)</div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Target)</span>
              </label>
              <input
                type="text"
                value={dataRef}
                onChange={e => setDataRef(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Name (New Anchor)</span>
              </label>
              <input
                type="text"
                value={dataName}
                onChange={e => setDataName(e.target.value)}
                className="input input-bordered"
                placeholder="e.g. 'avatar' or 'document'"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Blob UID (bytes32)</span>
              </label>
              <input
                type="text"
                value={dataBlobUID}
                onChange={e => setDataBlobUID(e.target.value)}
                className="input input-bordered font-mono text-xs"
                placeholder="0x..."
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">File Mode (string)</span>
              </label>
              <input
                type="text"
                value={dataFileMode}
                onChange={e => setDataFileMode(e.target.value)}
                className="input input-bordered"
                placeholder="100644"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={async () => {
                  if (!dataName) { notification.error("Name required"); return; }
                  if (!dataBlobUID.startsWith("0x")) { notification.error("Blob UID must be 0x hex"); return; }

                  // Step 1: Create Anchor
                  notification.info("Step 1/2: Creating Anchor...");
                  const anchorArgs = {
                    schema: schemas.ANCHOR as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: false,
                      refUID: (dataRef || zeroHash) as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("string"), [dataName]),
                      value: 0n,
                    },
                  };

                  const anchorUID = await attestWithArgs(anchorArgs);
                  if (!anchorUID) return;

                  // Step 2: Create Data
                  notification.info("Step 2/2: Attaching Data...");
                  const dataArgs = {
                    schema: schemas.DATA as `0x${string}`,
                    data: {
                      recipient: zeroAddress,
                      expirationTime: 0n,
                      revocable: true,
                      refUID: anchorUID as `0x${string}`,
                      data: encodeAbiParameters(parseAbiParameters("bytes32, string"), [dataBlobUID as `0x${string}`, dataFileMode]),
                      value: 0n,
                    },
                  };
                  await attestWithArgs(dataArgs);
                }}
              >
                Attest Data
              </button>
            </div>
          </div>
        </div>

        {/* BLOB FORM */}
        <div className="card w-96 bg-base-100 shadow-xl border border-base-200">
          <div className="card-body">
            <h2 className="card-title">Blob Schema</h2>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Ref UID (Self/None)</span>
              </label>
              <input
                type="text"
                value={blobRef}
                onChange={e => setBlobRef(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Content Type</span>
              </label>
              <input
                type="text"
                value={blobType}
                onChange={e => setBlobType(e.target.value)}
                className="input input-bordered"
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text">Data (Text -&gt; Bytes)</span>
              </label>
              <textarea
                value={blobData}
                onChange={e => setBlobData(e.target.value)}
                className="textarea textarea-bordered h-24"
              />
            </div>
            <div className="card-actions justify-end mt-4">
              <button
                className="btn btn-primary"
                disabled={isPending}
                onClick={() => {
                  const bytes = toHex(blobData);
                  // Schema: bytes data, string contentType
                  attest(
                    schemas.BLOB,
                    blobRef,
                    encodeAbiParameters(parseAbiParameters("bytes, string"), [bytes, blobType]),
                  );
                }}
              >
                Attest Blob
              </button>
            </div>
          </div>
        </div>
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Added Anchors Column */}
        <SchemaList title="Anchors" schemaUID={schemas.ANCHOR} targetRef={targetUID} easAddress={easAddress} onFocus={setTargetUID} />
        <SchemaList title="Tags" schemaUID={schemas.TAG} targetRef={targetUID} easAddress={easAddress} onFocus={setTargetUID} />
        <SchemaList title="Properties" schemaUID={schemas.PROPERTY} targetRef={targetUID} easAddress={easAddress} onFocus={setTargetUID} />
        <SchemaList title="Data" schemaUID={schemas.DATA} targetRef={targetUID} easAddress={easAddress} onFocus={setTargetUID} />
        <SchemaList title="Blobs" schemaUID={schemas.BLOB} targetRef={targetUID} easAddress={easAddress} onFocus={setTargetUID} />
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
    args: [targetRef as `0x${string}`, schemaUID as `0x${string}`, 0n, 10n, false],
  });

  return (
    <div className="card bg-base-200 shadow-lg">
      <div className="card-body p-4">
        <h3 className="card-title text-sm">{title}</h3>
        {!uids || uids.length === 0 ? (
          <p className="text-xs opacity-50">No attestations found.</p>
        ) : (
          <div className="flex flex-col gap-2">
            // @ts-ignore
            {uids.map(uid => (
              <AttestationItem key={uid} uid={uid} title={title} easAddress={easAddress} onFocus={onFocus} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AttestationItem({ uid, title, easAddress, onFocus }: { uid: string; title: string; easAddress: string; onFocus: (uid: string) => void }) {
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
      // bytes32 blobUID, string fileMode
      const [blobId, mode] = decodeAbiParameters(parseAbiParameters("bytes32, string"), attestation.data);
      decodedValue = (
        <div className="flex flex-col gap-1">
          <div className="badge badge-sm badge-neutral">Mode: {mode}</div>
          <div className="text-xs break-all font-mono bg-base-300 p-1 rounded">Blob: {blobId.slice(0, 10)}...</div>
        </div>
      );
    } else if (title === "Blobs") {
      // bytes data, string contentType
      const [data, contentType] = decodeAbiParameters(parseAbiParameters("bytes, string"), attestation.data);
      decodedValue = (
        <div className="flex flex-col gap-1">
          <div className="badge badge-sm badge-info">{contentType}</div>
          <div className="text-xs opacity-50">{data.length / 2 - 1} bytes</div>
          <div className="text-xs break-all font-mono bg-base-300 p-1 rounded max-h-20 overflow-auto">
            {contentType.includes("text") ? hexToString(data) : data.slice(0, 50) + "..."}
          </div>
        </div>
      );
    } else if (title === "Anchors") {
      // string name
      const [name] = decodeAbiParameters(parseAbiParameters("string"), attestation.data);
      decodedValue = (
        <div className="flex justify-between items-center w-full">
          <span className="font-bold text-lg">{name}</span>
          <button className="btn btn-xs btn-outline" onClick={() => onFocus(uid)}>Focus</button>
        </div>
      )
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
