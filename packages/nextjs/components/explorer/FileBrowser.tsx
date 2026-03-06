"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PropertiesModal } from "./PropertiesModal";
import { ethers } from "ethers";
import { usePublicClient } from "wagmi";
import {
  DocumentIcon,
  FolderIcon,
  InformationCircleIcon,
  Square2StackIcon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { isFile, isTopic } from "~~/utils/efs/efsTypes";
import { notification } from "~~/utils/scaffold-eth";

export const FileBrowser = ({
  currentAnchorUID,
  dataSchemaUID,
  currentPathNames,
  onNavigate,
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  currentPathNames: string[];
  onNavigate: (uid: string, name: string) => void;
}) => {
  const [selectedDebugItem, setSelectedDebugItem] = useState<any | null>(null);
  const [propertiesModalUID, setPropertiesModalUID] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [isFileLoading, setIsFileLoading] = useState(false);

  const { data: efsRouter } = useDeployedContractInfo("EFSRouter");
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient();

  const fetchFileContent = async (item: any) => {
    if (!efsRouter) {
      notification.error("EFSRouter not found. Please deploy.");
      return;
    }
    setIsFileLoading(true);
    setFileContent(null);
    setFileContentType(null);
    try {
      // In a real implementation we might pass the full path from the Toolbar/Page.
      // EFS Router expects the path elements. For now, we'll just request the item.name
      // assuming the router can resolve from root if we pass the right path.
      // Wait, the router resolve expects the full path from the root Anchor.
      // Since we don't have the breadcrumbs in FileBrowser, we might just try fetching by UID directly,
      // but EFSRouter requests take `web3://<router>/path/to/file`.
      // Let's pass the item name and assume it's at the root for this test,
      // or we can pass `currentPath` from page.tsx to FileBrowser and build it.
      // For the test files `/debug/test.txt`, path is `debug/test.txt`.
      // The frontend currently doesn't pass the full path string array to FileBrowser,
      // so for now, we'll try to just guess it's `debug/${item.name}` as a quick hack for the test,
      // or if we can't, we should add `currentPath` as a prop.

      // Let's fetch using web3protocol dynamically to avoid SSR WASM errors
      const { Client } = await import("web3protocol");
      const { getDefaultChainList } = await import("web3protocol/chains");

      let chainList = getDefaultChainList();
      if (targetNetwork.id === 31337) {
        chainList = [
          ...chainList,
          {
            id: 31337,
            name: "Hardhat",
            shortName: "hht",
            chain: "ETH",
            network: "hardhat",
            rpc: ["http://127.0.0.1:8545"],
            faucets: [],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            infoURL: "https://hardhat.org",
          },
        ];
      }

      const web3Client = new Client(chainList);

      // In a real app, `currentPath` and its string names should be passed to `FileBrowser`.
      const joinedPath = currentPathNames.length > 0 ? currentPathNames.join("/") + "/" : "";
      const uri = `web3://${efsRouter.address}:31337/${joinedPath}${item.name}`;

      let result: number[] = [];
      let contentTypeStr = "text/plain";

      try {
        const fetchedWeb3Url = await web3Client.fetchUrl(uri);
        if (fetchedWeb3Url.httpCode !== 200) {
          throw new Error(`HTTP ${fetchedWeb3Url.httpCode}`);
        }

        const reader = fetchedWeb3Url.output.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          result.push(...value);
        }

        const contentTypeInfo = Object.entries(fetchedWeb3Url.httpHeaders || {}).find(
          ([k]) => k.toLowerCase() === "content-type",
        );
        contentTypeStr = contentTypeInfo ? (contentTypeInfo[1] as string) : "text/plain";
      } catch (protocolErr) {
        console.warn("web3protocol failed, using direct fallback", protocolErr);
        // Direct Router Fallback for local dev
        if (!publicClient) throw protocolErr;

        result = []; // Clear any partial chunks downloaded before web3protocol crashed

        let hasMoreChunks = true;
        let currentChunkHeader = "";

        while (hasMoreChunks) {
          const args: any[] = [[...currentPathNames, item.name], []];

          // Mimic web3protocol query formatting for chunk queries if not the first chunk
          // In EFSRouter, `request(string[] memory path, KeyValue[] memory queries)` takes queries.
          if (currentChunkHeader) {
            // currentChunkHeader is "?chunk=1"
            const chunkIndex = currentChunkHeader.split("=")[1];
            if (chunkIndex !== undefined) {
              args[1] = [{ key: "chunk", value: chunkIndex }];
            }
          }

          const response = (await publicClient.readContract({
            address: efsRouter.address as `0x${string}`,
            abi: efsRouter.abi,
            functionName: "request",
            args: args as any,
          })) as any;

          if (response[0] === 200n || response[0] === 200) {
            // Convert hex body to bytes. (response.body is now a hex string since we changed ABI to return bytes)
            const bodyHex = response[1] as `0x${string}`;
            if (bodyHex && bodyHex !== "0x") {
              const bodyBytes = ethers.getBytes(bodyHex);
              for (let i = 0; i < bodyBytes.length; i++) {
                result.push(bodyBytes[i]);
              }
            }
            // Try to get content-type from headers
            const outHeaders = response[2] as any[];
            const ctHeader = outHeaders.find(h => h.key.toLowerCase() === "content-type");
            if (ctHeader) contentTypeStr = ctHeader.value;

            // Check for next chunk
            const nextChunkHeader = outHeaders.find(h => h.key.toLowerCase() === "web3-next-chunk");
            if (nextChunkHeader) {
              currentChunkHeader = nextChunkHeader.value;
            } else {
              hasMoreChunks = false;
            }
          } else {
            throw protocolErr; // Re-throw if fallback also fails
          }
        }
      }

      setFileContentType(contentTypeStr);

      if (contentTypeStr.startsWith("image/") && !contentTypeStr.includes("svg")) {
        // Use native Blob to bypass browser string-length and Base64-render truncations
        const bytes = new Uint8Array(result);
        const blob = new Blob([bytes], { type: contentTypeStr });
        const objectUrl = URL.createObjectURL(blob);
        setFileContent(objectUrl);
      } else {
        // parse as utf-8 string
        const text = new TextDecoder().decode(new Uint8Array(result));
        setFileContent(text);
      }
    } catch (e: unknown) {
      const err = e as Error;
      console.error("Failed to fetch file content", err);
      setFileContent(null);
      notification.error(`Fetch failed: ${err.message || String(e)}`);
    } finally {
      setIsFileLoading(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error("Failed to copy", e);
    }
  };

  const { data: propertySchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });

  // Pagination (Simple for now: fetch first 50)
  const { data: items, isLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [
      (currentAnchorUID ? currentAnchorUID : undefined) as `0x${string}` | undefined,
      0n,
      50n,
      dataSchemaUID as `0x${string}`,
      propertySchemaUID as `0x${string}`,
    ],
    watch: true,
  });

  if (isLoading) return <div>Loading items...</div>;
  if (!currentAnchorUID) return <div>Select a topic</div>;

  const DebugField = ({ label, value, type = "uid" }: { label: string; value: string; type?: "uid" | "address" }) => (
    <div>
      <span className="font-bold block text-xs uppercase text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        {type === "uid" ? (
          <Link
            href={`/easexplorer?uid=${value}`}
            target="_blank"
            className="font-mono text-xs break-all bg-base-200 p-1 rounded hover:opacity-80 underline decoration-dotted"
          >
            {value}
          </Link>
        ) : (
          <span className="font-mono text-xs break-all bg-base-200 p-1 rounded select-all">{value}</span>
        )}
        <button className="btn btn-ghost btn-xs btn-circle" onClick={() => copy(value)} title="Copy">
          <Square2StackIcon className="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative h-full">
      <div className="grid grid-cols-4 gap-4 p-4">
        {items
          ?.filter((item: any) => isTopic(item) || isFile(item, dataSchemaUID))
          .map((item: any) => {
            // isTopic = Generic Anchor (Schema 0 or undefined legacy)
            // isFile = Data Anchor (Schema DATA_SCHEMA_UID)
            const isItemTopic = isTopic(item);
            const isItemFile = isFile(item, dataSchemaUID);

            return (
              <div
                key={item.uid}
                className="card bg-base-100 shadow-xl group relative hover:bg-base-200 transition-colors"
                onClick={() => {
                  if (isItemTopic) {
                    onNavigate(item.uid, item.name);
                  } else if (isItemFile) {
                    setSelectedFile(item);
                    fetchFileContent(item);
                  }
                }}
              >
                {/* Actions Group */}
                <div className="absolute top-2 right-2 flex gap-1 z-10">
                  {/* Properties Button */}
                  <button
                    className="p-1 rounded-full bg-base-100 shadow-sm hover:bg-base-300 transition-colors"
                    onClick={e => {
                      e.stopPropagation();
                      setPropertiesModalUID(item.uid);
                    }}
                    title="Properties"
                  >
                    <TagIcon className="w-5 h-5 text-gray-400 hover:text-secondary" />
                  </button>

                  {/* Debug Info Button */}
                  <button
                    className="p-1 rounded-full bg-base-100 shadow-sm hover:bg-base-300 transition-colors"
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedDebugItem(item);
                    }}
                    title="Debug Info"
                  >
                    <InformationCircleIcon className="w-5 h-5 text-gray-400 hover:text-primary" />
                  </button>
                </div>

                <div className="card-body items-center text-center p-4 cursor-pointer">
                  <div className="text-4xl">
                    {isItemTopic ? (
                      <FolderIcon className="w-12 h-12 text-yellow-500" />
                    ) : (
                      <DocumentIcon className="w-12 h-12 text-blue-500" />
                    )}
                  </div>
                  <h2 className="card-title text-sm break-all text-center">{item.name || "Unnamed"}</h2>
                  <div className="text-xs text-gray-400">
                    {isItemTopic ? (item.childCount > 0 ? `${item.childCount} items` : "Empty") : "File"}
                  </div>
                </div>
              </div>
            );
          })}
        {items?.length === 0 && <div className="col-span-4 text-center text-gray-500">Topic is empty</div>}
      </div>

      {/* File Preview Modal */}
      {selectedFile && (
        <div
          className="absolute inset-0 bg-black/20 z-20 flex items-center justify-center p-8 transition-all"
          onClick={() => {
            setSelectedFile(null);
            setFileContent(null);
            setFileContentType(null);
          }}
        >
          <div
            className="card w-full max-w-4xl max-h-[90vh] bg-base-100 shadow-2xl border border-base-300 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="card-body overflow-hidden flex flex-col">
              <div className="flex justify-between items-start shrink-0">
                <h3 className="card-title text-lg font-bold">File Preview: {selectedFile.name}</h3>
                <button
                  className="btn btn-ghost btn-sm btn-circle"
                  onClick={() => {
                    setSelectedFile(null);
                    setFileContent(null);
                    setFileContentType(null);
                  }}
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-auto mt-4 bg-base-200 rounded p-4 relative">
                {isFileLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                  </div>
                ) : fileContent ? (
                  fileContentType?.includes("image/svg") ? (
                    <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: fileContent }} />
                  ) : fileContentType?.startsWith("image/") ? (
                    <img
                      src={
                        fileContent.startsWith("blob:") ? fileContent : `data:${fileContentType};base64,${fileContent}`
                      }
                      alt={selectedFile.name}
                      className="max-w-full h-auto"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm">{fileContent}</pre>
                  )
                ) : (
                  <div className="text-center text-gray-500">No content found or failed to load.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Debug Overlay */}
      {selectedDebugItem && (
        <div
          className="absolute inset-0 bg-black/20 z-20 flex items-center justify-center p-8 transition-all" // Removed backdrop-blur-sm, changed to black/20
          onClick={() => setSelectedDebugItem(null)}
        >
          <div
            className="card w-full max-w-lg bg-base-100 shadow-2xl border border-base-300" // Kept card opaque
            onClick={e => e.stopPropagation()}
          >
            <div className="card-body">
              <div className="flex justify-between items-start">
                <h3 className="card-title text-lg font-bold">Item Details</h3>
                <button className="btn btn-ghost btn-sm btn-circle" onClick={() => setSelectedDebugItem(null)}>
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>

              <div className="py-2 space-y-4 overflow-x-auto">
                <div>
                  <span className="font-bold block text-xs uppercase text-gray-500">Name</span>
                  <span className="font-bold text-lg">{selectedDebugItem.name}</span>
                </div>

                <DebugField label="UID" value={selectedDebugItem.uid} type="uid" />
                <DebugField label="Parent UID" value={selectedDebugItem.parentUID} type="uid" />
                <DebugField label="Attester" value={selectedDebugItem.attester} type="address" />
              </div>

              <div className="card-actions justify-end mt-4">
                <Link
                  href={`/easexplorer?uid=${selectedDebugItem.uid}`}
                  className="btn btn-primary btn-sm"
                  target="_blank"
                >
                  View in Explorer
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Properties Modal */}
      {propertiesModalUID && <PropertiesModal uid={propertiesModalUID} onClose={() => setPropertiesModalUID(null)} />}
    </div>
  );
};
