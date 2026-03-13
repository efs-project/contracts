"use client";

import { useEffect, useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { TAG_RESOLVER_ABI, getTagResolverAddress } from "~~/utils/efs/tagResolver";
import { notification } from "~~/utils/scaffold-eth";

interface TagModalProps {
  uid: string; // The anchor UID of the item being tagged
  isFile?: boolean; // When true, tags are attached to the connected user's DATA attestation for this anchor
  onClose: () => void;
  /** Called after any successful tag add or remove so the parent can refresh filtered results. */
  onTagChange?: () => void;
}

export const TagModal = ({ uid, isFile, onClose, onTagChange }: TagModalProps) => {
  const [tagName, setTagName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tagDefinitions, setTagDefinitions] = useState<`0x${string}`[]>([]);
  const [tagResolverAddress, setTagResolverAddress] = useState<`0x${string}` | undefined>();
  const [tagsRoot, setTagsRoot] = useState<`0x${string}` | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  // effectiveUID: for files this is the DATA attestation UID (edition-specific);
  // for folders it stays as the anchor UID. Tags on DATA UIDs are per-user per-edition.
  const [effectiveUID, setEffectiveUID] = useState<string>(uid);
  // True while the async DATA UID lookup is in flight for file items.
  // Submission is blocked until this resolves so we never accidentally tag the anchor UID.
  const [isResolvingDataUID, setIsResolvingDataUID] = useState(!!isFile);

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

  // Single EAS write hook used for both attest (add tag) and revoke (remove tag).
  const { writeContractAsync: easWrite } = useScaffoldWriteContract("EAS");

  // For file items: resolve the connected user's DATA attestation UID for this anchor.
  // Tags are applied to the DATA UID so that user A's edition can be tagged "nsfw"
  // while user B's edition of the same filename is not.
  useEffect(() => {
    if (!isFile || !publicClient || !connectedAddress) {
      setEffectiveUID(uid);
      setIsResolvingDataUID(false);
      return;
    }

    let cancelled = false;
    setIsResolvingDataUID(true);

    const resolve = async () => {
      try {
        const indexer = await import("~~/contracts/deployedContracts").then(m => {
          return (m.default as any)[publicClient.chain.id]?.Indexer;
        });
        if (!indexer) {
          if (!cancelled) {
            setEffectiveUID(uid);
            setIsResolvingDataUID(false);
          }
          return;
        }

        const dataUID = (await publicClient.readContract({
          address: indexer.address as `0x${string}`,
          abi: indexer.abi,
          functionName: "getDataByAddressList",
          args: [uid as `0x${string}`, [connectedAddress], false],
        })) as `0x${string}`;

        if (!cancelled) {
          setEffectiveUID(dataUID && dataUID !== zeroHash ? dataUID : uid);
          setIsResolvingDataUID(false);
        }
      } catch {
        if (!cancelled) {
          setEffectiveUID(uid);
          setIsResolvingDataUID(false);
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [uid, isFile, publicClient, connectedAddress]);

  // Load TagResolver address and the "tags" anchor UID (discovered from the normal tree).
  useEffect(() => {
    if (!publicClient || !rootAnchorUID) return;
    getTagResolverAddress(publicClient.chain.id).then(async addr => {
      if (!addr) return;
      setTagResolverAddress(addr);
      // "tags" is a normal anchor under root — discovered the same way any folder is.
      const indexer = await import("~~/contracts/deployedContracts").then(m => {
        return (m.default as any)[publicClient.chain.id]?.Indexer;
      });
      if (!indexer) return;
      const tagsUID = (await publicClient.readContract({
        address: indexer.address as `0x${string}`,
        abi: indexer.abi,
        functionName: "resolvePath",
        args: [rootAnchorUID as `0x${string}`, "tags"],
      })) as `0x${string}`;
      if (tagsUID && tagsUID !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        setTagsRoot(tagsUID);
      }
    });
  }, [publicClient, rootAnchorUID]);

  // Load tag definitions that have been applied to effectiveUID by anyone.
  useEffect(() => {
    if (!publicClient || !tagResolverAddress || !effectiveUID) return;

    let cancelled = false;

    const load = async () => {
      try {
        const count = (await publicClient.readContract({
          address: tagResolverAddress,
          abi: TAG_RESOLVER_ABI,
          functionName: "getTagDefinitionCount",
          args: [effectiveUID as `0x${string}`],
        })) as bigint;

        if (count === 0n) {
          if (!cancelled) setTagDefinitions([]);
          return;
        }

        // Paginate through all definitions (append-only list; can exceed 200).
        const PAGE_SIZE = 200n;
        const allDefs: `0x${string}`[] = [];
        for (let cursor = 0n; cursor < count; cursor += PAGE_SIZE) {
          const page = (await publicClient.readContract({
            address: tagResolverAddress,
            abi: TAG_RESOLVER_ABI,
            functionName: "getTagDefinitions",
            args: [effectiveUID as `0x${string}`, cursor, PAGE_SIZE],
          })) as `0x${string}`[];
          allDefs.push(...page);
        }

        if (!cancelled) setTagDefinitions(allDefs);
      } catch (e) {
        console.error("Failed to load tag definitions", e);
        if (!cancelled) setTagDefinitions([]);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [publicClient, tagResolverAddress, effectiveUID, refreshKey]);

  const handleAddTag = async () => {
    if (!anchorSchemaUID || !connectedAddress || !publicClient || !tagResolverAddress || !tagsRoot) return;
    setIsSubmitting(true);

    // Normalize tag names to lowercase so filter lookups (which also lowercase) always match
    const normalizedTagName = tagName.trim().toLowerCase();

    try {
      const { decodeEventLog, parseAbiItem } = await import("viem");

      let definitionUID: string | undefined;

      // Look up or create a tag definition anchor under tagsRoot.
      const indexer = await import("~~/contracts/deployedContracts").then(m => {
        const chainId = publicClient.chain.id;
        return (m.default as any)[chainId]?.Indexer;
      });

      if (indexer) {
        const existingUID = (await publicClient.readContract({
          address: indexer.address as `0x${string}`,
          abi: indexer.abi,
          functionName: "resolvePath",
          args: [tagsRoot, normalizedTagName],
        })) as `0x${string}`;

        if (existingUID && existingUID !== zeroHash) {
          definitionUID = existingUID;
        }
      }

      if (!definitionUID) {
        // Create a plain anchor under tagsRoot — same structure as any folder.
        const encodedName = encodeAbiParameters(parseAbiParameters("string name, bytes32 schemaUID"), [
          normalizedTagName,
          zeroHash,
        ]);

        const txHash = await easWrite({
          functionName: "attest",
          args: [
            {
              schema: anchorSchemaUID,
              data: {
                recipient: "0x0000000000000000000000000000000000000000",
                expirationTime: 0n,
                revocable: false,
                refUID: tagsRoot,
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

      // Compute TAG schema UID from TagResolver address
      const tagSchemaDefinition = "bytes32 definition, bool applies";
      const { ethers } = await import("ethers");
      const computedTagSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [tagSchemaDefinition, tagResolverAddress, true],
      );

      const encodedTagData = encodeAbiParameters(parseAbiParameters("bytes32 definition, bool applies"), [
        definitionUID as `0x${string}`,
        true,
      ]);

      // Tag the effectiveUID (DATA attestation for files, anchor for folders)
      const tagTxHash = await easWrite({
        functionName: "attest",
        args: [
          {
            schema: computedTagSchemaUID as `0x${string}`,
            data: {
              recipient: "0x0000000000000000000000000000000000000000",
              expirationTime: 0n,
              revocable: true,
              refUID: effectiveUID as `0x${string}`,
              data: encodedTagData,
              value: 0n,
            },
          },
        ],
      });

      if (tagTxHash) {
        await publicClient.waitForTransactionReceipt({ hash: tagTxHash });
      }

      notification.success("Tag applied!");
      setTagName("");
      setRefreshKey(prev => prev + 1);
      onTagChange?.();
    } catch (e: any) {
      console.error("Error applying tag:", e);
      notification.error("Tag operation failed. Check console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Remove a tag by revoking its active attestation on EAS.
  // Revoking clears the active UID in TagResolver without creating extra attestations.
  const handleRemoveTag = async (activeTagUID: `0x${string}`) => {
    if (!tagResolverAddress || !publicClient) return;
    setIsSubmitting(true);
    try {
      const { ethers } = await import("ethers");
      const tagSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["bytes32 definition, bool applies", tagResolverAddress, true],
      ) as `0x${string}`;

      const txHash = await easWrite({
        functionName: "revoke",
        args: [{ schema: tagSchemaUID, data: { uid: activeTagUID, value: 0n } }],
      });
      if (txHash) await publicClient.waitForTransactionReceipt({ hash: txHash });
      notification.success("Tag removed!");
      setRefreshKey(prev => prev + 1);
      onTagChange?.();
    } catch (e) {
      console.error("Error removing tag:", e);
      notification.error("Failed to remove tag.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const usingDataUID = isFile && effectiveUID !== uid;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-base-100 rounded-xl p-6 w-96 max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">Tags</h3>
          <button onClick={onClose} className="btn btn-ghost btn-circle btn-sm">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {isFile && (
          <p className="text-xs text-base-content/50 mb-3">
            {isResolvingDataUID
              ? "Resolving your edition…"
              : usingDataUID
                ? "Tagging your edition of this file."
                : "No data found for your address — tagging the file anchor."}
          </p>
        )}

        <div className="flex-grow overflow-y-auto mb-4 border border-base-300 rounded p-2 min-h-[100px]">
          {tagDefinitions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {tagDefinitions.map(defUID => (
                <TagDefinitionItem
                  key={`${defUID}-${refreshKey}`}
                  definitionUID={defUID}
                  targetUID={effectiveUID}
                  connectedAddress={connectedAddress}
                  tagResolverAddress={tagResolverAddress}
                  onRemove={handleRemoveTag}
                  disabled={isSubmitting}
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
              if (e.key === "Enter" && tagName.trim() && !isResolvingDataUID) handleAddTag();
            }}
          />
          <button
            className="btn btn-primary btn-sm w-full"
            onClick={() => handleAddTag()}
            disabled={!tagName.trim() || isSubmitting || isResolvingDataUID}
          >
            <PlusIcon className="w-4 h-4 mr-1" />
            {isSubmitting ? "Processing..." : "Add Tag"}
          </button>
          <p className="text-xs text-opacity-50 text-base-content mt-1">
            New tag names create an Anchor under &ldquo;tags&rdquo; (extra transaction).
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
  disabled,
}: {
  definitionUID: `0x${string}`;
  targetUID: string;
  connectedAddress: string | undefined;
  tagResolverAddress: `0x${string}` | undefined;
  onRemove: (activeTagUID: `0x${string}`) => void;
  disabled?: boolean;
}) => {
  const publicClient = usePublicClient();

  const { data: attestation } = useScaffoldReadContract({
    contractName: "EAS",
    functionName: "getAttestation",
    args: [definitionUID],
  });

  const [tagName, setTagName] = useState<string | null>(null);
  const [isActive, setIsActive] = useState<boolean>(false);
  const [activeTagUID, setActiveTagUID] = useState<`0x${string}` | null>(null);

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

  // Check whether the connected user has an active tag on this target.
  useEffect(() => {
    if (!publicClient || !tagResolverAddress || !connectedAddress) {
      setIsActive(false);
      setActiveTagUID(null);
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
          if (!cancelled) {
            setIsActive(false);
            setActiveTagUID(null);
          }
          return;
        }

        // Fetch the active attestation to check applies boolean
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
          if (!cancelled) {
            setIsActive(appliesVal);
            setActiveTagUID(appliesVal ? activeUID : null);
          }
        }
      } catch (e) {
        console.error("Failed to check active tag", e);
        if (!cancelled) {
          setIsActive(false);
          setActiveTagUID(null);
        }
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
      {isActive && activeTagUID && (
        <button
          className="btn btn-ghost btn-xs text-error"
          onClick={() => onRemove(activeTagUID)}
          disabled={disabled}
          title="Remove tag"
        >
          <XMarkIcon className="w-3 h-3" />
        </button>
      )}
    </li>
  );
};
