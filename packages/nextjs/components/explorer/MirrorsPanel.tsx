"use client";

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { encodeDeployData, toHex, zeroHash } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { ArrowUpTrayIcon, LinkIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { TAG_RESOLVER_ABI } from "~~/utils/efs/tagResolver";
import { TRANSPORT_LABELS, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";
import { notification } from "~~/utils/scaffold-eth";

const MOCK_CHUNKED_FILE_ABI = [
  {
    inputs: [{ internalType: "address[]", name: "_chunks", type: "address[]" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
] as const;

const MOCK_CHUNKED_FILE_BYTECODE =
  "0x60806040523461013f57610274803803806100198161015a565b92833981019060208183031261013f578051906001600160401b03821161013f570181601f8201121561013f578051916001600160401b038311610144578260051b9160208061006a81860161015a565b80968152019382010191821161013f57602001915b81831061011f576000845b80518210156101115760009160018060a01b0360208260051b84010151168354680100000000000000008110156100fd57600181018086558110156100e957602085806001969752200190838060a01b0319825416179055019061008a565b634e487b7160e01b85526032600452602485fd5b634e487b7160e01b85526041600452602485fd5b60405160f490816101808239f35b82516001600160a01b038116810361013f5781526020928301920161007f565b600080fd5b634e487b7160e01b600052604160045260246000fd5b6040519190601f01601f191682016001600160401b038111838210176101445760405256fe6080806040526004361015601257600080fd5b60003560e01c9081632bfedae0146053575063f91f093714603257600080fd5b34604e576000366003190112604e576020600054604051908152f35b600080fd5b34604e576020366003190112604e576004359060005482101560a857600080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563909101546001600160a01b03168152602090f35b634e487b7160e01b600052603260045260246000fdfea26469706673582212206ea2dc51d432b7722a3857f0e86c67aaa8fa760e9dee9a8bbd7f8fac66eade7f64736f6c634300081c0033";

interface MirrorItem {
  uid: string;
  transportDefinition: string;
  uri: string;
  attester: string;
  timestamp: bigint;
}

const EAS_GET_ATTESTATION_ABI = [
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
] as const;

const FILE_VIEW_MIRRORS_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "dataUID", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getDataMirrors",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "bytes32", name: "transportDefinition", type: "bytes32" },
          { internalType: "string", name: "uri", type: "string" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "uint64", name: "timestamp", type: "uint64" },
        ],
        internalType: "struct EFSFileView.MirrorItem[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const MirrorsPanel = ({
  fileAnchorUID,
  editionAddresses,
}: {
  fileAnchorUID: string;
  editionAddresses: string[];
}) => {
  const [mirrors, setMirrors] = useState<MirrorItem[]>([]);
  const [dataUID, setDataUID] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAddingMirror, setIsAddingMirror] = useState(false);
  const [addMode, setAddMode] = useState<"uri" | "upload">("uri");
  const [newUri, setNewUri] = useState("");
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [transportAnchors, setTransportAnchors] = useState<Record<string, string>>({});

  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { address: connectedAddress } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: fileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });
  const { data: tagResolverInfo } = useDeployedContractInfo({ contractName: "TagResolver" });
  const { writeContractAsync: attest } = useScaffoldWriteContract({ contractName: "EAS" });

  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });
  const { data: mirrorSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "MIRROR_SCHEMA_UID",
  });
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" });

  // Resolve DATA UID from file anchor via TAG query.
  // Scans all active targets and picks the one with the highest attestation timestamp
  // because the swap-and-pop array is not chronologically ordered.
  const resolveDataUID = useCallback(async () => {
    if (!publicClient || !tagResolverInfo || !easInfo || !dataSchemaUID || !fileAnchorUID) return;

    const attesters = editionAddresses.length > 0 ? editionAddresses : connectedAddress ? [connectedAddress] : [];
    if (attesters.length === 0) {
      setDataUID(null);
      return;
    }

    for (const attester of attesters) {
      try {
        const count = (await publicClient.readContract({
          address: tagResolverInfo.address as `0x${string}`,
          abi: TAG_RESOLVER_ABI,
          functionName: "getActiveTargetsByAttesterAndSchemaCount",
          args: [fileAnchorUID as `0x${string}`, attester as `0x${string}`, dataSchemaUID as `0x${string}`],
        })) as bigint;

        if (count > 0n) {
          const scanCount = count > 50n ? 50n : count;
          const targets = (await publicClient.readContract({
            address: tagResolverInfo.address as `0x${string}`,
            abi: TAG_RESOLVER_ABI,
            functionName: "getActiveTargetsByAttesterAndSchema",
            args: [
              fileAnchorUID as `0x${string}`,
              attester as `0x${string}`,
              dataSchemaUID as `0x${string}`,
              0n,
              scanCount,
            ],
          })) as `0x${string}`[];

          if (targets.length === 0) continue;

          // Pick the most recent DATA by attestation timestamp
          let best = targets[0];
          let bestTime = 0n;
          for (const uid of targets) {
            if (!uid || uid === zeroHash) continue;
            const att = (await publicClient.readContract({
              address: easInfo.address as `0x${string}`,
              abi: EAS_GET_ATTESTATION_ABI,
              functionName: "getAttestation",
              args: [uid],
            })) as { time: bigint };
            if (att.time > bestTime) {
              bestTime = att.time;
              best = uid;
            }
          }

          if (best && best !== zeroHash) {
            setDataUID(best);
            return;
          }
        }
      } catch (e) {
        console.warn("Failed to resolve DATA for attester", attester, e);
      }
    }
    // No active DATA found for any attester — clear stale value
    setDataUID(null);
  }, [publicClient, tagResolverInfo, easInfo, dataSchemaUID, fileAnchorUID, editionAddresses, connectedAddress]);

  // Fetch mirrors for the resolved DATA UID
  const fetchMirrors = useCallback(async () => {
    if (!dataUID || !publicClient || !fileViewInfo) {
      setMirrors([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = (await publicClient.readContract({
        address: fileViewInfo.address as `0x${string}`,
        abi: FILE_VIEW_MIRRORS_ABI,
        functionName: "getDataMirrors",
        args: [dataUID as `0x${string}`, 0n, 50n],
      })) as readonly {
        uid: `0x${string}`;
        transportDefinition: `0x${string}`;
        uri: string;
        attester: `0x${string}`;
        timestamp: bigint;
      }[];

      setMirrors(
        result.map(m => ({
          uid: m.uid,
          transportDefinition: m.transportDefinition,
          uri: m.uri,
          attester: m.attester,
          timestamp: m.timestamp,
        })),
      );
    } catch (e) {
      console.error("Failed to fetch mirrors:", e);
    } finally {
      setIsLoading(false);
    }
  }, [dataUID, publicClient, fileViewInfo]);

  // Resolve transport anchor UIDs for labeling
  const resolveTransportAnchors = useCallback(async () => {
    if (!publicClient || !indexerInfo) return;
    try {
      const rootUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "rootAnchorUID",
      })) as `0x${string}`;
      const transportsUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "resolvePath",
        args: [rootUID, "transports"],
      })) as `0x${string}`;
      if (!transportsUID || transportsUID === zeroHash) return;

      const names = ["onchain", "ipfs", "arweave", "https", "magnet"];
      const results = await Promise.allSettled(
        names.map(name =>
          publicClient.readContract({
            address: indexerInfo.address as `0x${string}`,
            abi: indexerInfo.abi,
            functionName: "resolvePath",
            args: [transportsUID, name],
          }),
        ),
      );
      const anchors: Record<string, string> = {};
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          const uid = result.value as `0x${string}`;
          if (uid && uid !== zeroHash) anchors[uid.toLowerCase()] = names[i];
        }
      });
      setTransportAnchors(anchors);
    } catch (e) {
      console.warn("Failed to resolve transport anchors:", e);
    }
  }, [publicClient, indexerInfo]);

  useEffect(() => {
    resolveDataUID();
  }, [resolveDataUID]);

  useEffect(() => {
    fetchMirrors();
  }, [fetchMirrors]);

  useEffect(() => {
    resolveTransportAnchors();
  }, [resolveTransportAnchors]);

  const resolveTransportAnchorUID = async (transportName: string): Promise<`0x${string}` | null> => {
    if (!indexerInfo || !publicClient) return null;
    try {
      const rootUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "rootAnchorUID",
      })) as `0x${string}`;
      const transportsUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "resolvePath",
        args: [rootUID, "transports"],
      })) as `0x${string}`;
      if (!transportsUID || transportsUID === zeroHash) return null;
      const uid = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "resolvePath",
        args: [transportsUID, transportName],
      })) as `0x${string}`;
      return uid && uid !== zeroHash ? uid : null;
    } catch {
      return null;
    }
  };

  /** Create a MIRROR attestation referencing the DATA UID. Returns true if a tx was sent. */
  const createMirrorAttestation = async (transportName: string, mirrorUri: string): Promise<boolean> => {
    if (!mirrorSchemaUID || !dataUID) {
      notification.error("Mirror schema or DATA UID not available.");
      return false;
    }
    const transportAnchorUID = await resolveTransportAnchorUID(transportName);
    if (!transportAnchorUID) {
      notification.error(`Transport anchor '/transports/${transportName}' not found.`);
      return false;
    }
    const encodedMirror = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "string"],
      [transportAnchorUID, mirrorUri],
    );
    const txHash = await attest({
      functionName: "attest",
      args: [
        {
          schema: mirrorSchemaUID as `0x${string}`,
          data: {
            recipient: ethers.ZeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: dataUID as `0x${string}`,
            data: encodedMirror as `0x${string}`,
            value: 0n,
          },
        },
      ],
    });
    if (txHash && publicClient) {
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    }
    return !!txHash;
  };

  const handleAddMirrorByUri = async () => {
    if (!dataUID || !newUri || !walletClient || !publicClient) return;
    setIsSubmitting(true);
    try {
      const detected = detectTransport(newUri);
      if (detected === "unknown") {
        notification.error("Unrecognized URI scheme. Use web3://, ipfs://, ar://, https://, or magnet:");
        setIsSubmitting(false);
        return;
      }
      const submitted = await createMirrorAttestation(detected, newUri);
      if (!submitted) return;
      notification.success(`${TRANSPORT_LABELS[detected as keyof typeof TRANSPORT_LABELS]} mirror added.`);
      setNewUri("");
      setIsAddingMirror(false);
      fetchMirrors();
    } catch (e) {
      console.error("Failed to add mirror:", e);
      notification.error("Failed to add mirror.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddMirrorByUpload = async () => {
    if (!dataUID || !fileToUpload || !walletClient || !publicClient) return;
    setIsSubmitting(true);
    try {
      const fileArrayBuffer = await fileToUpload.arrayBuffer();
      const dataBytes = new Uint8Array(fileArrayBuffer);
      if (dataBytes.length === 0) {
        notification.error("Cannot upload an empty file.");
        return;
      }

      const MAX_ONCHAIN_SIZE = 24_000_000;
      if (dataBytes.length > MAX_ONCHAIN_SIZE) {
        notification.error(
          `File too large for on-chain upload (${Math.round(dataBytes.length / 1024 / 1024)}MB). ` +
            `Maximum is ~${MAX_ONCHAIN_SIZE / 1_000_000}MB. Use IPFS or Arweave for large files.`,
        );
        return;
      }

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
          account: walletClient.account!,
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
        account: walletClient.account!,
      });
      const managerReceipt = await publicClient.waitForTransactionReceipt({ hash: managerHash });
      if (!managerReceipt.contractAddress) throw new Error("Manager deployment failed");

      const mirrorUri = `web3://${managerReceipt.contractAddress}:${targetNetwork.id}`;
      const submitted = await createMirrorAttestation("onchain", mirrorUri);
      if (!submitted) return;

      notification.success("On-chain mirror added.");
      setFileToUpload(null);
      setIsAddingMirror(false);
      fetchMirrors();
    } catch (e) {
      console.error("Failed to upload on-chain mirror:", e);
      notification.error("Failed to upload. See console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokeMirror = async (mirrorUID: string) => {
    if (!mirrorSchemaUID || !publicClient) return;
    setIsSubmitting(true);
    try {
      const txHash = await attest({
        functionName: "revoke",
        args: [{ schema: mirrorSchemaUID as `0x${string}`, data: { uid: mirrorUID as `0x${string}`, value: 0n } }],
      });
      if (txHash) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        notification.success("Mirror removed.");
        fetchMirrors();
      }
    } catch (e) {
      console.error("Failed to revoke mirror:", e);
      notification.error("Failed to remove mirror.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getTransportLabel = (defUID: string) => {
    const name = transportAnchors[defUID.toLowerCase()];
    if (name) return TRANSPORT_LABELS[name as keyof typeof TRANSPORT_LABELS] || name;
    return defUID.slice(0, 10) + "...";
  };

  if (!dataUID && !isLoading) {
    return null;
  }

  return (
    <div className="px-4 py-2 border-t border-base-300 shrink-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-base-content/70">
          Mirrors {mirrors.length > 0 && `(${mirrors.length})`}
        </span>
        {dataUID && (
          <button
            className="btn btn-ghost btn-xs gap-1"
            onClick={() => setIsAddingMirror(!isAddingMirror)}
            title="Add mirror"
          >
            <PlusIcon className="w-3 h-3" />
            Add
          </button>
        )}
      </div>

      {isLoading ? (
        <span className="loading loading-spinner loading-xs"></span>
      ) : (
        <div className="flex flex-col gap-1">
          {mirrors.map(m => {
            const gwUrl = resolveGatewayUrl(m.uri);
            return (
              <div key={m.uid} className="flex items-center gap-1.5 text-xs group">
                <span className="badge badge-xs badge-outline shrink-0">
                  {getTransportLabel(m.transportDefinition)}
                </span>
                {gwUrl || m.uri.startsWith("http") ? (
                  <a
                    href={gwUrl || m.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-primary hover:underline"
                    title={m.uri}
                  >
                    {m.uri}
                  </a>
                ) : (
                  <span className="truncate text-base-content/50" title={m.uri}>
                    {m.uri}
                  </span>
                )}
                {connectedAddress && m.attester.toLowerCase() === connectedAddress.toLowerCase() && (
                  <button
                    className="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={() => handleRevokeMirror(m.uid)}
                    disabled={isSubmitting}
                    title="Remove mirror"
                  >
                    <TrashIcon className="w-3 h-3 text-error" />
                  </button>
                )}
              </div>
            );
          })}
          {mirrors.length === 0 && !isLoading && <span className="text-xs text-base-content/40">No mirrors found</span>}
        </div>
      )}

      {isAddingMirror && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="tabs tabs-xs tabs-bordered">
            <button className={`tab ${addMode === "uri" ? "tab-active" : ""}`} onClick={() => setAddMode("uri")}>
              <LinkIcon className="w-3 h-3 mr-1" /> Paste URI
            </button>
            <button className={`tab ${addMode === "upload" ? "tab-active" : ""}`} onClick={() => setAddMode("upload")}>
              <ArrowUpTrayIcon className="w-3 h-3 mr-1" /> Upload File
            </button>
          </div>

          {addMode === "uri" ? (
            <>
              <input
                type="text"
                placeholder="ipfs://Qm..., ar://..., https://..."
                className="input input-bordered input-xs w-full"
                value={newUri}
                onChange={e => setNewUri(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && newUri) handleAddMirrorByUri();
                  if (e.key === "Escape") setIsAddingMirror(false);
                }}
                autoFocus
              />
              {newUri && (
                <span className="text-xs text-base-content/40">
                  Transport: {TRANSPORT_LABELS[detectTransport(newUri)]}
                </span>
              )}
            </>
          ) : (
            <input
              type="file"
              className="file-input file-input-bordered file-input-xs w-full"
              onChange={e => {
                setFileToUpload(e.target.files?.[0] || null);
              }}
            />
          )}

          <div className="flex gap-1 justify-end">
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setIsAddingMirror(false);
                setFileToUpload(null);
                setNewUri("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-xs"
              onClick={addMode === "uri" ? handleAddMirrorByUri : handleAddMirrorByUpload}
              disabled={(addMode === "uri" ? !newUri : !fileToUpload) || isSubmitting}
            >
              {isSubmitting ? "Adding..." : addMode === "uri" ? "Add Mirror" : "Upload & Add Mirror"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
