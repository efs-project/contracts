"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MirrorsPanel } from "./MirrorsPanel";
import { PropertiesModal } from "./PropertiesModal";
import { TagModal } from "./TagModal";
import { ethers } from "ethers";
import { createPortal } from "react-dom";
import { zeroHash } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import {
  AdjustmentsHorizontalIcon,
  ArrowsPointingOutIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  InformationCircleIcon,
  Square2StackIcon,
  TagIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useSortedData } from "~~/hooks/efs/useSortedData";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { isFile, isTopic } from "~~/utils/efs/efsTypes";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { TAG_RESOLVER_ABI, getTagResolverAddress } from "~~/utils/efs/tagResolver";
import { TRANSPORT_LABELS, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";
import { notification } from "~~/utils/scaffold-eth";

export type DrawerTagFilterState = "neutral" | "include" | "exclude";

const SORT_FUNC_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "uid", type: "bytes32" },
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
    ],
    name: "getSortKey",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const CHILDREN_COUNT_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "anchorUID", type: "bytes32" }],
    name: "getChildrenCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
    ],
    name: "getChildCountBySchema",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const CHILD_AT_ABI = [
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

/** application/* MIME types that are human-readable text */
const TEXT_LIKE_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "application/ecmascript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/rtf",
  "application/x-ndjson",
]);

function isTextViewable(contentType: string | null): boolean {
  if (!contentType) return false;
  if (contentType.startsWith("text/")) return true;
  if (contentType.includes("image/svg")) return true;
  if (TEXT_LIKE_APPLICATION_TYPES.has(contentType)) return true;
  // Catch-all for +json, +xml, +yaml suffixes (e.g. application/vnd.api+json)
  if (/\+(json|xml|yaml)$/.test(contentType)) return true;
  return false;
}

