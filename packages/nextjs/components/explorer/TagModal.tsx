"use client";

import { useEffect, useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { TAG_RESOLVER_ABI, getTagResolverAddress } from "~~/utils/efs/tagResolver";
import { notification } from "~~/utils/scaffold-eth";

interface TagModalProps {
  uid: string; // The target anchor/attestation UID being tagged
  onClose: () => void;
}

export const TagModal = ({ uid, onClose }: TagModalProps) => {
  const [tagName, setTagName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tagDefinitions, setTagDefinitions] = useState<`0x${string}`[]>([]);
  const [tagResolverAddress, setTagResolverAddress] = useState<`0x${string}` | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient();

  const { data: anchorSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "ANCHOR_SCHEMA_UID",
  });

  const { data: rootAnchorUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "rootAnchorUID",
  });

  const { writeContractAsync: attest } = useScaffoldWriteContract("EAS");

  // Load TagResolver address
  useEffect(() => {
    if (!publicClient) return;
    getTagResolverAddress(publicClient.chain.id).then(setTagResolverAddress);
  }, [publicClient]);

  // Load tag definitions for this target via publicClient
  useEffect(() => {
    if (!publicClient || !tagResolverAddress || !uid) return;

    let cancelled = false;

    const load = async () => {
      try {
        const count = (await publicClient.readContract({
          address: tagResolverAddress,
          abi: TAG_RESOLVER_ABI,
          functionName: "getTagDefinitionCount",
          args: [uid as `0x${string}`],
        })) as bigint;

        if (count === 0n) {
          if (!cancelled) setTagDefinitions([]);
          return;
        }

        const defs = (await publicClient.readContract({
          address: tagResolverAddress,
          abi: TAG_RESOLVER_ABI,
          functionName: "getTagDefinitions",
          args: [uid as `0x${string}`, 0n, count > 200n ? 200n : count],
        })) as `0x${string}`[];

        if (!cancelled) setTagDefinitions([...defs]);
      } catch (e) {
        console.error("Failed to load tag definitions", e);
        if (!cancelled) setTagDefinitions([]);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [publicClient, tagResolverAddress, uid, refreshKey]);

  const handleAddTag = async (applies: boolean, existingDefinitionUID?: string) => {
    if (!anchorSchemaUID || !connectedAddress || !publicClient || !tagResolverAddress) return;
    setIsSubmitting(true);

    // Normalize tag names to lowercase so filter lookups (which also lowercase) always match
    const normalizedTagName = tagName.trim().toLowerCase();

    try {
      const { decodeEventLog, parseAbiItem } = await import("viem");

      let definitionUID = existingDefinitionUID;

      if (!definitionUID) {
        // Need to find or create an Anchor for this tag name
        if (!rootAnchorUID) {
          notification.error("Root anchor not found");
          setIsSubmitting(false);
          return;
        }

        const indexer = await import("~~/contracts/deployedContracts").then(m => {
          const chainId = publicClient.chain.id;
          return (m.default as any)[chainId]?.Indexer;
        });

        // Tag definition anchors are stored with the TagResolver address (left-padded
        // to bytes32) as their schemaUID marker.  This keeps them invisible to
        // resolvePath() (which always looks up bytes32(0)) so they never appear as
        // regular user-visible folders in the file browser.
        const tagDefSchemaUID = `0x${"0".repeat(24)}${tagResolverAddress.slice(2).toLowerCase()}` as `0x${string}`;

        if (indexer) {
          const existingUID = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "resolveAnchor",
            args: [rootAnchorUID as `0x${string}`, normalizedTagName, tagDefSchemaUID],
          })) as `0x${string}`;

          if (existingUID && existingUID !== zeroHash) {
            definitionUID = existingUID;
          }
        }

        if (!definitionUID) {
          // Create a new Anchor for this tag definition.
          // Use tagDefSchemaUID (not zeroHash) so the indexer stores it under a
          // separate key — invisible to resolvePath and filterable in the UI.
          const encodedName = encodeAbiParameters(parseAbiParameters("string name, bytes32 schemaUID"), [
            normalizedTagName,
            tagDefSchemaUID,
          ]);

          const txHash = await attest({
            functionName: "attest",
            args: [
              {
                schema: anchorSchemaUID,
                data: {
                  recipient: "0x0000000000000000000000000000000000000000",
                  expirationTime: 0n,
                  revocable: false,
                  refUID: rootAnchorUID as `0x${string}`,
                  data: encodedName,
                  value: 0n,
                },
              },
            ],
          });

          if (!txHash) throw new Error("Anchor creation failed");

          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

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
              definitionUID = (event.args as any).uid as string;
              break;
            } catch {
              // Not our event
            }
          }

          if (!definitionUID) throw new Error("Could not extract Anchor UID");
          notification.info(`Tag definition "${normalizedTagName}" created.`);
        }
      }

      // Compute TAG schema UID from TagResolver address
      const tagSchemaDefinition = "bytes32 definition, bool applies";
      const { ethers } = await import("ethers");
      const computedTagSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [tagSchemaDefinition, tagResolverAddress, true],
      );

      const encodedTagData = encodeAbiParameters(parseAbiParameters("bytes32 definition, bool applies"), [
        definitionUID as `0x${string}`,
        applies,
      ]);

      const tagTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: computedTagSchemaUID as `0x${string}`,
            data: {
              recipient: "0x0000000000000000000000000000000000000000",
              expirationTime: 0n,
              revocable: true,
              refUID: uid as `0x${string}`, // Target the item being tagged
              data: encodedTagData,
              value: 0n,
            },
          },
        ],
      });

      if (tagTxHash) {
        await publicClient.waitForTransactionReceipt({ hash: tagTxHash });
      }

      notification.success(applies ? "Tag applied!" : "Tag removed!");
      setTagName("");
      setRefreshKey(prev => prev + 1);
    } catch (e: any) {
      console.error("Error managing tag:", e);
      notification.error("Tag operation failed. Check console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-base-100 rounded-xl p-6 w-96 max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">Tags</h3>
          <button onClick={onClose} className="btn btn-ghost btn-circle btn-sm">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-grow overflow-y-auto mb-4 border border-base-300 rounded p-2 min-h-[100px]">
          {tagDefinitions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {tagDefinitions.map(defUID => (
                <TagDefinitionItem
                  key={`${defUID}-${refreshKey}`}
                  definitionUID={defUID}
                  targetUID={uid}
                  connectedAddress={connectedAddress}
                  tagResolverAddress={tagResolverAddress}
                  onRemove={() => handleAddTag(false, defUID)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-gray-500 text-center italic mt-4">No tags applied.</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <input
            type="text"
            placeholder="Tag name — auto-lowercased (e.g. favorites)"
            className="input input-bordered input-sm w-full"
            value={tagName}
            onChange={e => setTagName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && tagName) handleAddTag(true);
            }}
          />
          <button
            className="btn btn-primary btn-sm w-full"
            onClick={() => handleAddTag(true)}
            disabled={!tagName || isSubmitting}
          >
            <PlusIcon className="w-4 h-4 mr-1" />
            {isSubmitting ? "Processing..." : "Add Tag"}
          </button>
          <p className="text-xs text-opacity-50 text-base-content mt-1">
            New tag names create an Anchor under root (extra transaction).
          </p>
        </div>
      </div>
    </div>
  );
};

const TagDefinitionItem = ({
  definitionUID,
  targetUID,
  connectedAddress,
  tagResolverAddress,
  onRemove,
}: {
  definitionUID: `0x${string}`;
  targetUID: string;
  connectedAddress: string | undefined;
  tagResolverAddress: `0x${string}` | undefined;
  onRemove: () => void;
}) => {
  const publicClient = usePublicClient();

  const { data: attestation } = useScaffoldReadContract({
    contractName: "EAS",
    functionName: "getAttestation",
    args: [definitionUID],
  });

  const [tagName, setTagName] = useState<string | null>(null);
  const [isActive, setIsActive] = useState<boolean>(false);

  useEffect(() => {
    if (attestation?.data) {
      try {
        const [name] = decodeAbiParameters(
          parseAbiParameters("string name, bytes32 schemaUID"),
          attestation.data as `0x${string}`,
        );
        setTagName(name);
      } catch {
        setTagName(`#${definitionUID.slice(0, 8)}`);
      }
    }
  }, [attestation, definitionUID]);

  // Check active tag via publicClient
  useEffect(() => {
    if (!publicClient || !tagResolverAddress || !connectedAddress) {
      setIsActive(false);
      return;
    }

    let cancelled = false;

    const check = async () => {
      try {
        const activeUID = (await publicClient.readContract({
          address: tagResolverAddress,
          abi: TAG_RESOLVER_ABI,
          functionName: "getActiveTagUID",
          args: [connectedAddress as `0x${string}`, targetUID as `0x${string}`, definitionUID],
        })) as `0x${string}`;

        if (!activeUID || activeUID === zeroHash) {
          if (!cancelled) setIsActive(false);
          return;
        }

        // Fetch the active tag attestation to check applies boolean
        const activeAttestation = (await publicClient.readContract({
          address: (await import("~~/contracts/deployedContracts").then(m => {
            const chainId = publicClient.chain.id;
            return (m.default as any)[chainId]?.EAS?.address;
          })) as `0x${string}`,
          abi: [
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
          ] as const,
          functionName: "getAttestation",
          args: [activeUID],
        })) as any;

        if (activeAttestation?.data) {
          const [, appliesVal] = decodeAbiParameters(
            parseAbiParameters("bytes32 definition, bool applies"),
            activeAttestation.data as `0x${string}`,
          );
          if (!cancelled) setIsActive(appliesVal);
        }
      } catch (e) {
        console.error("Failed to check active tag", e);
        if (!cancelled) setIsActive(false);
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [publicClient, tagResolverAddress, connectedAddress, targetUID, definitionUID]);

  return (
    <li className="bg-base-200 p-2 rounded text-sm flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`badge badge-sm ${isActive ? "badge-primary" : "badge-ghost"}`}>{tagName || "..."}</span>
        {isActive && <span className="text-xs text-success">active</span>}
      </div>
      {isActive && (
        <button className="btn btn-ghost btn-xs text-error" onClick={onRemove} title="Remove tag">
          <XMarkIcon className="w-3 h-3" />
        </button>
      )}
    </li>
  );
};
