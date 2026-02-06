"use client";

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
}: {
  uid: string;
  name: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  dataSchemaUID: string;
  propertySchemaUID: string;
  defaultOpen?: boolean;
  expandedUIDs?: Set<string>;
}) => {
  // Fetch children for this node
  // Note: This fetches purely to check for sub-topics.
  const { data: children } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [uid as `0x${string} `, 0n, 50n, dataSchemaUID as `0x${string} `, propertySchemaUID as `0x${string} `],
    watch: true,
  });

  const topics = children?.filter((item: any) => isTopic(item));

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
}: {
  rootUID: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  expandedUIDs?: Set<string>;
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
      />
    </ul>
  );
};
