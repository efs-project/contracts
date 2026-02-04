import { PathItem } from "./Toolbar";
import { FolderIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const TreeNode = ({
  uid,
  name,
  selectedUID,
  onSelect,
  dataSchemaUID,
  propertySchemaUID,
  defaultOpen,
}: {
  uid: string;
  name: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  dataSchemaUID: string;
  propertySchemaUID: string;
  defaultOpen?: boolean;
}) => {
  // Fetch children for this node
  // Note: This fetches purely to check for subfolders.
  // Optimization: Only fetch if expanded? For now, simple.

  // We assume we want to show children if they are folders.
  // EFSFileView returns paginated list.
  const { data: children } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [uid as `0x${string}`, 0n, 50n, dataSchemaUID as `0x${string}`, propertySchemaUID as `0x${string}`],
    watch: true,
  });

  // Treat anything that doesn't have data as a Folder
  const folders = children?.filter((c: any) => !c.hasData);

  return (
    <li>
      <details open={defaultOpen}>
        <summary
          className={`${selectedUID === uid ? "active" : ""}`}
          onClick={e => {
            e.preventDefault();
            onSelect(uid, [{ uid, name }]);
          }}
        >
          <FolderIcon className="w-4 h-4" /> {name}
        </summary>
        {folders && folders.length > 0 && (
          <ul>
            {folders.map((folder: any) => (
              <TreeNode
                key={folder.uid}
                uid={folder.uid}
                name={folder.name}
                selectedUID={selectedUID}
                onSelect={(id, p) => onSelect(id, [{ uid, name }, ...p])}
                dataSchemaUID={dataSchemaUID}
                propertySchemaUID={propertySchemaUID}
              />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
};

export const FileTree = ({
  rootUID,
  selectedUID,
  onSelect,
}: {
  rootUID: string;
  selectedUID: string | null;
  onSelect: (uid: string, path: PathItem[]) => void;
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
      />
    </ul>
  );
};
