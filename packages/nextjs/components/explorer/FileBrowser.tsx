"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ListPreviewPane } from "./ListPreviewPane";
import { MirrorsPanel } from "./MirrorsPanel";
import { PropertiesModal } from "./PropertiesModal";
import { TagModal } from "./TagModal";
import { createPortal } from "react-dom";
import { type Abi, zeroHash } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import {
  AdjustmentsHorizontalIcon,
  ArrowsPointingOutIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  InformationCircleIcon,
  QueueListIcon,
  Square2StackIcon,
  TagIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useLensesDirectoryPage } from "~~/hooks/efs/useLensesDirectoryPage";
import { useSortedData } from "~~/hooks/efs/useSortedData";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { isFile, isList, isTopic } from "~~/utils/efs/efsTypes";
import { fetchFileContent as fetchFileContentUtil } from "~~/utils/efs/fetchFileContent";
import { resolveSystemAnchorSet } from "~~/utils/efs/resolveSystemAnchorSet";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { TRANSPORT_LABELS } from "~~/utils/efs/transports";
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
  anchorSchemaUID,
  currentPathNames,
  lensAddresses,
  explicitLenses = false,
  onNavigate,
  tagFilter = "",
  drawerTagFilters = {},
  activeSortInfoUID = null,
  sortOverlayAddress,
  sortRefreshKey = 0,
  directoryRefreshKey = 0,
  recreatedListAnchor,
  reverseOrder = false,
  showSystemFiles = false,
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  /** ANCHOR_SCHEMA_UID from EFSIndexer — needed to query folder-level descriptive-label TAG buckets. */
  anchorSchemaUID?: string;
  currentPathNames: string[];
  lensAddresses: string[];
  /**
   * True when the caller passed `?lenses=…` explicitly — including the case
   * where every token in the list failed ENS / hex parsing and
   * `lensAddresses` ended up empty. Distinguishes "user asked for nothing"
   * (stay lens-scoped, render empty) from "nothing available to scope to"
   * (wallet disconnected, no default set — fall through to unscoped). Without
   * this flag, explicit-but-unresolved URLs like `?lenses=doesnotexist.eth`
   * silently leak default/unfiltered content into a view the user told us to
   * scope down. Defaults false for back-compat with callers that don't know
   * about `lensesParam`.
   */
  explicitLenses?: boolean;
  onNavigate: (uid: string, name: string) => void;
  tagFilter?: string;
  drawerTagFilters?: Record<string, DrawerTagFilterState>;
  activeSortInfoUID?: string | null;
  sortOverlayAddress?: `0x${string}`;
  sortRefreshKey?: number;
  /**
   * Bumped by the parent (ExplorerClient) after any out-of-component mutation
   * that adds/removes items in the current directory — today: file upload and
   * folder creation, which land via `CreateItemModal` → `FileActionsBar` and
   * therefore can't call the internal `refetch*` functions directly. Delete is
   * in-component and calls `refetchLensItems` / `refetchStandardItems`
   * inline; this key is the parallel escape hatch for create.
   *
   * Each bump triggers exactly one refetch of whichever query is active
   * (lens-scoped or standard). Initial mount is skipped — the hooks fetch
   * on their own when deps settle.
   */
  directoryRefreshKey?: number;
  /** Slot anchor of a just-created list. Recreating a deleted list reuses its permanent
   *  anchor, so this lifts any stale delete-suppression on it (see effect below). */
  recreatedListAnchor?: string;
  reverseOrder?: boolean;
  /**
   * When false (default), child anchors tagged `system` by any active lens
   * (the `/tags/system` set, per resolveSystemAnchorSet) are hidden from the
   * directory grid. When true, they're shown. Independent of the descriptive
   * label include/exclude (drawerTagFilters) path.
   */
  showSystemFiles?: boolean;
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
  const [edgeResolverAddress, setEdgeResolverAddress] = useState<`0x${string}` | null>(null);
  const [tagsRoot, setTagsRoot] = useState<`0x${string}` | null>(null);
  // Anchor UIDs tagged `system` by any active lens (`/tags/system`). Used to
  // hide system files from the grid unless `showSystemFiles` is set (Task 14).
  // Lowercased UIDs; empty when /tags/system doesn't exist or no lenses.
  const [systemSet, setSystemSet] = useState<Set<string>>(new Set());
  // Folder-delete confirmation. `pinUIDs` (file placements, cardinality 1) and
  // `tagUIDs` (folder visibility, cardinality N) are populated by scanSubtree.
  // Tracked separately because they live under different EAS schemas (PIN vs TAG)
  // and revoke() requires the matching schema (ADR-0041).
  const [deleteConfirm, setDeleteConfirm] = useState<{
    item: any;
    status: "scanning" | "ready" | "revoking";
    pinUIDs: `0x${string}`[];
    tagUIDs: `0x${string}`[];
    folderCount: number;
    fileCount: number;
    error?: string;
  } | null>(null);
  // Maps anchor UID → set of DATA UIDs for all relevant lens attesters.
  // Built when a tag filter is active; an item matches if ANY of its DATA UIDs is in the tag set.
  const [dataUIDMap, setDataUIDMap] = useState<Map<string, Set<string>>>(new Map());

  const { data: efsRouter } = useDeployedContractInfo({ contractName: "EFSRouter" });

  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: efsFileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });
  const publicClient = usePublicClient();
  const { address: connectedAddress } = useAccount();
  const { writeContractAsync: easWrite } = useScaffoldWriteContract("EAS");

  // PIN and TAG schema UIDs from EdgeResolver (ADR-0041 — distinct schemas
  // for cardinality 1 vs N). Declared early because the tag-filter useEffect
  // below depends on tagSchemaUID for schema-aware active-edge queries; the
  // revoke flow further down also uses both UIDs as the schema arg.
  const { data: pinSchemaUID } = useScaffoldReadContract({
    contractName: "EdgeResolver",
    functionName: "PIN_SCHEMA_UID",
  });
  const { data: tagSchemaUID } = useScaffoldReadContract({
    contractName: "EdgeResolver",
    functionName: "TAG_SCHEMA_UID",
  });

  // List support: LIST_SCHEMA_UID from ListReader + list items in the current folder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo({ contractName: "ListReader" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;

  const LIST_SCHEMA_UID_ABI = [
    {
      inputs: [],
      name: "LIST_SCHEMA_UID",
      outputs: [{ name: "", type: "bytes32" }],
      stateMutability: "view",
      type: "function",
    },
  ] as const;

  const { data: listSchemaUID } = useReadContract({
    address: listReaderAddress,
    abi: LIST_SCHEMA_UID_ABI,
    functionName: "LIST_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  // Selected list (clicked in directory grid) — shown in the preview pane.
  // `uid` is the resolved LIST attestation UID (from the anchor's active PIN);
  // `anchorUID` is the list-slot anchor (used to revoke the placement PIN on delete).
  const [selectedList, setSelectedList] = useState<{
    uid: string;
    anchorUID: string;
    name: string;
    attester: string;
  } | null>(null);

  // List anchors whose placement the user just revoked. The standard (non-lens)
  // `getDirectoryPage` returns anchor children regardless of an active LIST PIN, so a
  // deleted list would otherwise linger as a dead card (openList reports it missing).
  // Suppress them locally until the user navigates away. (The lens path already filters
  // by active placement, so this only matters for the standard view.)
  const [deletedListAnchors, setDeletedListAnchors] = useState<Set<string>>(new Set());

  // Lists are placed like files (ADR-0044 §1): a named ANCHOR with anchorType=LIST_SCHEMA_UID
  // plus a PIN(definition=anchor, refUID=LIST). They surface as anchor children of the folder
  // with `item.schema === LIST_SCHEMA_UID` — no dedicated read needed. The PIN target (the LIST
  // UID) is resolved on click via EdgeResolver.getActivePinTarget.

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
    setDeletedListAnchors(new Set()); // clear delete-suppression when navigating folders
  }, [currentAnchorUID]);

  // Recreating a deleted list reuses the SAME permanent anchor (CreateItemModal's
  // resolveAnchor reuse — the documented recovery path). Without this, the recreated
  // list's now-active placement would stay hidden by the delete-suppression set until
  // the user navigated away. Lift suppression on that specific anchor when a create lands
  // (keyed on directoryRefreshKey so it re-fires even if the same slot is recreated twice).
  useEffect(() => {
    if (!recreatedListAnchor) return;
    const lc = recreatedListAnchor.toLowerCase();
    setDeletedListAnchors(prev => {
      if (!prev.has(lc)) return prev;
      const next = new Set(prev);
      next.delete(lc);
      return next;
    });
  }, [directoryRefreshKey, recreatedListAnchor]);

  // Load EdgeResolver address and "tags" anchor UID once.
  // "tags" is a normal anchor under the file system root — discovered the same way
  // any folder is, via resolvePath. Tag definitions (e.g. "favorites") are its children.
  useEffect(() => {
    if (!publicClient || !indexerInfo) return;
    getEdgeResolverAddress(publicClient.chain.id).then(async addr => {
      if (!addr) return;
      setEdgeResolverAddress(addr);
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

    if (!publicClient || !indexerInfo || !edgeResolverAddress || !tagsRoot || !tagSchemaUID) {
      setIsTagFilterLoading(false);
      return;
    }

    let cancelled = false;
    setIsTagFilterLoading(true);

    // AGENT-NOTE (ADR-0041 + ADR-0042): descriptive labels under /tags/ are TAG-only (cardinality N).
    // Two distinct concepts:
    //   active TAG   = unrevoked edge exists (kernel semantic, ADR-0041 §4).
    //   effective TAG = active TAG with weight >= 0 (client-layer convention, ADR-0042).
    // Negative-weight TAGs remain active on-chain (kernel does not interpret sign) but are
    // suppressed for the include/exclude filter sets built here.  weight = 0 is effective.
    // hasActiveTagFromAny and other raw resolver helpers use the kernel (active-only) check
    // and are NOT changed by this convention.
    const resolveTagSet = async (tagName: string): Promise<Set<string>> => {
      const definitionUID = (await publicClient.readContract({
        address: indexerInfo.address as `0x${string}`,
        abi: indexerInfo.abi,
        functionName: "resolvePath",
        args: [tagsRoot as `0x${string}`, tagName],
      })) as `0x${string}`;

      if (!definitionUID || definitionUID === zeroHash) return new Set();

      // Only consider tags applied by the currently viewed attesters (lenses list).
      // Do NOT widen with connectedAddress — explicit ?lenses= must not be overridden
      // (ADR-0031/0039: same URL must render identically for all viewers).
      // Fall back to connectedAddress only when no lenses are configured.
      const tagAttesters: `0x${string}`[] =
        lensAddresses.length > 0
          ? lensAddresses.map(a => a as `0x${string}`)
          : connectedAddress
            ? [connectedAddress as `0x${string}`]
            : [];

      if (tagAttesters.length === 0) return new Set();

      // Per-attester bulk fetch: getActiveTagEntries (weight-aware) + getActiveTargetsByAttesterAndSchema
      // (resolves tagUID → targetID) fetched in parallel at the same pagination window.
      // The two arrays share the same underlying _activeByAAS[def][attester][targetSchema] index, so
      // entries[i] and targets[i] always correspond to the same edge. Filter to weight >= 0.
      //
      // _activeByAAS is keyed by TARGET schema (the schema of the tagged thing), NOT TAG_SCHEMA_UID.
      // Descriptive labels can target DATA attestations (file-level) or ANCHOR attestations
      // (folder-level), so we union both buckets. tagSchemaUID is deliberately NOT used here.
      const PAGE_SIZE = 500n;
      const effectiveTargets = new Set<string>();

      // The buckets we care about for the explorer's descriptive-label filter:
      //   dataSchemaUID  — DATA-target file labels (the primary use case)
      //   anchorSchemaUID — ANCHOR-target folder labels (optional — skipped if not provided)
      const targetSchemaBuckets: `0x${string}`[] = [dataSchemaUID as `0x${string}`];
      if (anchorSchemaUID) targetSchemaBuckets.push(anchorSchemaUID as `0x${string}`);

      for (const targetSchema of targetSchemaBuckets) {
        for (const attester of tagAttesters) {
          const count = (await publicClient.readContract({
            address: edgeResolverAddress,
            abi: EDGE_RESOLVER_ABI,
            functionName: "getActiveTagsCount",
            args: [definitionUID, attester, targetSchema],
          })) as bigint;

          if (count === 0n) continue;

          for (let cursor = 0n; cursor < count; cursor += PAGE_SIZE) {
            const [entries, targets] = (await Promise.all([
              publicClient.readContract({
                address: edgeResolverAddress,
                abi: EDGE_RESOLVER_ABI,
                functionName: "getActiveTagEntries",
                args: [definitionUID, attester, targetSchema, cursor, PAGE_SIZE],
              }),
              publicClient.readContract({
                address: edgeResolverAddress,
                abi: EDGE_RESOLVER_ABI,
                functionName: "getActiveTargetsByAttesterAndSchema",
                args: [definitionUID, attester, targetSchema, cursor, PAGE_SIZE],
              }),
            ])) as [ReadonlyArray<{ tagUID: `0x${string}`; weight: bigint }>, readonly `0x${string}`[]];

            // Use min length: getActiveTagEntries and getActiveTargetsByAttesterAndSchema are
            // two independent RPC calls. A revocation between them can produce arrays of
            // different lengths; iterating past the shorter array would throw on targets[i].
            const bound = Math.min(entries.length, targets.length);
            for (let i = 0; i < bound; i++) {
              // Effective TAG: weight >= 0. weight < 0 is active on-chain but suppressed for
              // this filter (ADR-0042). weight = 0 is included.
              if (entries[i].weight >= 0n) {
                effectiveTargets.add(targets[i].toLowerCase());
              }
            }
          }
        }
      }

      return effectiveTargets;
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
    edgeResolverAddress,
    tagsRoot,
    connectedAddress,
    lensAddresses,
    tagSchemaUID,
    dataSchemaUID,
    anchorSchemaUID,
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
      // Preview reads go straight through the same-origin wagmi transport:
      //   EFSRouter.request([...pathSegs], [{key:"lenses",value:csv}, ...]) via publicClient
      // plus gateway fetches for external-body mirrors (IPFS/Arweave/HTTPS).
      //
      // We used to try `web3protocol.Client.fetchUrl(uri)` first and fall back
      // to this direct path on error. Removed 2026-04-20:
      //   1. On devnet (app on `*.nip.io` / an eth.limo origin), `web3protocol`
      //      bundles WASM + its own fetcher and constructs RPC connections
      //      outside wagmi's configured transport. On first preview click the
      //      browser raised a **Local Network Access** permission prompt
      //      ("Access other apps and services on this device — Block / Allow")
      //      — users read that as malware and bounce. See
      //      `docs/decisions.md` entry for 2026-04-20.
      //   2. The direct path already covers every content shape: on-chain
      //      SSTORE2 chunks via `web3-next-chunk` pagination, and
      //      `message/external-body` delegation to a gateway. The
      //      web3protocol branch collapsed duplicate Content-Type headers
      //      (breaking external-body detection) and fell through on empty
      //      bodies anyway — strictly extra surface area.
      //   3. A future "native transport helper" (e.g. an opt-in local IPFS
      //      node) must be an explicit user toggle, never automatic from a
      //      preview click.
      if (!publicClient) {
        throw new Error("Public client not available");
      }

      // Router-read + chunk-reassembly + external-mirror logic now lives in the
      // pure util (utils/efs/fetchFileContent.ts), shared with the Overview hook.
      // Cancellation (fetchId) and all setState stay here in the component.
      const { bytes, contentType, transport } = await fetchFileContentUtil({
        routerAddress: efsRouter.address as `0x${string}`,
        routerAbi: efsRouter.abi as Abi,
        publicClient,
        lensAddresses,
        resourcePath: [...currentPathNames, item.name],
      });

      // External mirrors set a specific transport (ipfs/arweave/https/…); on-chain
      // bodies keep the default "onchain" set above. Matches the prior inline
      // setFileTransportType(detectTransport(externalUri)) behavior.
      if (transport !== "onchain") setFileTransportType(transport);

      // Discard results from a superseded fetch (user clicked a different file)
      if (fetchId !== fetchIdRef.current) return;

      const contentTypeStr = contentType ?? "text/plain";
      setFileContentType(contentTypeStr);

      const useBlobUrl =
        (contentTypeStr.startsWith("image/") && !contentTypeStr.includes("svg")) ||
        contentTypeStr.startsWith("video/") ||
        contentTypeStr.startsWith("audio/") ||
        contentTypeStr === "application/pdf";

      if (useBlobUrl) {
        const blob = new Blob([bytes], { type: contentTypeStr });
        const objectUrl = URL.createObjectURL(blob);
        setFileContent(objectUrl);
      } else {
        // parse as utf-8 string
        const text = new TextDecoder().decode(bytes);
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
  // pinSchemaUID and tagSchemaUID are declared earlier (top of component) so
  // they're in scope for the tag-filter useEffect.

  const { data: sortsAnchorUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "sortsAnchorUID",
  });

  // Root anchor — needed by resolveSystemAnchorSet to walk to /tags/system.
  const { data: rootUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "rootAnchorUID",
  });

  // System-anchor set for the current directory (Task 14). Independent of the
  // descriptive-label drawerTagFilters/matchesUID path: this resolves the
  // `/tags/system` kernel-active anchor-target set via resolveSystemAnchorSet
  // and is applied as a final visibility filter when showSystemFiles is off.
  // Keyed on the same inputs the directory listing keys on (anchor, lenses,
  // dataSchema). lensKey is the joined-address string so a fresh array identity
  // doesn't re-run the effect when the actual lenses are unchanged.
  const lensKey = lensAddresses.join(",");
  useEffect(() => {
    if (
      !publicClient ||
      !indexerInfo ||
      !edgeResolverAddress ||
      !rootUID ||
      !dataSchemaUID ||
      lensAddresses.length === 0
    ) {
      setSystemSet(new Set());
      return;
    }
    let cancelled = false;
    resolveSystemAnchorSet({
      publicClient,
      indexerAddress: indexerInfo.address as `0x${string}`,
      indexerAbi: indexerInfo.abi as Abi,
      edgeResolverAddress,
      edgeResolverAbi: EDGE_RESOLVER_ABI as unknown as Abi,
      rootUID: rootUID as `0x${string}`,
      dataSchemaUID: dataSchemaUID as `0x${string}`,
      lensAddresses,
    })
      .then(set => {
        if (!cancelled) setSystemSet(set);
      })
      .catch(() => {
        if (!cancelled) setSystemSet(new Set());
      });
    return () => {
      cancelled = true;
    };
    // lensKey stands in for lensAddresses (stable string key); see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, indexerInfo, edgeResolverAddress, rootUID, dataSchemaUID, currentAnchorUID, lensKey]);

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
    lensAddresses,
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

  const hasLenses = lensAddresses && lensAddresses.length > 0;

  // Once we've ever been in lens mode, stay there — prevents the standard (show-all) query
  // from firing its cached result during the brief window when lensAddresses is transitioning
  // to a new address (e.g. wallet account switch causes a momentary empty array).
  // BUT: if lensAddresses is empty (wallet disconnect, no default set), fall through to the
  // standard query rather than leaving both queries disabled — showing unfiltered data is better
  // than an indefinitely blank directory.
  //
  // `explicitLenses` overrides that fallthrough: when the user passed
  // `?lenses=…` but every token failed to resolve, we STAY in lens mode
  // (against an empty address list → empty grid) rather than silently
  // broadening the view to unscoped default content the URL never asked for.
  // See Codex P2 on PR #9 and ADR-0031 (explicit param must not widen results).
  const lockedToLenses = useRef(false);
  if (hasLenses) lockedToLenses.current = true;
  const useLensesQuery = explicitLenses || ((hasLenses || lockedToLenses.current) && lensAddresses.length > 0);

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
      enabled: !useLensesQuery,
    },
  });

  // Lens-scoped directory listing iterates the opaque cursor (ADR-0036) across
  // pages. The contract's phase-0 folder scan can return zero items with a
  // non-empty `nextCursor` when the 2048-entry per-call budget is burned on
  // revoked / wrong-attester entries; without cursor replay the UI would show
  // "Topic is empty" even when phase-1 has matches. `useLensesDirectoryPage`
  // auto-advances on empty pages and exposes `loadMore` for user-triggered paging.
  const {
    items: lensItems,
    isLoading: isLensLoading,
    hasMore: hasMoreLenses,
    loadMore: loadMoreLenses,
    refresh: refetchLensItems,
  } = useLensesDirectoryPage({
    parentAnchor: (currentAnchorUID ?? undefined) as `0x${string}` | undefined,
    dataSchemaUID: dataSchemaUID as `0x${string}` | undefined,
    lensAddresses: lensAddresses as string[],
    fileViewAddress: efsFileViewInfo?.address as `0x${string}` | undefined,
    fileViewAbi: efsFileViewInfo?.abi as any,
    pageSize,
    enabled: useLensesQuery && lensAddresses.length > 0,
  });

  // Lens-scoped LIST anchors. Lists are placed as anchors with anchorType=LIST_SCHEMA_UID,
  // so the same schema-filtered directory walk surfaces them — just with the LIST schema.
  // (The standard `getDirectoryPage` path already returns all anchor children, lists included.)
  const {
    items: lensListItems,
    hasMore: hasMoreLensList,
    loadMore: loadMoreLensList,
    refresh: refetchLensListItems,
  } = useLensesDirectoryPage({
    parentAnchor: (currentAnchorUID ?? undefined) as `0x${string}` | undefined,
    dataSchemaUID: listSchemaUID as `0x${string}` | undefined,
    lensAddresses: lensAddresses as string[],
    fileViewAddress: efsFileViewInfo?.address as `0x${string}` | undefined,
    fileViewAbi: efsFileViewInfo?.abi as any,
    pageSize,
    enabled: useLensesQuery && lensAddresses.length > 0 && !!listSchemaUID,
  });

  // Parent-driven refetch for out-of-component mutations (create file/folder).
  // Skip the initial render — the queries fire on their own when deps settle.
  // Subsequent bumps route to whichever query is currently live. We snapshot
  // `useLensesQuery` at call time so a mid-flight mode switch (e.g. wallet
  // disconnect between the create and the refetch) still hits the right
  // refetcher rather than racing the mode-flip.
  const firstRefreshRun = useRef(true);
  useEffect(() => {
    if (firstRefreshRun.current) {
      firstRefreshRun.current = false;
      return;
    }
    if (directoryRefreshKey === 0) return;
    if (useLensesQuery) {
      refetchLensItems().catch(e => console.error("Directory refetch (lenses) failed", e));
    } else {
      refetchStandardItems();
    }
    if (useLensesQuery) refetchLensListItems().catch(e => console.error("List refetch (lenses) failed", e));
    // refetch* identities are stable per query; useLensesQuery is the
    // dispatch key and changes rarely. Intentionally scoped to the bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryRefreshKey]);

  const isLoading = useLensesQuery ? isLensLoading : isStandardLoading;
  // When explicit-lenses requested an empty list (all tokens unresolved), the
  // lens hook is disabled and `lensItems` is undefined — without this
  // coercion, the grid would render neither items nor the "Topic is empty"
  // string (the empty-state check uses `items?.length === 0`, which is false
  // for undefined). Coerce to a stable `[]` so the user sees an explicit
  // empty result instead of a silently-blank pane. Memoized so downstream
  // effects that depend on `rawItems` identity don't refire every render.
  const rawItems = useMemo(() => {
    if (useLensesQuery) {
      if (lensAddresses.length === 0) return [];
      // Merge file/folder anchors with list anchors (the LIST-schema lens walk).
      // `getDirectoryPageBySchemaAndAddressList` returns qualifying generic folders in
      // phase 0 of BOTH walks, so every visible subfolder is in lensItems AND
      // lensListItems — dedupe by UID to avoid duplicate cards / duplicate React keys.
      const merged = [...(lensItems ?? []), ...(lensListItems ?? [])];
      const seen = new Set<string>();
      return merged.filter(it => {
        const uid = (it.uid as string | undefined)?.toLowerCase();
        if (!uid || seen.has(uid)) return false;
        seen.add(uid);
        return true;
      });
    }
    // Standard `getDirectoryPage` already returns every anchor child, lists included.
    return standardItems;
  }, [useLensesQuery, lensAddresses.length, lensItems, lensListItems, standardItems]);

  // When a tag filter is active, resolve DATA UIDs for each file item.
  // AGENT-NOTE (ADR-0041): file placement is now PIN (cardinality 1) — there's at
  // most one active DATA per (attester, anchor), so we use the O(1) `getActivePinTarget`
  // reader instead of the old TAG count → enumerate scan. We still build a Set per
  // anchor because multiple attesters can each have their own DATA at the same anchor.
  useEffect(() => {
    if ((!tagFilteredUIDs && tagExcludedUIDs.size === 0) || !rawItems || !publicClient || !edgeResolverAddress) {
      setDataUIDMap(new Map());
      setIsDataUIDMapLoading(false);
      return;
    }

    setIsDataUIDMapLoading(true);

    const attesters: string[] = lensAddresses.length > 0 ? lensAddresses : connectedAddress ? [connectedAddress] : [];

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
                  const target = (await publicClient.readContract({
                    address: edgeResolverAddress,
                    abi: EDGE_RESOLVER_ABI,
                    functionName: "getActivePinTarget",
                    args: [item.uid as `0x${string}`, attester as `0x${string}`, dataSchemaUID as `0x${string}`],
                  })) as `0x${string}`;
                  if (target && target !== zeroHash) {
                    dataUIDs.add(target.toLowerCase());
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
    edgeResolverAddress,
    dataSchemaUID,
    connectedAddress,
    lensAddresses,
  ]);

  // Apply tag filters. Include filter (tagFilteredUIDs): item must be in set (null = no filter).
  // Exclude filter (tagExcludedUIDs): item must NOT be in set (empty = no exclusions).
  const matchesUID = (item: any, uidSet: Set<string>): boolean => {
    const anchorUID = item.uid.toLowerCase();
    if (isFile(item, dataSchemaUID)) {
      // Tags on files target DATA UIDs — never anchor UIDs (specs/02 §Tag:
      // "tags should target the DATA attestation UID rather than the Anchor UID").
      // If no DATA is loaded for this anchor, treat as no-match; do NOT fall back
      // to the anchor UID (that would silently accept tags meant for different semantics).
      const dataUIDs = dataUIDMap.get(anchorUID);
      if (!dataUIDs || dataUIDs.size === 0) return false;
      return [...dataUIDs].some(uid => uidSet.has(uid));
    }
    return uidSet.has(anchorUID);
  };

  const items = rawItems?.filter((item: any) => {
    if (tagFilteredUIDs !== null && !matchesUID(item, tagFilteredUIDs)) return false;
    if (tagExcludedUIDs.size > 0 && matchesUID(item, tagExcludedUIDs)) return false;
    return true;
  });

  // Hide system files (Task 14) unless the user opted in. Applied as a final,
  // independent pass after the descriptive-label tag filter above — system
  // membership comes from the `/tags/system` set (systemSet, anchor-target,
  // kernel-active), NOT from drawerTagFilters/matchesUID. Everything downstream
  // (sortedItems, fileItems, the rendered grid, empty-state, pagination) reads
  // visibleItems so the toggle composes with sort/tag-filter rather than
  // fighting them.
  const visibleItems = showSystemFiles ? items : items?.filter((it: any) => !systemSet.has(it.uid.toLowerCase()));

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
    if (!visibleItems) return visibleItems;

    // Client-side preview sort: use locally-fetched sort keys
    if (isPreviewSort && previewSortKeys.size > 0 && (!sortedUIDs || sortedUIDs.length === 0)) {
      const dir = reverseOrder ? -1 : 1;
      return [...visibleItems].sort((a: any, b: any) => {
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
    if (!sortedUIDs) return visibleItems;
    const sortIndexMap = new Map(sortedUIDs.map((uid, idx) => [uid.toLowerCase(), idx]));
    const dir = reverseOrder ? -1 : 1;
    return [...visibleItems].sort((a: any, b: any) => {
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
    setSelectedList(null);
    setFileContent(null);
    setFileContentType(null);
    setFetchError(null);
    setPreviewFullscreen(false);
  };

  // File-only items for gallery navigation
  const fileItems =
    (sortedItems ?? visibleItems)?.filter(
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

  // Delete a file/folder by revoking the connected user's edges (ADR-0041 — PIN+TAG split).
  // File: revoke the user's PIN(definition=fileAnchorUID, target=DATA_UID, schema=DATA_SCHEMA).
  //   File placement is now PIN cardinality 1, so there's at most one PIN per file per user.
  //   Removes the file from this lens's view; other lenses with their own PIN are unaffected.
  //   DATA is permanent (ADR-0002).
  // Folder: full subtree cascade. Walks the folder and every subfolder, revoking
  //   (a) the user's visibility TAG on each folder (definition=dataSchemaUID, target=folder)
  //   and (b) the user's file placement PINs on every file child at any depth. Cascading
  //   prevents orphaned file placements (files invisible in the folder listing but still
  //   discoverable via "what files has this user placed?" queries).
  // AGENT-NOTE: PINs and TAGs live under different EAS schemas, so revoke() must be issued
  // per-schema. Returned arrays are kept separate; executeRevokesBySchema groups them.
  const collectUserFilePlacementPins = async (fileAnchorUID: `0x${string}`): Promise<`0x${string}`[]> => {
    if (!publicClient || !edgeResolverAddress || !connectedAddress || !dataSchemaUID) return [];
    // PIN cardinality 1: at most one active PIN per (attester, fileAnchorUID, DATA_SCHEMA).
    const slot = (await publicClient.readContract({
      address: edgeResolverAddress,
      abi: EDGE_RESOLVER_ABI,
      functionName: "getActivePinSlot",
      args: [fileAnchorUID, connectedAddress as `0x${string}`, dataSchemaUID as `0x${string}`],
    })) as { pinUID: `0x${string}`; targetID: `0x${string}` };
    if (slot.pinUID && slot.pinUID !== zeroHash) return [slot.pinUID];
    return [];
  };

  // A LIST is placed like a file — `Anchor(anchorType=LIST_SCHEMA_UID) ← PIN ← LIST`
  // (ADR-0044 §1) — so a folder cascade must revoke the user's list placement PIN too,
  // or the list resurrects when the folder/anchor is re-shown. PIN cardinality 1: at most
  // one active PIN per (attester, listAnchorUID, LIST_SCHEMA). Same PIN schema as files,
  // so the UID joins the file pins in `pinUIDs`.
  const collectUserListPlacementPin = async (listAnchorUID: `0x${string}`): Promise<`0x${string}`[]> => {
    if (!publicClient || !edgeResolverAddress || !connectedAddress || !listSchemaUID) return [];
    const slot = (await publicClient.readContract({
      address: edgeResolverAddress,
      abi: EDGE_RESOLVER_ABI,
      functionName: "getActivePinSlot",
      args: [listAnchorUID, connectedAddress as `0x${string}`, listSchemaUID as `0x${string}`],
    })) as { pinUID: `0x${string}`; targetID: `0x${string}` };
    if (slot.pinUID && slot.pinUID !== zeroHash) return [slot.pinUID];
    return [];
  };

  // Recursively walks the subtree rooted at `rootFolderUID`, paginating getDirectoryPage (500/page).
  // Returns every PIN/TAG UID the connected user would need to revoke to remove their visibility:
  //   - PINs: file placements the user authored at any depth (cardinality 1, schema=PIN)
  //   - TAGs: the visibility tag the user authored on the root folder and every subfolder (cardinality N, schema=TAG)
  // Skips `tagsRoot` and `sortsAnchorUID` (system anchors — never touch).
  const scanSubtree = async (
    rootFolderUID: `0x${string}`,
  ): Promise<{ pinUIDs: `0x${string}`[]; tagUIDs: `0x${string}`[]; folderCount: number; fileCount: number }> => {
    if (
      !publicClient ||
      !edgeResolverAddress ||
      !connectedAddress ||
      !dataSchemaUID ||
      !efsFileViewInfo ||
      !tagSchemaUID
    ) {
      throw new Error("Not ready — reconnect wallet and try again.");
    }
    // Lists supported (ListReader deployed) but LIST_SCHEMA_UID hasn't loaded yet: scanning now
    // would walk LIST anchors as plain subfolders and silently omit the user's LIST placement
    // PINs from the cascade — so revoking only the folder visibility TAG would leave those PINs
    // active, and re-showing the folder later would resurrect the lists (contradicting the
    // cascade's contract). Fail the scan rather than under-collect. Gated on listReaderAddress so
    // deployments without Lists (no ListReader → listSchemaUID never resolves) are unaffected.
    if (listReaderAddress && !listSchemaUID) {
      throw new Error("List schema still loading — try the delete again in a moment.");
    }
    const me = connectedAddress as `0x${string}`;
    const dataSchema = dataSchemaUID as `0x${string}`;
    const propertySchema = (propertySchemaUID as `0x${string}` | undefined) ?? zeroHash;
    const pinUIDs: `0x${string}`[] = [];
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
      // AGENT-NOTE (ADR-0041): visibility is TAG-only — getActiveEdgeUID with TAG_SCHEMA_UID.
      const visibilityTagUID = (await publicClient.readContract({
        address: edgeResolverAddress,
        abi: EDGE_RESOLVER_ABI,
        functionName: "getActiveEdgeUID",
        args: [me, folder, dataSchema, tagSchemaUID as `0x${string}`],
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
            // File anchor — collect placement PINs under this file.
            fileCount += 1;
            const childPins = await collectUserFilePlacementPins(childUID);
            pinUIDs.push(...childPins);
          } else if (listSchemaUID && schema === (listSchemaUID as string).toLowerCase()) {
            // List anchor — placed like a file (not a folder). Collect the user's list
            // placement PIN and do NOT recurse (a list anchor has no folder children).
            fileCount += 1;
            const listPins = await collectUserListPlacementPin(childUID);
            pinUIDs.push(...listPins);
          } else {
            // Subfolder — queue for recursion.
            queue.push(childUID);
          }
        }

        if (BigInt(children.length) < PAGE) break;
        start += PAGE;
      }
    }

    return { pinUIDs, tagUIDs, folderCount, fileCount };
  };

  // Revoke a batch of edge UIDs grouped by schema. Each multiRevoke call carries one schema's
  // chunk (max CHUNK_SIZE entries) — EAS requires the schema to match the attestation.
  const executeRevokesBySchema = async (
    edgesBySchema: { schema: `0x${string}`; uids: `0x${string}`[]; label: string }[],
    ops: ReturnType<typeof useBackgroundOps.getState>,
    opId: string,
  ) => {
    if (!publicClient) return;
    const CHUNK_SIZE = 50;
    const total = edgesBySchema.reduce((acc, g) => acc + g.uids.length, 0);
    if (total === 0) return;
    let done = 0;
    for (const group of edgesBySchema) {
      for (let i = 0; i < group.uids.length; i += CHUNK_SIZE) {
        const chunk = group.uids.slice(i, i + CHUNK_SIZE);
        ops.log(opId, `Revoking ${group.label}s ${done + 1}–${done + chunk.length} of ${total}...`);
        const txHash = await easWrite(
          {
            functionName: "multiRevoke",
            args: [[{ schema: group.schema, data: chunk.map(uid => ({ uid, value: 0n })) }]],
          },
          { silent: true },
        );
        if (txHash) await publicClient.waitForTransactionReceipt({ hash: txHash });
        done += chunk.length;
      }
    }
  };

  // Open a list: the grid item is the list-slot ANCHOR. Resolve its active PIN → the LIST UID
  // (the curator's placement), then show the pane against that LIST.
  const openList = async (item: any) => {
    if (!publicClient || !edgeResolverAddress || !listSchemaUID) return;
    setSelectedFile(null);
    const resolvePin = (attester: `0x${string}`) =>
      publicClient.readContract({
        address: edgeResolverAddress,
        abi: EDGE_RESOLVER_ABI,
        functionName: "getActivePinTarget",
        args: [item.uid as `0x${string}`, attester, listSchemaUID as `0x${string}`],
      }) as Promise<`0x${string}`>;
    try {
      // Resolve the placement through the SAME lens priority that made this card visible:
      // the connected user's own edition first (if any), then the active `lensAddresses` in
      // order — any of which may be the lens whose placement qualified this anchor (e.g. Bob
      // reusing Alice's list anchor in a ?lenses=bob view) — then the anchor creator as a
      // final fallback. Probing only connected+creator would open the wrong LIST or report
      // it missing when a requested lens is what surfaced the card.
      const candidates: `0x${string}`[] = [];
      const pushAttester = (a?: string) => {
        if (!a) return;
        const lc = a.toLowerCase();
        if (!candidates.some(c => c.toLowerCase() === lc)) candidates.push(a as `0x${string}`);
      };
      if (connectedAddress) pushAttester(connectedAddress);
      lensAddresses.forEach(pushAttester);
      pushAttester(item.attester);

      let listUID: `0x${string}` = zeroHash;
      let resolvedAttester: `0x${string}` = item.attester;
      for (const cand of candidates) {
        const uid = await resolvePin(cand);
        if (uid && uid !== zeroHash) {
          listUID = uid;
          resolvedAttester = cand;
          break;
        }
      }
      if (!listUID || listUID === zeroHash) {
        notification.error(
          "This list has no active placement here — it was deleted, or its creation was " +
            "interrupted before the placement landed. To restore it, create a list with the " +
            "same name in this folder; the existing slot is reused.",
        );
        return;
      }
      setSelectedList({ uid: listUID, anchorUID: item.uid, name: item.name, attester: resolvedAttester });
    } catch (e) {
      console.error("Failed to resolve list", e);
      notification.error("Could not open list.");
    }
  };

  // Delete a list = revoke its placement PIN (the anchor + LIST stay, exactly like deleting a
  // file revokes the PIN and leaves the DATA). Disappears from the folder.
  const deleteList = async (item: any) => {
    if (!publicClient || !edgeResolverAddress || !connectedAddress || !listSchemaUID || !pinSchemaUID) {
      notification.error("Not ready — reconnect wallet and try again.");
      return;
    }
    const ops = useBackgroundOps.getState();
    const opId = ops.start(`Delete list: ${item.name || "list"}`);
    try {
      ops.log(opId, "Locating placement PIN...");
      const slot = (await publicClient.readContract({
        address: edgeResolverAddress,
        abi: EDGE_RESOLVER_ABI,
        functionName: "getActivePinSlot",
        args: [item.uid as `0x${string}`, connectedAddress as `0x${string}`, listSchemaUID as `0x${string}`],
      })) as { pinUID: `0x${string}`; targetID: `0x${string}` };
      if (!slot || slot.pinUID === zeroHash) {
        throw new Error("You have no active placement on this list — nothing to delete.");
      }
      await executeRevokesBySchema(
        [{ schema: pinSchemaUID as `0x${string}`, uids: [slot.pinUID], label: "PIN" }],
        ops,
        opId,
      );
      ops.complete(opId, `Deleted list "${item.name || ""}".`);
      // Suppress the now-unplaced anchor locally — the standard getDirectoryPage still
      // returns it (the anchor is permanent), which would leave a dead card.
      setDeletedListAnchors(prev => new Set(prev).add((item.uid as string).toLowerCase()));
      if (selectedList?.anchorUID === item.uid) closePreview();
      if (useLensesQuery) await refetchLensListItems();
      else await refetchStandardItems();
    } catch (e: any) {
      ops.fail(opId, e?.shortMessage ?? e?.message ?? "Delete failed");
      notification.error(e?.shortMessage ?? e?.message ?? "Could not delete list.");
    }
  };

  const handleDelete = async (item: any, isItemFile: boolean) => {
    if (!publicClient || !edgeResolverAddress || !connectedAddress || !dataSchemaUID || !pinSchemaUID) {
      notification.error("Not ready — reconnect wallet and try again.");
      return;
    }
    if (!isItemFile) {
      // Folder → open confirm dialog and scan.
      setDeleteConfirm({ item, status: "scanning", pinUIDs: [], tagUIDs: [], folderCount: 0, fileCount: 0 });
      try {
        const scan = await scanSubtree(item.uid as `0x${string}`);
        setDeleteConfirm(prev =>
          prev && prev.item.uid === item.uid
            ? {
                ...prev,
                status: "ready",
                pinUIDs: scan.pinUIDs,
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
      ops.log(opId, "Locating placement PIN...");
      const placementPins = await collectUserFilePlacementPins(item.uid as `0x${string}`);
      if (placementPins.length === 0) {
        throw new Error("You have no active placement on this file — nothing to delete.");
      }
      await executeRevokesBySchema(
        [{ schema: pinSchemaUID as `0x${string}`, uids: placementPins, label: "PIN" }],
        ops,
        opId,
      );
      ops.complete(opId, `Deleted ${label}.`);
      if (selectedFile?.uid === item.uid) closePreview();
      if (useLensesQuery) {
        await refetchLensItems();
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
    if (!pinSchemaUID || !tagSchemaUID) {
      notification.error("Schema UIDs not loaded yet — try again in a moment.");
      return;
    }
    const { item, pinUIDs, tagUIDs } = deleteConfirm;
    const label = item.name || "folder";
    const total = pinUIDs.length + tagUIDs.length;
    if (total === 0) {
      notification.info(`Nothing of yours to delete in "${label}". Anchors are permanent.`);
      setDeleteConfirm(null);
      return;
    }
    setDeleteConfirm({ ...deleteConfirm, status: "revoking" });
    const ops = useBackgroundOps.getState();
    const opId = ops.start(`Delete folder: ${label}`);
    try {
      await executeRevokesBySchema(
        [
          { schema: pinSchemaUID as `0x${string}`, uids: pinUIDs, label: "PIN" },
          { schema: tagSchemaUID as `0x${string}`, uids: tagUIDs, label: "TAG" },
        ],
        ops,
        opId,
      );
      ops.complete(
        opId,
        `Deleted ${label} — revoked ${pinUIDs.length} PIN${pinUIDs.length === 1 ? "" : "s"} and ${tagUIDs.length} TAG${tagUIDs.length === 1 ? "" : "s"}.`,
      );
      if (selectedFile?.uid === item.uid) closePreview();
      if (useLensesQuery) {
        await refetchLensItems();
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
      <div className={`${selectedFile || selectedList ? "flex-1 min-w-0" : "w-full"} overflow-y-auto`}>
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
          {(sortedItems ?? visibleItems)
            ?.filter(
              (item: any) =>
                (isTopic(item) || isFile(item, dataSchemaUID) || isList(item, listSchemaUID)) &&
                item.uid !== tagsRoot &&
                item.uid !== sortsAnchorUID &&
                // Local delete-suppression applies ONLY to the standard unscoped view, where the
                // permanent list anchor reappears via getDirectoryPage after you revoke your PIN.
                // In a ?lenses= view the lens query is authoritative — if it still returns the card,
                // another requested lens actively places the same anchor, so suppressing it would
                // wrongly hide that lens's list until navigation. deleteList() only revokes YOUR PIN.
                (useLensesQuery || !deletedListAnchors.has((item.uid as string)?.toLowerCase())),
            )
            .map((item: any) => {
              // isTopic = generic anchor (folder) · isFile = DATA anchor · isList = LIST anchor (ADR-0044 §1)
              const isItemTopic = isTopic(item);
              const isItemFile = isFile(item, dataSchemaUID);
              const isItemList = isList(item, listSchemaUID);
              const isSelected = isItemList ? selectedList?.anchorUID === item.uid : selectedFile?.uid === item.uid;

              return (
                <div
                  key={item.uid}
                  className={`card bg-base-100 shadow-xl group relative hover:bg-base-200 transition-all duration-200 ${isSelected ? "ring-2 ring-primary bg-primary/10" : ""}`}
                  onClick={() => {
                    if (isItemTopic) onNavigate(item.uid, item.name);
                    else if (isItemFile) {
                      setSelectedFile(item);
                      fetchFileContent(item);
                    } else if (isItemList) openList(item);
                  }}
                >
                  {/* Actions — visible on hover */}
                  <div className="absolute top-1.5 right-1.5 flex gap-0.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!isItemList && (
                      <>
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
                      </>
                    )}
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
                        if (isItemList) deleteList(item);
                        else handleDelete(item, isItemFile);
                      }}
                      title={isItemList ? "Delete list" : isItemFile ? "Delete file" : "Delete folder"}
                    >
                      <TrashIcon className="w-3.5 h-3.5 text-base-content/50 hover:text-error" />
                    </button>
                  </div>

                  <div className="card-body items-center text-center p-4 pt-6 cursor-pointer">
                    <div>
                      {isItemTopic ? (
                        <FolderIcon className="w-10 h-10 text-yellow-500" />
                      ) : isItemList ? (
                        <QueueListIcon className="w-10 h-10 text-purple-500" />
                      ) : (
                        <DocumentIcon className="w-10 h-10 text-blue-500" />
                      )}
                    </div>
                    <h2 className="card-title text-sm break-all text-center leading-tight">{item.name || "Unnamed"}</h2>
                    <div className="text-xs text-base-content/40">
                      {isItemList
                        ? "List"
                        : isItemTopic
                          ? useLensesQuery
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

          {(sortedItems ?? visibleItems)?.length === 0 && (
            <div className="col-span-full text-center text-gray-500">
              {tagFilteredUIDs !== null
                ? `No items match tag filter: "${tagFilter}"`
                : tagExcludedUIDs.size > 0
                  ? "All items hidden by active exclusion filter"
                  : "Topic is empty"}
            </div>
          )}
        </div>
        {/* Load more: lens-scoped mode keys on the opaque cursor (ADR-0036);
            standard mode keys on the kernel page heuristic + sort overlay. */}
        {(() => {
          const showLoadMore = useLensesQuery
            ? hasMoreLenses || hasMoreLensList
            : items && items.length > 0 && items.length >= Number(pageSize);
          if (!showLoadMore) return null;
          return (
            <div className="flex justify-center py-4">
              <button
                className="btn btn-sm btn-outline"
                onClick={() => {
                  if (useLensesQuery) {
                    // Iterate the opaque cursor via the hook; `pageSize` is the
                    // per-fetch target, not a cumulative cap. Advance BOTH the
                    // file/folder walk and the list-anchor walk — either may have
                    // more pages (a folder can have more lists than files, or vice versa).
                    if (hasMoreLenses) loadMoreLenses();
                    if (hasMoreLensList) loadMoreLensList();
                  } else {
                    setPageSize(prev => prev + 50n);
                    if (hasSortMore) loadMoreSorted();
                  }
                }}
              >
                Load more
              </button>
            </div>
          );
        })()}
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
          {!selectedFile.isFolder && <MirrorsPanel fileAnchorUID={selectedFile.uid} lensAddresses={lensAddresses} />}
        </div>
      )}

      {/* List Preview Side Pane */}
      {selectedList && !selectedFile && (
        <ListPreviewPane
          uid={selectedList.uid}
          name={selectedList.name}
          attester={selectedList.attester}
          onClose={closePreview}
          connectedAddress={connectedAddress}
        />
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
          lensAddresses={lensAddresses}
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

            {deleteConfirm.status !== "scanning" &&
              (() => {
                const totalEdges = deleteConfirm.pinUIDs.length + deleteConfirm.tagUIDs.length;
                const txCount =
                  Math.ceil(deleteConfirm.pinUIDs.length / 50) + Math.ceil(deleteConfirm.tagUIDs.length / 50);
                return (
                  <div className="mt-4 space-y-2 text-sm">
                    {deleteConfirm.error && <div className="text-error">{deleteConfirm.error}</div>}
                    {totalEdges === 0 ? (
                      <div className="text-base-content/70">
                        Nothing of yours to delete here. Anchors are permanent, and this folder contains no file
                        placements or visibility tags you authored.
                      </div>
                    ) : (
                      <>
                        <div>
                          This will revoke{" "}
                          <span className="font-semibold text-error">
                            {deleteConfirm.pinUIDs.length} PIN{deleteConfirm.pinUIDs.length === 1 ? "" : "s"} and{" "}
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
                          Batched in chunks of 50 per transaction (one batch per schema) — expect {txCount} wallet
                          prompt{txCount === 1 ? "" : "s"}. Anchors themselves are permanent and cannot be deleted.
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

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
                disabled={
                  deleteConfirm.status !== "ready" || deleteConfirm.pinUIDs.length + deleteConfirm.tagUIDs.length === 0
                }
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
