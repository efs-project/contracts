"use client";

import { useState } from "react";
import { CreateItemModal, CreationType } from "./CreateItemModal";
import { SortDropdown } from "./SortDropdown";
import { DocumentPlusIcon, FolderPlusIcon, FunnelIcon, QueueListIcon } from "@heroicons/react/24/outline";
import type { ClassifiedContainer } from "~~/utils/efs/containers";
import { notification } from "~~/utils/scaffold-eth";

export type FileActionsBarProps = {
  currentAnchorUID: string | null;
  /** Top-level container — threaded into CreateItemModal for Address parent handling. */
  container?: ClassifiedContainer | null;

  anchorSchemaUID: string;
  dataSchemaUID: string;
  propertySchemaUID: string;
  // PIN/TAG schema split (ADR-0041): PIN is cardinality 1 (file placement, PROPERTY value
  // binding), TAG is cardinality N (descriptive labels, folder visibility).
  pinSchemaUID: string;
  tagSchemaUID: string;
  mirrorSchemaUID: string;

  indexerAddress?: `0x${string}`;
  easAddress?: `0x${string}`;
  sortOverlayAddress?: `0x${string}`;
  lensAddresses?: string[];

  activeSortInfoUID?: string | null;
  onSortChange?: (uid: string | null) => void;
  onSortProcessed?: () => void;
  reverseOrder?: boolean;
  onReverseOrderChange?: (reverse: boolean) => void;
  autoProcessKey?: number;
  autoProcessSortUIDs?: string[];

  isFilterDrawerOpen?: boolean;
  onToggleFilterDrawer?: () => void;

  // Show hidden/system files toggle (Task 14) — filtered out of the grid by default.
  showSystemFiles: boolean;
  onToggleSystemFiles: () => void;

  onFolderCreated?: (uid: string, name: string) => void;
  onFileCreated?: (enabledSortUIDs: string[]) => void;
  onListCreated?: (uid: string) => void;
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
  pinSchemaUID,
  tagSchemaUID,
  mirrorSchemaUID,
  indexerAddress,
  easAddress,
  sortOverlayAddress,
  lensAddresses,
  activeSortInfoUID,
  onSortChange,
  onSortProcessed,
  reverseOrder,
  onReverseOrderChange,
  autoProcessKey,
  autoProcessSortUIDs,
  isFilterDrawerOpen,
  onToggleFilterDrawer,
  showSystemFiles,
  onToggleSystemFiles,
  onFolderCreated,
  onFileCreated,
  onListCreated,
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
            lensAddresses={lensAddresses ?? []}
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
        <label className="label cursor-pointer gap-2 text-xs">
          <span className="opacity-70">Show hidden</span>
          <input
            type="checkbox"
            className="toggle toggle-xs"
            checked={showSystemFiles}
            onChange={onToggleSystemFiles}
          />
        </label>
      </div>

      {/* ADD dropdown — Folder/File/List require an anchor context */}
      <div className="dropdown dropdown-end flex-shrink-0">
        <div tabIndex={0} role="button" className="btn btn-sm btn-primary">
          + Add ▾
        </div>
        <ul
          tabIndex={0}
          className="dropdown-content menu menu-sm bg-base-100/90 rounded-box z-50 w-40 p-1 shadow-lg border border-primary"
        >
          <li>
            <button
              onClick={() => {
                if (!currentAnchorUID) {
                  notification.info("Open a folder first to add files or subfolders.");
                  return;
                }
                setCreationType("Folder");
              }}
            >
              <FolderPlusIcon className="w-4 h-4" /> Folder
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                if (!currentAnchorUID) {
                  notification.info("Open a folder first to add files or subfolders.");
                  return;
                }
                setCreationType("File");
              }}
            >
              <DocumentPlusIcon className="w-4 h-4" /> File
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                if (!currentAnchorUID) {
                  notification.info("Open a folder first to add a list.");
                  return;
                }
                setCreationType("List");
              }}
            >
              <QueueListIcon className="w-4 h-4" /> List
            </button>
          </li>
        </ul>
      </div>

      <CreateItemModal
        creationType={creationType}
        onClose={() => setCreationType(null)}
        currentAnchorUID={currentAnchorUID}
        container={container}
        anchorSchemaUID={anchorSchemaUID}
        dataSchemaUID={dataSchemaUID}
        propertySchemaUID={propertySchemaUID}
        pinSchemaUID={pinSchemaUID}
        tagSchemaUID={tagSchemaUID}
        mirrorSchemaUID={mirrorSchemaUID}
        indexerAddress={indexerAddress}
        easAddress={easAddress}
        sortOverlayAddress={sortOverlayAddress}
        lensAddresses={lensAddresses}
        onFolderCreated={onFolderCreated}
        onFileCreated={onFileCreated}
        onListCreated={onListCreated}
      />
    </div>
  );
};
