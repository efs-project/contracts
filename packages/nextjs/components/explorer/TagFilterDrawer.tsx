"use client";

import { useState } from "react";
import { MinusIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { DrawerTagFilterState } from "./FileBrowser";

interface TagFilterDrawerProps {
  tagFilters: Record<string, DrawerTagFilterState>;
  onUpdateFilter: (tagName: string, state: DrawerTagFilterState) => void;
  onAddTag: (tagName: string) => void;
  onRemoveTag: (tagName: string) => void;
}

export const TagFilterDrawer = ({ tagFilters, onUpdateFilter, onAddTag, onRemoveTag }: TagFilterDrawerProps) => {
  const [newTag, setNewTag] = useState("");

  const handleAddTag = () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    if (tagFilters[trimmed] !== undefined) return; // already in list
    onAddTag(trimmed);
    setNewTag("");
  };

  const tagEntries = Object.entries(tagFilters);

  return (
    <div className="w-[250px] min-w-[250px] border-l border-base-300 bg-base-100 flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-base-300">
        <h3 className="font-bold text-sm mb-2">Tag Filters</h3>
        <div className="flex gap-1">
          <input
            type="text"
            className="input input-bordered input-sm flex-grow min-w-0"
            placeholder="Add tag..."
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleAddTag();
            }}
          />
          <button className="btn btn-sm btn-primary btn-square" onClick={handleAddTag} disabled={!newTag.trim()}>
            <PlusIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tag List */}
      <div className="flex-grow overflow-y-auto p-2">
        {tagEntries.length === 0 ? (
          <p className="text-xs text-gray-400 text-center mt-4 italic">
            No tags added. Type a tag name above to start filtering.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tagEntries.map(([name, state]) => (
              <li key={name} className="flex items-center gap-1 bg-base-200 rounded px-2 py-1">
                {/* Exclude button */}
                <button
                  className={`btn btn-xs btn-square ${state === "exclude" ? "btn-error" : "btn-ghost"}`}
                  onClick={() => onUpdateFilter(name, state === "exclude" ? "neutral" : "exclude")}
                  title="Exclude files with this tag"
                >
                  <MinusIcon className="w-3 h-3" />
                </button>

                {/* Tag name */}
                <span className="flex-grow text-sm truncate px-1">{name}</span>

                {/* Include button */}
                <button
                  className={`btn btn-xs btn-square ${state === "include" ? "btn-success" : "btn-ghost"}`}
                  onClick={() => onUpdateFilter(name, state === "include" ? "neutral" : "include")}
                  title="Show only files with this tag"
                >
                  <PlusIcon className="w-3 h-3" />
                </button>

                {/* Remove button */}
                <button
                  className="btn btn-xs btn-ghost btn-square opacity-50 hover:opacity-100"
                  onClick={() => onRemoveTag(name)}
                  title="Remove tag from filter list"
                >
                  <XMarkIcon className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Legend */}
      {tagEntries.length > 0 && (
        <div className="p-2 border-t border-base-300 text-[10px] text-gray-400">
          <span className="text-error font-bold">-</span> exclude &nbsp;
          <span className="text-success font-bold">+</span> include only
        </div>
      )}
    </div>
  );
};
