"use client";

import { useState } from "react";
import { CreateItemModal, CreationType } from "./CreateItemModal";
import { SortDropdown } from "./SortDropdown";
import { FunnelIcon } from "@heroicons/react/24/outline";
import type { ClassifiedContainer } from "~~/utils/efs/containers";

export type FileActionsBarProps = {
  currentAnchorUID: string | null;
  /** Top-level container — threaded into CreateItemModal for Address parent handling. */
  container?: ClassifiedContainer | null;

  anchorSchemaUID: string;
  dataSchemaUID: string;
  propertySchemaUID: string;
  tagSchemaUID: string;
  mirrorSchemaUID: string;

  indexerAddress?: `0x${string}`;
  easAddress?: `0x${string}`;
  sortOverlayAddress?: `0x${string}`;
  editionAddresses?: string[];

  activeSortInfoUID?: string | null;
  onSortChange?: (uid: string | null) => void;
  onSortProcessed?: () => void;
  reverseOrder?: boolean;
  onReverseOrderChange?: (reverse: boolean) => void;
  autoProcessKey?: number;
  autoProcessSortUIDs?: string[];

  isFilterDrawerOpen?: boolean;
  onToggleFilterDrawer?: () => void;

  onFolderCreated?: (uid: string, name: string) => void;
  onFileCreated?: (enabledSortUIDs: string[]) => void;
};

/**
 * Actions row rendered at the top of the file view. Replaces the old Toolbar.
 * Owns the Create flow via CreateItemModal.
 */
export const FileActionsBar = ({
  currentAnchorUID,
  container,
  anchorSchemaUID,
  dataSchemaUID,
  propertySchemaUID,
  tagSchemaUID,
  mirrorSchemaUID,
  indexerAddress,
  easAddress,
  sortOverlayAddress,
  editionAddresses,
  activeSortInfoUID,
  onSortChange,
  onSortProcessed,
  reverseOrder,
  onReverseOrderChange,
  autoProcessKey,
  autoProcessSortUIDs,
  isFilterDrawerOpen,
  onToggleFilterDrawer,
  onFolderCreated,
  onFileCreated,
}: FileActionsBarProps) => {
  const [creationType, setCreationType] = useState<CreationType | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-base-300/50">
      <div className="flex gap-2 items-center flex-grow min-w-0">
        {onSortChange && sortOverlayAddress && (
          <SortDropdown
            parentAnchor={currentAnchorUID ?? undefined}
            indexerAddress={indexerAddress}
            easAddress={easAddress}
            sortOverlayAddress={sortOverlayAddress}
            editionAddresses={editionAddresses ?? []}
            activeSortInfoUID={activeSortInfoUID ?? null}
            onSortChange={onSortChange}
            onProcessComplete={onSortProcessed}
            reverseOrder={reverseOrder}
            onReverseOrderChange={onReverseOrderChange}
            autoProcessKey={autoProcessKey}
            autoProcessSortUIDs={autoProcessSortUIDs}
            anchorSchemaUID={anchorSchemaUID}
          />
        )}
        {onToggleFilterDrawer && (
          <button
            className={`btn btn-sm btn-square ${isFilterDrawerOpen ? "btn-primary" : "btn-ghost"}`}
            onClick={onToggleFilterDrawer}
            title="Toggle tag filter drawer"
          >
            <FunnelIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex gap-2 items-center flex-shrink-0">
        <button className="btn btn-sm btn-ghost" onClick={() => setCreationType("Folder")} disabled={!currentAnchorUID}>
          New Folder
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setCreationType("File")} disabled={!currentAnchorUID}>
          Add File
        </button>
      </div>

      <CreateItemModal
        creationType={creationType}
        onClose={() => setCreationType(null)}
        currentAnchorUID={currentAnchorUID}
        container={container}
        anchorSchemaUID={anchorSchemaUID}
        dataSchemaUID={dataSchemaUID}
        propertySchemaUID={propertySchemaUID}
        tagSchemaUID={tagSchemaUID}
        mirrorSchemaUID={mirrorSchemaUID}
        indexerAddress={indexerAddress}
        easAddress={easAddress}
        sortOverlayAddress={sortOverlayAddress}
        editionAddresses={editionAddresses}
        onFolderCreated={onFolderCreated}
        onFileCreated={onFileCreated}
      />
    </div>
  );
};
