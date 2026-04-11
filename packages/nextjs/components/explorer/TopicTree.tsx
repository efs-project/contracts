"use client";

import { useRef } from "react";
import type { PathItem } from "./Toolbar";
import { FolderIcon } from "@heroicons/react/24/outline";
import { useSortedData } from "~~/hooks/efs/useSortedData";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { isTopic } from "~~/utils/efs/efsTypes";

const TreeNode = ({
  uid,
  name,
  selectedUID,
  onSelect,
  dataSchemaUID,
  propertySchemaUID,
  defaultOpen,
  expandedUIDs,
  editionAddresses,
  systemTagsUID,
  systemSortsUID,
  activeSortInfoUID,
  sortOverlayAddress,
  sortRefreshKey,
}: {
  uid: string;
  name: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  dataSchemaUID: string;
  propertySchemaUID: string;
  defaultOpen?: boolean;
  expandedUIDs?: Set<string>;
  editionAddresses: string[];
  /** UID of the system-managed "tags" anchor under root. Hidden from the sidebar. */
  systemTagsUID?: string;
  /** UID of the system-managed "sorts" anchor under root. Hidden from the sidebar. */
  systemSortsUID?: string;
  /** Active sort overlay UID (from ?sort= URL param). When set, tree nodes use sorted order. */
  activeSortInfoUID?: string | null;
  /** EFSSortOverlay contract address. Required when activeSortInfoUID is set. */
  sortOverlayAddress?: `0x${string}`;
  /** Incremented after processItems completes so useSortedData re-fetches. */
  sortRefreshKey?: number;
}) => {
  const hasEditions = editionAddresses && editionAddresses.length > 0;

  // Once we've ever had editions, stay locked to the editions query so that
  // the brief moment connectedAddress is undefined during account switch
  // doesn't flash the unfiltered standard query results.
  // BUT: when editionAddresses is empty (wallet disconnect, unresolved ENS), fall through
  // to the standard query rather than leaving both queries disabled and collapsing the tree.
  const lockedToEditions = useRef(false);
  if (hasEditions) lockedToEditions.current = true;
  const useEditionsQuery = (hasEditions || lockedToEditions.current) && editionAddresses.length > 0;

  const { data: standardChildren, isLoading: isStandardLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [uid as `0x${string}`, 0n, 50n, dataSchemaUID as `0x${string}`, propertySchemaUID as `0x${string}`],
    query: {
      enabled: !useEditionsQuery,
    },
  });

  const { data: editionChildrenRaw, isLoading: isEditionLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPageBySchemaAndAddressList",
    args: [uid as `0x${string}`, dataSchemaUID as `0x${string}`, editionAddresses as string[], 0n, 50n],
    query: {
      enabled: useEditionsQuery && editionAddresses.length > 0,
    },
  });

  const isLoading = useEditionsQuery ? isEditionLoading : isStandardLoading;
  const children = useEditionsQuery
    ? editionChildrenRaw
      ? (editionChildrenRaw as any)[0]
      : undefined
    : standardChildren;

  // Sorted UIDs from the sort overlay — only fetched when a sort is active
  const { sortedUIDs } = useSortedData({
    sortInfoUID: activeSortInfoUID ?? null,
    parentAnchor: uid,
    sortOverlayAddress,
    editionAddresses,
    refreshKey: sortRefreshKey,
  });

  // Hide system anchors by UID (not by name) so user-created folders with the same
  // names deeper in the hierarchy are still navigable.
  let topics = children?.filter(
    (item: any) => isTopic(item) && item.uid !== systemTagsUID && item.uid !== systemSortsUID,
  );

  if (topics) {
    if (activeSortInfoUID && sortedUIDs && sortedUIDs.length > 0) {
      // Sort overlay active: reorder topics by sorted UIDs, unsorted items at end
      const sortIndexMap = new Map(sortedUIDs.map((uid, idx) => [uid.toLowerCase(), idx]));
      topics = [...topics].sort((a: any, b: any) => {
        const ai = sortIndexMap.get(a.uid?.toLowerCase() ?? "");
        const bi = sortIndexMap.get(b.uid?.toLowerCase() ?? "");
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return (a.name ?? "").localeCompare(b.name ?? "");
      });
    } else {
      // No sort active or not yet processed: alphabetical
      topics = [...topics].sort((a: any, b: any) => (a.name ?? "").localeCompare(b.name ?? ""));
    }
  }

  if (isLoading) {
    return (
      <li className="py-1 px-2">
        <div className="flex items-center gap-2">
          <FolderIcon className="w-4 h-4 opacity-30" />
          <span className="loading loading-dots loading-xs opacity-40"></span>
        </div>
      </li>
    );
  }

  if (!topics || topics.length === 0) {
    return (
      <li className="py-1">
        <div
          className={`flex items-center gap-2 cursor-pointer transition-colors px-2 py-1 rounded-md ${
            selectedUID === uid ? "text-base-content bg-base-300 font-bold" : "text-base-content font-medium"
          }`}
          onClick={() => onSelect(uid, [{ uid, name }])}
        >
          <FolderIcon className="w-4 h-4" />
          <span className="truncate text-sm">{name}</span>
        </div>
      </li>
    );
  }

  return (
    <li>
      <details open={defaultOpen || (expandedUIDs && expandedUIDs.has(uid))}>
        <summary
          className={`list-none flex items-center gap-2 cursor-pointer transition-colors px-2 py-1 rounded-md ${
            selectedUID === uid ? "text-base-content bg-base-300 font-bold" : "text-base-content font-medium"
          }`}
          onClick={() => {
            onSelect(uid, [{ uid, name }]);
          }}
        >
          <FolderIcon className="w-4 h-4" /> {name}
        </summary>
        {topics && topics.length > 0 && (
          <ul className="pl-4 border-l border-base-300 ml-2 mt-1">
            {topics.map((child: any) => (
              <TreeNode
                key={child.uid}
                uid={child.uid}
                name={child.name}
                selectedUID={selectedUID}
                onSelect={(id, p) => onSelect(id, [{ uid, name }, ...p])}
                dataSchemaUID={dataSchemaUID}
                propertySchemaUID={propertySchemaUID}
                expandedUIDs={expandedUIDs}
                editionAddresses={editionAddresses}
                systemTagsUID={systemTagsUID}
                systemSortsUID={systemSortsUID}
                activeSortInfoUID={activeSortInfoUID}
                sortOverlayAddress={sortOverlayAddress}
                sortRefreshKey={sortRefreshKey}
              />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
};

export const TopicTree = ({
  rootUID,
  selectedUID,
  onSelect,
  expandedUIDs,
  editionAddresses,
  activeSortInfoUID,
  sortOverlayAddress,
  sortRefreshKey,
}: {
  rootUID: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  expandedUIDs?: Set<string>;
  editionAddresses: string[];
  /** Active sort overlay UID (from ?sort= URL param). When set, tree nodes use sorted order. */
  activeSortInfoUID?: string | null;
  /** EFSSortOverlay contract address. Required when activeSortInfoUID is set. */
  sortOverlayAddress?: `0x${string}`;
  /** Incremented after processItems completes so the tree's sorted data re-fetches. */
  sortRefreshKey?: number;
}) => {
  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });

  const { data: propertySchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });

  // Resolve the UID of the system "tags" anchor (one level below root) so we can
  // hide it by UID rather than by name — a name match would incorrectly hide any
  // user-created folder also named "tags" elsewhere in the hierarchy.
  const { data: systemTagsUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "resolvePath",
    args: [rootUID as `0x${string}`, "tags"],
  });

  const { data: systemSortsUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "sortsAnchorUID",
  });

  const { data: sortOverlayInfo } = useDeployedContractInfo({ contractName: "EFSSortOverlay" });
  const resolvedSortOverlayAddress = (sortOverlayAddress ?? sortOverlayInfo?.address) as `0x${string}` | undefined;

  if (!dataSchemaUID || !propertySchemaUID) return <span className="loading loading-dots loading-xs"></span>;

  return (
    <ul className="menu bg-base-100 w-full rounded-box">
      <TreeNode
        uid={rootUID}
        name="Root"
        selectedUID={selectedUID}
        onSelect={onSelect}
        dataSchemaUID={dataSchemaUID}
        propertySchemaUID={propertySchemaUID}
        defaultOpen={true}
        expandedUIDs={expandedUIDs}
        editionAddresses={editionAddresses}
        systemTagsUID={systemTagsUID as string | undefined}
        systemSortsUID={systemSortsUID as string | undefined}
        activeSortInfoUID={activeSortInfoUID}
        sortOverlayAddress={resolvedSortOverlayAddress}
        sortRefreshKey={sortRefreshKey}
      />
    </ul>
  );
};
