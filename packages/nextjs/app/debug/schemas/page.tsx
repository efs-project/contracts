"use client";

import { useEffect, useState } from "react";
import { encodeAbiParameters, parseAbiParameters, stringToHex, toHex, zeroAddress, zeroHash, decodeAbiParameters, decodeEventLog, hexToString } from "viem";
import { useWriteContract, useReadContract, usePublicClient } from "wagmi";
import { notification } from "~~/utils/scaffold-eth";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useSchemaRegistry, SCHEMA_DEFS } from "~~/hooks/efs/useSchemaRegistry";

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
            { indexed: true, internalType: "bytes32", name: "schemaUID", type: "bytes32" }
        ],
        name: "Attested",
        type: "event"
    },
    {
        inputs: [{ name: "uid", type: "bytes32" }],
        name: "getAttestation",
        outputs: [{
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
        }],
        stateMutability: "view",
        type: "function",
    }
] as const;

export default function DebugSchemas() {
    const { writeContractAsync, isPending } = useWriteContract();
    const publicClient = usePublicClient();
    const registry = useSchemaRegistry();

    // State for forms
    const [tagRef, setTagRef] = useState("");
    const [tagDef, setTagDef] = useState("");

    const [propRef, setPropRef] = useState("");
    const [propVal, setPropVal] = useState("");

    const [fileRef, setFileRef] = useState("");
    const [fileType, setFileType] = useState("1");
    const [fileData, setFileData] = useState("");

    const [blobRef, setBlobRef] = useState("");
    const [blobType, setBlobType] = useState("text/plain");
    const [blobData, setBlobData] = useState("");

    const [lastTxHash, setLastTxHash] = useState("");

    // Initialize/Update form refs when rootTopicUid loads
    useEffect(() => {
        if (registry.rootTopicUid && registry.rootTopicUid !== zeroHash) {
            if (!tagRef || tagRef === zeroHash) setTagRef(registry.rootTopicUid);
            if (!propRef || propRef === zeroHash) setPropRef(registry.rootTopicUid);
            if (!fileRef || fileRef === zeroHash) setFileRef(registry.rootTopicUid);
            if (!blobRef || blobRef === zeroHash) setBlobRef(registry.rootTopicUid);
        }
    }, [registry.rootTopicUid]);


    const attest = async (schemaUID: string, refUID: string, data: `0x${string}`) => {
        if (!registry.easAddress) {
            notification.error("EAS Address not found");
            return;
        }

        try {
            const tx = await writeContractAsync({
                address: registry.easAddress as `0x${string}`,
                abi: EAS_ABI,
                functionName: "attest",
                args: [
                    {
                        schema: schemaUID as `0x${string}`,
                        data: {
                            recipient: zeroAddress,
                            expirationTime: 0n,
                            revocable: true,
                            refUID: (refUID || zeroHash) as `0x${string}`,
                            data: data,
                            value: 0n,
                        },
                    },
                ],
            });
            setLastTxHash(tx);
            console.log("Attested!", tx);
            notification.info("Attestation submitted. Waiting for confirmation...");

            if (!publicClient) return;

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

            if (uid && registry.indexerAddress && registry.indexerAbi) {
                console.log("Found UID:", uid);
                notification.info("Indexing attestation...");

                await writeContractAsync({
                    address: registry.indexerAddress as `0x${string}`,
                    abi: registry.indexerAbi,
                    functionName: "indexAttestation",
                    args: [uid as `0x${string}`],
                });
                notification.success("Attestation indexed successfully!");
            } else {
                console.error("Could not find UID in logs or Indexer missing");
                notification.warning("Could not find UID to index.");
            }

        } catch (e) {
            console.error("Attestation failed", e);
            notification.error("Attestation failed");
        }
    };

    if (!registry.schemas || !registry.rootTopicUid || !registry.easAddress || !registry.indexerAddress) {
        return <div className="flex justify-center p-10"><span className="loading loading-spinner loading-lg"></span></div>;
    }

    // Extract guarded constants for type safety in callbacks
    const schemas = registry.schemas;
    const rootTopicUid = registry.rootTopicUid;
    const easAddress = registry.easAddress;

    return (
        <div className="flex flex-col items-center justify-center py-8 gap-8">
            <h1 className="text-4xl font-bold">Debug Schemas</h1>

            <div className="text-xs font-mono opacity-50 flex flex-col items-center gap-1">
                <div>Topic Root: {rootTopicUid}</div>
                <div>EAS: {easAddress}</div>
            </div>

            {lastTxHash && (
                <div className="alert alert-success max-w-2xl">
                    <span>Success! Tx: {lastTxHash}</span>
                </div>
            )}

            <div className="flex flex-wrap gap-4 justify-center">
                {/* TAG FORM */}
                <div className="card w-96 bg-base-100 shadow-xl">
                    <div className="card-body">
                        <h2 className="card-title">Tag Schema</h2>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Ref UID (Topic)</span></label>
                            <input type="text" value={tagRef} onChange={e => setTagRef(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Definition (String -&gt; Bytes32)</span></label>
                            <input type="text" value={tagDef} onChange={e => setTagDef(e.target.value)} className="input input-bordered" placeholder="e.g. 'verified'" />
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button
                                className="btn btn-primary"
                                disabled={isPending}
                                onClick={() => {
                                    let encoded;
                                    try {
                                        if (tagDef.startsWith("0x")) {
                                            encoded = encodeAbiParameters(parseAbiParameters("bytes32"), [tagDef as `0x${string}`]);
                                        } else {
                                            const hex = stringToHex(tagDef, { size: 32 });
                                            encoded = encodeAbiParameters(parseAbiParameters("bytes32"), [hex]);
                                        }
                                        attest(schemas.TAG, tagRef, encoded);
                                    } catch (e) { console.error(e); }
                                }}
                            >
                                Attest Tag
                            </button>
                        </div>
                    </div>
                </div>

                {/* PROPERTY FORM */}
                <div className="card w-96 bg-base-100 shadow-xl">
                    <div className="card-body">
                        <h2 className="card-title">Property Schema</h2>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Ref UID (Anchor)</span></label>
                            <input type="text" value={propRef} onChange={e => setPropRef(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Value (String)</span></label>
                            <input type="text" value={propVal} onChange={e => setPropVal(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button
                                className="btn btn-primary"
                                disabled={isPending}
                                onClick={() => attest(schemas.PROPERTY, propRef, encodeAbiParameters(parseAbiParameters("string"), [propVal]))}
                            >
                                Attest Property
                            </button>
                        </div>
                    </div>
                </div>

                {/* FILE FORM */}
                <div className="card w-96 bg-base-100 shadow-xl">
                    <div className="card-body">
                        <h2 className="card-title">File Schema</h2>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Ref UID</span></label>
                            <input type="text" value={fileRef} onChange={e => setFileRef(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Type (uint8)</span></label>
                            <input type="number" value={fileType} onChange={e => setFileType(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Data (String/CID)</span></label>
                            <input type="text" value={fileData} onChange={e => setFileData(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button
                                className="btn btn-primary"
                                disabled={isPending}
                                onClick={() => attest(schemas.FILE, fileRef, encodeAbiParameters(parseAbiParameters("uint8, string"), [parseInt(fileType), fileData]))}
                            >
                                Attest File
                            </button>
                        </div>
                    </div>
                </div>

                {/* BLOB FORM */}
                <div className="card w-96 bg-base-100 shadow-xl">
                    <div className="card-body">
                        <h2 className="card-title">Blob Schema</h2>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Ref UID</span></label>
                            <input type="text" value={blobRef} onChange={e => setBlobRef(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Content Type</span></label>
                            <input type="text" value={blobType} onChange={e => setBlobType(e.target.value)} className="input input-bordered" />
                        </div>
                        <div className="form-control">
                            <label className="label"><span className="label-text">Data (Text -&gt; Bytes)</span></label>
                            <textarea value={blobData} onChange={e => setBlobData(e.target.value)} className="textarea textarea-bordered h-24" />
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button
                                className="btn btn-primary"
                                disabled={isPending}
                                onClick={() => {
                                    const bytes = toHex(blobData);
                                    attest(schemas.BLOB, blobRef, encodeAbiParameters(parseAbiParameters("bytes, string"), [bytes, blobType]));
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

function AttestationViewer({ rootUid, schemas, easAddress }: { rootUid: string, schemas: any, easAddress: string }) {
    const [targetUID, setTargetUID] = useState(rootUid);

    return (
        <div className="flex flex-col gap-6 w-full max-w-6xl">
            <div className="flex flex-col gap-2">
                <label className="text-lg font-bold">Target Topic/Anchor UID</label>
                <input
                    type="text"
                    value={targetUID}
                    onChange={e => setTargetUID(e.target.value)}
                    className="input input-bordered w-full font-mono"
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <SchemaList title="Tags" schemaUID={schemas.TAG} targetRef={targetUID} easAddress={easAddress} />
                <SchemaList title="Properties" schemaUID={schemas.PROPERTY} targetRef={targetUID} easAddress={easAddress} />
                <SchemaList title="Files" schemaUID={schemas.FILE} targetRef={targetUID} easAddress={easAddress} />
                <SchemaList title="Blobs" schemaUID={schemas.BLOB} targetRef={targetUID} easAddress={easAddress} />
            </div>
        </div>
    );
}

function SchemaList({ title, schemaUID, targetRef, easAddress }: { title: string, schemaUID: string, targetRef: string, easAddress: string }) {
    // Fetch UIDs
    const { data: uids } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "getReferencingAttestationUIDs",
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
                        {uids.map(uid => (
                            <AttestationItem key={uid} uid={uid} title={title} easAddress={easAddress} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function AttestationItem({ uid, title, easAddress }: { uid: string, title: string, easAddress: string }) {
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
            const [val] = decodeAbiParameters(parseAbiParameters("bytes32"), attestation.data);
            try {
                const asString = hexToString(val, { size: 32 }).replace(/\0/g, '');
                decodedValue = <span>{asString} <span className="text-xs opacity-50 block font-mono">({val})</span></span>;
            } catch {
                decodedValue = <span className="font-mono">{val}</span>;
            }
        } else if (title === "Properties") {
            const [val] = decodeAbiParameters(parseAbiParameters("string"), attestation.data);
            decodedValue = <span>{val}</span>;
        } else if (title === "Files") {
            const [t, d] = decodeAbiParameters(parseAbiParameters("uint8, string"), attestation.data);
            decodedValue = (
                <div className="flex flex-col gap-1">
                    <div className="badge badge-sm badge-neutral">Type: {t}</div>
                    <div className="text-xs break-all font-mono bg-base-300 p-1 rounded">{d}</div>
                </div>
            );
        } else if (title === "Blobs") {
            const [data, contentType] = decodeAbiParameters(parseAbiParameters("bytes, string"), attestation.data);
            decodedValue = (
                <div className="flex flex-col gap-1">
                    <div className="badge badge-sm badge-info">{contentType}</div>
                    <div className="text-xs opacity-50">{data.length / 2 - 1} bytes</div>
                    <div className="text-xs break-all font-mono bg-base-300 p-1 rounded max-h-20 overflow-auto">
                        {/* Try to show as string if text, else hex snippet */}
                        {contentType.includes("text") ? hexToString(data) : data.slice(0, 50) + "..."}
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
                <div className="font-mono font-bold text-xxs opacity-50" title={uid}>{uid.slice(0, 6)}...{uid.slice(-4)}</div>
            </div>
            <div className="font-semibold text-primary">{decodedValue}</div>
        </div>
    );
}
