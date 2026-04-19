"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PathItem } from "./types";
import { useAccount } from "wagmi";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import type { ClassifiedContainer, ContainerKind } from "~~/utils/efs/containers";

const TreeIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="5" r="1.75" />
    <circle cx="17" cy="11" r="1.75" />
    <circle cx="17" cy="19" r="1.75" />
    <path d="M6 6.75v12.5" />
    <path d="M6 11h9.25" />
    <path d="M6 19h9.25" />
  </svg>
);

export type PathBarProps = {
  /** Resolved walk from the URL. `currentPath[0]` is the container root; the leaf is the last element. */
  currentPath: PathItem[];
  /** The kind of the *top-level* container, drives the leaf badge. */
  containerKind: ContainerKind;
  /** Addresses currently filtering the view. Drives the editions chip count. */
  editionAddresses: string[];
  /** The resolved top-level container — used to label the "Current" row in the editions popover. */
  container?: ClassifiedContainer | null;
  /**
   * Resolved display name for the container (ADR-0034 `name` PROPERTY / ENS /
   * persona label), when different from the path leaf. Overrides the leaf
   * label on the ITEM button so seeded personas render human-readably.
   */
  containerDisplayName?: string | null;
  /** Whether the info band is currently expanded. */
  isInfoOpen: boolean;
  /** Toggles the info band. Receives the new `isInfoOpen` value. */
  onToggleInfo: () => void;
  /** Toggles the sidebar tree. Rendered only below `lg` — sidebar is always visible at `lg+`. */
  onToggleSidebar?: () => void;
  /** Disables the bar while a resolution is in flight. */
  disabled?: boolean;
};

function buildUrlFromPath(currentPath: PathItem[], containerKind: ContainerKind): string {
  // currentPath[0] is the container root. For anchor walks the head is the root
  // anchor (display label "Topics") and should NOT appear in the URL bar. For
  // address/schema/attestation containers the head IS the URL segment
  // (e.g. "vitalik.eth" or "0x1234…/5678") and must be shown.
  if (currentPath.length === 0) return "";
  const [head, ...rest] = currentPath;
  const tail = rest.map(p => p.name).join("/");
  const headSegment = containerKind === "anchor" ? "" : head.name;
  if (headSegment && tail) return `${headSegment}/${tail}`;
  if (headSegment) return headSegment;
  return tail;
}

/**
 * Primary navigation control. A typeable URL bar with a leading ITEM button that
 * toggles the container info band, and a trailing EDITIONS chip for attester
 * filtering. Shipping the bar as its own component lets the user edit the whole
 * path freely (ENS, raw addresses, schema/attestation UIDs, nested sub-paths).
 */
