"use client";

import { useEffect, useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { notification } from "~~/utils/scaffold-eth";

interface TagModalProps {
  uid: string; // The anchor UID of the item being tagged
  isFile?: boolean; // When true, tags are attached to the connected user's DATA attestation for this anchor
  editionAddresses?: string[]; // Edition addresses for resolving DATA UID when viewing others' files
  onClose: () => void;
  /** Called after any successful tag add or remove so the parent can refresh filtered results. */
  onTagChange?: () => void;
}

interface UserTag {
  definitionUID: `0x${string}`;
  tagName: string;
  activeTagUID: `0x${string}` | null; // null = no active tag by connected user
}

// AGENT-NOTE (ADR-0041): TAGs are cardinality-N with `int256 weight`. There is no longer
// an `applies` boolean and no "negate" semantic — removal is solely via eas.revoke().
// Default weight=1 mirrors the test idioms.
export const TagModal = ({ uid, isFile, editionAddresses = [], onClose, onTagChange }: TagModalProps) => {
  const [tagName, setTagName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userTags, setUserTags] = useState<UserTag[]>([]);
  const [isLoadingTags, setIsLoadingTags] = useState(false);
  const [edgeResolverAddress, setEdgeResolverAddress] = useState<`0x${string}` | undefined>();
  const [tagsRoot, setTagsRoot] = useState<`0x${string}` | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  // effectiveUID: for files this is the DATA attestation UID (edition-specific);
  // for folders it stays as the anchor UID. Tags on DATA UIDs are per-user per-edition.
  const [effectiveUID, setEffectiveUID] = useState<string>(uid);
  // True while the async DATA UID lookup is in flight for file items.
  // Submission is blocked until this resolves so we never accidentally tag the anchor UID.
  const [isResolvingDataUID, setIsResolvingDataUID] = useState(!!isFile);
  // True when isFile=true but no active PIN was found for any edition attester.
  // Submission is blocked — tagging the anchor UID for a file is incorrect (specs/02 §Tag).
  const [dataUIDMissing, setDataUIDMissing] = useState(false);

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
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" });

  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });

  // Pull PIN/TAG schema UIDs directly from EdgeResolver (single source of truth).
  const { data: pinSchemaUID } = useScaffoldReadContract({
    contractName: "EdgeResolver",
    functionName: "PIN_SCHEMA_UID",
  });
  const { data: tagSchemaUID } = useScaffoldReadContract({
    contractName: "EdgeResolver",
    functionName: "TAG_SCHEMA_UID",
  });

  // For file items: resolve the DATA attestation UID to tag.
  // AGENT-NOTE (ADR-0041): DATA placement is now PIN (cardinality 1) — there's at most one
  // active DATA per (attester, anchor) so we can use the O(1) `getActivePinTarget` reader
  // instead of the old TAG count → enumerate → newest-by-time scan.
  // The TagModal targets the DATA the user is actually *viewing*:
  //   - editions set → resolve via editionAddresses (what's on screen)
  //   - no editions → resolve via connectedAddress (own-files default view)
  //   - neither resolves → fall back to anchor UID (folder-level semantics)
  useEffect(() => {
    if (!isFile || !publicClient || !edgeResolverAddress || !dataSchemaUID || !pinSchemaUID) {
      setEffectiveUID(uid);
      if (!isFile) setIsResolvingDataUID(false);
      return;
    }

    let cancelled = false;
    // Reset both flags at the start of each resolution cycle so a prior failure doesn't
    // block the UI if a dependency change (new editions, reconnected wallet) leads to success.
    setDataUIDMissing(false);
    setIsResolvingDataUID(true);

    const resolve = async () => {
      try {
        const viewAttesters: `0x${string}`[] =
          editionAddresses.length > 0
            ? (editionAddresses.map(a => a as `0x${string}`) as `0x${string}`[])
            : connectedAddress
              ? [connectedAddress as `0x${string}`]
              : [];

        if (viewAttesters.length === 0) {
          if (!cancelled) {
            setEffectiveUID(uid);
            setIsResolvingDataUID(false);
          }
          return;
        }

        // First-attester-wins fallback per ADR-0031.
        for (const attester of viewAttesters) {
          const target = (await publicClient.readContract({
            address: edgeResolverAddress,
            abi: EDGE_RESOLVER_ABI,
            functionName: "getActivePinTarget",
            args: [uid as `0x${string}`, attester, dataSchemaUID as `0x${string}`],
          })) as `0x${string}`;

          if (target && target !== zeroHash) {
            if (!cancelled) {
              setEffectiveUID(target);
              setDataUIDMissing(false); // clear any stale missing flag from a previous resolution
              setIsResolvingDataUID(false);
            }
            return;
          }
        }

        // No DATA found — refuse to tag rather than falling back to the anchor UID.
        // File tags must target DATA UIDs (specs/02 §Tag). Setting dataUIDMissing
        // disables submission so the user can't accidentally tag the wrong target.
        if (!cancelled) {
          setDataUIDMissing(true);
          setIsResolvingDataUID(false);
        }
      } catch {
        if (!cancelled) {
          setDataUIDMissing(true);
          setIsResolvingDataUID(false);
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [uid, isFile, publicClient, connectedAddress, editionAddresses, edgeResolverAddress, dataSchemaUID, pinSchemaUID]);

  // Load EdgeResolver address and the "tags" anchor UID (discovered from the normal tree).
  useEffect(() => {
    if (!publicClient || !rootAnchorUID) return;
    getEdgeResolverAddress(publicClient.chain.id).then(async addr => {
      if (!addr) return;
      setEdgeResolverAddress(addr);
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
      if (tagsUID && tagsUID !== zeroHash) {
        setTagsRoot(tagsUID);
      }
    });
  }, [publicClient, rootAnchorUID]);

  // Load tag definitions on this target and check the connected user's active tags.
  // Only shows tags where the connected user has an active TAG.
  useEffect(() => {
    // When no DATA was found for a file, refuse to load tags from the stale anchor UID —
    // displaying anchor-level tags in a file context is misleading and the Remove buttons
    // would revoke the wrong target. dataUIDMissing already disables submission (line 522).
    // Reset isLoadingTags here: a prior invocation may have set it to true and been cancelled
    // mid-flight; without this reset the modal would stay stuck on "Loading...".
    if (dataUIDMissing) {
      setUserTags([]);
      setIsLoadingTags(false);
      return;
    }
    if (!publicClient || !edgeResolverAddress || !effectiveUID || !connectedAddress || !easInfo || !tagSchemaUID) {
      setUserTags([]);
      setIsLoadingTags(false);
      return;
    }

    let cancelled = false;
    setIsLoadingTags(true);

    const getEASAttestation = (uid: `0x${string}`) =>
      publicClient.readContract({
        address: easInfo.address as `0x${string}`,
        abi: easInfo.abi,
        functionName: "getAttestation",
        args: [uid],
      });

    const load = async () => {
      try {
        // AGENT-NOTE: under EdgeResolver, definitions are recorded once per (target, definition)
        // across PIN+TAG. Use getEdgeDefinitions to enumerate all definitions, then filter to
        // those that resolve to a user-facing tag in the active TAG set.
        const count = (await publicClient.readContract({
          address: edgeResolverAddress,
          abi: EDGE_RESOLVER_ABI,
          functionName: "getEdgeDefinitionCount",
          args: [effectiveUID as `0x${string}`],
        })) as bigint;

        if (count === 0n) {
          if (!cancelled) {
            setUserTags([]);
            setIsLoadingTags(false);
          }
          return;
        }

        // Paginate through all definitions (append-only list).
        const PAGE_SIZE = 200n;
        const allDefs: `0x${string}`[] = [];
        for (let cursor = 0n; cursor < count; cursor += PAGE_SIZE) {
          const page = (await publicClient.readContract({
            address: edgeResolverAddress,
            abi: EDGE_RESOLVER_ABI,
            functionName: "getEdgeDefinitions",
            args: [effectiveUID as `0x${string}`, cursor, PAGE_SIZE],
          })) as `0x${string}`[];
          allDefs.push(...page);
        }

        // For each definition, check if the connected user has an active TAG and resolve the name.
        // Only show tags whose definition anchor lives under /tags/ — file placement edges
        // (where definition is a file/folder anchor) are internal bookkeeping, not user-facing.
        const tags = await Promise.all(
          allDefs.map(async defUID => {
            const [activeTagUID, defAttestation] = await Promise.all([
              publicClient.readContract({
                address: edgeResolverAddress,
                abi: EDGE_RESOLVER_ABI,
                functionName: "getActiveEdgeUID",
                args: [
                  connectedAddress as `0x${string}`,
                  effectiveUID as `0x${string}`,
                  defUID,
                  tagSchemaUID as `0x${string}`,
                ],
              }) as Promise<`0x${string}`>,
              getEASAttestation(defUID) as Promise<any>,
            ]);

            // Filter: only show definitions that are descendants of /tags/.
            // Walk up the refUID chain from the definition anchor until we hit tagsRoot
            // (it's a user-facing tag) or 0x0/root (it's not).
            if (!tagsRoot) return null;
            let isUnderTags = false;
            let walker = defAttestation.refUID as `0x${string}`;
            while (walker && walker !== zeroHash) {
              if (walker.toLowerCase() === tagsRoot.toLowerCase()) {
                isUnderTags = true;
                break;
              }
              try {
                const parentAtt = (await getEASAttestation(walker)) as any;
                walker = parentAtt.refUID as `0x${string}`;
              } catch {
                break;
              }
            }
            if (!isUnderTags) return null;

            let tagName: string;
            try {
              const [name] = decodeAbiParameters(
                parseAbiParameters("string name, bytes32 schemaUID"),
                defAttestation.data as `0x${string}`,
              );
              tagName = name;
            } catch {
              tagName = `#${defUID.slice(0, 10)}`;
            }

            const hasUserTag = activeTagUID && activeTagUID !== zeroHash;

            return {
              definitionUID: defUID,
              tagName,
              activeTagUID: hasUserTag ? activeTagUID : null,
            } as UserTag;
          }),
        );

        if (!cancelled) {
          // Only show /tags/ definitions where the connected user has an active tag
          setUserTags(tags.filter((t): t is UserTag => t !== null && t.activeTagUID !== null));
          setIsLoadingTags(false);
        }
      } catch (e) {
        console.error("Failed to load tags", e);
        if (!cancelled) {
          setUserTags([]);
          setIsLoadingTags(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    edgeResolverAddress,
    effectiveUID,
    connectedAddress,
    easInfo,
    refreshKey,
    tagsRoot,
    tagSchemaUID,
    dataUIDMissing,
  ]);

  const handleAddTag = async () => {
    if (dataUIDMissing) return; // handler-level guard: belt-and-suspenders alongside the disabled prop
    if (!anchorSchemaUID || !connectedAddress || !publicClient || !tagsRoot || !tagSchemaUID) return;
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

      // AGENT-NOTE (ADR-0041): TAG payload is `(bytes32 definition, int256 weight)`. Default
      // weight=1 — sign/magnitude is consumer-defined sort/score metadata. There is no
      // applies bool and no negate path; removal is via eas.revoke().
      const encodedTagData = encodeAbiParameters(parseAbiParameters("bytes32 definition, int256 weight"), [
        definitionUID as `0x${string}`,
        1n,
      ]);

      // Tag the effectiveUID (DATA attestation for files, anchor for folders)
      const tagTxHash = await easWrite({
        functionName: "attest",
        args: [
          {
            schema: tagSchemaUID as `0x${string}`,
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
  // AGENT-NOTE (ADR-0041): revocation is the ONLY removal mechanism — the old
  // negate-via-applies-false path no longer exists.
  const handleRemoveTag = async (activeTagUID: `0x${string}`) => {
    if (!publicClient || !tagSchemaUID) return;
    setIsSubmitting(true);
    try {
      const txHash = await easWrite({
        functionName: "revoke",
        args: [{ schema: tagSchemaUID as `0x${string}`, data: { uid: activeTagUID, value: 0n } }],
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
              ? "Resolving edition..."
              : dataUIDMissing
                ? "No edition data found — tagging unavailable for this file."
                : "Tagging the viewed edition of this file."}
          </p>
        )}

        <div className="flex-grow overflow-y-auto mb-4 border border-base-300 rounded p-2 min-h-[100px]">
          {isLoadingTags ? (
            <p className="text-gray-500 text-center italic mt-4">Loading...</p>
          ) : userTags.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {userTags.map(tag => (
                <li
                  key={tag.definitionUID}
                  className="bg-base-200 p-2 rounded text-sm flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="badge badge-sm badge-primary">{tag.tagName}</span>
                  </div>
                  {tag.activeTagUID && (
                    <button
                      className="btn btn-error btn-xs"
                      onClick={() => handleRemoveTag(tag.activeTagUID!)}
                      disabled={isSubmitting || dataUIDMissing}
                    >
                      <XMarkIcon className="w-3 h-3" />
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500 text-center italic mt-4">No tags by you.</p>
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
              if (e.key === "Enter" && tagName.trim() && !isResolvingDataUID && !dataUIDMissing) handleAddTag();
            }}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-primary btn-sm flex-1"
              onClick={() => handleAddTag()}
              disabled={!tagName.trim() || isSubmitting || isResolvingDataUID || dataUIDMissing}
            >
              <PlusIcon className="w-4 h-4 mr-1" />
              {isSubmitting ? "..." : "Apply"}
            </button>
          </div>
          <p className="text-xs text-opacity-50 text-base-content mt-1">
            New tag names create an Anchor under &ldquo;tags&rdquo; (extra transaction).
          </p>
        </div>
      </div>
    </div>
  );
};