export const FileBrowser = ({
  currentAnchorUID,
  dataSchemaUID,
  currentPathNames,
  editionAddresses,
  onNavigate,
  tagFilter = "",
  drawerTagFilters = {},
  activeSortInfoUID = null,
  sortOverlayAddress,
  sortRefreshKey = 0,
  reverseOrder = false,
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  currentPathNames: string[];
  editionAddresses: string[];
  onNavigate: (uid: string, name: string) => void;
  tagFilter?: string;
  drawerTagFilters?: Record<string, DrawerTagFilterState>;
  activeSortInfoUID?: string | null;
  sortOverlayAddress?: `0x${string}`;
  sortRefreshKey?: number;
  reverseOrder?: boolean;
}) => {
  const [selectedDebugItem, setSelectedDebugItem] = useState<any | null>(null);
  const [propertiesModalUID, setPropertiesModalUID] = useState<string | null>(null);
  const [tagModalUID, setTagModalUID] = useState<string | null>(null);
  const [tagModalIsFile, setTagModalIsFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const fetchIdRef = useRef(0);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [fileTransportType, setFileTransportType] = useState<string>("onchain");
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
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
  // Folder-delete confirmation. `tagUIDs` is populated by scanSubtree.
  const [deleteConfirm, setDeleteConfirm] = useState<{
    item: any;
    status: "scanning" | "ready" | "revoking";
    tagUIDs: `0x${string}`[];
    folderCount: number;
    fileCount: number;
    error?: string;
  } | null>(null);
  // Maps anchor UID → set of DATA UIDs for all relevant edition attesters.
  // Built when a tag filter is active; an item matches if ANY of its DATA UIDs is in the tag set.
  const [dataUIDMap, setDataUIDMap] = useState<Map<string, Set<string>>>(new Map());

  const { data: efsRouter } = useDeployedContractInfo({ contractName: "EFSRouter" });

  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: efsFileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient();
  const { address: connectedAddress } = useAccount();
  const { writeContractAsync: easWrite } = useScaffoldWriteContract("EAS");

  // Revoke blob URLs when fileContent changes to prevent memory leaks
  useEffect(() => {
    return () => {
      if (fileContent && fileContent.startsWith("blob:")) {
        URL.revokeObjectURL(fileContent);
      }
    };
  }, [fileContent]);

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

      // Only consider tags applied by the currently viewed attesters (connected user + editions).
      // This prevents strangers from affecting your view by tagging your files.
      const tagAttesters: `0x${string}`[] = [
        ...(connectedAddress ? [connectedAddress as `0x${string}`] : []),
        ...editionAddresses
          .filter(a => a.toLowerCase() !== connectedAddress?.toLowerCase())
          .map(a => a as `0x${string}`),
      ];

      const activeChecks = await Promise.all(
        allTargets.map(async target => {
          const isActive =
            tagAttesters.length > 0
              ? ((await publicClient.readContract({
                  address: tagResolverAddress,
                  abi: TAG_RESOLVER_ABI,
                  functionName: "isActivelyTaggedByAny",
                  args: [target, definitionUID, tagAttesters],
                })) as boolean)
              : false;
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
  }, [
    tagFilter,
    drawerTagFilters,
    tagFilterVersion,
    publicClient,
    indexerInfo,
    tagResolverAddress,
    tagsRoot,
    connectedAddress,
    editionAddresses,
  ]);

  const fetchFileContent = async (item: any) => {
    if (!efsRouter) {
      notification.error("EFSRouter not found. Please deploy.");
      return;
    }
    // Increment fetch ID so any in-flight fetch from a previous file click becomes stale
    const fetchId = ++fetchIdRef.current;
    setIsFileLoading(true);
    setFileContent(null);
    setFileContentType(null);
    setFileTransportType("onchain");
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

        // web3protocol collapses duplicate headers, so we can't reliably detect
        // message/external-body here. If body is empty, fall through to the
        // direct contract call which preserves both raw Content-Type headers.
        if (result.length === 0) {
          throw new Error("Empty body — likely external URI delegation, trying direct fallback");
        }

        const contentTypeInfo = Object.entries(fetchedWeb3Url.httpHeaders || {}).find(
          ([k]) => k.toLowerCase() === "content-type",
        );
        contentTypeStr = contentTypeInfo ? (contentTypeInfo[1] as string) : "text/plain";
      } catch (protocolErr) {
        console.warn("web3protocol failed or empty response, using direct fallback", protocolErr);
        // Direct Router Fallback — also handles external-body delegation (IPFS, Arweave, etc.)
        if (!publicClient) throw protocolErr;

        result = [];

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
            const outHeaders = response[2] as any[];
            const ctHeaders = outHeaders.filter((h: any) => h.key.toLowerCase() === "content-type");

            // Detect external-body delegation (IPFS, Arweave, HTTPS mirrors)
            const externalHeader = ctHeaders.find((h: any) => h.value.includes("message/external-body"));
            if (externalHeader) {
              // Extract the original URI from: message/external-body; access-type=URL; URL="ipfs://..."
              const urlMatch = externalHeader.value.match(/URL="([^"]+)"/);
              const externalUri = urlMatch?.[1];
              // Extract the actual MIME type from the content-type= parameter in the
              // message/external-body header (router embeds it as a quoted parameter).
              const ctParam = externalHeader.value.match(/content-type="([^"]+)"/);
              if (ctParam?.[1]) contentTypeStr = ctParam[1];

              if (externalUri) {
                setFileTransportType(detectTransport(externalUri));
                const gatewayUrl = resolveGatewayUrl(externalUri);
                if (gatewayUrl) {
                  // Fetch from gateway
                  const gatewayResp = await globalThis.fetch(gatewayUrl);
                  if (!gatewayResp.ok) throw new Error(`Gateway returned ${gatewayResp.status} for ${gatewayUrl}`);
                  const buf = await gatewayResp.arrayBuffer();
                  const bytes = new Uint8Array(buf);
                  for (let i = 0; i < bytes.length; i++) result.push(bytes[i]);
                  // Use gateway content-type as fallback if we didn't get one from the contract
                  if (contentTypeStr === "text/plain") {
                    const gwCt = gatewayResp.headers.get("content-type");
                    if (gwCt) contentTypeStr = gwCt.split(";")[0].trim();
                  }
                }
                hasMoreChunks = false;
                break;
              }
            }

            // On-chain body
            const bodyHex = response[1] as `0x${string}`;
            if (bodyHex && bodyHex !== "0x") {
              const bodyBytes = ethers.getBytes(bodyHex);
              for (let i = 0; i < bodyBytes.length; i++) {
                result.push(bodyBytes[i]);
              }
            }
            // Use first content-type header for on-chain responses
            if (ctHeaders.length > 0) contentTypeStr = ctHeaders[0].value;

            // Check for next chunk
            const nextChunkHeader = outHeaders.find((h: any) => h.key.toLowerCase() === "web3-next-chunk");
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

      // Discard results from a superseded fetch (user clicked a different file)
      if (fetchId !== fetchIdRef.current) return;

      setFileContentType(contentTypeStr);

      const useBlobUrl =
        (contentTypeStr.startsWith("image/") && !contentTypeStr.includes("svg")) ||
        contentTypeStr.startsWith("video/") ||
        contentTypeStr.startsWith("audio/") ||
        contentTypeStr === "application/pdf";

      if (useBlobUrl) {
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
      if (fetchId !== fetchIdRef.current) return;
      const err = e as Error;
      console.error("Failed to fetch file content", err);
      setFileContent(null);
      setFetchError(err.message || String(e));
    } finally {
      // Only clear the loading flag if this fetch is still the active one —
      // a stale fetch completing should not stop the spinner for the newer request.
      if (fetchId === fetchIdRef.current) setIsFileLoading(false);
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

  const { data: sortsAnchorUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "sortsAnchorUID",
  });

  // Staleness for the active sort on this anchor — drives the preview banner count
  const { data: activeSortStaleness } = useScaffoldReadContract({
    contractName: "EFSSortOverlay",
    functionName: "getSortStaleness",
    args: [
      activeSortInfoUID as `0x${string}` | undefined,
      (currentAnchorUID ?? undefined) as `0x${string}` | undefined,
    ],
    query: { enabled: !!activeSortInfoUID && !!currentAnchorUID },
  });

  // ── Sort overlay integration ─────────────────────────────────────────────────
  const {
    sortedUIDs,
    isLoading: isSortLoading,
    hasMore: hasSortMore,
    loadMore: loadMoreSorted,
  } = useSortedData({
    sortInfoUID: activeSortInfoUID,
    parentAnchor: currentAnchorUID ?? undefined,
    sortOverlayAddress,
    editionAddresses,
    refreshKey: sortRefreshKey,
  });

  // ── Client-side preview sort (when on-chain sort is 0% processed) ──────────
  // Fetches sort keys locally and sorts items in browser memory.
  const [previewSortKeys, setPreviewSortKeys] = useState<Map<string, string>>(new Map());
  const [isPreviewSort, setIsPreviewSort] = useState(false);
  // Track which (anchor, sort) pair we fetched preview keys for. Keyed by both so that
  // navigating to a different anchor while keeping the same sort selected still triggers
  // a fresh fetch instead of reusing the prior anchor's keys.
  const previewFetchRef = useRef<string | null>(null);
  // Include staleness in the guard key so the preview refetches when new items are
  // added under the same (anchor, sort). Without this, the effect returns early and
  // keeps serving stale keys even though previewCacheKey (below) has rotated.
  const previewFetchKey =
    activeSortInfoUID && currentAnchorUID
      ? `${currentAnchorUID}:${activeSortInfoUID}:${activeSortStaleness?.toString() ?? "0"}`
      : null;

  // sessionStorage key for preview sort cache: includes anchor + sort + staleness count
  // so the cache is automatically invalidated when new items are added (staleness changes).
  const previewCacheKey =
    activeSortInfoUID && currentAnchorUID
      ? `efs-preview:${currentAnchorUID}:${activeSortInfoUID}:${activeSortStaleness?.toString() ?? "0"}`
      : null;

  // Client-side preview sort: fetch sort keys locally when on-chain sort is 0% processed.
  // Caches results in sessionStorage keyed by (anchor, sort, staleness) — invalidates
  // automatically when new items are added (staleness count changes).
  useEffect(() => {
    if (
      !activeSortInfoUID ||
      !sortOverlayAddress ||
      !publicClient ||
      !currentAnchorUID ||
      (sortedUIDs && sortedUIDs.length > 0)
    ) {
      // Clear preview state when sort/anchor changes or on-chain data arrives
      if (previewFetchRef.current !== previewFetchKey) {
        setPreviewSortKeys(new Map());
        setIsPreviewSort(false);
        previewFetchRef.current = null;
      }
      return;
    }
    if (previewFetchRef.current === previewFetchKey) return;

    let cancelled = false;

    (async () => {
      try {
        // Check sessionStorage cache first
        if (previewCacheKey) {
          try {
            const cached = sessionStorage.getItem(previewCacheKey);
            if (cached) {
              const parsed: [string, string][] = JSON.parse(cached);
              const keyMap = new Map<string, string>(parsed);
              if (keyMap.size > 0) {
                previewFetchRef.current = previewFetchKey;
                setPreviewSortKeys(keyMap);
                setIsPreviewSort(true);
                return;
              }
            }
          } catch {
            // sessionStorage unavailable or corrupted — proceed with fresh fetch
          }
        }

        const config = await publicClient.readContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "getSortConfig",
          args: [activeSortInfoUID as `0x${string}`],
        });
        if (cancelled) return;

        const sortFuncAddr = (config as any).sortFunc as `0x${string}`;
        if (!sortFuncAddr || sortFuncAddr === "0x0000000000000000000000000000000000000000") return;

        // Match the contract's sourceType routing so preview fetches the same items
        // that processItems would validate against.
        const sourceType = Number((config as any).sourceType ?? 0);
        const targetSchema = (config as any).targetSchema as `0x${string}`;
        if (sourceType !== 0 && sourceType !== 1) return; // unsupported sourceTypes bail out of preview

        const indexerAddr = indexerInfo?.address as `0x${string}`;
        if (!indexerAddr) return;

        const count =
          sourceType === 0
            ? ((await publicClient.readContract({
                address: indexerAddr,
                abi: CHILDREN_COUNT_ABI,
                functionName: "getChildrenCount",
                args: [currentAnchorUID as `0x${string}`],
              })) as bigint)
            : ((await publicClient.readContract({
                address: indexerAddr,
                abi: CHILDREN_COUNT_ABI,
                functionName: "getChildCountBySchema",
                args: [currentAnchorUID as `0x${string}`, targetSchema],
              })) as bigint);

        if (cancelled || count === 0n) return;

        // Paginate over the full kernel count — no hard cap. Preview mode has to key every
        // candidate so the resulting order is correct; truncating would push out-of-window
        // items to an unsorted tail and show an incorrect preview.
        const keyMap = new Map<string, string>();
        const batchSize = 50;
        for (let i = 0n; i < count; i += BigInt(batchSize)) {
          const end = i + BigInt(batchSize) > count ? count : i + BigInt(batchSize);
          const promises: Promise<void>[] = [];
          for (let j = i; j < end; j++) {
            promises.push(
              (async () => {
                const childUID =
                  sourceType === 0
                    ? ((await publicClient.readContract({
                        address: indexerAddr,
                        abi: CHILD_AT_ABI,
                        functionName: "getChildAt",
                        args: [currentAnchorUID as `0x${string}`, j],
                      })) as `0x${string}`)
                    : ((await publicClient.readContract({
                        address: indexerAddr,
                        abi: CHILD_AT_ABI,
                        functionName: "getChildBySchemaAt",
                        args: [currentAnchorUID as `0x${string}`, targetSchema, j],
                      })) as `0x${string}`);

                try {
                  const sortKey = (await publicClient.readContract({
                    address: sortFuncAddr,
                    abi: SORT_FUNC_ABI,
                    functionName: "getSortKey",
                    args: [childUID, activeSortInfoUID as `0x${string}`],
                  })) as `0x${string}`;
                  if (sortKey && sortKey !== "0x") {
                    keyMap.set(childUID.toLowerCase(), sortKey);
                  }
                } catch {
                  // Ineligible item
                }
              })(),
            );
          }
          await Promise.all(promises);
          if (cancelled) return;
        }

        if (!cancelled && keyMap.size > 0) {
          previewFetchRef.current = previewFetchKey;
          setPreviewSortKeys(keyMap);
          setIsPreviewSort(true);
          // Persist to sessionStorage for instant load on re-navigation
          if (previewCacheKey) {
            try {
              sessionStorage.setItem(previewCacheKey, JSON.stringify([...keyMap.entries()]));
            } catch {
              // sessionStorage quota exceeded — not critical
            }
          }
        }
      } catch (e) {
        console.error("Preview sort key fetch failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeSortInfoUID,
    sortOverlayAddress,
    publicClient,
    currentAnchorUID,
    sortedUIDs,
    indexerInfo,
    previewCacheKey,
    previewFetchKey,
  ]);

  const hasEditions = editionAddresses && editionAddresses.length > 0;

  // Once we've ever been in editions mode, stay there — prevents the standard (show-all) query
  // from firing its cached result during the brief window when editionAddresses is transitioning
  // to a new address (e.g. wallet account switch causes a momentary empty array).
  // BUT: if editionAddresses is empty (wallet disconnect, unresolved ENS), fall through to the
  // standard query rather than leaving both queries disabled — showing unfiltered data is better
  // than an indefinitely blank directory.
  const lockedToEditions = useRef(false);
  if (hasEditions) lockedToEditions.current = true;
  const useEditionsQuery = (hasEditions || lockedToEditions.current) && editionAddresses.length > 0;

  const {
    data: standardItems,
    isLoading: isStandardLoading,
    refetch: refetchStandardItems,
  } = useScaffoldReadContract({
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

  const {
    data: editionItemsRaw,
    isLoading: isEditionLoading,
    refetch: refetchEditionItems,
  } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPageBySchemaAndAddressList",
    args: [
      (currentAnchorUID ? currentAnchorUID : undefined) as `0x${string}` | undefined,
      dataSchemaUID as `0x${string}`,
      editionAddresses as string[],
      0n,
      pageSize,
    ],
    query: {
      enabled: useEditionsQuery && editionAddresses.length > 0,
    },
  });

  const isLoading = useEditionsQuery ? isEditionLoading : isStandardLoading;
  const rawItems = useEditionsQuery ? (editionItemsRaw ? (editionItemsRaw as any)[0] : undefined) : standardItems;

  // When a tag filter is active, resolve DATA UIDs for each file item.
  // DATA is standalone (refUID=0x0) and placed at anchors via TAGs, so we query
  // TagResolver's _activeByAAS index to find which DATAs are at each anchor.
  // Multiple attesters can have data for the same anchor, so we store a Set per anchor.
  useEffect(() => {
    if ((!tagFilteredUIDs && tagExcludedUIDs.size === 0) || !rawItems || !publicClient || !tagResolverAddress) {
      setDataUIDMap(new Map());
      setIsDataUIDMapLoading(false);
      return;
    }

    setIsDataUIDMapLoading(true);

    const attesters: string[] =
      editionAddresses.length > 0 ? editionAddresses : connectedAddress ? [connectedAddress] : [];

    if (attesters.length === 0) {
      setDataUIDMap(new Map());
      setIsDataUIDMapLoading(false);
      return;
    }

    let cancelled = false;
    const map = new Map<string, Set<string>>();

    const resolve = async () => {
      await Promise.all(
        (rawItems as any[])
          .filter((item: any) => isFile(item, dataSchemaUID))
          .map(async (item: any) => {
            const dataUIDs = new Set<string>();
            await Promise.all(
              attesters.map(async attester => {
                try {
                  const count = (await publicClient.readContract({
                    address: tagResolverAddress,
                    abi: TAG_RESOLVER_ABI,
                    functionName: "getActiveTargetsByAttesterAndSchemaCount",
                    args: [item.uid as `0x${string}`, attester as `0x${string}`, dataSchemaUID as `0x${string}`],
                  })) as bigint;
                  if (count > 0n) {
                    const targets = (await publicClient.readContract({
                      address: tagResolverAddress,
                      abi: TAG_RESOLVER_ABI,
                      functionName: "getActiveTargetsByAttesterAndSchema",
                      args: [
                        item.uid as `0x${string}`,
                        attester as `0x${string}`,
                        dataSchemaUID as `0x${string}`,
                        0n,
                        count,
                      ],
                    })) as `0x${string}`[];
                    for (const t of targets) {
                      if (t !== zeroHash) dataUIDs.add(t.toLowerCase());
                    }
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
    tagResolverAddress,
    dataSchemaUID,
    connectedAddress,
    editionAddresses,
  ]);

  // Apply tag filters. Include filter (tagFilteredUIDs): item must be in set (null = no filter).
  // Exclude filter (tagExcludedUIDs): item must NOT be in set (empty = no exclusions).
  const matchesUID = (item: any, uidSet: Set<string>): boolean => {
    const anchorUID = item.uid.toLowerCase();
    if (isFile(item, dataSchemaUID)) {
      // Tags target DATA UIDs (standalone, placed at anchors via TAGs).
      // Check if any DATA placed at this anchor matches the filter set.
      const dataUIDs = dataUIDMap.get(anchorUID);
      if (dataUIDs && dataUIDs.size > 0) {
        return [...dataUIDs].some(uid => uidSet.has(uid));
      }
      // Fallback: check anchor UID directly (covers tags applied to anchor itself)
      return uidSet.has(anchorUID);
    }
    return uidSet.has(anchorUID);
  };

  const items = rawItems?.filter((item: any) => {
    if (tagFilteredUIDs !== null && !matchesUID(item, tagFilteredUIDs)) return false;
    if (tagExcludedUIDs.size > 0 && matchesUID(item, tagExcludedUIDs)) return false;
    return true;
  });

  // Keyboard handler ref — lets the useEffect stay above early returns while
  // the actual handler logic (which depends on computed values) is set later.
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!currentAnchorUID) return <div>Select a topic</div>;
  if (isLoading || isTagFilterLoading || isDataUIDMapLoading || isSortLoading) return <div>Loading items...</div>;

  // When a sort is active, reorder rawItems by the sorted UIDs.
  // Items not yet in the sorted list appear at the end in their original order.
  // Falls back to client-side preview sort when on-chain sort has no data.
  const sortedItems: any[] | undefined = (() => {
    if (!items) return items;

    // Client-side preview sort: use locally-fetched sort keys
    if (isPreviewSort && previewSortKeys.size > 0 && (!sortedUIDs || sortedUIDs.length === 0)) {
      const dir = reverseOrder ? -1 : 1;
      return [...items].sort((a: any, b: any) => {
        const aKey = previewSortKeys.get(a.uid?.toLowerCase() ?? "");
        const bKey = previewSortKeys.get(b.uid?.toLowerCase() ?? "");
        if (aKey && bKey) {
          if (aKey < bKey) return -1 * dir;
          if (aKey > bKey) return 1 * dir;
          return 0;
        }
        if (aKey) return -1;
        if (bKey) return 1;
        return 0;
      });
    }

    // On-chain sorted data
    if (!sortedUIDs) return items;
    const sortIndexMap = new Map(sortedUIDs.map((uid, idx) => [uid.toLowerCase(), idx]));
    const dir = reverseOrder ? -1 : 1;
    return [...items].sort((a: any, b: any) => {
      const ai = sortIndexMap.get(a.uid?.toLowerCase() ?? "");
      const bi = sortIndexMap.get(b.uid?.toLowerCase() ?? "");
      if (ai !== undefined && bi !== undefined) return (ai - bi) * dir;
      if (ai !== undefined) return -1; // a is sorted, b is not → a first
      if (bi !== undefined) return 1; // b is sorted, a is not → b first
      return 0; // both unsorted → keep relative order
    });
  })();

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

  const closePreview = () => {
    setSelectedFile(null);
    setFileContent(null);
    setFileContentType(null);
    setFetchError(null);
    setPreviewFullscreen(false);
  };

  // File-only items for gallery navigation
  const fileItems =
    (sortedItems ?? items)?.filter(
      (item: any) => isFile(item, dataSchemaUID) && item.uid !== tagsRoot && item.uid !== sortsAnchorUID,
    ) ?? [];

  const navigateGallery = (direction: 1 | -1) => {
    if (!selectedFile || fileItems.length === 0) return;
    const currentIdx = fileItems.findIndex((item: any) => item.uid === selectedFile.uid);
    if (currentIdx === -1) return;
    const nextIdx = (currentIdx + direction + fileItems.length) % fileItems.length;
    const nextItem = fileItems[nextIdx];
    setSelectedFile(nextItem);
    fetchFileContent(nextItem);
  };

  // Delete a file/folder by revoking the connected user's TAGs (ADR-0006 revised 2026-04-18,
  // tag-only folder visibility).
  // File: revoke TAG(target=DATA_UID, definition=fileAnchorUID) for every DATA the
  //   user placed at this anchor. Removes the file from this edition's view; other
  //   editions with their own placement TAGs are unaffected. DATA is permanent (ADR-0002).
  // Folder: full subtree cascade. Walks the folder and every subfolder, revoking
  //   (a) the user's visibility TAG on each folder (definition=dataSchemaUID, refUID=folder)
  //   and (b) the user's file placement TAGs on every file child at any depth. Cascading
  //   prevents orphaned file placements (files invisible in the folder listing but still
  //   discoverable via "what files has this user placed?" queries).
  const collectUserFilePlacementTags = async (fileAnchorUID: `0x${string}`): Promise<`0x${string}`[]> => {
    if (!publicClient || !tagResolverAddress || !connectedAddress || !dataSchemaUID) return [];
    const count = (await publicClient.readContract({
      address: tagResolverAddress,
      abi: TAG_RESOLVER_ABI,
      functionName: "getActiveTargetsByAttesterAndSchemaCount",
      args: [fileAnchorUID, connectedAddress as `0x${string}`, dataSchemaUID as `0x${string}`],
    })) as bigint;
    if (count === 0n) return [];
    const dataUIDs = (await publicClient.readContract({
      address: tagResolverAddress,
      abi: TAG_RESOLVER_ABI,
      functionName: "getActiveTargetsByAttesterAndSchema",
      args: [fileAnchorUID, connectedAddress as `0x${string}`, dataSchemaUID as `0x${string}`, 0n, count],
    })) as `0x${string}`[];
    const tagUIDs: `0x${string}`[] = [];
    for (const dataUID of dataUIDs) {
      if (dataUID === zeroHash) continue;
      const tagUID = (await publicClient.readContract({
        address: tagResolverAddress,
        abi: TAG_RESOLVER_ABI,
        functionName: "getActiveTagUID",
        args: [connectedAddress as `0x${string}`, dataUID, fileAnchorUID],
      })) as `0x${string}`;
      if (tagUID && tagUID !== zeroHash) tagUIDs.push(tagUID);
    }
    return tagUIDs;
  };

  const getTagSchemaUID = (): `0x${string}` =>
    ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, bool applies", tagResolverAddress, true],
    ) as `0x${string}`;

  // Recursively walks the subtree rooted at `rootFolderUID`, paginating getDirectoryPage (500/page).
  // Returns every TAG UID the connected user would need to revoke to remove their visibility of the folder:
  //   - file placements the user authored at any depth
  //   - the visibility TAG the user authored on the root folder and every subfolder (if any)
  // Skips `tagsRoot` and `sortsAnchorUID` (system anchors — never touch).
  const scanSubtree = async (
    rootFolderUID: `0x${string}`,
  ): Promise<{ tagUIDs: `0x${string}`[]; folderCount: number; fileCount: number }> => {
    if (!publicClient || !tagResolverAddress || !connectedAddress || !dataSchemaUID || !efsFileViewInfo) {
      throw new Error("Not ready — reconnect wallet and try again.");
    }
    const me = connectedAddress as `0x${string}`;
    const dataSchema = dataSchemaUID as `0x${string}`;
    const propertySchema = (propertySchemaUID as `0x${string}` | undefined) ?? zeroHash;
    const tagUIDs: `0x${string}`[] = [];
    const visited = new Set<string>();
    const queue: `0x${string}`[] = [rootFolderUID];
    let folderCount = 0;
    let fileCount = 0;

    while (queue.length > 0) {
      const folder = queue.shift() as `0x${string}`;
      if (visited.has(folder.toLowerCase())) continue;
      visited.add(folder.toLowerCase());
      folderCount += 1;

      // Folder's own visibility TAG (if the user authored one).
      const visibilityTagUID = (await publicClient.readContract({
        address: tagResolverAddress,
        abi: TAG_RESOLVER_ABI,
        functionName: "getActiveTagUID",
        args: [me, folder, dataSchema],
      })) as `0x${string}`;
      if (visibilityTagUID && visibilityTagUID !== zeroHash) tagUIDs.push(visibilityTagUID);

      // Walk direct children in 500-item pages.
      let start = 0n;
      const PAGE = 500n;
      // Hard safety cap — 50 pages = 25K children per folder. If a folder is bigger than that
      // we stop paginating (the user can delete remaining content by navigating in).
      for (let page = 0; page < 50; page++) {
        let children: any[] = [];
        try {
          children = (await publicClient.readContract({
            address: efsFileViewInfo.address as `0x${string}`,
            abi: efsFileViewInfo.abi,
            functionName: "getDirectoryPage",
            args: [folder, start, PAGE, dataSchema, propertySchema],
          })) as any[];
        } catch (e) {
          console.warn("Subtree walk: getDirectoryPage failed at folder", folder, e);
          break;
        }
        if (!children || children.length === 0) break;

        for (const child of children) {
          const childUID = child.uid as `0x${string}`;
          if (!childUID || childUID === zeroHash) continue;
          if (childUID === tagsRoot || childUID === sortsAnchorUID) continue;
          const schema = (child.schema as string | undefined)?.toLowerCase();
          if (schema === (dataSchema as string).toLowerCase()) {
            // File anchor — collect placement TAGs under this file.
            fileCount += 1;
            const childTags = await collectUserFilePlacementTags(childUID);
            tagUIDs.push(...childTags);
          } else {
            // Subfolder — queue for recursion.
            queue.push(childUID);
          }
        }

        if (BigInt(children.length) < PAGE) break;
        start += PAGE;
      }
    }

    return { tagUIDs, folderCount, fileCount };
  };

  const executeRevokes = async (
    tagUIDs: `0x${string}`[],
    ops: ReturnType<typeof useBackgroundOps.getState>,
    opId: string,
  ) => {
    if (tagUIDs.length === 0 || !publicClient) return;
    const tagSchemaUID = getTagSchemaUID();
    const CHUNK_SIZE = 50;
    const total = tagUIDs.length;
    let done = 0;
    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = tagUIDs.slice(i, i + CHUNK_SIZE);
      ops.log(opId, `Revoking TAGs ${done + 1}–${done + chunk.length} of ${total}...`);
      const txHash = await easWrite(
        {
          functionName: "multiRevoke",
          args: [[{ schema: tagSchemaUID, data: chunk.map(uid => ({ uid, value: 0n })) }]],
        },
        { silent: true },
      );
      if (txHash) await publicClient.waitForTransactionReceipt({ hash: txHash });
      done += chunk.length;
    }
  };

  const handleDelete = async (item: any, isItemFile: boolean) => {
    if (!publicClient || !tagResolverAddress || !connectedAddress || !dataSchemaUID) {
      notification.error("Not ready — reconnect wallet and try again.");
      return;
    }
    if (!isItemFile) {
      // Folder → open confirm dialog and scan.
      setDeleteConfirm({ item, status: "scanning", tagUIDs: [], folderCount: 0, fileCount: 0 });
      try {
        const scan = await scanSubtree(item.uid as `0x${string}`);
        setDeleteConfirm(prev =>
          prev && prev.item.uid === item.uid
            ? {
                ...prev,
                status: "ready",
                tagUIDs: scan.tagUIDs,
                folderCount: scan.folderCount,
                fileCount: scan.fileCount,
              }
            : prev,
        );
      } catch (e: any) {
        console.error("Subtree scan failed:", e);
        setDeleteConfirm(prev =>
          prev && prev.item.uid === item.uid
            ? { ...prev, status: "ready", error: e?.shortMessage ?? e?.message ?? "Scan failed." }
            : prev,
        );
      }
      return;
    }

    // File → immediate single-click delete, no confirm.
    const ops = useBackgroundOps.getState();
    const label = item.name || "item";
    const opId = ops.start(`Delete: ${label}`);
    try {
      ops.log(opId, "Locating placement TAG...");
      const placementTags = await collectUserFilePlacementTags(item.uid as `0x${string}`);
      if (placementTags.length === 0) {
        throw new Error("You have no active placement on this file — nothing to delete.");
      }
      await executeRevokes(placementTags, ops, opId);
      ops.complete(opId, `Deleted ${label}.`);
      if (selectedFile?.uid === item.uid) closePreview();
      if (useEditionsQuery) {
        await refetchEditionItems();
      } else {
        await refetchStandardItems();
      }
    } catch (e: any) {
      console.error("Delete failed:", e);
      const msg = e?.shortMessage ?? e?.message ?? "Delete failed.";
      notification.error(msg);
      ops.fail(opId, msg);
    }
  };

  const confirmFolderDelete = async () => {
    if (!deleteConfirm || deleteConfirm.status !== "ready") return;
    const { item, tagUIDs } = deleteConfirm;
    const label = item.name || "folder";
    if (tagUIDs.length === 0) {
      notification.info(`Nothing of yours to delete in "${label}". Anchors are permanent.`);
      setDeleteConfirm(null);
      return;
    }
    setDeleteConfirm({ ...deleteConfirm, status: "revoking" });
    const ops = useBackgroundOps.getState();
    const opId = ops.start(`Delete folder: ${label}`);
    try {
      await executeRevokes(tagUIDs, ops, opId);
      ops.complete(opId, `Deleted ${label} — revoked ${tagUIDs.length} TAG${tagUIDs.length === 1 ? "" : "s"}.`);
      if (selectedFile?.uid === item.uid) closePreview();
      if (useEditionsQuery) {
        await refetchEditionItems();
      } else {
        await refetchStandardItems();
      }
      setDeleteConfirm(null);
    } catch (e: any) {
      console.error("Folder delete failed:", e);
      const msg = e?.shortMessage ?? e?.message ?? "Delete failed.";
      notification.error(msg);
      ops.fail(opId, msg);
      setDeleteConfirm(prev => (prev ? { ...prev, status: "ready", error: msg } : prev));
    }
  };

  // Update the keyboard handler ref each render with fresh closure
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (!selectedFile) return;
    // Don't intercept keys when user is typing in an input/textarea/contenteditable,
    // or when any modal dialog is open
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateGallery(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateGallery(1);
    } else if (e.key === "Escape") {
      if (previewFullscreen) {
        setPreviewFullscreen(false);
      } else {
        closePreview();
      }
    }
  };

  return (
    <div className="relative h-full flex flex-row">
      <div className={`${selectedFile ? "flex-1 min-w-0" : "w-full"} overflow-y-auto`}>
        {/* Preview sort banner — shown when no on-chain sorted data exists yet */}
        {isPreviewSort && previewSortKeys.size > 0 && (!sortedUIDs || sortedUIDs.length === 0) && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-info/10 border border-info/20 flex items-center justify-between text-sm gap-3">
            <span className="text-info-content/70 flex items-center gap-1.5">
              Preview sort
              {activeSortStaleness != null && activeSortStaleness > 0n && (
                <span className="text-xs font-mono text-warning">
                  — {activeSortStaleness.toString()} item{activeSortStaleness !== 1n ? "s" : ""} unprocessed
                </span>
              )}
            </span>
            <span className="text-xs text-base-content/40 flex-shrink-0">
              Use &ldquo;Process All&rdquo; in the sort menu to save on-chain
            </span>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 p-4">
          {(sortedItems ?? items)
            ?.filter(
              (item: any) =>
                (isTopic(item) || isFile(item, dataSchemaUID)) && item.uid !== tagsRoot && item.uid !== sortsAnchorUID,
            )
            .map((item: any) => {
              // isTopic = Generic Anchor (Schema 0 or undefined legacy)
              // isFile = Data Anchor (Schema DATA_SCHEMA_UID)
              const isItemTopic = isTopic(item);
              const isItemFile = isFile(item, dataSchemaUID);

              return (
                <div
                  key={item.uid}
                  className={`card bg-base-100 shadow-xl group relative hover:bg-base-200 transition-all duration-200 ${selectedFile?.uid === item.uid ? "ring-2 ring-primary bg-primary/10" : ""}`}
                  onClick={() => {
                    if (isItemTopic) {
                      onNavigate(item.uid, item.name);
                    } else if (isItemFile) {
                      setSelectedFile(item);
                      fetchFileContent(item);
                    }
                  }}
                >
                  {/* Actions — visible on hover */}
                  <div className="absolute top-1.5 right-1.5 flex gap-0.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="p-0.5 rounded bg-base-300/80 hover:bg-base-300 transition-colors"
                      onClick={e => {
                        e.stopPropagation();
                        setTagModalUID(item.uid);
                        setTagModalIsFile(isItemFile);
                      }}
                      title="Tags"
                    >
                      <TagIcon className="w-3.5 h-3.5 text-base-content/50 hover:text-accent" />
                    </button>
                    <button
                      className="p-0.5 rounded bg-base-300/80 hover:bg-base-300 transition-colors"
                      onClick={e => {
                        e.stopPropagation();
                        setPropertiesModalUID(item.uid);
                      }}
                      title="Properties"
                    >
                      <AdjustmentsHorizontalIcon className="w-3.5 h-3.5 text-base-content/50 hover:text-secondary" />
                    </button>
                    <button
                      className="p-0.5 rounded bg-base-300/80 hover:bg-base-300 transition-colors"
                      onClick={e => {
                        e.stopPropagation();
                        setSelectedDebugItem(item);
                      }}
                      title="Debug Info"
                    >
                      <InformationCircleIcon className="w-3.5 h-3.5 text-base-content/50 hover:text-primary" />
                    </button>
                    <button
                      className="p-0.5 rounded bg-base-300/80 hover:bg-base-300 transition-colors"
                      onClick={e => {
                        e.stopPropagation();
                        handleDelete(item, isItemFile);
                      }}
                      title={isItemFile ? "Delete file" : "Delete folder"}
                    >
                      <TrashIcon className="w-3.5 h-3.5 text-base-content/50 hover:text-error" />
                    </button>
                  </div>

                  <div className="card-body items-center text-center p-4 pt-6 cursor-pointer">
                    <div>
                      {isItemTopic ? (
                        <FolderIcon className="w-10 h-10 text-yellow-500" />
                      ) : (
                        <DocumentIcon className="w-10 h-10 text-blue-500" />
                      )}
                    </div>
                    <h2 className="card-title text-sm break-all text-center leading-tight">{item.name || "Unnamed"}</h2>
                    <div className="text-xs text-base-content/40">
                      {isItemTopic
                        ? useEditionsQuery
                          ? "Folder"
                          : item.childCount > 0
                            ? `${item.childCount} items`
                            : "Empty"
                        : "File"}
                    </div>
                  </div>
                </div>
              );
            })}
          {(sortedItems ?? items)?.length === 0 && (
            <div className="col-span-full text-center text-gray-500">
              {tagFilteredUIDs !== null
                ? `No items match tag filter: "${tagFilter}"`
                : tagExcludedUIDs.size > 0
                  ? "All items hidden by active exclusion filter"
                  : "Topic is empty"}
            </div>
          )}
        </div>
        {/* Load more: kernel items when page is full, or sorted pages when more exist */}
        {items && items.length > 0 && items.length >= Number(pageSize) && (
          <div className="flex justify-center py-4">
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setPageSize(prev => prev + 50n);
                if (hasSortMore) loadMoreSorted();
              }}
            >
              Load more
            </button>
          </div>
        )}
      </div>
      {/* end scrollable grid wrapper */}

      {/* File Preview Side Pane */}
      {selectedFile && !previewFullscreen && (
        <div className="preview-pane absolute inset-0 z-10 max-lg:bg-base-200 lg:static lg:w-[400px] lg:flex-shrink-0 border-l border-base-300 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {fileItems.length > 1 && (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    className="btn btn-ghost btn-xs btn-circle"
                    onClick={() => navigateGallery(-1)}
                    title="Previous file"
                  >
                    <ChevronLeftIcon className="w-4 h-4" />
                  </button>
                  <button
                    className="btn btn-ghost btn-xs btn-circle"
                    onClick={() => navigateGallery(1)}
                    title="Next file"
                  >
                    <ChevronRightIcon className="w-4 h-4" />
                  </button>
                </div>
              )}
              <h3 className="font-bold text-sm truncate">{selectedFile.name}</h3>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                className="btn btn-ghost btn-sm btn-circle"
                onClick={() => setPreviewFullscreen(true)}
                title="Fullscreen"
              >
                <ArrowsPointingOutIcon className="w-4 h-4" />
              </button>
              <button className="btn btn-ghost btn-sm btn-circle" onClick={closePreview} title="Close">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Transport badge — shown when file preview is loaded */}
          {fileContent && !isFileLoading && fileContentType && (
            <div className="px-4 py-1 border-b border-base-300 shrink-0 flex gap-1.5 items-center">
              <span className="badge badge-sm badge-outline">
                {TRANSPORT_LABELS[fileTransportType as keyof typeof TRANSPORT_LABELS] || fileTransportType}
              </span>
              <span className="text-xs text-base-content/50">{fileContentType}</span>
            </div>
          )}

          <div className="flex-1 overflow-auto p-4">
            {isFileLoading ? (
              <div className="flex items-center justify-center h-32">
                <span className="loading loading-spinner loading-lg text-primary"></span>
              </div>
            ) : fetchError ? (
              <div className="text-center text-error">
                <p className="font-semibold mb-1">Failed to load file</p>
                <p className="text-xs opacity-70">{fetchError}</p>
              </div>
            ) : fileContent ? (
              fileContentType?.includes("image/svg") ? (
                // Render SVG as <img> data URI to prevent XSS from untrusted content
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(fileContent)}`}
                  alt={selectedFile.name}
                  className="max-w-full max-h-full w-auto h-auto object-contain rounded cursor-pointer mx-auto"
                  onClick={() => setPreviewFullscreen(true)}
                />
              ) : fileContentType?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={fileContent.startsWith("blob:") ? fileContent : `data:${fileContentType};base64,${fileContent}`}
                  alt={selectedFile.name}
                  className="max-w-full max-h-full w-auto h-auto object-contain rounded cursor-pointer mx-auto"
                  onClick={() => setPreviewFullscreen(true)}
                />
              ) : fileContentType === "application/pdf" ? (
                <iframe
                  src={fileContent}
                  title={selectedFile.name}
                  className="w-full rounded cursor-pointer"
                  style={{ height: "60vh" }}
                  onClick={() => setPreviewFullscreen(true)}
                />
              ) : fileContentType?.startsWith("video/") ? (
                <video
                  src={fileContent}
                  controls
                  className="max-w-full h-auto rounded cursor-pointer"
                  onClick={e => {
                    e.preventDefault();
                    setPreviewFullscreen(true);
                  }}
                />
              ) : fileContentType?.startsWith("audio/") ? (
                <audio src={fileContent} controls className="w-full" />
              ) : fileContentType && !isTextViewable(fileContentType) ? (
                <div className="text-center text-gray-500">
                  <p className="font-semibold mb-1">Binary file — cannot preview</p>
                  <p className="text-xs opacity-60">{fileContentType}</p>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap text-sm cursor-pointer" onClick={() => setPreviewFullscreen(true)}>
                  {fileContent}
                </pre>
              )
            ) : (
              <div className="text-center text-gray-500">No content found.</div>
            )}
          </div>

          {/* Mirrors panel */}
          {!selectedFile.isFolder && (
            <MirrorsPanel fileAnchorUID={selectedFile.uid} editionAddresses={editionAddresses} />
          )}
        </div>
      )}

      {/* Fullscreen overlay — portaled to body to escape stacking contexts */}
      {selectedFile &&
        previewFullscreen &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center"
            onClick={() => setPreviewFullscreen(false)}
          >
            {/* Close button */}
            <button
              className="absolute top-4 right-4 btn btn-ghost btn-circle text-white/70 hover:text-white hover:bg-white/10"
              onClick={e => {
                e.stopPropagation();
                setPreviewFullscreen(false);
              }}
            >
              <XMarkIcon className="w-6 h-6" />
            </button>

            {/* File name */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/70 text-sm font-medium">
              {selectedFile.name}
            </div>

            {/* Gallery nav arrows */}
            {fileItems.length > 1 && (
              <>
                <button
                  className="absolute left-4 top-1/2 -translate-y-1/2 btn btn-circle btn-ghost text-white/70 hover:text-white hover:bg-white/10"
                  onClick={e => {
                    e.stopPropagation();
                    navigateGallery(-1);
                  }}
                >
                  <ChevronLeftIcon className="w-6 h-6" />
                </button>
                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 btn btn-circle btn-ghost text-white/70 hover:text-white hover:bg-white/10"
                  onClick={e => {
                    e.stopPropagation();
                    navigateGallery(1);
                  }}
                >
                  <ChevronRightIcon className="w-6 h-6" />
                </button>
              </>
            )}

            {/* Content */}
            <div className="max-w-[90vw] max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
              {isFileLoading ? (
                <span className="loading loading-spinner loading-lg text-white"></span>
              ) : fetchError ? (
                <div className="text-center text-error">
                  <p className="font-semibold mb-1">Failed to load file</p>
                  <p className="text-xs opacity-70">{fetchError}</p>
                </div>
              ) : fileContent ? (
                fileContentType?.includes("image/svg") ? (
                  // Render SVG as <img> data URI to prevent XSS from untrusted content
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(fileContent)}`}
                    alt={selectedFile.name}
                    className="max-w-[90vw] max-h-[85vh] object-contain"
                  />
                ) : fileContentType?.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={
                      fileContent.startsWith("blob:") ? fileContent : `data:${fileContentType};base64,${fileContent}`
                    }
                    alt={selectedFile.name}
                    className="max-w-[90vw] max-h-[85vh] object-contain"
                  />
                ) : fileContentType === "application/pdf" ? (
                  <iframe
                    src={fileContent}
                    title={selectedFile.name}
                    className="rounded"
                    style={{ width: "90vw", height: "85vh" }}
                  />
                ) : fileContentType?.startsWith("video/") ? (
                  <video src={fileContent} controls className="max-w-[90vw] max-h-[85vh] object-contain" />
                ) : fileContentType?.startsWith("audio/") ? (
                  <audio src={fileContent} controls className="w-[60vw]" />
                ) : fileContentType && !isTextViewable(fileContentType) ? (
                  <div className="text-center text-white/50">
                    <p className="font-semibold mb-1">Binary file — cannot preview</p>
                    <p className="text-xs opacity-60">{fileContentType}</p>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap text-sm text-white bg-black/50 rounded-lg p-6">{fileContent}</pre>
                )
              ) : (
                <div className="text-center text-white/50">No content found.</div>
              )}
            </div>
          </div>,
          document.body,
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
          editionAddresses={editionAddresses}
          onClose={() => {
            setTagModalUID(null);
            setTagModalIsFile(false);
          }}
          onTagChange={() => setTagFilterVersion(v => v + 1)}
        />
      )}
      {/* Folder delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <div className="bg-base-100 rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="font-bold text-lg">Delete folder?</h3>
            <p className="mt-2 text-sm text-base-content/70 break-all">
              <span className="font-mono">{deleteConfirm.item.name || "folder"}</span>
            </p>

            {deleteConfirm.status === "scanning" && (
              <div className="mt-4 flex items-center gap-3 text-sm">
                <span className="loading loading-spinner loading-sm" />
                <span>Scanning subtree for your content…</span>
              </div>
            )}

            {deleteConfirm.status !== "scanning" && (
              <div className="mt-4 space-y-2 text-sm">
                {deleteConfirm.error && <div className="text-error">{deleteConfirm.error}</div>}
                {deleteConfirm.tagUIDs.length === 0 ? (
                  <div className="text-base-content/70">
                    Nothing of yours to delete here. Anchors are permanent, and this folder contains no files or
                    visibility TAGs you authored.
                  </div>
                ) : (
                  <>
                    <div>
                      This will revoke{" "}
                      <span className="font-semibold text-error">
                        {deleteConfirm.tagUIDs.length} TAG{deleteConfirm.tagUIDs.length === 1 ? "" : "s"}
                      </span>{" "}
                      you authored across{" "}
                      <span className="font-semibold">
                        {deleteConfirm.folderCount} folder{deleteConfirm.folderCount === 1 ? "" : "s"}
                      </span>{" "}
                      and{" "}
                      <span className="font-semibold">
                        {deleteConfirm.fileCount} file{deleteConfirm.fileCount === 1 ? "" : "s"}
                      </span>
                      .
                    </div>
                    <div className="text-xs text-base-content/60">
                      Batched in chunks of 50 per transaction — expect {Math.ceil(deleteConfirm.tagUIDs.length / 50)}{" "}
                      wallet prompt
                      {Math.ceil(deleteConfirm.tagUIDs.length / 50) === 1 ? "" : "s"}. Anchors themselves are permanent
                      and cannot be deleted.
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteConfirm.status === "revoking"}
              >
                Cancel
              </button>
              <button
                className="btn btn-error btn-sm"
                onClick={confirmFolderDelete}
                disabled={deleteConfirm.status !== "ready" || deleteConfirm.tagUIDs.length === 0}
              >
                {deleteConfirm.status === "revoking" ? (
                  <>
                    <span className="loading loading-spinner loading-xs" />
                    Deleting…
                  </>
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
