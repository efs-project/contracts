"use client";

import { useEffect, useState } from "react";
import { decodeEventLog, encodeAbiParameters, parseAbiItem, parseAbiParameters, zeroAddress, zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { notification } from "~~/utils/scaffold-eth";

interface PropertiesModalProps {
  uid: string;
  onClose: () => void;
}

/**
 * PROPERTY CRUD modal. Per ADR-0035 PROPERTY is free-floating
 * (refUID=0x0, non-revocable) and placed on a container via the unified
 * hierarchy:
 *
 *   Container → Anchor<PROPERTY>(name=key) → TAG(applies=true) → PROPERTY(value)
 *
 * Writes take three attestations: (1) key anchor, if missing, (2) the new
 * PROPERTY value, (3) a TAG binding the PROPERTY to the key anchor. The TAG is
 * the singleton — re-attesting supersedes; revoking it removes the binding
 * without touching the immutable PROPERTY.
 *
 * Reads use TagResolver._activeByAAS as the per-attester singleton index:
 * getActiveTargetsByAttesterAndSchema(keyAnchor, attester, PROPERTY_SCHEMA_UID).
 */
export const PropertiesModal = ({ uid, onClose }: PropertiesModalProps) => {
  const [propName, setPropName] = useState("");
  const [propValue, setPropValue] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient();

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

  const { data: tagResolverInfo } = useDeployedContractInfo({ contractName: "TagResolver" });
  const tagResolverAddress = tagResolverInfo?.address as `0x${string}` | undefined;

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

  const handleAddProperty = async () => {
    if (!anchorSchemaUID || !propertySchemaUID || !tagResolverAddress || !publicClient) return;
    setIsSubmitting(true);

    const ops = useBackgroundOps.getState();
    const opId = ops.start(`Set property: ${propName} = ${propValue}`);

    try {
      // 1. Find or create the key anchor under the container.
      //    Anchor<PROPERTY>(refUID=uid, name=propName, schemaUID=PROPERTY_SCHEMA_UID).
      let keyAnchorUID = fileSystemItems?.find(item => item.name === propName && item.schema === propertySchemaUID)
        ?.uid as `0x${string}` | undefined;

      if (!keyAnchorUID) {
        const encodedName = encodeAbiParameters(parseAbiParameters("string name, bytes32 schemaUID"), [
          propName,
          propertySchemaUID as `0x${string}`,
        ]);

        ops.log(opId, "Creating property key anchor...");
        const anchorTxHash = await attest(
          {
            functionName: "attest",
            args: [
              {
                schema: anchorSchemaUID,
                data: {
                  recipient: zeroAddress,
                  expirationTime: 0n,
                  revocable: false,
                  refUID: uid as `0x${string}`,
                  data: encodedName,
                  value: 0n,
                },
              },
            ],
          },
          { silent: true },
        );

        if (!anchorTxHash) {
          ops.fail(opId, "Key anchor attestation aborted.");
          setIsSubmitting(false);
          return;
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash: anchorTxHash });
        if (!receipt) {
          const msg = "Transaction failed or timed out.";
          notification.error(msg);
          ops.fail(opId, msg);
          setIsSubmitting(false);
          return;
        }

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
            keyAnchorUID = (event.args as any).uid as `0x${string}`;
            break;
          } catch {
            // Not our event
          }
        }

        if (!keyAnchorUID) {
          const msg = "Could not retrieve new key anchor UID from receipt.";
          notification.error(msg);
          ops.fail(opId, msg);
          setIsSubmitting(false);
          return;
        }
        ops.log(opId, "Key anchor created.");
      }

      // 2. Attest a free-floating PROPERTY(value=propValue).
      const encodedValue = encodeAbiParameters(parseAbiParameters("string value"), [propValue]);

      ops.log(opId, "Attesting PROPERTY value...");
      const propertyTxHash = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: propertySchemaUID,
              data: {
                recipient: zeroAddress,
                expirationTime: 0n,
                revocable: false,
                refUID: zeroHash,
                data: encodedValue,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (!propertyTxHash) {
        ops.fail(opId, "PROPERTY attestation aborted.");
        setIsSubmitting(false);
        return;
      }
      const propReceipt = await publicClient.waitForTransactionReceipt({ hash: propertyTxHash });

      let propertyUID: `0x${string}` | undefined;
      for (const log of propReceipt.logs) {
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
          propertyUID = (event.args as any).uid as `0x${string}`;
          break;
        } catch {
          // Not our event
        }
      }
      if (!propertyUID) {
        const msg = "Could not retrieve new PROPERTY UID from receipt.";
        notification.error(msg);
        ops.fail(opId, msg);
        setIsSubmitting(false);
        return;
      }

      // 3. Attest TAG(definition=keyAnchor, refUID=property, applies=true).
      //    TAG_SCHEMA_UID is derived from the resolver address per EAS.
      const { ethers } = await import("ethers");
      const tagSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["bytes32 definition, bool applies", tagResolverAddress, true],
      ) as `0x${string}`;

      const encodedTagData = encodeAbiParameters(parseAbiParameters("bytes32 definition, bool applies"), [
        keyAnchorUID,
        true,
      ]);

      ops.log(opId, "Binding TAG...");
      const tagTxHash = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: tagSchemaUID,
              data: {
                recipient: zeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: propertyUID,
                data: encodedTagData,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (tagTxHash) await publicClient.waitForTransactionReceipt({ hash: tagTxHash });

      notification.success("Property added.");
      ops.complete(opId, "Property added.");
      setPropName("");
      setPropValue("");
      setRefreshKey(prev => prev + 1);
      refetch();
    } catch (e: any) {
      console.error("Error adding property:", e);
      const msg = e.message?.includes("DuplicateFileName")
        ? "Error: Key exists but list wasn't updated. Please wait a moment and try again."
        : "Error adding property. Check console.";
      notification.error(msg);
      ops.fail(opId, msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Show anchors that are PROPERTY key anchors (schemaUID field = PROPERTY schema).
  const propertyItems = fileSystemItems?.filter(item => item.schema === propertySchemaUID) || [];

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
                  tagResolverAddress={tagResolverAddress}
                  viewer={connectedAddress}
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
            New keys take three transactions (key anchor + property + tag); existing keys take two.
          </p>
        </div>
      </div>
    </div>
  );
};

