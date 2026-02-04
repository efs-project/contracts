"use client";

import { useState } from "react";
import { decodeEventLog, parseAbiItem, zeroHash } from "viem";
import { usePublicClient } from "wagmi";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

interface PropertiesModalProps {
    uid: string;
    onClose: () => void;
}

export const PropertiesModal = ({ uid, onClose }: PropertiesModalProps) => {
    const [propName, setPropName] = useState("");
    const [propValue, setPropValue] = useState("");

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    const { data: anchorSchemaUID } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "ANCHOR_SCHEMA_UID",
    });

    const { data: dataSchemaUID } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "DATA_SCHEMA_UID",
    });

    const { data: propertySchemaUID } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "PROPERTY_SCHEMA_UID",
    });

    // Fetch Children (Anchors) via EFSFileView
    const { data: fileSystemItems, refetch } = useScaffoldReadContract({
        contractName: "EFSFileView",
        functionName: "getDirectoryPage",
        args: [uid as `0x${string}`, 0n, 100n, dataSchemaUID || zeroHash, propertySchemaUID || zeroHash],
        query: {
            enabled: !!uid && !!dataSchemaUID && !!propertySchemaUID,
        },
    });

    const { writeContractAsync: attest } = useScaffoldWriteContract("EAS");
    const publicClient = usePublicClient();

    const handleAddProperty = async () => {
        if (!anchorSchemaUID || !propertySchemaUID) return;
        setIsSubmitting(true);

        try {
            const { encodeAbiParameters, parseAbiParameters } = await import("viem");

            // 1. Find or Create Anchor (Key)
            console.log("Searching for anchor with name:", propName);
            let targetAnchorUID = fileSystemItems?.find(item => item.name === propName)?.uid;
            console.log("Found targetAnchorUID:", targetAnchorUID);

            if (!targetAnchorUID) {
                // Create Anchor
                const encodedName = encodeAbiParameters(parseAbiParameters("string name"), [propName]);

                const txHash = await attest({
                    functionName: "attest",
                    args: [
                        {
                            schema: anchorSchemaUID,
                            data: {
                                recipient: "0x0000000000000000000000000000000000000000",
                                expirationTime: 0n,
                                revocable: false,
                                refUID: uid as `0x${string}`,
                                data: encodedName,
                                value: 0n,
                            },
                        },
                    ],
                });

                // We'd need to wait and get the UID, but EAS attest returns tx hash.
                // In a real app we parse logs.
                // For this MVP, we might need the user to reload or we optimistically wait.
                notification.info("Creating Property Key... Please confirm transaction.");

                // Wait for receipt to get the UID immediately
                if (!txHash) return;
                const receipt = await publicClient?.waitForTransactionReceipt({ hash: txHash });

                if (!receipt) {
                    notification.error("Transaction failed or timed out.");
                    setIsSubmitting(false);
                    return;
                }

                // Parse Log to find Attested(uid, ...)
                // Event: Attested(bytes32 indexed uid, bytes32 indexed schema, address indexed attester, address recipient)
                // We look for the log that matches our anchor creation.
                // Since this is the only event we triggered, we can look for it.
                // Topic 0 for Attested is: 0xf39e6e1eb0edcf53c221607b54b00cd28f3196fed0a949d46a41bd5843295864 (but better to use decode)

                let newAnchorUID: `0x${string}` | undefined;

                for (const log of receipt.logs) {
                    try {
                        const event = decodeEventLog({
                            abi: [
                                parseAbiItem(
                                    "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
                                ),
                            ],
                            data: log.data,
                            topics: log.topics,
                        });
                        newAnchorUID = (event.args as any).uid as `0x${string}`;
                        break;
                    } catch {
                        // Not our event
                    }
                }

                if (!newAnchorUID) {
                    notification.error("Could not retrieve new Anchor UID from receipt.");
                    setIsSubmitting(false);
                    return;
                }

                console.log("Extracted new Anchor UID:", newAnchorUID);
                targetAnchorUID = newAnchorUID;
                notification.success("Key created! Automatically proving value...");
                // Proceed to Step 2 automatically
            }

            // 2. Create Property Value
            const encodedValue = encodeAbiParameters(parseAbiParameters("string value"), [propValue]);

            await attest({
                functionName: "attest",
                args: [
                    {
                        schema: propertySchemaUID,
                        data: {
                            recipient: "0x0000000000000000000000000000000000000000",
                            expirationTime: 0n,
                            revocable: true,
                            refUID: targetAnchorUID as unknown as `0x${string}`,
                            data: encodedValue,
                            value: 0n,
                        },
                    },
                ],
            });

            notification.success("Property value added successfully!");
            setPropName("");
            setPropValue("");
            setRefreshKey(prev => prev + 1);
            refetch();
        } catch (e: any) {
            console.error("Error adding property:", e);
            if (e.message?.includes("DuplicateFileName")) {
                notification.error("Error: Key exists but list wasn't updated. Please wait a moment and try again.");
            } else {
                notification.error("Error adding property. Check console.");
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    // Filter items that are properties (have property attestations or are just intended to be?)
    // In this model, ANY anchor could be a property.
    // We should show items that HAVE properties, or just all children?
    // If I mix Folders and Properties, it's confusing.
    // I'll show items with propertyCount > 0 OR items that match our "property" heuristic.
    // For now, let's show items with propertyCount > 0.
    // Filter items: Show items that HAVE properties OR are empty anchors (potential properties)
    // We hide items that are definitely Files (hasData) or Populated Folders (childCount > 0), unless they already have properties.
    const propertyItems =
        fileSystemItems?.filter(item => item.propertyCount > 0n || (!item.hasData && item.childCount === 0n)) || [];

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-base-100 rounded-xl p-6 w-96 max-h-[80vh] flex flex-col shadow-2xl">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold">Properties</h3>
                    <button onClick={onClose} className="btn btn-ghost btn-circle btn-sm">
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-grow overflow-y-auto mb-4 border border-base-300 rounded p-2 min-h-[100px]">
                    {propertyItems.length > 0 ? (
                        <ul className="flex flex-col gap-2">
                            {propertyItems.map(item => (
                                <PropertyAnchorItem
                                    key={`${item.uid}-${refreshKey}`}
                                    item={item}
                                    propertySchemaUID={propertySchemaUID}
                                />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-gray-500 text-center italic mt-4">No properties found.</p>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <input
                        type="text"
                        placeholder="Key (e.g. Color)"
                        className="input input-bordered input-sm w-full"
                        value={propName}
                        onChange={e => setPropName(e.target.value)}
                    />
                    <input
                        type="text"
                        placeholder="Value (e.g. Red)"
                        className="input input-bordered input-sm w-full"
                        value={propValue}
                        onChange={e => setPropValue(e.target.value)}
                    />
                    <button
                        className="btn btn-primary btn-sm w-full"
                        onClick={handleAddProperty}
                        disabled={!propName || !propValue || isSubmitting}
                    >
                        <PlusIcon className="w-4 h-4 mr-1" />
                        {isSubmitting ? "Processing..." : "Add Property"}
                    </button>
                    <p className="text-xs text-opacity-50 text-base-content mt-1">
                        Note: First-time keys require an extra transaction (Anchor creation).
                    </p>
                </div>
            </div>
        </div>
    );
};

// Item Component: Renders "Key: Value" on a single line
const PropertyAnchorItem = ({ item, propertySchemaUID }: { item: any; propertySchemaUID: string | undefined }) => {
    const { data: valueUIDs, isLoading } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "getReferencingAttestations",
        args: [item.uid as `0x${string}`, (propertySchemaUID || zeroHash) as `0x${string}`, 0n, 50n, true],
        query: {
            enabled: !!item.uid && !!propertySchemaUID,
        },
    });

    return (
        <li className="bg-base-200 p-2 rounded text-sm mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2 overflow-hidden">
                <span className="font-bold whitespace-nowrap">{item.name}:</span>
                {isLoading ? (
                    <span className="loading loading-dots loading-xs"></span>
                ) : valueUIDs && valueUIDs.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                        {valueUIDs.map((uid: string) => (
                            <PropertyValueItem key={uid} uid={uid} />
                        ))}
                    </div>
                ) : (
                    <span className="text-gray-400 italic text-xs">Empty</span>
                )}
            </div>
            {/* Debug UID tooltip or hidden */}
            <span className="text-[10px] text-gray-300 ml-2" title={item.uid}>
                #{item.uid.slice(0, 4)}
            </span>
        </li>
    );
};

const PropertyValueItem = ({ uid }: { uid: string }) => {
    const { data: attestation } = useScaffoldReadContract({
        contractName: "EAS",
        functionName: "getAttestation",
        args: [uid as `0x${string}`],
    });

    if (!attestation) return <span className="opacity-50">...</span>;
    return <PropertyValueDecoded data={attestation.data} />;
};

const PropertyValueDecoded = ({ data }: { data: string }) => {
    const [value, setValue] = useState<string | null>(null);

    useState(() => {
        const decode = async () => {
            try {
                const { decodeAbiParameters, parseAbiParameters } = await import("viem");
                const [v] = decodeAbiParameters(parseAbiParameters("string value"), data as `0x${string}`);
                setValue(v);
            } catch (e) {
                console.error("Decode failed", e);
            }
        };
        decode();
    });

    if (value === null) return <span>?</span>;
    return <span className="badge badge-sm badge-neutral">{value}</span>;
};
