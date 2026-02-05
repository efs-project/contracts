"use client";

import { useState } from "react";
import Link from "next/link";
import { PropertiesModal } from "./PropertiesModal";
import { zeroHash } from "viem";
import {
  DocumentIcon,
  FolderIcon,
  InformationCircleIcon,
  Square2StackIcon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";
import { isTopic, isFile } from "~~/utils/efs/efsTypes";
export const FileBrowser = ({
  currentAnchorUID,
  dataSchemaUID,
  onNavigate,
}: {
  currentAnchorUID: string | null;
  dataSchemaUID: string;
  onNavigate: (uid: string, name: string) => void;
}) => {
  const [selectedDebugItem, setSelectedDebugItem] = useState<any | null>(null);
  const [propertiesModalUID, setPropertiesModalUID] = useState<string | null>(null);

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
                    // Files are not navigation targets (yet).
                    // Maybe open a preview or show a toast?
                    console.log("File Selected:", item.name);
                    notification.info(`File: ${item.name} (Preview coming soon)`);
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
