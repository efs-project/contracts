"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PropertiesModal } from "./PropertiesModal";
import { TagModal } from "./TagModal";
import { ethers } from "ethers";
import { zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import {
  AdjustmentsHorizontalIcon,
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
import { TAG_RESOLVER_ABI, getTagResolverAddress } from "~~/utils/efs/tagResolver";
import { notification } from "~~/utils/scaffold-eth";

export type DrawerTagFilterState = "neutral" | "include" | "exclude";

export const FileBrowser = ({
  currentAnchorUID,
  dataSchemaUID,
  currentPathNames,
  editionAddresses,
  onNavigate,
  tagFilter = "",
  drawerTagFilters = {},
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  currentPathNames: string[];
  editionAddresses: string[];
  onNavigate: (uid: string, name: string) => void;
  tagFilter?: string;
  drawerTagFilters?: Record<string, DrawerTagFilterState>;
}) => {
  const [selectedDebugItem, setSelectedDebugItem] = useState<any | null>(null);
  const [propertiesModalUID, setPropertiesModalUID] = useState<string | null>(null);
  const [tagModalUID, setTagModalUID] = useState<string | null>(null);
  const [tagModalIsFile, setTagModalIsFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<bigint>(50n);

  // Tag filter state: null = no filter active; Set<string> = allowed DATA/anchor UIDs
  const [tagFilteredUIDs, setTagFilteredUIDs] = useState<Set<string> | null>(null);
  // Excluded UIDs from the drawer's "exclude" filters — empty = no exclusions
  const [tagExcludedUIDs, setTagExcludedUIDs] = useState<Set<string>>(new Set());
  const [isTagFilterLoading, setIsTagFilterLoading] = useState(false);
  // True while the dataUIDMap is being populated asynchronously.
  // Prevents showing unfiltered results during the brief window between tag resolution and map build.
  const [isDataUIDMapLoading, setIsDataUIDMapLoading] = useState(false);
  // Incremented whenever the user adds or removes a tag so the filter effect re-runs immediately.
  const [tagFilterVersion, setTagFilterVersion] = useState(0);
  const [tagResolverAddress, setTagResolverAddress] = useState<`0x${string}` | null>(null);
  const [tagsRoot, setTagsRoot] = useState<`0x${string}` | null>(null);
  // Maps anchor UID → set of DATA UIDs for all relevant edition attesters.
  // Built when a tag filter is active; an item matches if ANY of its DATA UIDs is in the tag set.
  const [dataUIDMap, setDataUIDMap] = useState<Map<string, Set<string>>>(new Map());

  const { data: efsRouter } = useDeployedContractInfo({ contractName: "EFSRouter" });

  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient();
  const { address: connectedAddress } = useAccount();

  useEffect(() => {
    setPageSize(50n);
  }, [currentAnchorUID]);

  // Load TagResolver address and "tags" anchor UID once.
  // "tags" is a normal anchor under the file system root — discovered the same way
  // any folder is, via resolvePath. Tag definitions (e.g. "favorites") are its children.
  useEffect(() => {
    if (!publicClient || !indexerInfo) return;
    getTagResolverAddress(publicClient.chain.id).then(async addr => {
      if (!addr) return;
      setTagResolverAddress(addr);
      try {
        const fsRoot = (await publicClient.readContract({
          address: indexerInfo.address as `0x${string}`,
          abi: indexerInfo.abi,
          functionName: "rootAnchorUID",
        })) as `0x${string}`;
        if (!fsRoot || fsRoot === zeroHash) return;
        const tagsUID = (await publicClient.readContract({
          address: indexerInfo.address as `0x${string}`,
          abi: indexerInfo.abi,
          functionName: "resolvePath",
          args: [fsRoot, "tags"],
        })) as `0x${string}`;
        if (tagsUID && tagsUID !== zeroHash) setTagsRoot(tagsUID);
      } catch {
        // "tags" not yet created — tag filter will be unavailable
      }
    });
  }, [publicClient, indexerInfo]);

  // Resolve tag filter names → definition UIDs → tagged target sets.
  // Sources: tagFilter (URL, include), drawerTagFilters include entries, drawerTagFilters exclude entries.
  useEffect(() => {
    const urlIncludeNames = tagFilter
      .split(",")
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    const drawerIncludeNames = Object.entries(drawerTagFilters)
      .filter(([, s]) => s === "include")
      .map(([name]) => name.toLowerCase());
    const drawerExcludeNames = Object.entries(drawerTagFilters)
      .filter(([, s]) => s === "exclude")
      .map(([name]) => name.toLowerCase());

    const includeNames = [...new Set([...urlIncludeNames, ...drawerIncludeNames])];

    if (includeNames.length === 0 && drawerExcludeNames.length === 0) {
      setTagFilteredUIDs(null);
      setTagExcludedUIDs(new Set());
      setIsTagFilterLoading(false);
      return;
    }

    if (!publicClient || !indexerInfo || !tagResolverAddress || !tagsRoot) {
      setIsTagFilterLoading(false);
      return;
    }

    let cancelled = false;
    setIsTagFilterLoading(true);

    const resolveTagSet = async (tagName: string): Promise<Set<string>> => {
      const definitionUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "resolvePath",
        args: [tagsRoot as `0x${string}`, tagName],
      })) as `0x${string}`;

      if (!definitionUID || definitionUID === zeroHash) return new Set();

      const count = (await publicClient.readContract({
        address: tagResolverAddress,
        abi: TAG_RESOLVER_ABI,
        functionName: "getTaggedTargetCount",
        args: [definitionUID],
      })) as bigint;

      if (count === 0n) return new Set();

      const PAGE_SIZE = 500n;
      const allTargets: `0x${string}`[] = [];
      for (let cursor = 0n; cursor < count; cursor += PAGE_SIZE) {
        const page = (await publicClient.readContract({
          address: tagResolverAddress,
          abi: TAG_RESOLVER_ABI,
          functionName: "getTaggedTargets",
          args: [definitionUID, cursor, PAGE_SIZE],
        })) as `0x${string}`[];
        allTargets.push(...page);
      }

      const activeChecks = await Promise.all(
        allTargets.map(async target => {
          const isActive = (await publicClient.readContract({
            address: tagResolverAddress,
            abi: TAG_RESOLVER_ABI,
            functionName: "isActivelyTagged",
            args: [target, definitionUID],
          })) as boolean;
          return isActive ? target.toLowerCase() : null;
        }),
      );
      return new Set(activeChecks.filter((t): t is string => t !== null));
    };

    const resolve = async () => {
      try {
        // Fetch each unique tag name exactly once, even if it appears in both lists.
        const allNames = [...new Set([...includeNames, ...drawerExcludeNames])];
        const resolvedEntries = await Promise.all(
          allNames.map(async name => [name, await resolveTagSet(name)] as const),
        );
        if (cancelled) return;
        const cache = new Map<string, Set<string>>(resolvedEntries);

        if (includeNames.length > 0) {
          let intersection = cache.get(includeNames[0])!;
          for (let i = 1; i < includeNames.length; i++) {
            const s = cache.get(includeNames[i])!;
            intersection = new Set([...intersection].filter(uid => s.has(uid)));
          }
          setTagFilteredUIDs(intersection);
        } else {
          setTagFilteredUIDs(null);
        }

        if (drawerExcludeNames.length > 0) {
          setTagExcludedUIDs(new Set(drawerExcludeNames.flatMap(name => [...(cache.get(name) ?? [])])));
        } else {
          setTagExcludedUIDs(new Set());
        }
      } catch (e) {
        console.error("Tag filter resolution failed", e);
        if (!cancelled) {
          setTagFilteredUIDs(null);
          setTagExcludedUIDs(new Set());
        }
      } finally {
        if (!cancelled) setIsTagFilterLoading(false);
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [tagFilter, drawerTagFilters, tagFilterVersion, publicClient, indexerInfo, tagResolverAddress, tagsRoot]);

  const fetchFileContent = async (item: any) => {
    if (!efsRouter) {
      notification.error("EFSRouter not found. Please deploy.");
      return;
    }
    setIsFileLoading(true);
    setFileContent(null);
    setFileContentType(null);
    setFetchError(null);
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
      const editionParams =
        editionAddresses.length > 0 ? `?editions=${editionAddresses.map(a => a.trim()).join(",")}` : "";
      const uri = `web3://${efsRouter.address}:${targetNetwork.id}/${joinedPath}${item.name}${editionParams}`;

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
          const queryParams: any[] = [];
          if (editionAddresses.length > 0) {
            queryParams.push({ key: "editions", value: editionAddresses.join(",") });
          }

          // Mimic web3protocol query formatting for chunk queries if not the first chunk
          // In EFSRouter, `request(string[] memory path, KeyValue[] memory queries)` takes queries.
          if (currentChunkHeader) {
            // currentChunkHeader is "?chunk=1"
            const chunkIndex = currentChunkHeader.split("=")[1];
            if (chunkIndex !== undefined) {
              queryParams.push({ key: "chunk", value: chunkIndex });
            }
          }

          const args: any[] = [[...currentPathNames, item.name], queryParams];

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
      setFetchError(err.message || String(e));
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

  const hasEditions = editionAddresses && editionAddresses.length > 0;

  // Once we've ever been in editions mode, stay there — prevents the standard (show-all) query
  // from firing its cached result during the brief window when editionAddresses is transitioning
  // to a new address (e.g. wallet account switch causes a momentary empty array).
  const lockedToEditions = useRef(false);
  if (hasEditions) lockedToEditions.current = true;
  const useEditionsQuery = hasEditions || lockedToEditions.current;

  const { data: standardItems, isLoading: isStandardLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [
      (currentAnchorUID ? currentAnchorUID : undefined) as `0x${string}` | undefined,
      0n,
      pageSize,
      dataSchemaUID as `0x${string}`,
      propertySchemaUID as `0x${string}`,
    ],
    query: {
      enabled: !useEditionsQuery,
    },
  });

  const { data: editionItemsRaw, isLoading: isEditionLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPageByAddressList",
    args: [
      (currentAnchorUID ? currentAnchorUID : undefined) as `0x${string}` | undefined,
      editionAddresses as string[],
      0n,
      pageSize,
    ],
    query: {
      enabled: useEditionsQuery,
    },
  });

  const isLoading = useEditionsQuery ? isEditionLoading : isStandardLoading;
  const rawItems = useEditionsQuery ? (editionItemsRaw ? (editionItemsRaw as any)[0] : undefined) : standardItems;

  // When a tag filter is active, resolve DATA UIDs for each file item based on the
  // currently-viewed attesters. item.attester is always the ANCHOR creator (fixed), so we
  // derive the attester list from the viewing context instead:
  //   - editions mode → editionAddresses (whose data is on screen)
  //   - own-files mode → [connectedAddress]
  // Multiple attesters can have data for the same anchor, so we store a Set per anchor and
  // show the item if ANY of those DATA UIDs is in the tag filter set.
  useEffect(() => {
    // connectedAddress is only needed as the own-files fallback; if editionAddresses is
    // already provided (e.g. shared ?editions= link), we can build the map without a wallet.
    // Build the map whenever either an include filter OR an exclude filter is active.
    if ((!tagFilteredUIDs && tagExcludedUIDs.size === 0) || !rawItems || !publicClient || !indexerInfo) {
      setDataUIDMap(new Map());
      setIsDataUIDMapLoading(false);
      return;
    }

    setIsDataUIDMapLoading(true);

    // Which attesters' data are we looking at?
    // editionAddresses takes precedence; fall back to connected wallet for own-files mode.
    const attesters: string[] =
      editionAddresses.length > 0 ? editionAddresses : connectedAddress ? [connectedAddress] : [];

    if (attesters.length === 0) {
      setDataUIDMap(new Map());
      return;
    }

    let cancelled = false;
    const map = new Map<string, Set<string>>();

    const resolve = async () => {
      await Promise.all(
        (rawItems as any[])
          .filter((item: any) => isFile(item, dataSchemaUID) && item.hasData)
          .map(async (item: any) => {
            const dataUIDs = new Set<string>();
            await Promise.all(
              attesters.map(async attester => {
                try {
                  const dataUID = (await publicClient.readContract({
                    address: indexerInfo.address as `0x${string}`,
                    abi: indexerInfo.abi,
                    functionName: "getDataByAddressList",
                    args: [item.uid as `0x${string}`, [attester as `0x${string}`], false],
                  })) as `0x${string}`;
                  if (dataUID && dataUID !== zeroHash) {
                    dataUIDs.add(dataUID.toLowerCase());
                  }
                } catch {
                  // ignore
                }
              }),
            );
            if (dataUIDs.size > 0) {
              map.set(item.uid.toLowerCase(), dataUIDs);
            }
          }),
      );
      if (!cancelled) {
        setDataUIDMap(map);
        setIsDataUIDMapLoading(false);
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [
    tagFilteredUIDs,
    tagExcludedUIDs,
    rawItems,
    publicClient,
    indexerInfo,
    dataSchemaUID,
    connectedAddress,
    editionAddresses,
  ]); // connectedAddress kept for own-files fallback re-trigger

  // Apply tag filters. Include filter (tagFilteredUIDs): item must be in set (null = no filter).
  // Exclude filter (tagExcludedUIDs): item must NOT be in set (empty = no exclusions).
  const matchesUID = (item: any, uidSet: Set<string>): boolean => {
    if (isFile(item, dataSchemaUID)) {
      const anchorUID = item.uid.toLowerCase();
      const dataUIDs = dataUIDMap.get(anchorUID);
      if (dataUIDs && [...dataUIDs].some(uid => uidSet.has(uid))) return true;
      return uidSet.has(anchorUID);
    }
    return uidSet.has(item.uid.toLowerCase());
  };

  const items = rawItems?.filter((item: any) => {
    if (tagFilteredUIDs !== null && !matchesUID(item, tagFilteredUIDs)) return false;
    if (tagExcludedUIDs.size > 0 && matchesUID(item, tagExcludedUIDs)) return false;
    return true;
  });

  if (!currentAnchorUID) return <div>Select a topic</div>;
  if (isLoading || isTagFilterLoading || isDataUIDMapLoading) return <div>Loading items...</div>;

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
          ?.filter((item: any) => (isTopic(item) || isFile(item, dataSchemaUID)) && item.uid !== tagsRoot)
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
                  {/* Tags Button */}
                  <button
                    className="p-1 rounded-full bg-base-100 shadow-sm hover:bg-base-300 transition-colors"
                    onClick={e => {
                      e.stopPropagation();
                      setTagModalUID(item.uid);
                      setTagModalIsFile(isItemFile);
                    }}
                    title="Tags"
                  >
                    <TagIcon className="w-5 h-5 text-gray-400 hover:text-accent" />
                  </button>

                  {/* Properties Button */}
                  <button
                    className="p-1 rounded-full bg-base-100 shadow-sm hover:bg-base-300 transition-colors"
                    onClick={e => {
                      e.stopPropagation();
                      setPropertiesModalUID(item.uid);
                    }}
                    title="Properties"
                  >
                    <AdjustmentsHorizontalIcon className="w-5 h-5 text-gray-400 hover:text-secondary" />
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
        {items?.length === 0 && (
          <div className="col-span-4 text-center text-gray-500">
            {tagFilteredUIDs !== null ? `No items match tag filter: "${tagFilter}"` : "Topic is empty"}
          </div>
        )}
      </div>
      {items && items.length > 0 && items.length >= Number(pageSize) && (
        <div className="flex justify-center py-4">
          <button className="btn btn-sm btn-outline" onClick={() => setPageSize(prev => prev + 50n)}>
            Load more
          </button>
        </div>
      )}

      {/* File Preview Modal */}
      {selectedFile && (
        <div
          className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center p-8 transition-all"
          onClick={() => {
            setSelectedFile(null);
            setFileContent(null);
            setFileContentType(null);
            setFetchError(null);
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
                    setFetchError(null);
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
                ) : fetchError ? (
                  <div className="text-center text-error">
                    <p className="font-semibold mb-1">Failed to load file</p>
                    <p className="text-xs opacity-70">{fetchError}</p>
                  </div>
                ) : fileContent ? (
                  fileContentType?.includes("image/svg") ? (
                    <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: fileContent }} />
                  ) : fileContentType?.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={
                        fileContent.startsWith("blob:") ? fileContent : `data:${fileContentType};base64,${fileContent}`
                      }
                      alt={selectedFile.name}
                      className="max-w-full h-auto"
                    />
                  ) : fileContentType && !fileContentType.startsWith("text/") ? (
                    <div className="text-center text-gray-500">
                      <p className="font-semibold mb-1">Binary file — cannot preview</p>
                      <p className="text-xs opacity-60">{fileContentType}</p>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm">{fileContent}</pre>
                  )
                ) : (
                  <div className="text-center text-gray-500">No content found.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Debug Overlay */}
      {selectedDebugItem && (
        <div
          className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center p-8 transition-all" // Removed backdrop-blur-sm, changed to black/20
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
      {/* Tag Modal */}
      {tagModalUID && (
        <TagModal
          uid={tagModalUID}
          isFile={tagModalIsFile}
          onClose={() => {
            setTagModalUID(null);
            setTagModalIsFile(false);
          }}
          onTagChange={() => setTagFilterVersion(v => v + 1)}
        />
      )}
    </div>
  );
};
