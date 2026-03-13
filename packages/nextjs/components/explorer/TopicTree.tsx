"use client";

import { useRef } from "react";
import type { PathItem } from "./Toolbar";
import { FolderIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
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
}) => {
  // Fetch children for this node
  // Note: This fetches purely to check for sub-topics.
  const hasEditions = editionAddresses && editionAddresses.length > 0;

  // Once we've ever had editions, stay locked to the editions query so that
  // the brief moment connectedAddress is undefined during account switch
  // doesn't flash the unfiltered standard query results.
  const lockedToEditions = useRef(false);
  if (hasEditions) lockedToEditions.current = true;
  const useEditionsQuery = hasEditions || lockedToEditions.current;

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
    functionName: "getDirectoryPageByAddressList",
    args: [uid as `0x${string}`, editionAddresses as string[], 0n, 50n],
    query: {
      enabled: useEditionsQuery,
    },
  });

  const isLoading = useEditionsQuery ? isEditionLoading : isStandardLoading;
  const children = useEditionsQuery
    ? editionChildrenRaw
      ? (editionChildrenRaw as any)[0]
      : undefined
    : standardChildren;

  const topics = children?.filter((item: any) => isTopic(item));

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
          {/* Spacer for alignment with details marker if needed, or just standard icon */}
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
            // Do NOT preventDefault, otherwise details won't toggle.
            // But we might want to manually manage it if we want separate select vs expand logic.
            // For now, let's allow both.
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
}: {
  rootUID: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  expandedUIDs?: Set<string>;
  editionAddresses: string[];
}) => {
  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });

  const { data: propertySchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });

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
      />
    </ul>
  );
};
