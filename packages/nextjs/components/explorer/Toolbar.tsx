"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SortDropdown } from "./SortDropdown";
import { ethers } from "ethers";
import { decodeEventLog, encodeDeployData, parseAbiItem, toHex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { Cog6ToothIcon, FunnelIcon } from "@heroicons/react/24/outline";
import { useSortDiscovery } from "~~/hooks/efs/useSortDiscovery";
import { useDeployedContractInfo, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { notification } from "~~/utils/scaffold-eth";

const MOCK_CHUNKED_FILE_ABI = [
  {
    inputs: [{ internalType: "address[]", name: "_chunks", type: "address[]" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
    name: "chunkAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "chunkCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MOCK_CHUNKED_FILE_BYTECODE =
  "0x60806040523461013f57610274803803806100198161015a565b92833981019060208183031261013f578051906001600160401b03821161013f570181601f8201121561013f578051916001600160401b038311610144578260051b9160208061006a81860161015a565b80968152019382010191821161013f57602001915b81831061011f576000845b80518210156101115760009160018060a01b0360208260051b84010151168354680100000000000000008110156100fd57600181018086558110156100e957602085806001969752200190838060a01b0319825416179055019061008a565b634e487b7160e01b85526032600452602485fd5b634e487b7160e01b85526041600452602485fd5b60405160f490816101808239f35b82516001600160a01b038116810361013f5781526020928301920161007f565b600080fd5b634e487b7160e01b600052604160045260246000fd5b6040519190601f01601f191682016001600160401b038111838210176101445760405256fe6080806040526004361015601257600080fd5b60003560e01c9081632bfedae0146053575063f91f093714603257600080fd5b34604e576000366003190112604e576020600054604051908152f35b600080fd5b34604e576020366003190112604e576004359060005482101560a857600080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563909101546001600160a01b03168152602090f35b634e487b7160e01b600052603260045260246000fdfea26469706673582212206ea2dc51d432b7722a3857f0e86c67aaa8fa760e9dee9a8bbd7f8fac66eade7f64736f6c634300081c0033";

const INDEXER_CHILDREN_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "anchorUID", type: "bytes32" }],
    name: "getChildrenCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type PathItem = {
  uid: string;
  name: string;
};

export const Toolbar = ({
  currentPath,
  currentAnchorUID,
  anchorSchemaUID,
  dataSchemaUID,
  indexerAddress,
  easAddress,
  sortOverlayAddress,
  editionAddresses,
  activeSortInfoUID,
  onSortChange,
  onSortProcessed,
  onNavigate,
  onFolderCreated,
  onFileCreated,
  isFilterDrawerOpen = false,
  onToggleFilterDrawer,
  reverseOrder = false,
  onReverseOrderChange,
  autoProcessKey = 0,
  autoProcessSortUIDs,
}: {
  currentPath: PathItem[];
  currentAnchorUID: string | null;
  anchorSchemaUID: string;
  dataSchemaUID: string;
  indexerAddress?: `0x${string}`;
  easAddress?: `0x${string}`;
  sortOverlayAddress?: `0x${string}`;
  editionAddresses?: string[];
  activeSortInfoUID?: string | null;
  onSortChange?: (uid: string | null) => void;
  onSortProcessed?: () => void;
  onNavigate: (uid: string) => void;
  onFolderCreated?: (uid: string, name: string) => void;
  /** Called after upload. Receives the sort UIDs the user wants auto-processed. */
  onFileCreated?: (enabledSortUIDs: string[]) => void;
  isFilterDrawerOpen?: boolean;
  onToggleFilterDrawer?: () => void;
  reverseOrder?: boolean;
  onReverseOrderChange?: (reverse: boolean) => void;
  autoProcessKey?: number;
  autoProcessSortUIDs?: string[];
}) => {
  const { writeContractAsync: attest } = useScaffoldWriteContract({ contractName: "EAS" });
  const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });
  const { targetNetwork } = useTargetNetwork();

  // Modal State
  const [creationType, setCreationType] = useState<"Folder" | "File" | null>(null);
  const [newName, setNewName] = useState("");
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sort auto-update config: discover available sorts, let user opt specific ones out
  const { availableSorts } = useSortDiscovery({
    parentAnchor: currentAnchorUID ?? undefined,
    indexerAddress,
    easAddress,
    editionAddresses: editionAddresses ?? [],
  });
  const [disabledAutoSorts, setDisabledAutoSorts] = useState<Set<string>>(new Set());
  const [showSortConfig, setShowSortConfig] = useState(false);

  const enabledSortUIDs = availableSorts.filter(s => !disabledAutoSorts.has(s.sortInfoUID)).map(s => s.sortInfoUID);

  // Dialog Ref for DaisyUI
  const modalRef = useRef<HTMLDialogElement>(null);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Editions Input State
  const [editionsInput, setEditionsInput] = useState(searchParams.get("editions") || "");

  useEffect(() => {
    if (creationType && modalRef.current) {
      modalRef.current.showModal();
    } else if (!creationType && modalRef.current) {
      modalRef.current.close();
    }
  }, [creationType]);

  const handleOpenModal = (type: "Folder" | "File") => {
    if (!currentAnchorUID) {
      notification.error("Cannot create item: Root not found.");
      return;
    }
    setCreationType(type);
    setNewName("");
  };

  const handleCloseModal = () => {
    setCreationType(null);
    setNewName("");
    setFileToUpload(null);
  };

  const handleSubmitCreate = async () => {
    if (!currentAnchorUID || !newName || !walletClient || !publicClient) return;
    if (creationType === "File" && !fileToUpload) {
      notification.error("Please select a file to upload.");
      return;
    }
    setIsSubmitting(true);

    try {
      const schemaUID = creationType === "File" ? (dataSchemaUID as `0x${string}`) : ethers.ZeroHash;
      const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [newName, schemaUID]);

      let newAnchorUID: `0x${string}` | undefined;

      // 1) First check if the Anchor already exists
      if (indexer) {
        try {
          const existingUID = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "resolveAnchor",
            args: [currentAnchorUID as `0x${string}`, newName, schemaUID as `0x${string}`],
          })) as `0x${string}`;

          if (existingUID && existingUID !== ethers.ZeroHash) {
            newAnchorUID = existingUID;
            notification.info("Namespace already exists. Appending to it...");
          }
        } catch (e) {
          console.warn("Failed to check if anchor exists", e);
        }
      }

      // 2) If not existing, create a new Anchor
      if (!newAnchorUID) {
        const txHash = await attest({
          functionName: "attest",
          args: [
            {
              schema: anchorSchemaUID as `0x${string}`,
              data: {
                recipient: ethers.ZeroAddress,
                expirationTime: 0n,
                revocable: false,
                refUID: currentAnchorUID as `0x${string}`,
                data: encodedName as `0x${string}`,
                value: 0n,
              },
            },
          ],
        });

        if (creationType === "File") {
          notification.info("File Anchor created. Uploading data...");
        }

        if (!txHash) throw new Error("No txHash returned for ANCHOR creation.");

        const receipt = await publicClient?.waitForTransactionReceipt({ hash: txHash });
        if (!receipt) throw new Error("Failed to get transaction receipt for ANCHOR");

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

        if (!newAnchorUID) throw new Error("Could not extract new Anchor UID");
      }

      // 3) Create Data / Folder logic
      if (creationType === "File") {
        notification.info(`Target Anchor UID: ${newAnchorUID}`);
        // Read file contents as bytes for accurate chunking
        const fileArrayBuffer = await fileToUpload!.arrayBuffer();
        const dataBytes = new Uint8Array(fileArrayBuffer);
        const contentType = fileToUpload!.type || "text/plain";

        if (dataBytes.length === 0) {
          notification.error("Cannot upload an empty file.");
          setIsSubmitting(false);
          return;
        }

        let uri = "";
        const CHUNK_SIZE = 24000; // Under 24576 bytes limit to leave room for 1-byte SSTORE2 prefix

        // Always upload to SSTORE2 — `uri` must be a web3:// URI, never raw file content.
        // Embedding file bytes directly in an EAS attestation calldata causes gas estimation
        // to time out even for files a few KB in size.
        const totalChunks = Math.ceil(dataBytes.length / CHUNK_SIZE) || 1;
        notification.info(
          `Uploading ${Math.round(dataBytes.length / 1024) || 1}KB in ${totalChunks} chunk${totalChunks > 1 ? "s" : ""} via SSTORE2...`,
        );
        const chunkAddresses: string[] = [];

        for (let i = 0; i < dataBytes.length; i += CHUNK_SIZE) {
          const chunk = dataBytes.slice(i, i + CHUNK_SIZE);
          const chunkHex = toHex(chunk);

          // Creation code prefix for SSTORE2 (0x00 stop-byte + data)
          const sizeTotal = chunk.length + 1;
          const sizeHex = sizeTotal.toString(16).padStart(4, "0");
          const bytecode = `0x61${sizeHex}80600a3d393df300${chunkHex.slice(2)}`;

          const hash = await walletClient.sendTransaction({
            data: bytecode as `0x${string}`,
            account: walletClient.account,
          });
          const chunkReceipt = await publicClient.waitForTransactionReceipt({ hash });
          if (!chunkReceipt.contractAddress) throw new Error("Chunk deployment failed");
          chunkAddresses.push(chunkReceipt.contractAddress);
          notification.info(`Deployed chunk ${chunkAddresses.length} of ${totalChunks}...`);
        }

        notification.info("Deploying chunk manager...");
        const deployData = encodeDeployData({
          abi: MOCK_CHUNKED_FILE_ABI,
          bytecode: MOCK_CHUNKED_FILE_BYTECODE as `0x${string}`,
          args: [chunkAddresses as readonly `0x${string}`[]],
        });

        const managerHash = await walletClient.sendTransaction({
          data: deployData,
          account: walletClient.account,
        });
        const managerReceipt = await publicClient.waitForTransactionReceipt({ hash: managerHash });
        if (!managerReceipt.contractAddress) throw new Error("Manager deployment failed");

        uri = `web3://${managerReceipt.contractAddress}:${targetNetwork.id}`;
        notification.info(`File URI: ${uri}`);

        // Encode DATA schema: string uri, string contentType, string fileMode
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "string"],
          [uri, contentType, ""],
        );

        notification.info("Attesting file data...");
        const dataTxHash = await attest({
          functionName: "attest",
          args: [
            {
              schema: dataSchemaUID as `0x${string}`,
              data: {
                recipient: ethers.ZeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: newAnchorUID,
                data: encodedData as `0x${string}`,
                value: 0n,
              },
            },
          ],
        });

        if (dataTxHash) {
          await publicClient.waitForTransactionReceipt({ hash: dataTxHash });
        }

        notification.success("File uploaded and data attested successfully.");
        onFileCreated?.(enabledSortUIDs);
      } else {
        notification.success("Folder created successfully.");
        handleCloseModal();

        // Process parent directory sorts before navigating away.
        // The new folder anchor is immediately in the parent's kernel array (staleness +1).
        // Once we navigate into the child, SortDropdown's parentAnchor changes, so we must
        // process the parent's sorts here while we still have the correct context.
        if (sortOverlayAddress && indexerAddress && currentAnchorUID && walletClient?.account && publicClient) {
          for (const sortInfoUID of enabledSortUIDs) {
            try {
              const [currentIndex, totalCount] = await Promise.all([
                publicClient.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_OVERLAY_ABI,
                  functionName: "getLastProcessedIndex",
                  args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`],
                }) as Promise<bigint>,
                publicClient.readContract({
                  address: indexerAddress,
                  abi: INDEXER_CHILDREN_ABI,
                  functionName: "getChildrenCount",
                  args: [currentAnchorUID as `0x${string}`],
                }) as Promise<bigint>,
              ]);

              if (totalCount <= currentIndex) continue;

              const items: `0x${string}`[] = [];
              for (let i = currentIndex; i < totalCount; i++) {
                const uid = (await publicClient.readContract({
                  address: indexerAddress,
                  abi: INDEXER_CHILDREN_ABI,
                  functionName: "getChildAt",
                  args: [currentAnchorUID as `0x${string}`, i],
                })) as `0x${string}`;
                items.push(uid);
              }

              const [leftHints, rightHints] = (await publicClient.readContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "computeHints",
                args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`, items],
              })) as [`0x${string}`[], `0x${string}`[]];

              const { request } = await publicClient.simulateContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "processItems",
                args: [
                  sortInfoUID as `0x${string}`,
                  currentAnchorUID as `0x${string}`,
                  currentIndex,
                  items,
                  leftHints,
                  rightHints,
                ],
                account: walletClient.account,
              });
              const txHash = await walletClient.writeContract(request);
              await publicClient.waitForTransactionReceipt({ hash: txHash });
            } catch (e) {
              console.error("Auto-process sort after folder creation failed:", e);
            }
          }
        }

        if (newAnchorUID) {
          onFolderCreated?.(newAnchorUID, newName);
        }
        return;
      }
      handleCloseModal();
    } catch (e) {
      console.error(e);
      notification.error("Creation failed. See console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateQueryParam = (key: string, value: string) => {
    const currentQuery = new URLSearchParams(searchParams.toString());
    if (value.trim() === "") {
      currentQuery.delete(key);
    } else {
      currentQuery.set(key, value.trim());
    }

    const urlSegments = currentPath.slice(1).map(p => encodeURIComponent(p.name));
    const queryPart = currentQuery.toString() ? `?${currentQuery.toString()}` : "";
    const url = `/explorer/${urlSegments.join("/")}${queryPart}`;

    router.push(url);
  };

  const handleUpdateEditions = () => updateQueryParam("editions", editionsInput);

  return (
    <div className="flex flex-wrap items-center p-2 bg-base-100 rounded-lg gap-2">
      <div className="breadcrumbs text-sm flex-shrink-0">
        <ul>
          {currentPath.map((p, i) => (
            <li key={i}>
              <button
                onClick={() => onNavigate(p.uid)}
                className={`hover:text-primary ${i === currentPath.length - 1 ? "font-bold cursor-default" : "cursor-pointer"}`}
                disabled={i === currentPath.length - 1}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2 items-center flex-grow min-w-0">
        <label
          className="input input-bordered input-sm flex items-center gap-2 flex-grow min-w-[180px]"
          title="Filter files by attester address or ENS name. Only files attested by the given addresses will be shown. Leave blank to see all files from any attester."
        >
          Editions:
          <input
            type="text"
            className="grow min-w-0"
            placeholder="vitalik.eth, 0x..."
            value={editionsInput}
            onChange={e => setEditionsInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleUpdateEditions();
            }}
          />
        </label>
        <button className="btn btn-sm btn-outline flex-shrink-0" onClick={handleUpdateEditions}>
          Apply
        </button>
      </div>

      <div className="flex gap-2 flex-shrink-0 items-center">
        {onSortChange && sortOverlayAddress && (
          <SortDropdown
            parentAnchor={currentAnchorUID ?? undefined}
            indexerAddress={indexerAddress}
            easAddress={easAddress}
            sortOverlayAddress={sortOverlayAddress}
            editionAddresses={editionAddresses ?? []}
            activeSortInfoUID={activeSortInfoUID ?? null}
            onSortChange={onSortChange}
            onProcessComplete={onSortProcessed}
            reverseOrder={reverseOrder}
            onReverseOrderChange={onReverseOrderChange}
            autoProcessKey={autoProcessKey}
            autoProcessSortUIDs={autoProcessSortUIDs}
            anchorSchemaUID={anchorSchemaUID}
          />
        )}
        {onToggleFilterDrawer && (
          <button
            className={`btn btn-sm btn-square ${isFilterDrawerOpen ? "btn-primary" : "btn-ghost"}`}
            onClick={onToggleFilterDrawer}
            title="Toggle tag filter drawer"
          >
            <FunnelIcon className="w-4 h-4" />
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => handleOpenModal("Folder")} disabled={!currentAnchorUID}>
          New Folder
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => handleOpenModal("File")} disabled={!currentAnchorUID}>
          New File
        </button>
      </div>

      {/* DaisyUI Modal */}
      <dialog id="create_modal" className="modal" ref={modalRef}>
        <div className="modal-box">
          <h3 className="font-bold text-lg">Create New {creationType}</h3>
          <div className="py-4 form-control w-full">
            <label className="label">
              <span className="label-text">Name</span>
            </label>
            <input
              type="text"
              placeholder={`Enter ${creationType} Name`}
              className="input input-bordered w-full"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newName && (creationType !== "File" || fileToUpload)) handleSubmitCreate();
                if (e.key === "Escape") handleCloseModal();
              }}
              autoFocus
            />
          </div>
          {creationType === "File" && (
            <div className="py-2 form-control w-full">
              <label className="label">
                <span className="label-text">Select File</span>
              </label>
              <input
                type="file"
                className="file-input file-input-bordered w-full"
                onChange={e => {
                  if (e.target.files && e.target.files.length > 0) {
                    const file = e.target.files[0];
                    setFileToUpload(file);
                    if (!newName) setNewName(file.name);
                  } else {
                    setFileToUpload(null);
                  }
                }}
              />
            </div>
          )}

          <div className="modal-action items-center">
            {/* Sort auto-update config — bottom left, only for file uploads when sorts exist */}
            {creationType === "File" && availableSorts.length > 0 ? (
              <div className="flex-1">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-base-content/50 hover:text-base-content transition-colors"
                  onClick={() => setShowSortConfig(v => !v)}
                >
                  <Cog6ToothIcon className="w-3.5 h-3.5" />
                  Auto-update {enabledSortUIDs.length}/{availableSorts.length} sort
                  {availableSorts.length !== 1 ? "s" : ""}
                  <span className="text-base-content/30">{showSortConfig ? "▴" : "▾"}</span>
                </button>
                {showSortConfig && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {availableSorts.map(sort => (
                      <label
                        key={sort.sortInfoUID}
                        className="flex items-center gap-2 text-sm cursor-pointer select-none"
                      >
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs"
                          checked={!disabledAutoSorts.has(sort.sortInfoUID)}
                          onChange={e => {
                            setDisabledAutoSorts(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(sort.sortInfoUID);
                              else next.add(sort.sortInfoUID);
                              return next;
                            });
                          }}
                        />
                        <span className="text-base-content/70">{sort.name}</span>
                        {!sort.isLocal && <span className="text-xs text-base-content/30">global</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1" />
            )}
            <button className="btn btn-ghost" onClick={handleCloseModal} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSubmitCreate}
              disabled={!newName || isSubmitting || (creationType === "File" && !fileToUpload)}
            >
              {isSubmitting ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button onClick={handleCloseModal}>close</button>
        </form>
      </dialog>
    </div>
  );
};