export const PathBar = ({
  currentPath,
  containerKind,
  editionAddresses,
  container,
  containerDisplayName,
  isInfoOpen,
  onToggleInfo,
  onToggleSidebar,
  disabled = false,
}: PathBarProps) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address: connectedAddress } = useAccount();
  const [input, setInput] = useState(() => buildUrlFromPath(currentPath, containerKind));
  const [isEditing, setIsEditing] = useState(false);
  const [editionsInput, setEditionsInput] = useState(searchParams.get("editions") || "");

  useEffect(() => {
    if (!isEditing) setInput(buildUrlFromPath(currentPath, containerKind));
  }, [currentPath, containerKind, isEditing]);

  useEffect(() => {
    setEditionsInput(searchParams.get("editions") || "");
  }, [searchParams]);

  const leaf = currentPath[currentPath.length - 1];
  // Use the resolved container display name only at the container root; once
  // the user walks into a sub-path the leaf segment (folder/file name) is
  // more informative than the root container label.
  const atContainerRoot = currentPath.length === 1;
  const leafName = (atContainerRoot && containerDisplayName) || leaf?.name || "—";
  const kindLabel: Record<ContainerKind, string> = {
    anchor: "Anchor",
    address: "Address",
    schema: "Schema",
    attestation: "Attestation",
  };

  const navigate = (raw: string) => {
    const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
    const segments = trimmed
      .split("/")
      .map(s => s.trim())
      .filter(Boolean)
      .map(encodeURIComponent);
    const query = searchParams.toString();
    const url = `/explorer/${segments.join("/")}${query ? `?${query}` : ""}`;
    router.push(url);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsEditing(false);
    navigate(input);
  };

  const applyEditions = () => {
    const next = new URLSearchParams(searchParams.toString());
    const trimmed = editionsInput.trim();
    if (trimmed) next.set("editions", trimmed);
    else next.delete("editions");
    const tailSegments = currentPath.slice(containerKind === "anchor" ? 1 : 0).map(p => encodeURIComponent(p.name));
    const q = next.toString();
    router.push(`/explorer/${tailSegments.join("/")}${q ? `?${q}` : ""}`);
  };

  const editionsCount = editionAddresses.length;
  const editionsLabel =
    editionsCount === 0 ? "No editions" : `${editionsCount} edition${editionsCount === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-wrap items-stretch gap-2 w-full">
      {/* Sidebar toggle — only below `lg` (the aside is always visible at `lg+`). */}
      {onToggleSidebar && (
        <button
          type="button"
          className="lg:hidden flex items-center justify-center h-11 w-11 rounded-lg border border-base-content/20 bg-base-200 hover:bg-base-300 flex-shrink-0"
          onClick={onToggleSidebar}
          title="Show tree"
          aria-label="Show tree"
        >
          <TreeIcon className="w-5 h-5" />
        </button>
      )}
      {/* ITEM button — uniform label + leaf name, toggles info band */}
      <button
        type="button"
        className={`relative flex items-center gap-2 px-4 h-11 rounded-lg border transition-colors flex-shrink-0 max-w-[40%] ${
          isInfoOpen
            ? "bg-primary text-primary-content border-primary"
            : "bg-base-200 hover:bg-base-300 border-base-content/20"
        }`}
        onClick={onToggleInfo}
        title={isInfoOpen ? "Hide details" : "Show details"}
      >
        <span className="flex flex-col items-start leading-tight min-w-0">
          <span className={`text-[9px] uppercase tracking-wider ${isInfoOpen ? "opacity-80" : "opacity-50"}`}>
            {kindLabel[containerKind]}
          </span>
          <span className="truncate font-mono text-sm font-medium max-w-full">{leafName}</span>
        </span>
        {isInfoOpen ? (
          <ChevronUpIcon className="w-3.5 h-3.5 opacity-70" />
        ) : (
          <ChevronDownIcon className="w-3.5 h-3.5 opacity-70" />
        )}
      </button>

      {/* URL bar — typeable */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-grow min-w-[250px] h-11 rounded-lg border border-base-content/20 bg-base-200 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary overflow-hidden"
      >
        <span className="flex items-center px-3 bg-base-300 text-xs opacity-80 font-mono select-none border-r border-base-content/10">
          efs://
        </span>
        <input
          type="text"
          value={input}
          onChange={e => {
            setInput(e.target.value);
            setIsEditing(true);
          }}
          onBlur={() => setIsEditing(false)}
          onKeyDown={e => {
            if (e.key === "Escape") {
              setIsEditing(false);
              setInput(buildUrlFromPath(currentPath, containerKind));
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="flex-grow px-3 bg-transparent font-mono text-sm outline-none placeholder:opacity-50"
          placeholder="vitalik.eth/memes, 0x…, schemas/TAG, …"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
        />
        <button
          type="submit"
          className="px-4 bg-primary text-primary-content text-sm font-medium hover:brightness-110 disabled:opacity-50"
          disabled={disabled}
        >
          Go
        </button>
      </form>

      {/* EDITIONS chip — below `lg` the chip wraps to its own row so we left-anchor the popover;
          at `lg+` the chip sits at the right of the PathBar so we right-anchor to keep it on-screen. */}
      <details className="dropdown lg:dropdown-end flex-shrink-0">
        <summary
          className="flex items-center gap-1 px-3 h-11 rounded-lg border border-base-content/20 bg-base-200 hover:bg-base-300 cursor-pointer"
          title="Filter by attester (ENS or 0x address, comma-separated)"
        >
          <span aria-hidden>👥</span>
          <span className="text-xs">{editionsLabel}</span>
          <span className="text-xs opacity-60">▾</span>
        </summary>
        <div className="dropdown-content z-50 !bg-base-100 border border-base-300 rounded-box shadow-lg p-3 mt-1 w-80 max-w-[calc(100vw-2rem)]">
          {editionAddresses.length > 0 && (
            <div className="mb-2 rounded-md bg-base-200 p-2 text-xs font-mono flex flex-col gap-1">
              {editionAddresses.map((addr, i) => {
                const isYou = connectedAddress && addr.toLowerCase() === connectedAddress.toLowerCase();
                const isContainer =
                  container?.kind === "address" &&
                  container.address &&
                  addr.toLowerCase() === container.address.toLowerCase();
                const label = isYou ? "You" : isContainer ? "Current" : `#${i + 1}`;
                return (
                  <div key={`${addr}-${i}`} className="flex items-center justify-between gap-2">
                    <span className="opacity-60 uppercase tracking-wide text-[10px]">{label}</span>
                    <span className="truncate" title={addr}>
                      {addr.slice(0, 6)}…{addr.slice(-4)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-xs opacity-60 mb-1">Override (comma-separated; ENS or 0x…)</div>
          <input
            type="text"
            className="input input-bordered input-sm w-full"
            placeholder="vitalik.eth, 0x..."
            value={editionsInput}
            onChange={e => setEditionsInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") applyEditions();
            }}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => {
                setEditionsInput("");
                const next = new URLSearchParams(searchParams.toString());
                next.delete("editions");
                const tailSegments = currentPath
                  .slice(containerKind === "anchor" ? 1 : 0)
                  .map(p => encodeURIComponent(p.name));
                const q = next.toString();
                router.push(`/explorer/${tailSegments.join("/")}${q ? `?${q}` : ""}`);
              }}
            >
              Clear
            </button>
            <button className="btn btn-xs btn-primary" onClick={applyEditions}>
              Apply
            </button>
          </div>
        </div>
      </details>
    </div>
  );
};
