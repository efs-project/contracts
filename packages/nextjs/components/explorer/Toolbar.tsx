"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { decodeEventLog, encodeDeployData, parseAbiItem, toHex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
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

export type PathItem = {
  uid: string;
  name: string;
};

export const Toolbar = ({
  currentPath,
  currentAnchorUID,
  anchorSchemaUID,
  dataSchemaUID,
  onNavigate,
}: {
  currentPath: PathItem[];
  currentAnchorUID: string | null;
  anchorSchemaUID: string;
  dataSchemaUID: string;
  onNavigate: (uid: string) => void;
}) => {
  const { writeContractAsync: attest } = useScaffoldWriteContract("EAS");

  // Modal State
  const [creationType, setCreationType] = useState<"Folder" | "File" | null>(null);
  const [newName, setNewName] = useState("");
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dialog Ref for DaisyUI
  const modalRef = useRef<HTMLDialogElement>(null);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

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
        if (!txHash) throw new Error("No txHash returned for ANCHOR creation.");

        // Wait for receipt
        const receipt = await publicClient?.waitForTransactionReceipt({ hash: txHash });
        if (!receipt) throw new Error("Failed to get transaction receipt for ANCHOR");

        // Parse Log to find the new Anchor UID
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

        if (!newAnchorUID) throw new Error("Could not extract new Anchor UID");
        notification.info(`New Anchor UID: ${newAnchorUID}`);
        // Read file contents as bytes for accurate chunking
        const fileArrayBuffer = await fileToUpload!.arrayBuffer();
        const dataBytes = new Uint8Array(fileArrayBuffer);
        const contentType = fileToUpload!.type || "text/plain";

        let uri = "";
        const CHUNK_SIZE = 24000; // Under 24576 bytes limit to leave room for 1-byte SSTORE2 prefix

        // Always upload to SSTORE2 — `uri` must be a web3:// URI, never raw file content.
        // Embedding file bytes directly in an EAS attestation calldata causes gas estimation
        // to time out even for files a few KB in size.
        notification.info(`Uploading ${Math.round(dataBytes.length / 1024) || 1}KB via SSTORE2...`);
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
          notification.info(`Deployed chunk ${chunkAddresses.length}...`);
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

        uri = `web3://${managerReceipt.contractAddress}:31337`;
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
      } else {
        notification.success("Folder created successfully.");
      }
      handleCloseModal();
    } catch (e) {
      console.error(e);
      notification.error("Creation failed. See console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex justify-between items-center p-2 bg-base-100 rounded-lg">
      <div className="breadcrumbs text-sm">
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

      <div className="flex gap-2">
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
          <div className="modal-action">
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
