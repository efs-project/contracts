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
import { TRANSPORT_LABELS, computeContentHash, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";
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
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildBySchemaAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
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
  propertySchemaUID,
  tagSchemaUID,
  mirrorSchemaUID,
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
  propertySchemaUID: string;
  tagSchemaUID: string;
  mirrorSchemaUID: string;
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
  const { data: tagResolverInfo } = useDeployedContractInfo({ contractName: "TagResolver" });
  const { targetNetwork } = useTargetNetwork();

  // Modal State
  const [creationType, setCreationType] = useState<"Folder" | "File" | "PasteLink" | null>(null);
  const [newName, setNewName] = useState("");
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [pasteUri, setPasteUri] = useState("");
  const [pasteContentType, setPasteContentType] = useState("");
  const [pasteSize, setPasteSize] = useState("");
  const [pasteContentHash, setPasteContentHash] = useState<`0x${string}` | null>(null);
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [showPasteDetails, setShowPasteDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [existingAnchorWarning, setExistingAnchorWarning] = useState(false);

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

  const handleOpenModal = (type: "Folder" | "File" | "PasteLink") => {
    if (!currentAnchorUID) {
      notification.error("Cannot create item: Root not found.");
      return;
    }
    setCreationType(type);
    setNewName("");
    setPasteUri("");
    setPasteContentType("");
    setPasteSize("");
    setPasteContentHash(null);
    setShowPasteDetails(false);
  };

  const handleCloseModal = () => {
    setCreationType(null);
    setNewName("");
    setFileToUpload(null);
    setPasteUri("");
    setPasteContentType("");
    setPasteSize("");
    setPasteContentHash(null);
    setShowPasteDetails(false);
    setExistingAnchorWarning(false);
  };

  /** Fetch content info from a pasted URI via its gateway. */
  const handleFetchInfo = async () => {
    if (!pasteUri) return;
    const gatewayUrl = resolveGatewayUrl(pasteUri);
    if (!gatewayUrl) {
      notification.error("Cannot fetch info for this URI type. Enter values manually.");
      return;
    }
    setIsFetchingInfo(true);
    setShowPasteDetails(true);
    try {
      // Try HEAD first for metadata
      const headResp = await fetch(gatewayUrl, { method: "HEAD" });
      if (!headResp.ok) throw new Error(`HTTP ${headResp.status}`);

      const ct = headResp.headers.get("content-type");
      if (ct) setPasteContentType(ct.split(";")[0].trim());

      const cl = headResp.headers.get("content-length");
      if (cl) setPasteSize(cl);

      // For files under 10MB, fetch full body to compute real contentHash
      const sizeNum = cl ? parseInt(cl, 10) : 0;
      if (sizeNum > 0 && sizeNum <= 10 * 1024 * 1024) {
        notification.info("Downloading file to compute content hash...");
        const getResp = await fetch(gatewayUrl);
        const bytes = new Uint8Array(await getResp.arrayBuffer());
        setPasteSize(String(bytes.length));
        setPasteContentHash(computeContentHash(bytes));
        notification.success("Content hash computed.");
      } else if (sizeNum > 10 * 1024 * 1024) {
        notification.info(`File is ${Math.round(sizeNum / 1024 / 1024)}MB — hash not computed (too large).`);
      } else {
        // No content-length from HEAD — try full GET
        notification.info("Downloading file to determine size and hash...");
        const getResp = await fetch(gatewayUrl);
        const bytes = new Uint8Array(await getResp.arrayBuffer());
        setPasteSize(String(bytes.length));
        if (bytes.length <= 10 * 1024 * 1024) {
          setPasteContentHash(computeContentHash(bytes));
          notification.success("Content hash computed.");
        }
        if (!ct) {
          const getCt = getResp.headers.get("content-type");
          if (getCt) setPasteContentType(getCt.split(";")[0].trim());
        }
      }
    } catch (e) {
      console.error("Fetch info failed:", e);
      notification.error("Could not fetch info from gateway. Enter values manually.");
    } finally {
      setIsFetchingInfo(false);
    }
  };

  /** Extract attestation UID from a transaction receipt. */
  const extractUIDFromReceipt = (receipt: any): `0x${string}` | undefined => {
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
        return (event.args as any).uid as `0x${string}`;
      } catch {
        // Not our event
      }
    }
    return undefined;
  };

  /** Resolve a transport anchor UID (e.g. /transports/onchain). */
  const resolveTransportAnchor = async (transportName: string): Promise<`0x${string}` | null> => {
    if (!indexer || !publicClient) return null;
    try {
      const rootUID = (await publicClient.readContract({
        address: indexer.address as `0x${string}`,
        abi: indexer.abi,
        functionName: "rootAnchorUID",
      })) as `0x${string}`;
      const transportsUID = (await publicClient.readContract({
        address: indexer.address as `0x${string}`,
        abi: indexer.abi,
        functionName: "resolvePath",
        args: [rootUID, "transports"],
      })) as `0x${string}`;
      if (!transportsUID || transportsUID === ethers.ZeroHash) return null;
      const uid = (await publicClient.readContract({
        address: indexer.address as `0x${string}`,
        abi: indexer.abi,
        functionName: "resolvePath",
        args: [transportsUID, transportName],
      })) as `0x${string}`;
      return uid && uid !== ethers.ZeroHash ? uid : null;
    } catch {
      return null;
    }
  };

  const handleSubmitCreate = async () => {
    if (!currentAnchorUID || !newName || !walletClient || !publicClient) return;
    if (creationType === "File" && !fileToUpload) {
      notification.error("Please select a file to upload.");
      return;
    }
    if (creationType === "PasteLink" && !pasteUri) {
      notification.error("Please enter a URI.");
      return;
    }
    setIsSubmitting(true);

    try {
      if (creationType === "Folder") {
        // --- FOLDER CREATION ---
        const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [newName, ethers.ZeroHash]);

        let newAnchorUID: `0x${string}` | undefined;
        if (indexer) {
          try {
            const existingUID = (await publicClient.readContract({
              address: indexer.address as `0x${string}`,
              abi: indexer.abi,
              functionName: "resolveAnchor",
              args: [currentAnchorUID as `0x${string}`, newName, ethers.ZeroHash as `0x${string}`],
            })) as `0x${string}`;
            if (existingUID && existingUID !== ethers.ZeroHash) {
              newAnchorUID = existingUID;
              notification.info("Folder already exists.");
            }
          } catch (e) {
            console.warn("Failed to check if anchor exists", e);
          }
        }

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
          if (!txHash) throw new Error("No txHash returned for ANCHOR creation.");
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          newAnchorUID = extractUIDFromReceipt(receipt);
          if (!newAnchorUID) throw new Error("Could not extract new Anchor UID");
        }

        // Tag the folder so it appears in schema-filtered views
        if (tagResolverInfo && newAnchorUID) {
          try {
            const encodedTagData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bool"], [dataSchemaUID, true]);
            const tagTxHash = await attest({
              functionName: "attest",
              args: [
                {
                  schema: tagSchemaUID as `0x${string}`,
                  data: {
                    recipient: ethers.ZeroAddress,
                    expirationTime: 0n,
                    revocable: true,
                    refUID: newAnchorUID,
                    data: encodedTagData as `0x${string}`,
                    value: 0n,
                  },
                },
              ],
            });
            if (tagTxHash) await publicClient.waitForTransactionReceipt({ hash: tagTxHash });
          } catch (e) {
            console.error("Auto-tag folder failed:", e);
          }
        }

        notification.success("Folder created successfully.");
        handleCloseModal();

        // Process parent directory sorts
        if (sortOverlayAddress && indexerAddress && currentAnchorUID && walletClient?.account && publicClient) {
          for (const sortInfoUID of enabledSortUIDs) {
            try {
              const config = (await publicClient.readContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "getSortConfig",
                args: [sortInfoUID as `0x${string}`],
              })) as { sortFunc: string; targetSchema: `0x${string}`; sourceType: number };

              if (config.sourceType !== 0 && config.sourceType !== 1) continue;

              const [currentIndex, staleness] = (await Promise.all([
                publicClient.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_OVERLAY_ABI,
                  functionName: "getLastProcessedIndex",
                  args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`],
                }),
                publicClient.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_OVERLAY_ABI,
                  functionName: "getSortStaleness",
                  args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`],
                }),
              ])) as [bigint, bigint];
              const totalCount = currentIndex + staleness;
              if (totalCount <= currentIndex) continue;

              const items: `0x${string}`[] = [];
              for (let i = currentIndex; i < totalCount; i++) {
                const uid =
                  config.sourceType === 0
                    ? ((await publicClient.readContract({
                        address: indexerAddress,
                        abi: INDEXER_CHILDREN_ABI,
                        functionName: "getChildAt",
                        args: [currentAnchorUID as `0x${string}`, i],
                      })) as `0x${string}`)
                    : ((await publicClient.readContract({
                        address: indexerAddress,
                        abi: INDEXER_CHILDREN_ABI,
                        functionName: "getChildBySchemaAt",
                        args: [currentAnchorUID as `0x${string}`, config.targetSchema, i],
                      })) as `0x${string}`);
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

        if (newAnchorUID) onFolderCreated?.(newAnchorUID, newName);
        return;
      }

      // --- FILE UPLOAD or PASTE LINK ---
      // Both create: file anchor + standalone DATA + PROPERTY(contentType) + MIRROR + TAG(placement)

      // 1) Ensure file anchor exists
      const fileAnchorSchemaUID = dataSchemaUID as `0x${string}`;
      const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32"],
        [newName, fileAnchorSchemaUID],
      );

      let fileAnchorUID: `0x${string}` | undefined;
      if (indexer) {
        try {
          const existingUID = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "resolveAnchor",
            args: [currentAnchorUID as `0x${string}`, newName, fileAnchorSchemaUID],
          })) as `0x${string}`;
          if (existingUID && existingUID !== ethers.ZeroHash) {
            if (!existingAnchorWarning) {
              setExistingAnchorWarning(true);
              setIsSubmitting(false);
              return;
            }
            fileAnchorUID = existingUID;
            setExistingAnchorWarning(false);
          }
        } catch (e) {
          console.warn("Failed to check if anchor exists", e);
        }
      }

      if (!fileAnchorUID) {
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
        if (!txHash) throw new Error("No txHash returned for file ANCHOR creation.");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        fileAnchorUID = extractUIDFromReceipt(receipt);
        if (!fileAnchorUID) throw new Error("Could not extract file Anchor UID");
        notification.info("File anchor created.");
      }

      let contentHash: `0x${string}`;
      let fileSize: bigint;
      let mirrorUri: string;
      let transportName: string;
      let contentType: string;

      if (creationType === "File") {
        // --- ON-CHAIN FILE UPLOAD ---
        const fileArrayBuffer = await fileToUpload!.arrayBuffer();
        const dataBytes = new Uint8Array(fileArrayBuffer);
        contentType = fileToUpload!.type || "application/octet-stream";

        if (dataBytes.length === 0) {
          notification.error("Cannot upload an empty file.");
          setIsSubmitting(false);
          return;
        }

        // EIP-3860 limits contract init code to ~49KB. The chunk manager's constructor
        // args grow with chunk count. Cap at 1000 chunks (~24MB) to stay safe.
        // This is a client-side upload limitation, not a protocol one — future upload
        // tools can use hierarchical managers for larger files.
        const MAX_ONCHAIN_SIZE = 24_000_000; // ~24MB
        if (dataBytes.length > MAX_ONCHAIN_SIZE) {
          notification.error(
            `File too large for on-chain upload (${Math.round(dataBytes.length / 1024 / 1024)}MB). ` +
            `Maximum is ~${MAX_ONCHAIN_SIZE / 1_000_000}MB. Use IPFS or Arweave for large files.`,
          );
          setIsSubmitting(false);
          return;
        }

        contentHash = computeContentHash(dataBytes);
        fileSize = BigInt(dataBytes.length);

        // SSTORE2 chunking
        const CHUNK_SIZE = 24000;
        const totalChunks = Math.ceil(dataBytes.length / CHUNK_SIZE) || 1;
        notification.info(
          `Uploading ${Math.round(dataBytes.length / 1024) || 1}KB in ${totalChunks} chunk${totalChunks > 1 ? "s" : ""} via SSTORE2...`,
        );
        const chunkAddresses: string[] = [];

        for (let i = 0; i < dataBytes.length; i += CHUNK_SIZE) {
          const chunk = dataBytes.slice(i, i + CHUNK_SIZE);
          const chunkHex = toHex(chunk);
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

        mirrorUri = `web3://${managerReceipt.contractAddress}:${targetNetwork.id}`;
        transportName = "onchain";
        notification.info(`File URI: ${mirrorUri}`);
      } else {
        // --- PASTE LINK ---
        mirrorUri = pasteUri;
        const detected = detectTransport(pasteUri);
        transportName = detected === "unknown" ? "https" : detected;
        contentType = pasteContentType || "application/octet-stream";
        contentHash = pasteContentHash || (ethers.ZeroHash as `0x${string}`);
        fileSize = pasteSize ? BigInt(pasteSize) : 0n;
      }

      // 2) Create standalone DATA attestation (non-revocable)
      notification.info("Creating DATA attestation...");
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint64"], [contentHash, fileSize]);
      const dataTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: dataSchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: ethers.ZeroHash as `0x${string}`,
              data: encodedData as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });
      if (!dataTxHash) throw new Error("DATA attestation failed.");
      const dataReceipt = await publicClient.waitForTransactionReceipt({ hash: dataTxHash });
      const dataUID = extractUIDFromReceipt(dataReceipt);
      if (!dataUID) throw new Error("Could not extract DATA UID");
      notification.info(`DATA created: ${dataUID.slice(0, 10)}...`);

      // 3) Create PROPERTY(contentType) referencing DATA
      notification.info("Attesting content type...");
      const encodedProperty = ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["contentType", contentType]);
      const propTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: propertySchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: true,
              refUID: dataUID,
              data: encodedProperty as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });
      if (propTxHash) await publicClient.waitForTransactionReceipt({ hash: propTxHash });

      // 4) Create MIRROR referencing DATA
      const transportAnchorUID = await resolveTransportAnchor(transportName);
      if (!transportAnchorUID) {
        notification.error(`Transport anchor '/transports/${transportName}' not found. Skipping mirror.`);
      } else {
        notification.info(
          `Creating ${TRANSPORT_LABELS[transportName as keyof typeof TRANSPORT_LABELS] || transportName} mirror...`,
        );
        const encodedMirror = ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [transportAnchorUID, mirrorUri],
        );
        const mirrorTxHash = await attest({
          functionName: "attest",
          args: [
            {
              schema: mirrorSchemaUID as `0x${string}`,
              data: {
                recipient: ethers.ZeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: dataUID,
                data: encodedMirror as `0x${string}`,
                value: 0n,
              },
            },
          ],
        });
        if (mirrorTxHash) await publicClient.waitForTransactionReceipt({ hash: mirrorTxHash });
      }

      // 5) Create TAG placing DATA at the file anchor
      notification.info("Placing file in folder via TAG...");
      const encodedTag = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bool"], [fileAnchorUID, true]);
      const tagTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: tagSchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: true,
              refUID: dataUID,
              data: encodedTag as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });
      if (tagTxHash) await publicClient.waitForTransactionReceipt({ hash: tagTxHash });

      notification.success("File uploaded and placed successfully.");
      onFileCreated?.(enabledSortUIDs);
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
          Add File
        </button>
      </div>

      {/* DaisyUI Modal */}
      <dialog id="create_modal" className="modal" ref={modalRef}>
        <div className="modal-box">
          <h3 className="font-bold text-lg">
            {creationType === "Folder" ? "Create New Folder" : "Add File"}
          </h3>
          {creationType !== "Folder" && (
            <div className="tabs tabs-bordered mt-2">
              <button
                className={`tab ${creationType === "File" ? "tab-active" : ""}`}
                onClick={() => setCreationType("File")}
              >
                Upload File
              </button>
              <button
                className={`tab ${creationType === "PasteLink" ? "tab-active" : ""}`}
                onClick={() => setCreationType("PasteLink")}
              >
                Paste Link
              </button>
            </div>
          )}
          <div className="py-4 form-control w-full">
            <label className="label">
              <span className="label-text">Name</span>
            </label>
            <input
              type="text"
              placeholder={`Enter ${creationType === "Folder" ? "folder" : "file"} name`}
              className="input input-bordered w-full"
              value={newName}
              onChange={e => { setNewName(e.target.value); setExistingAnchorWarning(false); }}
              onKeyDown={e => {
                if (
                  e.key === "Enter" &&
                  newName &&
                  (creationType !== "File" || fileToUpload) &&
                  (creationType !== "PasteLink" || pasteUri)
                )
                  handleSubmitCreate();
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
          {creationType === "PasteLink" && (
            <>
              <div className="py-2 form-control w-full">
                <label className="label">
                  <span className="label-text">URI</span>
                </label>
                <input
                  type="text"
                  placeholder="ipfs://Qm..., ar://..., bafyb..."
                  className="input input-bordered w-full"
                  value={pasteUri}
                  onChange={e => {
                    let val = e.target.value.trim();
                    // Auto-detect bare IPFS CIDs (CIDv0: Qm..., CIDv1: bafy...)
                    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z2-7]{50,})$/.test(val)) {
                      val = `ipfs://${val}`;
                    }
                    setPasteUri(val);
                  }}
                />
                {pasteUri && (
                  <label className="label">
                    <span className="label-text-alt text-base-content/50">
                      Detected: {TRANSPORT_LABELS[detectTransport(pasteUri)]}
                    </span>
                  </label>
                )}
              </div>
              {/* Collapsible file details section */}
              <div className="mt-1">
                <button
                  type="button"
                  className="flex items-center justify-between w-full text-sm text-base-content/60 hover:text-base-content transition-colors"
                  onClick={() => setShowPasteDetails(v => !v)}
                >
                  <span className="flex items-center gap-1">
                    <span>{showPasteDetails ? "▾" : "▸"}</span>
                    <span>File Details</span>
                    {(pasteContentType || pasteSize || pasteContentHash) && (
                      <span className="badge badge-xs badge-success ml-1">
                        {[pasteContentType && "type", pasteSize && "size", pasteContentHash && "hash"].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </span>
                  {pasteUri && detectTransport(pasteUri) !== "magnet" && detectTransport(pasteUri) !== "onchain" && (
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      onClick={e => { e.stopPropagation(); handleFetchInfo(); }}
                      disabled={isFetchingInfo}
                    >
                      {isFetchingInfo ? "Fetching..." : "Fetch Info"}
                    </button>
                  )}
                </button>
                {showPasteDetails && (
                  <div className="mt-2 pl-4 border-l-2 border-base-300 flex flex-col gap-2">
                    <div className="form-control w-full">
                      <label className="label py-1">
                        <span className="label-text text-sm">Content Type</span>
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. image/png, text/html"
                        className="input input-bordered input-sm w-full"
                        value={pasteContentType}
                        onChange={e => setPasteContentType(e.target.value)}
                      />
                    </div>
                    <div className="form-control w-full">
                      <label className="label py-1">
                        <span className="label-text text-sm">Size (bytes)</span>
                      </label>
                      <input
                        type="text"
                        placeholder="Unknown"
                        className="input input-bordered input-sm w-full"
                        value={pasteSize}
                        onChange={e => setPasteSize(e.target.value.replace(/\D/g, ""))}
                      />
                    </div>
                    <div className="form-control w-full">
                      <label className="label py-1">
                        <span className="label-text text-sm">Content Hash</span>
                      </label>
                      <input
                        type="text"
                        placeholder="0x... (auto-computed via Fetch Info)"
                        className="input input-bordered input-sm w-full font-mono text-xs"
                        value={pasteContentHash || ""}
                        onChange={e => {
                          const val = e.target.value;
                          if (!val) { setPasteContentHash(null); return; }
                          setPasteContentHash(val as `0x${string}`);
                        }}
                      />
                      {pasteContentHash && (
                        <label className="label py-0">
                          <span className="label-text-alt text-success text-xs">
                            Verified from file bytes
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {existingAnchorWarning && creationType !== "Folder" && (
            <div className="alert alert-warning mt-2 text-sm py-2">
              A file named &quot;{newName}&quot; already exists here. Submitting will add a new version to the existing anchor.
            </div>
          )}

          <div className="modal-action items-center">
            {/* Sort auto-update config — bottom left, only for file uploads when sorts exist */}
            {creationType !== "Folder" && availableSorts.length > 0 ? (
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
              className={`btn ${existingAnchorWarning && creationType !== "Folder" ? "btn-warning" : "btn-primary"}`}
              onClick={handleSubmitCreate}
              disabled={
                !newName ||
                isSubmitting ||
                (creationType === "File" && !fileToUpload) ||
                (creationType === "PasteLink" && !pasteUri)
              }
            >
              {isSubmitting ? "Creating..." : existingAnchorWarning && creationType !== "Folder" ? "Update Existing" : "Create"}
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