// Item Component: renders "Key: ConnectedUserValue" on a single line.
// Walks TagResolver._activeByAAS[keyAnchor][viewer][PROPERTY_SCHEMA] to get the
// viewer's current PROPERTY under this key. Edition-scoped lookups (non-viewer
// attesters) belong on the read-side viewing UIs, not this write-side modal.
const PropertyAnchorItem = ({
  item,
  propertySchemaUID,
  tagResolverAddress,
  viewer,
}: {
  item: any;
  propertySchemaUID: string | undefined;
  tagResolverAddress: `0x${string}` | undefined;
  viewer: `0x${string}` | undefined;
}) => {
  const { data: activeTargets, isLoading } = useScaffoldReadContract({
    contractName: "TagResolver",
    functionName: "getActiveTargetsByAttesterAndSchema",
    args: [
      item.uid as `0x${string}`,
      (viewer ?? zeroAddress) as `0x${string}`,
      (propertySchemaUID || zeroHash) as `0x${string}`,
      0n,
      1n,
    ],
    query: {
      enabled: !!item.uid && !!propertySchemaUID && !!tagResolverAddress && !!viewer,
    },
  });

  const activeUID = activeTargets && activeTargets.length > 0 ? (activeTargets[0] as `0x${string}`) : null;

  return (
    <li className="bg-base-200 p-2 rounded text-sm mb-1 flex items-center justify-between">
      <div className="flex items-center gap-2 overflow-hidden">
        <span className="font-bold whitespace-nowrap">{item.name}:</span>
        {isLoading ? (
          <span className="loading loading-dots loading-xs"></span>
        ) : activeUID ? (
          <PropertyValueItem uid={activeUID} />
        ) : (
          <span className="text-gray-400 italic text-xs">Empty</span>
        )}
      </div>
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

  useEffect(() => {
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
  }, [data]);

  if (value === null) return <span>?</span>;
  return <span className="badge badge-sm badge-neutral">{value}</span>;
};
