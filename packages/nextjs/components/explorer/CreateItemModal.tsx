"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { decodeEventLog, encodeDeployData, parseAbiItem, toHex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { Cog6ToothIcon, StopIcon } from "@heroicons/react/24/outline";
import { useSortDiscovery } from "~~/hooks/efs/useSortDiscovery";
import { useDeployedContractInfo, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import type { ClassifiedContainer } from "~~/utils/efs/containers";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { TAG_RESOLVER_ABI, getTagResolverAddress } from "~~/utils/efs/tagResolver";
import { TRANSPORT_LABELS, computeContentHash, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";
import { notification } from "~~/utils/scaffold-eth";

export type CreationType = "Folder" | "File" | "PasteLink";

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

// Mirrors EFSIndexer.sol::_isValidAnchorName so we fail fast with a friendly
// message instead of waiting for the on-chain revert. Reject the same byte set
// the contract rejects: NUL, space, " # % & / : = ? @ [ \ ] ^ ` { | }, plus the
// reserved relative segments "." and "..".
const FORBIDDEN_ANCHOR_NAME_CHARS = new Set([
  0x00, 0x20, 0x22, 0x23, 0x25, 0x26, 0x2f, 0x3a, 0x3d, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x60, 0x7b, 0x7c, 0x7d,
]);

function validateAnchorName(name: string): string | null {
  if (name.length === 0) return "Name cannot be empty.";
  if (name === "." || name === "..") return "Name cannot be '.' or '..'.";
  const bytes = new TextEncoder().encode(name);
  for (const b of bytes) {
    if (FORBIDDEN_ANCHOR_NAME_CHARS.has(b)) {
      const ch = b === 0x20 ? "space" : b === 0x00 ? "NUL" : `'${String.fromCharCode(b)}'`;
      return `Name cannot contain ${ch}.`;
    }
  }
  return null;
}

/**
 * Best-effort extraction of a human-readable message from viem/wagmi/ethers errors.
 * Falls back to a short generic message — never swallows silently.
 */
function extractErrorMessage(e: unknown): string {
  const anyErr = e as {
    shortMessage?: string;
    details?: string;
    message?: string;
    cause?: { details?: string; shortMessage?: string };
  };
  if (typeof anyErr?.details === "string" && anyErr.details.length < 200) return anyErr.details;
  if (typeof anyErr?.cause?.details === "string") return anyErr.cause.details;
  if (typeof anyErr?.shortMessage === "string") return anyErr.shortMessage;
  if (typeof anyErr?.cause?.shortMessage === "string") return anyErr.cause.shortMessage;
  if (typeof anyErr?.message === "string") return anyErr.message.slice(0, 200);
  return "Creation failed. See console.";
}

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

export type CreateItemModalProps = {
  /** Open the modal with this creation type. `null` closes it. */
  creationType: CreationType | null;
  onClose: () => void;

  /** Parent anchor the new item attaches to. */
  currentAnchorUID: string | null;

  /**
   * The resolved top-level container. When a direct child of an Address
   * container is being created, EAS refuses refUID = bytes32(uint160(addr))
   * (it's not a valid attestation UID), so the new anchor must be attested
   * with `refUID = 0, recipient = addr` instead — EFSIndexer.onAttest then
   * re-derives the parent as `bytes32(uint160(recipient))`. Schema and
   * attestation containers resolve through an alias anchor (a real
   * attestation) so the standard path applies; if no alias exists, raw
   * schema UIDs also fail EAS validation and we fall back in the same way.
   */
  container?: ClassifiedContainer | null;

  anchorSchemaUID: string;
  dataSchemaUID: string;
  propertySchemaUID: string;
  tagSchemaUID: string;
  mirrorSchemaUID: string;

  indexerAddress?: `0x${string}`;
  easAddress?: `0x${string}`;
  sortOverlayAddress?: `0x${string}`;
  editionAddresses?: string[];

  /** Called after a folder is created. */
  onFolderCreated?: (uid: string, name: string) => void;
  /** Called after a file is uploaded. Passes the sort UIDs the user wants auto-processed. */
  onFileCreated?: (enabledSortUIDs: string[]) => void;
};

export const CreateItemModal = ({
  creationType,
  onClose,
  currentAnchorUID,
  container,
  anchorSchemaUID,
  dataSchemaUID,
  propertySchemaUID,
  tagSchemaUID,
  mirrorSchemaUID,
  indexerAddress,
  easAddress: _easAddress,
  sortOverlayAddress,
  editionAddresses,
  onFolderCreated,
  onFileCreated,
}: CreateItemModalProps) => {
  const { writeContractAsync: attest } = useScaffoldWriteContract({ contractName: "EAS" });
  const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });
  const { targetNetwork } = useTargetNetwork();

  const [internalType, setInternalType] = useState<CreationType | null>(creationType);
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

  // Only surface the inline error once the user has typed something; empty-name
  // is already covered by the disabled submit button.
  const nameValidationError = newName ? validateAnchorName(newName) : null;

  const { availableSorts } = useSortDiscovery({
    parentAnchor: currentAnchorUID ?? undefined,
    indexerAddress,
    easAddress: _easAddress,
    editionAddresses: editionAddresses ?? [],
  });
  const [disabledAutoSorts, setDisabledAutoSorts] = useState<Set<string>>(new Set());
  const [showSortConfig, setShowSortConfig] = useState(false);

  const enabledSortUIDs = availableSorts.filter(s => !disabledAutoSorts.has(s.sortInfoUID)).map(s => s.sortInfoUID);

  const modalRef = useRef<HTMLDialogElement>(null);
  // Flipped by the Stop button mid-upload. Checked between transactions so we
  // break cleanly on the next safe boundary (can't abort an already-broadcast tx).
  const cancelledRef = useRef(false);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // Sync external `creationType` prop to internal state + dialog visibility.
  useEffect(() => {
    setInternalType(creationType);
    if (creationType) {
      setNewName("");
      setFileToUpload(null);
      setPasteUri("");
      setPasteContentType("");
      setPasteSize("");
      setPasteContentHash(null);
      setShowPasteDetails(false);
      setExistingAnchorWarning(false);
      modalRef.current?.showModal();
    } else {
      modalRef.current?.close();
    }
  }, [creationType]);

  const handleClose = () => {
    modalRef.current?.close();
    onClose();
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
      const headResp = await fetch(gatewayUrl, { method: "HEAD" });
      if (!headResp.ok) throw new Error(`HTTP ${headResp.status}`);

      const ct = headResp.headers.get("content-type");
      if (ct) setPasteContentType(ct.split(";")[0].trim());

      const cl = headResp.headers.get("content-length");
      if (cl) setPasteSize(cl);

      const sizeNum = cl ? parseInt(cl, 10) : 0;
      if (sizeNum > 0 && sizeNum <= 10 * 1024 * 1024) {
        notification.info("Downloading file to compute content hash...");
        const getResp = await fetch(gatewayUrl);
        if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
        const bytes = new Uint8Array(await getResp.arrayBuffer());
        setPasteSize(String(bytes.length));
        setPasteContentHash(computeContentHash(bytes));
        notification.success("Content hash computed.");
      } else if (sizeNum > 10 * 1024 * 1024) {
        notification.info(`File is ${Math.round(sizeNum / 1024 / 1024)}MB — hash not computed (too large).`);
      } else {
        const MAX_AUTO_DOWNLOAD = 10 * 1024 * 1024;
        notification.info("Downloading file to determine size and hash (cap: 10 MB)...");
        const controller = new AbortController();
        const getResp = await fetch(gatewayUrl, { signal: controller.signal });
        if (!getResp.ok) throw new Error(`Gateway returned ${getResp.status} — cannot compute hash`);
        const reader = getResp.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || !value) break;
              if (totalBytes + value.length > MAX_AUTO_DOWNLOAD) {
                truncated = true;
                controller.abort();
                break;
              }
              chunks.push(value);
              totalBytes += value.length;
            }
          } catch (err) {
            if (err instanceof Error && err.name !== "AbortError") throw err;
          }
        }
        if (truncated) {
          notification.info("File exceeds 10 MB — hash not computed. Enter values manually.");
        } else if (totalBytes > 0) {
          const bytes = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          setPasteSize(String(totalBytes));
          setPasteContentHash(computeContentHash(bytes));
          notification.success("Content hash computed.");
          if (!ct) {
            const getCt = getResp.headers.get("content-type");
            if (getCt) setPasteContentType(getCt.split(";")[0].trim());
          }
        }
      }
    } catch (e) {
      console.error("Fetch info failed:", e);
      notification.error("Could not fetch info from gateway. Enter values manually.");
    } finally {
      setIsFetchingInfo(false);
    }
  };

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
        // not our event
      }
    }
    return undefined;
  };

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

  // For Address containers the top-level parent is `bytes32(uint160(addr))`,
  // which is NOT a valid EAS attestation UID. Passing it as refUID makes EAS
  // revert. EFSIndexer.onAttest has a carve-out: if refUID == 0 and recipient
  // != 0, it derives the parent as `bytes32(uint160(recipient))`. We use that
  // path only when the user is creating a direct child of the Address
  // container root; deeper children reference real anchor attestations.
  const anchorParent = (): { refUID: `0x${string}`; recipient: `0x${string}` } => {
    if (
      container?.kind === "address" &&
      container.address &&
      currentAnchorUID &&
      currentAnchorUID.toLowerCase() === container.uid.toLowerCase()
    ) {
      return { refUID: ethers.ZeroHash as `0x${string}`, recipient: container.address };
    }
    return { refUID: currentAnchorUID as `0x${string}`, recipient: ethers.ZeroAddress as `0x${string}` };
  };

  const handleSubmit = async () => {
    if (!currentAnchorUID || !newName || !walletClient || !publicClient || !internalType) return;
    const nameError = validateAnchorName(newName);
    if (nameError) {
      notification.error(nameError);
      return;
    }
    if (internalType === "File" && !fileToUpload) {
      notification.error("Please select a file to upload.");
      return;
    }
    if (internalType === "PasteLink" && !pasteUri) {
      notification.error("Please enter a URI.");
      return;
    }

    // Pre-flight: writing a file means deploying N chunks + ~5 attestations.
    // If the wallet has 0 funds every step will fail silently at the RPC layer;
    // surface it up front rather than midway.
    try {
      const bal = await publicClient.getBalance({ address: walletClient.account.address });
      if (bal === 0n) {
        notification.error("Wallet has 0 ETH on this network. Click the faucet icon to fund it, then retry.");
        return;
      }
    } catch {
      // non-fatal — let the real tx surface its own error
    }

    setIsSubmitting(true);
    cancelledRef.current = false;

    const ops = useBackgroundOps.getState();
    const opTitle =
      internalType === "Folder"
        ? `Create folder: ${newName}`
        : internalType === "PasteLink"
          ? `Add link: ${newName}`
          : `Upload file: ${fileToUpload?.name || newName}`;
    const opId = ops.start(opTitle);

    const CANCEL_SENTINEL = "__UPLOAD_CANCELLED__";
    const checkCancelled = () => {
      if (cancelledRef.current) throw new Error(CANCEL_SENTINEL);
    };

    try {
      if (internalType === "Folder") {
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
              ops.log(opId, "Folder already exists; reusing anchor.");
            }
          } catch (e) {
            console.warn("Failed to check if anchor exists", e);
          }
        }

        if (!newAnchorUID) {
          const parent = anchorParent();
          const txHash = await attest(
            {
              functionName: "attest",
              args: [
                {
                  schema: anchorSchemaUID as `0x${string}`,
                  data: {
                    recipient: parent.recipient,
                    expirationTime: 0n,
                    revocable: false,
                    refUID: parent.refUID,
                    data: encodedName as `0x${string}`,
                    value: 0n,
                  },
                },
              ],
            },
            { silent: true },
          );
          if (!txHash) throw new Error("No txHash returned for ANCHOR creation.");
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          newAnchorUID = extractUIDFromReceipt(receipt);
          if (!newAnchorUID) throw new Error("Could not extract new Anchor UID");

          // Visibility TAG — folder visibility is tag-only (ADR-0006 revised 2026-04-18).
          // A folder appears in an edition-scoped listing iff at least one edition attester
          // has an active applies=true TAG(definition=dataSchemaUID, refUID=folder).
          const encodedTag = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bool"], [dataSchemaUID, true]);
          try {
            const tagTx = await attest(
              {
                functionName: "attest",
                args: [
                  {
                    schema: tagSchemaUID as `0x${string}`,
                    data: {
                      recipient: ethers.ZeroAddress,
                      expirationTime: 0n,
                      revocable: true,
                      refUID: newAnchorUID,
                      data: encodedTag as `0x${string}`,
                      value: 0n,
                    },
                  },
                ],
              },
              { silent: true },
            );
            if (tagTx) await publicClient.waitForTransactionReceipt({ hash: tagTx });
          } catch (e) {
            console.warn("Empty-folder visibility tag failed; folder will remain hidden until it has content.", e);
          }
        }

        notification.success("Folder created successfully.");
        handleClose();

        if (sortOverlayAddress && indexerAddress && currentAnchorUID && walletClient?.account && publicClient) {
          const pendingSortCount = enabledSortUIDs.length;
          if (pendingSortCount > 0) ops.log(opId, `Processing ${pendingSortCount} sort overlay(s)...`);
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
        ops.complete(opId, "Folder ready.");
        return;
      }

      // --- FILE UPLOAD or PASTE LINK ---
      const fileAnchorSchemaUID = dataSchemaUID as `0x${string}`;
      const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32"],
        [newName, fileAnchorSchemaUID],
      );

      let existingFileAnchorUID: `0x${string}` | undefined;
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
              // Nothing has been written yet — drop the op instead of leaving
              // it running forever while the user confirms.
              ops.clear(opId);
              return;
            }
            existingFileAnchorUID = existingUID;
            setExistingAnchorWarning(false);
          }
        } catch (e) {
          console.warn("Failed to check if anchor exists", e);
        }
      }

      let contentHash: `0x${string}`;
      let fileSize: bigint;
      let mirrorUri: string;
      let transportName: string;
      let contentType: string;

      if (internalType === "File") {
        const fileArrayBuffer = await fileToUpload!.arrayBuffer();
        const dataBytes = new Uint8Array(fileArrayBuffer);
        contentType = fileToUpload!.type || "application/octet-stream";

        if (dataBytes.length === 0) {
          const msg = "Cannot upload an empty file.";
          notification.error(msg);
          ops.fail(opId, msg);
          setIsSubmitting(false);
          return;
        }

        const MAX_ONCHAIN_SIZE = 24_000_000;
        if (dataBytes.length > MAX_ONCHAIN_SIZE) {
          const msg =
            `File too large for on-chain upload (${Math.round(dataBytes.length / 1024 / 1024)}MB). ` +
            `Maximum is ~${MAX_ONCHAIN_SIZE / 1_000_000}MB. Use IPFS or Arweave for large files.`;
          notification.error(msg);
          ops.fail(opId, msg);
          setIsSubmitting(false);
          return;
        }

        contentHash = computeContentHash(dataBytes);
        fileSize = BigInt(dataBytes.length);

        const CHUNK_SIZE = 24000;
        const totalChunks = Math.ceil(dataBytes.length / CHUNK_SIZE) || 1;
        ops.log(
          opId,
          `Uploading ${Math.round(dataBytes.length / 1024) || 1}KB in ${totalChunks} chunk${totalChunks > 1 ? "s" : ""} via SSTORE2...`,
        );
        const chunkAddresses: string[] = [];

        for (let i = 0; i < dataBytes.length; i += CHUNK_SIZE) {
          checkCancelled();
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
          ops.log(opId, `Deployed chunk ${chunkAddresses.length} of ${totalChunks}`);
          ops.progress(opId, Math.round((chunkAddresses.length / (totalChunks + 6)) * 100));
        }
        checkCancelled();

        ops.log(opId, "Deploying chunk manager...");
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
        checkCancelled();

        mirrorUri = `web3://${managerReceipt.contractAddress}:${targetNetwork.id}`;
        transportName = "onchain";
        ops.log(opId, `File URI: ${mirrorUri}`);
      } else {
        mirrorUri = pasteUri;
        const detected = detectTransport(pasteUri);
        if (detected === "unknown") {
          const msg = `Unsupported URI scheme. Supported: web3://, ipfs://, ar://, https://, magnet:`;
          notification.error(msg);
          ops.fail(opId, msg);
          return;
        }
        transportName = detected;
        contentType = pasteContentType || "application/octet-stream";
        contentHash = pasteContentHash || (ethers.ZeroHash as `0x${string}`);
        fileSize = pasteSize ? BigInt(pasteSize) : 0n;
      }

      let fileAnchorUID: `0x${string}` | undefined = existingFileAnchorUID;
      if (!fileAnchorUID) {
        const parent = anchorParent();
        const txHash = await attest(
          {
            functionName: "attest",
            args: [
              {
                schema: anchorSchemaUID as `0x${string}`,
                data: {
                  recipient: parent.recipient,
                  expirationTime: 0n,
                  revocable: false,
                  refUID: parent.refUID,
                  data: encodedName as `0x${string}`,
                  value: 0n,
                },
              },
            ],
          },
          { silent: true },
        );
        if (!txHash) throw new Error("No txHash returned for file ANCHOR creation.");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        fileAnchorUID = extractUIDFromReceipt(receipt);
        if (!fileAnchorUID) throw new Error("Could not extract file Anchor UID");
        ops.log(opId, "File anchor created.");
        checkCancelled();
      }

      if (contentHash !== ethers.ZeroHash && indexer && publicClient) {
        try {
          const canonical = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "dataByContentKey",
            args: [contentHash as `0x${string}`],
          })) as `0x${string}`;
          if (canonical && canonical !== ethers.ZeroHash) {
            ops.log(opId, "Note: DATA for this content already exists. A new one will still be created and tagged.");
          }
        } catch {
          // non-fatal
        }
      }

      ops.log(opId, "Creating DATA attestation...");
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint64"], [contentHash, fileSize]);
      const dataTxHash = await attest(
        {
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
        },
        { silent: true },
      );
      if (!dataTxHash) throw new Error("DATA attestation failed.");
      const dataReceipt = await publicClient.waitForTransactionReceipt({ hash: dataTxHash });
      const dataUID = extractUIDFromReceipt(dataReceipt);
      if (!dataUID) throw new Error("Could not extract DATA UID");
      ops.log(opId, `DATA created: ${dataUID.slice(0, 10)}...`);
      checkCancelled();

      // contentType PROPERTY (ADR-0035 / ADR-0005-superseded) uses the unified
      // free-floating model: key anchor under the DATA, free-floating PROPERTY
      // with value, then a TAG binding them. Three transactions; only the TAG
      // is revocable, so flipping a MIME type is a TAG re-attest, not a
      // PROPERTY revoke.
      ops.log(opId, "Creating contentType key anchor...");
      let contentTypeKeyAnchorUID: `0x${string}` | undefined;
      if (indexer && publicClient) {
        contentTypeKeyAnchorUID = (await publicClient.readContract({
          address: indexer.address as `0x${string}`,
          abi: indexer.abi,
          functionName: "resolveAnchor",
          args: [dataUID, "contentType", propertySchemaUID as `0x${string}`],
        })) as `0x${string}`;
      }
      if (!contentTypeKeyAnchorUID || contentTypeKeyAnchorUID === (ethers.ZeroHash as `0x${string}`)) {
        const encodedKey = ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "bytes32"],
          ["contentType", propertySchemaUID],
        );
        const keyTx = await attest(
          {
            functionName: "attest",
            args: [
              {
                schema: anchorSchemaUID as `0x${string}`,
                data: {
                  recipient: ethers.ZeroAddress,
                  expirationTime: 0n,
                  revocable: false,
                  refUID: dataUID,
                  data: encodedKey as `0x${string}`,
                  value: 0n,
                },
              },
            ],
          },
          { silent: true },
        );
        if (!keyTx) throw new Error("contentType key anchor attestation failed.");
        const keyReceipt = await publicClient.waitForTransactionReceipt({ hash: keyTx });
        contentTypeKeyAnchorUID = extractUIDFromReceipt(keyReceipt);
        if (!contentTypeKeyAnchorUID) throw new Error("Could not extract contentType key anchor UID");
      }

      ops.log(opId, "Attesting content type PROPERTY...");
      const encodedProperty = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [contentType]);
      const propTxHash = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: propertySchemaUID as `0x${string}`,
              data: {
                recipient: ethers.ZeroAddress,
                expirationTime: 0n,
                revocable: false,
                refUID: ethers.ZeroHash as `0x${string}`,
                data: encodedProperty as `0x${string}`,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (!propTxHash) throw new Error("contentType PROPERTY attestation failed.");
      const propReceipt = await publicClient.waitForTransactionReceipt({ hash: propTxHash });
      const contentTypePropertyUID = extractUIDFromReceipt(propReceipt);
      if (!contentTypePropertyUID) throw new Error("Could not extract contentType PROPERTY UID");

      ops.log(opId, "Binding contentType TAG...");
      const encodedContentTypeTag = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bool"],
        [contentTypeKeyAnchorUID, true],
      );
      const contentTypeTagTxHash = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: tagSchemaUID as `0x${string}`,
              data: {
                recipient: ethers.ZeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: contentTypePropertyUID,
                data: encodedContentTypeTag as `0x${string}`,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (contentTypeTagTxHash) await publicClient.waitForTransactionReceipt({ hash: contentTypeTagTxHash });
      checkCancelled();

      const transportAnchorUID = await resolveTransportAnchor(transportName);
      if (!transportAnchorUID) {
        const msg = `Transport anchor '/transports/${transportName}' not found. Aborting upload.`;
        notification.error(msg);
        ops.fail(opId, msg);
        return;
      } else {
        ops.log(
          opId,
          `Creating ${TRANSPORT_LABELS[transportName as keyof typeof TRANSPORT_LABELS] || transportName} mirror...`,
        );
        const encodedMirror = ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [transportAnchorUID, mirrorUri],
        );
        const mirrorTxHash = await attest(
          {
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
          },
          { silent: true },
        );
        if (mirrorTxHash) await publicClient.waitForTransactionReceipt({ hash: mirrorTxHash });
      }
      checkCancelled();

      ops.log(opId, "Placing file in folder via TAG...");
      const encodedTag = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bool"], [fileAnchorUID, true]);
      const tagTxHash = await attest(
        {
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
        },
        { silent: true },
      );
      if (tagTxHash) await publicClient.waitForTransactionReceipt({ hash: tagTxHash });
      checkCancelled();

      // Ancestor-walk visibility TAGs (tag-only folder-visibility model, ADR-0006 revised
      // 2026-04-18). A folder appears in an edition listing iff at least one edition
      // attester has an active applies=true TAG(definition=dataSchemaUID, refUID=folder).
      // On upload, the uploader must emit that TAG at every generic-folder ancestor from
      // the immediate parent up to (but excluding) root, or those folders stay hidden in
      // the uploader's edition. Skip ancestors already tagged by this attester.
      if (indexer) {
        const tagResolverAddress = await getTagResolverAddress(targetNetwork.id);
        if (tagResolverAddress) {
          try {
            const rootUID = (await publicClient.readContract({
              address: indexer.address as `0x${string}`,
              abi: indexer.abi,
              functionName: "rootAnchorUID",
            })) as `0x${string}`;

            const attester = walletClient.account.address;
            let current = currentAnchorUID as `0x${string}`;
            const MAX_ANCHOR_DEPTH = 32;
            let walked = 0;
            while (
              walked < MAX_ANCHOR_DEPTH &&
              current &&
              current !== (ethers.ZeroHash as `0x${string}`) &&
              current.toLowerCase() !== rootUID.toLowerCase()
            ) {
              const existing = (await publicClient.readContract({
                address: tagResolverAddress,
                abi: TAG_RESOLVER_ABI,
                functionName: "getActiveTagUID",
                args: [attester, current, dataSchemaUID as `0x${string}`],
              })) as `0x${string}`;

              if (existing === (ethers.ZeroHash as `0x${string}`)) {
                ops.log(opId, `Tagging ancestor folder ${current.slice(0, 10)}... for visibility`);
                const encodedVisTag = ethers.AbiCoder.defaultAbiCoder().encode(
                  ["bytes32", "bool"],
                  [dataSchemaUID, true],
                );
                const visTxHash = await attest(
                  {
                    functionName: "attest",
                    args: [
                      {
                        schema: tagSchemaUID as `0x${string}`,
                        data: {
                          recipient: ethers.ZeroAddress,
                          expirationTime: 0n,
                          revocable: true,
                          refUID: current,
                          data: encodedVisTag as `0x${string}`,
                          value: 0n,
                        },
                      },
                    ],
                  },
                  { silent: true },
                );
                if (visTxHash) await publicClient.waitForTransactionReceipt({ hash: visTxHash });
              }

              const parent = (await publicClient.readContract({
                address: indexer.address as `0x${string}`,
                abi: indexer.abi,
                functionName: "getParent",
                args: [current],
              })) as `0x${string}`;
              current = parent;
              walked += 1;
              checkCancelled();
            }
          } catch (e) {
            console.warn("Ancestor-walk visibility tagging failed; some ancestors may stay hidden.", e);
          }
        }
      }

      notification.success("File uploaded and placed successfully.");
      ops.complete(opId, "File uploaded and placed.");
      onFileCreated?.(enabledSortUIDs);
      handleClose();
    } catch (e) {
      if (e instanceof Error && e.message === CANCEL_SENTINEL) {
        ops.fail(opId, "Cancelled by user. Any transactions already broadcast will still settle on-chain.");
      } else {
        console.error(e);
        const msg = extractErrorMessage(e);
        notification.error(msg);
        ops.fail(opId, msg);
      }
    } finally {
      setIsSubmitting(false);
      cancelledRef.current = false;
    }
  };

  return (
    <dialog id="create_modal" className="modal" ref={modalRef}>
      <div className="modal-box">
        <h3 className="font-bold text-lg">{internalType === "Folder" ? "Create New Folder" : "Add File"}</h3>
        {internalType !== "Folder" && internalType !== null && (
          <div className="tabs tabs-bordered mt-2">
            <button
              className={`tab ${internalType === "File" ? "tab-active" : ""}`}
              onClick={() => setInternalType("File")}
            >
              Upload File
            </button>
            <button
              className={`tab ${internalType === "PasteLink" ? "tab-active" : ""}`}
              onClick={() => setInternalType("PasteLink")}
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
            placeholder={`Enter ${internalType === "Folder" ? "folder" : "file"} name`}
            className={`input input-bordered w-full ${nameValidationError ? "input-error" : ""}`}
            value={newName}
            onChange={e => {
              setNewName(e.target.value);
              setExistingAnchorWarning(false);
            }}
            onKeyDown={e => {
              if (
                e.key === "Enter" &&
                newName &&
                !nameValidationError &&
                (internalType !== "File" || fileToUpload) &&
                (internalType !== "PasteLink" || pasteUri)
              )
                handleSubmit();
              if (e.key === "Escape") handleClose();
            }}
            autoComplete="off"
            autoFocus
          />
          {nameValidationError && (
            <label className="label">
              <span className="label-text-alt text-error">{nameValidationError}</span>
            </label>
          )}
        </div>
        {internalType === "File" && (
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
        {internalType === "PasteLink" && (
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
                      {[pasteContentType && "type", pasteSize && "size", pasteContentHash && "hash"]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  )}
                </span>
                {pasteUri && detectTransport(pasteUri) !== "magnet" && detectTransport(pasteUri) !== "onchain" && (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    onClick={e => {
                      e.stopPropagation();
                      handleFetchInfo();
                    }}
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
                        if (!val) {
                          setPasteContentHash(null);
                          return;
                        }
                        setPasteContentHash(val as `0x${string}`);
                      }}
                    />
                    {pasteContentHash && (
                      <label className="label py-0">
                        <span className="label-text-alt text-success text-xs">Verified from file bytes</span>
                      </label>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {existingAnchorWarning && internalType !== "Folder" && (
          <div className="alert alert-warning mt-2 text-sm py-2">
            A file named &quot;{newName}&quot; already exists here. Submitting will add a new version to the existing
            anchor.
          </div>
        )}

        <div className="modal-action items-center">
          {internalType !== "Folder" && availableSorts.length > 0 ? (
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
          {isSubmitting ? (
            <button
              type="button"
              className="btn btn-error"
              onClick={() => {
                cancelledRef.current = true;
              }}
              title="Stop upload. Transactions already broadcast will still settle on-chain."
            >
              <StopIcon className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={handleClose}>
              Close
            </button>
          )}
          <button
            className={`btn ${existingAnchorWarning && internalType !== "Folder" ? "btn-warning" : "btn-primary"}`}
            onClick={handleSubmit}
            disabled={
              !newName ||
              !!nameValidationError ||
              isSubmitting ||
              (internalType === "File" && !fileToUpload) ||
              (internalType === "PasteLink" && !pasteUri)
            }
          >
            {isSubmitting && <span className="loading loading-spinner loading-xs" />}
            {isSubmitting
              ? "Creating..."
              : existingAnchorWarning && internalType !== "Folder"
                ? "Update Existing"
                : "Create"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={handleClose}>close</button>
      </form>
    </dialog>
  );
};
