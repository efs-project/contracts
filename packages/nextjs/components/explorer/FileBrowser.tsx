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
  ArrowDownTrayIcon,
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
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { isFile, isList, isTopic } from "~~/utils/efs/efsTypes";
import { computeExcludesPending, tagsRootGateDecision } from "~~/utils/efs/excludeFilter";
import { clearFetchFileContentCache, fetchFileContent as fetchFileContentUtil } from "~~/utils/efs/fetchFileContent";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { TRANSPORT_LABELS } from "~~/utils/efs/transports";
import { safeDownloadName } from "~~/utils/markdown/downloadName";
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
  onNavigate,
  tagFilter = "",
  drawerTagFilters = {},
  activeSortInfoUID = null,
  sortOverlayAddress,
  sortRefreshKey = 0,
  directoryRefreshKey = 0,
  excludeRefreshKey = 0,
  reverseOrder = false,
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  /** ANCHOR_SCHEMA_UID from EFSIndexer — needed to query folder-level descriptive-label TAG buckets. */
  anchorSchemaUID?: string;
  currentPathNames: string[];
  lensAddresses: string[];
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
   * in-component and calls `refetchLensItems` inline; this key is the parallel
   * escape hatch for create.
   *
   * Each bump triggers exactly one refetch of whichever query is active
   * (lens-scoped or standard). Initial mount is skipped — the hooks fetch
   * on their own when deps settle.
   */
  directoryRefreshKey?: number;
  /** Bumped by an Overview save to re-resolve exclude tag defs (the save may create
   *  /tags/system on the fly). Drives the tagsRoot + exclude resolvers only — NOT
   *  the parent-driven directory refetch — so it can't race an unfiltered read. */
  excludeRefreshKey?: number;
  reverseOrder?: boolean;
}) => {
  const [selectedDebugItem, setSelectedDebugItem] = useState<any | null>(null);
  const [propertiesModalUID, setPropertiesModalUID] = useState<string | null>(null);
  const [tagModalUID, setTagModalUID] = useState<string | null>(null);
  const [tagModalIsFile, setTagModalIsFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  // Raw fetched bytes, kept verbatim for downloads. The preview may decode these
  // to text/blob-URL (lossy for binary), so downloads must derive from here.
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const fetchIdRef = useRef(0);
  // Generation counter bumped on every chain switch (see the targetNetwork.id
  // reset effect below). Chain-scoped async resolvers capture this at request
  // time and discard their result if it no longer matches — so a resolver that
  // launched against the previous chain can't write that chain's
  // edgeResolverAddress/tagsRoot back into state after the switch. Makes the
  // chain change atomic for the resolvers, not just for the synchronous reset.
  const chainGenRef = useRef(0);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [fileTransportType, setFileTransportType] = useState<string>("onchain");
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  // Per-fetch page target. Constant since the lens load-more iterates the opaque
  // cursor (ADR-0036) rather than growing a page size (the old standard-path
  // load-more that incremented this was removed with the unfiltered fallback).
  const pageSize = 50n;

  // Tag filter state: null = no filter active; Set<string> = allowed DATA/anchor UIDs
  const [tagFilteredUIDs, setTagFilteredUIDs] = useState<Set<string> | null>(null);
  // EXCLUDE filtering is applied on-chain (ADR-0054): the active exclude tags'
  // definition UIDs are resolved below and passed to `getDirectoryPageFiltered`,
  // so the lens-scoped listing comes back already filtered. No client-side
  // exclude scan / exclude UID set is kept.
  const [excludeTagDefUIDs, setExcludeTagDefUIDs] = useState<`0x${string}`[]>([]);
  // True once the exclude-def-UID resolver effect below has finished resolving
  // the currently-active exclude tag names — even if the resolved set is empty
  // because the defs don't exist yet. Starts false and is re-gated false on every
  // resolution restart (drawer exclude set / lenses / tagsRoot / tagFilterVersion
  // change). Used to HOLD the lens directory fetch until the real def UIDs are
  // known, so a fresh mount doesn't take the UNFILTERED branch and briefly flash
  // `system`/`nsfw` items before a self-correcting refetch (SHOULD-FIX 1). The
  // empty-excludes case (no active exclude tags) is NOT gated by this — see
  // `excludesPending` below.
  const [excludeResolved, setExcludeResolved] = useState(false);
  const [isTagFilterLoading, setIsTagFilterLoading] = useState(false);
  // True while the dataUIDMap is being populated asynchronously.
  // Prevents showing unfiltered results during the brief window between tag resolution and map build.
  const [isDataUIDMapLoading, setIsDataUIDMapLoading] = useState(false);
  // Incremented whenever the user adds or removes a tag so the filter effect re-runs immediately.
  const [tagFilterVersion, setTagFilterVersion] = useState(0);
  const [edgeResolverAddress, setEdgeResolverAddress] = useState<`0x${string}` | null>(null);
  const [tagsRoot, setTagsRoot] = useState<`0x${string}` | null>(null);
  // True once the `/tags` lookup has SETTLED — either it resolved to a UID, or it
  // definitively resolved to absent (no `/tags` anchor on this deploy). Lets the
  // exclude gate distinguish "still loading, keep holding" from "no tags exist,
  // nothing to hide → release to the unfiltered read". Stays false on a hard RPC
  // error so we hold (leak-safe) rather than fall through to unfiltered.
  const [tagsRootSettled, setTagsRootSettled] = useState(false);
  // Bumped to retry exclude-def resolution after a transient failure. The catch
  // HOLDS the gate (never releases to an unfiltered read) and schedules a bounded
  // retry so a transient RPC blip self-heals without the directory wedging on
  // "Loading…" until a manual filter toggle.
  const [excludeRetry, setExcludeRetry] = useState(0);
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
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { address: connectedAddress } = useAccount();
  const { writeContractAsync: easWrite } = useScaffoldWriteContract("EAS");

  // On a network switch the chain-scoped tag-filter resolver state below was
  // resolved against the previous chain's Indexer/EdgeResolver. The `/tags` gate
  // (`if (tagsRoot) return`) never re-resolves once set, so without this reset a
  // hardhat <-> Sepolia switch reuses the old chain's `/tags` UID + edge-resolver
  // address while the directory reads follow the new chain — the exclude filter
  // then resolves empty/wrong and the listing falls back to unfiltered until a
  // reload. Keyed on targetNetwork.id so it clears only on an actual chain change.
  //
  // Clearing this state synchronously is necessary but NOT sufficient on its own:
  // a chain-scoped async resolver launched against the previous chain (the `/tags`
  // resolver below has no cancel guard) can still resolve AFTER this reset and
  // write the old chain's edgeResolverAddress/tagsRoot back. Bumping chainGenRef
  // makes those resolvers discard their stale result (they capture the gen at
  // request time). We also clear the selected file/list/preview/modal state and
  // bump fetchIdRef so any in-flight content fetch is invalidated — otherwise the
  // old chain's bytes/UIDs stay visible in the preview while the write panels act
  // against the newly-selected chain.
  useEffect(() => {
    clearFetchFileContentCache();
    chainGenRef.current += 1;
    fetchIdRef.current += 1;
    setTagsRoot(null);
    setTagsRootSettled(false);
    setEdgeResolverAddress(null);
    setExcludeResolved(false);
    setExcludeTagDefUIDs([]);
    setTagFilteredUIDs(null);
    setExcludeRetry(0);
    // Clear selection / preview / modal state so no old-chain bytes or UIDs remain
    // rendered after the switch.
    setSelectedFile(null);
    setSelectedList(null);
    setSelectedDebugItem(null);
    setPropertiesModalUID(null);
    setTagModalUID(null);
    setTagModalIsFile(false);
    setDeleteConfirm(null);
    setFileContent(null);
    setFileBytes(null);
    setFileContentType(null);
    setFetchError(null);
    setIsFileLoading(false);
    setPreviewFullscreen(false);
    // Client-side preview-sort state is chain-scoped too: previewCacheKey already
    // includes targetNetwork.id, but previewFetchKey/previewFetchRef do NOT, so
    // after a switch the preview effect can early-return on
    // `previewFetchRef.current === previewFetchKey` (the (anchor,sort,staleness)
    // tuple is chain-agnostic and unchanged when the same folder/sort exists on
    // both chains) before reading the chain-scoped cache or refetching — leaving
    // the previous chain's previewSortKeys/isPreviewSort applied to the new
    // chain's items whenever on-chain sortedUIDs is empty (Codex round 2,
    // FileBrowser.tsx:920). Clear all three here so the effect re-fetches against
    // the new chain instead of reusing stale keys. (Refs and the setters are
    // declared below; the effect body runs at commit time after all hooks
    // initialize, so the forward references resolve — same as setSelectedList.)
    previewFetchRef.current = null;
    setPreviewSortKeys(new Map());
    setIsPreviewSort(false);
  }, [targetNetwork.id]);

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
    chainId: targetNetwork.id,
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

  // Load EdgeResolver address and "tags" anchor UID once.
  // "tags" is a normal anchor under the file system root — discovered the same way
  // any folder is, via resolvePath. Tag definitions (e.g. "favorites") are its children.
  // `/tags` resolution is DECOUPLED from the EdgeResolver address: it only needs the
  // indexer (which we already have). The EdgeResolver address is used elsewhere
  // (include-tag + delete scans); a missing/unknown resolver must NOT wedge the
  // exclude gate. If we early-returned on `!addr`, `tagsRootSettled` would stay false
  // and the directory would hold "Loading…" forever; and releasing the gate there
  // would be worse — it would fall to an UNFILTERED lens read and leak system/nsfw.
  useEffect(() => {
    if (!publicClient || !indexerInfo) return;
    // Once `/tags` is found it's permanent — never re-resolve. But if `/tags`
    // itself was ABSENT at mount (a bare chain), an Overview save creates it on the
    // fly; re-run on `excludeRefreshKey` (bumped by that save) so tagsRoot is picked
    // up, which in turn re-runs the exclude resolver below. (When `/tags` already
    // exists but `/tags/system` doesn't — the real-deploy case — tagsRoot is
    // unchanged and the exclude resolver re-resolves directly off excludeRefreshKey.)
    if (tagsRoot) return;
    // Capture the chain generation at request time; a switch bumps chainGenRef,
    // so a result computed against the previous chain is discarded instead of
    // writing that chain's edgeResolverAddress/tagsRoot after the reset.
    const gen = chainGenRef.current;
    getEdgeResolverAddress(publicClient.chain.id).then(async addr => {
      if (gen !== chainGenRef.current) return;
      if (addr) setEdgeResolverAddress(addr);
      try {
        const fsRoot = (await publicClient.readContract({
          address: indexerInfo.address as `0x${string}`,
          abi: indexerInfo.abi,
          functionName: "rootAnchorUID",
        })) as `0x${string}`;
        if (gen !== chainGenRef.current) return;
        if (!fsRoot || fsRoot === zeroHash) {
          // No filesystem root → no `/tags`, nothing taggable. Settle as absent.
          setTagsRootSettled(true);
          return;
        }
        const tagsUID = (await publicClient.readContract({
          address: indexerInfo.address as `0x${string}`,
          abi: indexerInfo.abi,
          functionName: "resolvePath",
          args: [fsRoot, "tags"],
        })) as `0x${string}`;
        if (gen !== chainGenRef.current) return;
        if (tagsUID && tagsUID !== zeroHash) setTagsRoot(tagsUID);
        // Resolved either way (UID or absent) — settle so the exclude gate can
        // release instead of holding "Loading…" forever on a deploy without /tags.
        setTagsRootSettled(true);
      } catch (e) {
        // Hard RPC error — leave `tagsRootSettled` false so the exclude gate keeps
        // holding (leak-safe) rather than dropping to the unfiltered read.
        console.error("Resolving /tags anchor failed; tag filter unavailable", e);
      }
    });
  }, [publicClient, indexerInfo, excludeRefreshKey, tagsRoot]);

  // Resolve INCLUDE tag filter names → definition UIDs → tagged target sets.
  // Sources: tagFilter (URL, include), drawerTagFilters include entries.
  // EXCLUDE filtering is no longer resolved here — it is pushed on-chain via
  // `getDirectoryPageFiltered` (ADR-0054); see the `excludeTagDefUIDs` effect
  // below. This effect only scans full target sets for INCLUDE tags.
  useEffect(() => {
    const urlIncludeNames = tagFilter
      .split(",")
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    const drawerIncludeNames = Object.entries(drawerTagFilters)
      .filter(([, s]) => s === "include")
      .map(([name]) => name.toLowerCase());

    const includeNames = [...new Set([...urlIncludeNames, ...drawerIncludeNames])];

    if (includeNames.length === 0) {
      setTagFilteredUIDs(null);
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
        // Resolve each unique INCLUDE tag name's effective target set, then
        // intersect (an item must carry ALL include tags).
        const resolvedEntries = await Promise.all(
          includeNames.map(async name => [name, await resolveTagSet(name)] as const),
        );
        if (cancelled) return;
        const cache = new Map<string, Set<string>>(resolvedEntries);

        let intersection = cache.get(includeNames[0])!;
        for (let i = 1; i < includeNames.length; i++) {
          const s = cache.get(includeNames[i])!;
          intersection = new Set([...intersection].filter(uid => s.has(uid)));
        }
        setTagFilteredUIDs(intersection);
      } catch (e) {
        console.error("Tag filter resolution failed", e);
        if (!cancelled) {
          setTagFilteredUIDs(null);
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

  // Active EXCLUDE tag names from the drawer (e.g. the default {nsfw, system}).
  // Joined into a stable string so the resolver effect below only re-fires when
  // the SET of exclude tags changes — not on every drawer-object identity churn.
  const drawerExcludeNamesKey = useMemo(
    () =>
      Object.entries(drawerTagFilters)
        .filter(([, s]) => s === "exclude")
        .map(([name]) => name.toLowerCase())
        .sort()
        .join(","),
    [drawerTagFilters],
  );

  // Resolve the EXCLUDE tags' DEFINITION UIDs (ADR-0054). Unlike the INCLUDE
  // path we do NOT paginate each tag's full target set — the on-chain filter in
  // `getDirectoryPageFiltered` does the per-item exclusion. We only need the def
  // UID per active exclude tag. Def UIDs that resolve to zero (tag not yet
  // created under /tags/) are dropped. `minWeights` is all-zero, matching
  // ADR-0042's `weight >= 0` effective-TAG convention.
  useEffect(() => {
    const rawNames = drawerExcludeNamesKey ? drawerExcludeNamesKey.split(",") : [];
    // Order the system-managed safety excludes (system, nsfw) FIRST so the
    // MAX_EXCLUDE_TAGS cap below can never drop them in favor of user-added tags
    // that happen to sort earlier alphabetically — dropping a safety tag would
    // un-hide system/nsfw content despite its drawer toggle still being set to
    // exclude (Codex P2). drawerExcludeNamesKey is lowercased, so these match.
    const SAFETY_EXCLUDES = ["system", "nsfw"];
    const names = [
      ...rawNames.filter(n => SAFETY_EXCLUDES.includes(n)),
      ...rawNames.filter(n => !SAFETY_EXCLUDES.includes(n)),
    ];
    if (names.length === 0) {
      // No active exclude tags. Nothing to resolve — clear the def set and mark
      // resolved so the lens gate doesn't wait on a resolution that never runs
      // (would otherwise deadlock the empty-excludes case). The
      // `drawerExcludeNamesKey === ""` branch in the lens gate also covers this,
      // but keeping the flag truthful avoids a stale-false carrying over from a
      // prior non-empty exclude set.
      setExcludeTagDefUIDs([]);
      setExcludeResolved(true);
      return;
    }
    if (!publicClient || !indexerInfo || !tagsRoot) {
      if (tagsRootGateDecision(tagsRootSettled) === "release-empty") {
        // `/tags` resolution settled with no anchor — there are no def UIDs to
        // resolve, and an item can only be system/nsfw-tagged if its def anchor
        // exists under `/tags/`, so there is genuinely nothing to hide. Release
        // the gate to the unfiltered read instead of holding "Loading…" forever.
        setExcludeTagDefUIDs([]);
        setExcludeResolved(true);
        return;
      }
      // tagsRoot still loading → excludes are EXPECTED but not yet resolvable.
      // Keep `excludeResolved` false so the lens gate HOLDS the fetch instead of
      // taking the unfiltered branch and flashing system/nsfw. This effect
      // re-runs once tagsRoot (or its settled signal) lands.
      setExcludeResolved(false);
      return;
    }

    // Excludes are active and resolvable: (re)start resolution.
    setExcludeResolved(false);

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const resolved = await Promise.all(
          names.map(
            name =>
              publicClient.readContract({
                address: indexerInfo.address as `0x${string}`,
                abi: indexerInfo.abi,
                functionName: "resolvePath",
                args: [tagsRoot as `0x${string}`, name],
              }) as Promise<`0x${string}`>,
          ),
        );
        if (cancelled) return;
        const resolvedDefs = resolved.filter(uid => uid && uid !== zeroHash);
        // The contract caps `excludeTagDefs.length` at MAX_EXCLUDE_TAGS_PER_QUERY
        // (8) and reverts above it. The drawer lets users add arbitrary filters, so
        // cap here — otherwise 9+ active exclude tags would make every directory
        // read revert and leave the grid empty/stale (Codex P2). Apply a bounded
        // set + warn rather than fail the whole listing.
        const MAX_EXCLUDE_TAGS = 8;
        if (resolvedDefs.length > MAX_EXCLUDE_TAGS) {
          console.warn(
            `Active exclude tags (${resolvedDefs.length}) exceed the on-chain cap of ${MAX_EXCLUDE_TAGS}; ` +
              `only the first ${MAX_EXCLUDE_TAGS} are applied.`,
          );
        }
        const defs = resolvedDefs.slice(0, MAX_EXCLUDE_TAGS);
        // Stable-set comparison: only update state when the UID set actually
        // changed, so a re-resolve to the same defs doesn't restart the cursor.
        setExcludeTagDefUIDs(prev =>
          prev.length === defs.length && prev.every((u, i) => u === defs[i]) ? prev : defs,
        );
        // Resolution complete (defs known — possibly empty if the tags don't
        // exist under /tags/). Release the lens gate and reset the retry budget.
        setExcludeResolved(true);
        if (excludeRetry !== 0) setExcludeRetry(0);
      } catch (e) {
        console.error("Exclude tag def resolution failed", e);
        if (!cancelled) {
          // HOLD the gate — do NOT release to an unfiltered read. Excludes are
          // active (the drawer requested them), so releasing with empty defs would
          // run the unfiltered listing and leak system/nsfw. Leave `excludeResolved`
          // false so the directory keeps holding, and schedule a bounded retry so a
          // transient RPC blip self-heals (without retry it would wedge on
          // "Loading…" until a manual filter toggle, since folder navigation is not
          // a dep of this effect).
          if (excludeRetry < 3) retryTimer = setTimeout(() => setExcludeRetry(n => n + 1), 1500);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // `lensesKey` is deliberately NOT a dep: def UID resolution is lens-independent,
    // and including it re-ran this effect (flashing "Loading…") on every lens
    // change. The lens-scoped query refetches with the already-resolved defs via
    // its own `depsKey`.
    // `tagFilterVersion` IS a dep: a default-excluded tag whose DEFINITION doesn't
    // exist yet (e.g. `nsfw` on the seed, which only creates `/tags/system`)
    // resolves to nothing, so `excludeTagDefUIDs` omits it. When the user then
    // creates that definition via TagModal (`onTagChange` bumps tagFilterVersion)
    // without changing `drawerExcludeNamesKey`, we must re-resolve to pick up the
    // new def — otherwise the just-tagged item stays visible (Codex P2). The
    // stable-set comparison keeps this from restarting the cursor when the def set
    // is unchanged. `excludeRetry` re-runs a bounded post-error retry.
    // `excludeRefreshKey` re-runs after an Overview save that may have created
    // `/tags/system` even when `tagsRoot` is unchanged (the real-deploy case where
    // `/tags` exists but `/tags/system` is created on first save) — without it the
    // exclude defs stay stale and the new system README renders (Codex P2). This
    // sets excludeResolved=false (holds the directory) then re-resolves, so there's
    // no unfiltered flash.
  }, [
    drawerExcludeNamesKey,
    tagFilterVersion,
    publicClient,
    indexerInfo,
    tagsRoot,
    tagsRootSettled,
    excludeRetry,
    excludeRefreshKey,
  ]);

  // Parallel-array minWeights for getDirectoryPageFiltered — all 0n (ADR-0042
  // effective-TAG threshold `weight >= 0`). One entry per resolved exclude def.
  const excludeMinWeights = useMemo(() => excludeTagDefUIDs.map(() => 0n), [excludeTagDefUIDs]);

  // SHOULD-FIX 1: excludes are EXPECTED (the drawer has active exclude tags) but
  // their def UIDs haven't resolved yet. While true, HOLD the lens directory
  // (file/folder) fetch — otherwise its first fetch fires with an empty
  // `excludeTagDefUIDs`, takes the UNFILTERED
  // `getDirectoryPageBySchemaAndAddressList` branch, and briefly renders
  // system/nsfw items before the resolved def UIDs trigger a self-correcting
  // refetch. The empty-excludes case (`drawerExcludeNamesKey === ""`) is NOT
  // pending — there's nothing to resolve, so we never deadlock there.
  const excludesPending = computeExcludesPending(drawerExcludeNamesKey, excludeResolved);

  const fetchFileContent = async (item: any) => {
    if (!efsRouter) {
      notification.error("EFSRouter not found. Please deploy.");
      return;
    }
    // Increment fetch ID so any in-flight fetch from a previous file click becomes stale
    const fetchId = ++fetchIdRef.current;
    setIsFileLoading(true);
    setFileContent(null);
    setFileBytes(null);
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
        chainId: targetNetwork.id,
        routerAddress: efsRouter.address as `0x${string}`,
        routerAbi: efsRouter.abi as Abi,
        publicClient,
        lensAddresses,
        resourcePath: [...currentPathNames, item.name],
      });

      // Discard results from a superseded fetch (user clicked a different file).
      // This MUST come before any setState below — otherwise a slow fetch for File
      // A resolving after File B was clicked would still overwrite the transport
      // type with A's value (then bail), leaving B showing A's transport (Gemini).
      if (fetchId !== fetchIdRef.current) return;

      // External mirrors set a specific transport (ipfs/arweave/https/…); on-chain
      // bodies keep the default "onchain" set above. Matches the prior inline
      // setFileTransportType(detectTransport(externalUri)) behavior.
      if (transport !== "onchain") setFileTransportType(transport);

      const contentTypeStr = contentType ?? "text/plain";
      setFileContentType(contentTypeStr);
      setFileBytes(bytes);

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
      setFileBytes(null);
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
  const { sortedUIDs, isLoading: isSortLoading } = useSortedData({
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

  // sessionStorage key for preview sort cache: includes chain + anchor + sort + staleness count
  // so the cache is scoped per selected network (a chain switch can't reload another chain's
  // preview entry) and is automatically invalidated when new items are added (staleness changes).
  const previewCacheKey =
    activeSortInfoUID && currentAnchorUID
      ? `efs-preview:${targetNetwork.id}:${currentAnchorUID}:${activeSortInfoUID}:${activeSortStaleness?.toString() ?? "0"}`
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

  // Directory reads are ALWAYS lens-scoped — there is no unfiltered fallback.
  // The previous `EFSFileView.getDirectoryPage` path (used when `lensAddresses`
  // was empty) applied no exclusion filter and was the one read path that could
  // leak `system`/`nsfw` items. It was also dead in practice: `systemLenses`
  // always seeds at least the devnet constants, so `lensAddresses` is never
  // empty on the default path. Removed so that an empty lens list fails SAFE —
  // the lens hooks below are disabled (their `enabled` requires a non-empty
  // address list), the grid renders empty, and no unfiltered content is shown.
  // When mainnet introduces user-configurable lenses, the fix for "empty list"
  // is a FILTERED listing, not a return of this unfiltered call. (Was: ADR-0031
  // explicit-override + Codex P2 on PR #9 — the explicit-empty case already
  // resolves to an empty grid via the disabled lens hooks.)

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
    // EXCLUDE tags applied on-chain (ADR-0054). Empty array ⇒ unfiltered read.
    excludeTagDefs: excludeTagDefUIDs,
    minWeights: excludeMinWeights,
    // SHOULD-FIX 1: hold the fetch while excludes are expected but unresolved so
    // the unfiltered branch never runs on first mount (no system/nsfw flash).
    // Once resolved (with the real def UIDs, possibly empty), this re-enables and
    // the filtered read fires. Empty-excludes is never pending → not gated.
    // Empty `lensAddresses` (e.g. explicit `?lenses=` whose tokens all failed)
    // disables the fetch → empty grid, never an unfiltered fallback.
    enabled: lensAddresses.length > 0 && !excludesPending,
  });

  // Lens-scoped LIST anchors. Lists are placed as anchors with anchorType=LIST_SCHEMA_UID,
  // so the same schema-filtered directory walk surfaces them — just with the LIST schema.
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
    // Apply the SAME excludes here as the file/folder query. The LIST walk's
    // phase-0 returns the same generic qualifying folders, so without this an
    // excluded (system/nsfw-tagged) folder surfaced via LIST visibility would
    // re-enter the merged `rawItems` unfiltered. LIST anchors themselves carry no
    // descriptive tag and have no placement PIN, so getDirectoryPageFiltered still
    // passes them through per ADR-0054 — only phase-0 folders get filtered.
    excludeTagDefs: excludeTagDefUIDs,
    minWeights: excludeMinWeights,
    // Gate on `!excludesPending` symmetrically with the file/folder query above so
    // the merged page never renders half-resolved (list items present, file/folder
    // items still held) on first mount.
    enabled: lensAddresses.length > 0 && !!listSchemaUID && !excludesPending,
  });

  // Parent-driven refetch for out-of-component mutations (create file/folder).
  // Skip the initial render — the queries fire on their own when deps settle.
  // Subsequent bumps re-run both lens-scoped refetchers (file/folder + list).
  const firstRefreshRun = useRef(true);
  useEffect(() => {
    if (firstRefreshRun.current) {
      firstRefreshRun.current = false;
      return;
    }
    if (directoryRefreshKey === 0) return;
    clearFetchFileContentCache();
    if (selectedFile && !selectedFile.isFolder) {
      fetchFileContent(selectedFile).catch(e => console.error("Preview refetch after directory refresh failed", e));
    }
    // Only create/delete/list mutations bump directoryRefreshKey — they don't touch
    // /tags/system, so the exclude defs are never stale here and a normal refetch is
    // correct (and filtered, since excludeTagDefUIDs is already resolved). Overview
    // saves (which CAN create /tags/system) go through `excludeRefreshKey` →
    // the exclude resolver instead, which holds + re-resolves + drives a filtered
    // refetch via depsKey, so there's no unfiltered-flash race here.
    refetchLensItems().catch(e => console.error("Directory refetch (lenses) failed", e));
    refetchLensListItems().catch(e => console.error("List refetch (lenses) failed", e));
    // refetch* identities are stable per query. Intentionally scoped to the bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryRefreshKey]);

  const isLoading = isLensLoading;
  // When explicit-lenses requested an empty list (all tokens unresolved), the
  // lens hook is disabled and `lensItems` is undefined — without this
  // coercion, the grid would render neither items nor the "Topic is empty"
  // string (the empty-state check uses `items?.length === 0`, which is false
  // for undefined). Coerce to a stable `[]` so the user sees an explicit
  // empty result instead of a silently-blank pane. Memoized so downstream
  // effects that depend on `rawItems` identity don't refire every render.
  const rawItems = useMemo(() => {
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
  }, [lensAddresses.length, lensItems, lensListItems]);

  // When an INCLUDE tag filter is active, resolve DATA UIDs for each file item.
  // (EXCLUDE filtering is on-chain now — ADR-0054 — so the map is only needed to
  // back the client-side INCLUDE intersection in `matchesUID`.)
  // AGENT-NOTE (ADR-0041): file placement is now PIN (cardinality 1) — there's at
  // most one active DATA per (attester, anchor), so we use the O(1) `getActivePinTarget`
  // reader instead of the old TAG count → enumerate scan. We still build a Set per
  // anchor because multiple attesters can each have their own DATA at the same anchor.
  useEffect(() => {
    if (!tagFilteredUIDs || !rawItems || !publicClient || !edgeResolverAddress) {
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
  }, [tagFilteredUIDs, rawItems, publicClient, edgeResolverAddress, dataSchemaUID, connectedAddress, lensAddresses]);

  // Apply the INCLUDE tag filter. tagFilteredUIDs: item must be in set (null = no
  // filter). EXCLUDE filtering happens on-chain now (ADR-0054) — see
  // `excludeTagDefUIDs` → `getDirectoryPageFiltered`; nothing to do here.
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
    return true;
  });

  // `system`- and `nsfw`-tagged items are hidden ON-CHAIN (ADR-0054):
  // `drawerTagFilters` carries `{nsfw, system}: "exclude"` as permanent defaults,
  // their def UIDs flow into `excludeTagDefUIDs` → `getDirectoryPageFiltered`, so
  // `rawItems` already excludes them. Toggling `system` off in the Tag Filters
  // drawer drops it from `excludeTagDefUIDs` → the next fetch (cursor reset via
  // the hook's depsKey) returns the README again. No client-side exclude pass is
  // needed; downstream (sortedItems, fileItems, the grid, empty-state,
  // pagination) reads `visibleItems`.
  const visibleItems = items;

  // Close the side/fullscreen preview if a filter change or refetch removed the
  // open item from the visible (post-exclude) set — otherwise toggling `system`
  // back on (or applying an exclude tag) would leave a now-hidden file still
  // rendering in the preview, defeating the hide guarantee (Codex P2). Inlines the
  // reset (rather than calling `closePreview`, defined below) so this hook can sit
  // above the component's early returns, as rules-of-hooks requires.
  useEffect(() => {
    if (!visibleItems) return;
    const openUID = (
      (selectedFile?.uid as string | undefined) ?? (selectedList?.anchorUID as string | undefined)
    )?.toLowerCase();
    if (!openUID) return;
    const stillVisible = visibleItems.some((it: any) => (it.uid as string | undefined)?.toLowerCase() === openUID);
    if (!stillVisible) {
      setSelectedFile(null);
      setSelectedList(null);
      setFileContent(null);
      setFileBytes(null);
      setFileContentType(null);
      setFetchError(null);
      setPreviewFullscreen(false);
    }
  }, [visibleItems, selectedFile, selectedList]);

  // Keyboard handler ref — lets the useEffect stay above early returns while
  // the actual handler logic (which depends on computed values) is set later.
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!currentAnchorUID) return <div>Select a topic</div>;
  // `excludesPending` (SHOULD-FIX 1): the lens directory hook is held disabled
  // while exclude defs resolve, so it reports neither loading nor items — show
  // the loading state rather than a premature "Topic is empty" during the hold.
  if (isLoading || isTagFilterLoading || isDataUIDMapLoading || isSortLoading || excludesPending)
    return <div>Loading items...</div>;

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
    setFileBytes(null);
    setFileContentType(null);
    setFetchError(null);
    setPreviewFullscreen(false);
  };

  // Download the currently-previewed file from the raw fetched bytes — NOT from
  // the preview string, which is a lossy text/blob decode for anything binary.
  // Download-only anchor with a sanitized filename (anchor names are
  // attacker-controlled — strip bidi/path tricks). The minted URL is revoked.
  const handleDownload = () => {
    if (!fileBytes || !selectedFile) return;
    const href = URL.createObjectURL(new Blob([fileBytes], { type: fileContentType || "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = safeDownloadName(selectedFile.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
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
    // Capture the chain generation up front. openList closes over the old chain's
    // publicClient / edgeResolverAddress / listSchemaUID and awaits getActivePinTarget;
    // if the user switches networks mid-resolve, the reset effect bumps chainGenRef and
    // clears the pane, then this old-chain promise would otherwise restore an old-chain
    // LIST UID into setSelectedList (Codex round 2, FileBrowser.tsx:288). Re-check before
    // every state write below — same guard the /tags resolver uses.
    const gen = chainGenRef.current;
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
        // A chain switch during the resolve loop invalidates every remaining probe
        // (they ran against the old chain's edgeResolver) — stop and write nothing.
        if (gen !== chainGenRef.current) return;
        if (uid && uid !== zeroHash) {
          listUID = uid;
          resolvedAttester = cand;
          break;
        }
      }
      if (gen !== chainGenRef.current) return;
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
      if (selectedList?.anchorUID === item.uid) closePreview();
      await refetchLensListItems();
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
      clearFetchFileContentCache();
      if (selectedFile?.uid === item.uid) closePreview();
      await refetchLensItems();
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
      clearFetchFileContentCache();
      if (selectedFile?.uid === item.uid) closePreview();
      await refetchLensItems();
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
                item.uid !== sortsAnchorUID,
              // The lens query is authoritative: if it still returns a deleted list
              // card, another requested lens actively places the same anchor (your
              // deleteList() only revokes YOUR PIN), so it should stay visible. No
              // local delete-suppression — that only mattered for the removed
              // unscoped getDirectoryPage view where permanent anchors reappeared.
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
                      {isItemList ? "List" : isItemTopic ? "Folder" : "File"}
                    </div>
                  </div>
                </div>
              );
            })}

          {(sortedItems ?? visibleItems)?.length === 0 && (
            <div className="col-span-full text-center text-gray-500">
              {tagFilteredUIDs !== null
                ? `No items match tag filter: "${tagFilter}"`
                : excludeTagDefUIDs.length > 0
                  ? "All items hidden by active exclusion filter"
                  : "Topic is empty"}
            </div>
          )}
        </div>
        {/* Load more: lens-scoped reads iterate the opaque cursor (ADR-0036). */}
        {(() => {
          const showLoadMore = hasMoreLenses || hasMoreLensList;
          if (!showLoadMore) return null;
          return (
            <div className="flex justify-center py-4">
              <button
                className="btn btn-sm btn-outline"
                onClick={() => {
                  // Iterate the opaque cursor via the hook; `pageSize` is the
                  // per-fetch target, not a cumulative cap. Advance BOTH the
                  // file/folder walk and the list-anchor walk — either may have
                  // more pages (a folder can have more lists than files, or vice versa).
                  if (hasMoreLenses) loadMoreLenses();
                  if (hasMoreLensList) loadMoreLensList();
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
        <div className="preview-pane absolute inset-0 z-10 max-xl:bg-base-200 xl:static xl:w-[min(52vw,800px)] xl:flex-shrink-0 border-l border-base-300 flex flex-col overflow-hidden">
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
                onClick={handleDownload}
                disabled={!fileBytes}
                title="Download"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
              </button>
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
                <p className="text-xs opacity-70 break-all">{fetchError}</p>
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
                // Untrusted PDF bytes from a mirror, served through a blob: URL —
                // which would otherwise inherit the app's origin. Sandbox it for
                // the same reason as the HTML preview below: `allow-scripts` keeps
                // the browser's PDF viewer (incl. pdf.js, which needs JS) working,
                // but OMITTING `allow-same-origin` pins the frame to an opaque
                // origin so embedded PDF JS can't reach the parent app's DOM /
                // cookies / storage. A spoofed contentType only mislabels which
                // viewer renders here; it can't escalate to a same-origin script.
                <iframe
                  sandbox="allow-scripts"
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
              ) : fileContentType?.startsWith("text/html") || fileContentType === "application/xhtml+xml" ? (
                // Untrusted HTML from a mirror. `allow-scripts` runs JS + WASM, but
                // we deliberately OMIT `allow-same-origin`: that pairing lets the
                // framed content rewrite its own iframe and escape the sandbox.
                // Without it the iframe is an opaque origin — scripts run but can't
                // reach the parent app's DOM / cookies / storage.
                <iframe
                  sandbox="allow-scripts"
                  srcDoc={fileContent}
                  title={selectedFile.name}
                  className="w-full rounded border border-base-300 bg-white"
                  style={{ height: "60vh" }}
                />
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
            <MirrorsPanel
              fileAnchorUID={selectedFile.uid}
              lensAddresses={lensAddresses}
              onMirrorsChanged={() => {
                if (selectedFile && !selectedFile.isFolder) {
                  fetchFileContent(selectedFile).catch(e =>
                    console.error("Preview refetch after mirror change failed", e),
                  );
                }
              }}
            />
          )}
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
                  <p className="text-xs opacity-70 break-all">{fetchError}</p>
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
                  // Untrusted PDF bytes via blob: URL — sandboxed to an opaque
                  // origin (allow-scripts, no allow-same-origin), same as inline.
                  <iframe
                    sandbox="allow-scripts"
                    src={fileContent}
                    title={selectedFile.name}
                    className="rounded"
                    style={{ width: "90vw", height: "85vh" }}
                  />
                ) : fileContentType?.startsWith("video/") ? (
                  <video src={fileContent} controls className="max-w-[90vw] max-h-[85vh] object-contain" />
                ) : fileContentType?.startsWith("audio/") ? (
                  <audio src={fileContent} controls className="w-[60vw]" />
                ) : fileContentType?.startsWith("text/html") || fileContentType === "application/xhtml+xml" ? (
                  // Untrusted HTML — runs JS + WASM via allow-scripts, but no
                  // allow-same-origin (opaque origin; can't reach the parent app).
                  <iframe
                    sandbox="allow-scripts"
                    srcDoc={fileContent}
                    title={selectedFile.name}
                    className="rounded bg-white"
                    style={{ width: "90vw", height: "85vh" }}
                  />
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
          onTagChange={() => {
            setTagFilterVersion(v => v + 1);
            // Applying/revoking an EXCLUDED tag changes the on-chain filter result,
            // so the directory must re-query getDirectoryPageFiltered. The
            // tagFilterVersion bump only re-resolves the def UID *set* — when an
            // already-known def is applied the set is unchanged, so without an
            // explicit refetch the newly-hidden item would linger until navigation
            // (Codex P2). Refetch both lens queries; the include-filter path keys
            // off tagFilterVersion separately.
            refetchLensItems().catch(e => console.error("Directory refetch after tag change failed", e));
            refetchLensListItems().catch(e => console.error("List refetch after tag change failed", e));
          }}
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
