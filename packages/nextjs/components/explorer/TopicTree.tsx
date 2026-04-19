"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PathItem } from "./types";
import { zeroHash } from "viem";
import { useAccount } from "wagmi";
import {
  CircleStackIcon,
  CubeTransparentIcon,
  FolderIcon,
  HashtagIcon,
  ServerStackIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useDisplayName } from "~~/hooks/efs/useDisplayName";
import { useSortedData } from "~~/hooks/efs/useSortedData";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import type { ClassifiedContainer } from "~~/utils/efs/containers";
import { isTopic } from "~~/utils/efs/efsTypes";

const RECENT_ADDRESSES_KEY = "efs.recentAddresses";
const RECENT_ATTESTATIONS_KEY = "efs.recentAttestations";
const RECENT_MAX = 20;

// ----- Anchor subtree (unchanged functional behavior, prop-threaded) -----

// Regex for the ADR-0033 alias-anchor naming convention: root-child anchors whose
// name is a schema/attestation UID in lowercase 0x-hex (64 hex chars). Cheap
// string test; no extra chain reads.
const ALIAS_ANCHOR_NAME_RE = /^0x[0-9a-f]{64}$/;

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
  hideAliasAnchors,
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
  systemTagsUID?: string;
  systemSortsUID?: string;
  /** When true, filters out child anchors whose name looks like a schema/attestation UID alias. Applied only at root per ADR-0033. */
  hideAliasAnchors?: boolean;
  activeSortInfoUID?: string | null;
  sortOverlayAddress?: `0x${string}`;
  sortRefreshKey?: number;
}) => {
  const hasEditions = editionAddresses && editionAddresses.length > 0;
  const lockedToEditions = useRef(false);
  if (hasEditions) lockedToEditions.current = true;
  const useEditionsQuery = (hasEditions || lockedToEditions.current) && editionAddresses.length > 0;

  const { data: standardChildren, isLoading: isStandardLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPage",
    args: [uid as `0x${string}`, 0n, 50n, dataSchemaUID as `0x${string}`, propertySchemaUID as `0x${string}`],
    query: { enabled: !useEditionsQuery },
  });

  const { data: editionChildrenRaw, isLoading: isEditionLoading } = useScaffoldReadContract({
    contractName: "EFSFileView",
    functionName: "getDirectoryPageBySchemaAndAddressList",
    args: [uid as `0x${string}`, dataSchemaUID as `0x${string}`, editionAddresses as string[], 0n, 50n],
    query: { enabled: useEditionsQuery && editionAddresses.length > 0 },
  });

  const isLoading = useEditionsQuery ? isEditionLoading : isStandardLoading;
  const children = useEditionsQuery
    ? editionChildrenRaw
      ? (editionChildrenRaw as any)[0]
      : undefined
    : standardChildren;

  const { sortedUIDs } = useSortedData({
    sortInfoUID: activeSortInfoUID ?? null,
    parentAnchor: uid,
    sortOverlayAddress,
    editionAddresses,
    refreshKey: sortRefreshKey,
  });

  let topics = children?.filter(
    (item: any) =>
      isTopic(item) &&
      item.uid !== systemTagsUID &&
      item.uid !== systemSortsUID &&
      !(hideAliasAnchors && typeof item.name === "string" && ALIAS_ANCHOR_NAME_RE.test(item.name)),
  );

  if (topics) {
    if (activeSortInfoUID && sortedUIDs && sortedUIDs.length > 0) {
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
            selectedUID === uid
              ? "bg-primary/20 text-primary font-bold border-l-2 border-primary"
              : "text-base-content font-medium"
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
            selectedUID === uid
              ? "bg-primary/20 text-primary font-bold border-l-2 border-primary"
              : "text-base-content font-medium"
          }`}
          onClick={() => onSelect(uid, [{ uid, name }])}
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

// ----- Branch wrappers (Addresses / Schemas / Attestations) -----

type BranchProps = {
  icon: React.ReactNode;
  title: string;
  /** When true, opens the branch and keeps it open until the user collapses it manually. */
  forceOpen?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

const Branch = ({ icon, title, forceOpen = false, defaultOpen = false, children }: BranchProps) => {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  // Re-open the branch whenever the forceOpen signal flips true (URL navigation).
  // Never auto-close — the user may have collapsed it intentionally.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <li>
      <details open={open} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary className="list-none flex items-center gap-2 cursor-pointer px-2 py-1 rounded-md hover:bg-base-200 text-sm font-medium">
          {icon}
          <span>{title}</span>
        </summary>
        <ul className="pl-4 border-l border-base-300 ml-2 mt-1">{children}</ul>
      </details>
    </li>
  );
};

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortUid = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

const AddressEntry = ({
  address,
  connectedAddress,
  deployerAddress,
  isYou,
  isActive,
  onSelect,
}: {
  address: string;
  connectedAddress: string | undefined;
  deployerAddress: string | undefined;
  isYou?: boolean;
  isActive?: boolean;
  onSelect: (addr: string) => void;
}) => {
  const editions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (a: string | undefined) => {
      if (!a) return;
      const key = a.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(a);
    };
    push(connectedAddress);
    push(address);
    push(deployerAddress);
    return out;
  }, [connectedAddress, address, deployerAddress]);

  const { displayName } = useDisplayName({ target: address as `0x${string}`, editions });
  const label = isYou ? "You" : displayName;

  return (
    <li>
      <button
        type="button"
        className={`w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-base-200 disabled:opacity-40 ${
          isActive ? "bg-primary/20 text-primary font-bold border-l-2 border-primary" : ""
        }`}
        onClick={() => onSelect(address)}
      >
        <UserCircleIcon className={`w-4 h-4 flex-shrink-0 ${isYou ? "" : "opacity-70"}`} />
        <div className="flex flex-col items-start min-w-0 leading-tight">
          <span className="text-sm truncate">{label}</span>
          <span className="text-[10px] opacity-40 font-mono truncate">{shortAddr(address)}</span>
        </div>
      </button>
    </li>
  );
};

const AddressesBranch = ({ activeAddress }: { activeAddress?: string | null }) => {
  const router = useRouter();
  const { address: connectedAddress } = useAccount();
  const { data: deployerAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DEPLOYER",
  });
  const [recent, setRecent] = useState<string[]>([]);

  // Re-read localStorage when the active address changes so addresses freshly
  // written by the page's route-resolution effect show up immediately.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_ADDRESSES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecent(parsed.slice(0, RECENT_MAX));
      }
    } catch {
      /* ignore */
    }
  }, [activeAddress]);

  const go = (addr: string) => router.push(`/explorer/${addr}`);

  const activeLower = activeAddress?.toLowerCase();
  const connectedLower = connectedAddress?.toLowerCase();

  // Merge the active address into the displayed list in case localStorage hasn't
  // caught up yet (first-ever visit writes happen in the same render tick).
  const mergedRecent = useMemo(() => {
    if (!activeAddress) return recent;
    if (recent.some(a => a.toLowerCase() === activeLower)) return recent;
    return [activeAddress, ...recent];
  }, [recent, activeAddress, activeLower]);

  const others = mergedRecent.filter(a => !connectedLower || a.toLowerCase() !== connectedLower);

  return (
    <>
      {connectedAddress && (
        <AddressEntry
          address={connectedAddress}
          connectedAddress={connectedAddress}
          deployerAddress={deployerAddress as string | undefined}
          isYou
          isActive={activeLower === connectedLower}
          onSelect={go}
        />
      )}
      {others.map(addr => (
        <AddressEntry
          key={addr}
          address={addr}
          connectedAddress={connectedAddress}
          deployerAddress={deployerAddress as string | undefined}
          isActive={addr.toLowerCase() === activeLower}
          onSelect={go}
        />
      ))}
      {!connectedAddress && mergedRecent.length === 0 && (
        <li className="px-2 py-1 text-xs opacity-50">Connect wallet to see your page</li>
      )}
    </>
  );
};

const SchemasBranch = ({ activeUID }: { activeUID?: string | null }) => {
  const router = useRouter();
  const { data: anchorUID } = useScaffoldReadContract({ contractName: "Indexer", functionName: "ANCHOR_SCHEMA_UID" });
  const { data: propertyUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });
  const { data: dataUID } = useScaffoldReadContract({ contractName: "Indexer", functionName: "DATA_SCHEMA_UID" });
  const { data: tagUID } = useScaffoldReadContract({ contractName: "TagResolver", functionName: "TAG_SCHEMA_UID" });
  const { data: mirrorUID } = useScaffoldReadContract({ contractName: "Indexer", functionName: "MIRROR_SCHEMA_UID" });
  const { data: sortInfoUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "SORT_INFO_SCHEMA_UID",
  });

  // Per ADR-0033 an alias anchor at root whose *name* is the schema UID in lowercase 0x-hex
  // is the EFS-native representation of the schema. The router prefers the alias anchor over
  // the raw schema UID when walking, so linking to `/explorer/<schemaUID>` lands on the alias
  // whenever one exists and falls through to raw JSON otherwise.
  const items: { label: string; uid: string | undefined }[] = [
    { label: "ANCHOR", uid: anchorUID as string | undefined },
    { label: "DATA", uid: dataUID as string | undefined },
    { label: "PROPERTY", uid: propertyUID as string | undefined },
    { label: "TAG", uid: tagUID as string | undefined },
    { label: "MIRROR", uid: mirrorUID as string | undefined },
    { label: "SORT_INFO", uid: sortInfoUID as string | undefined },
  ];

  const activeLower = activeUID?.toLowerCase();

  return (
    <>
      {items.map(it => {
        const isActive = !!it.uid && it.uid.toLowerCase() === activeLower;
        return (
          <li key={it.label}>
            <button
              type="button"
              className={`w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-base-200 disabled:opacity-40 ${
                isActive ? "bg-primary/20 text-primary font-bold border-l-2 border-primary" : ""
              }`}
              onClick={() => it.uid && router.push(`/explorer/${it.uid.toLowerCase()}`)}
              disabled={!it.uid || it.uid === zeroHash}
            >
              <CircleStackIcon className="w-4 h-4 opacity-70 flex-shrink-0" />
              <div className="flex flex-col items-start min-w-0 leading-tight">
                <span className="text-sm truncate">{it.label}</span>
                {it.uid && <span className="text-[10px] opacity-40 font-mono truncate">{shortUid(it.uid)}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </>
  );
};

const AttestationEntry = ({
  uid,
  connectedAddress,
  deployerAddress,
  isActive,
  onSelect,
}: {
  uid: string;
  connectedAddress: string | undefined;
  deployerAddress: string | undefined;
  isActive?: boolean;
  onSelect: (uid: string) => void;
}) => {
  const editions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (a: string | undefined) => {
      if (!a) return;
      const key = a.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(a);
    };
    push(connectedAddress);
    push(deployerAddress);
    return out;
  }, [connectedAddress, deployerAddress]);

  const { displayName, source } = useDisplayName({ target: uid as `0x${string}`, editions, skipEns: true });
  // Show the resolved `name` PROPERTY on top when available; otherwise fall
  // back to the short UID as the primary label so the two-line layout stays
  // consistent with addresses and schemas.
  const hasName = source === "property" && displayName;
  const primary = hasName ? displayName : shortUid(uid);

  return (
    <li>
      <button
        type="button"
        className={`w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-base-200 disabled:opacity-40 ${
          isActive ? "bg-primary/20 text-primary font-bold border-l-2 border-primary" : ""
        }`}
        onClick={() => onSelect(uid)}
        title={uid}
      >
        <HashtagIcon className="w-4 h-4 opacity-70 flex-shrink-0" />
        <div className="flex flex-col items-start min-w-0 leading-tight">
          <span className={`text-sm truncate ${hasName ? "" : "font-mono"}`}>{primary}</span>
          {hasName && <span className="text-[10px] opacity-40 font-mono truncate">{shortUid(uid)}</span>}
        </div>
      </button>
    </li>
  );
};

const AttestationsBranch = ({ activeUID }: { activeUID?: string | null }) => {
  const router = useRouter();
  const { address: connectedAddress } = useAccount();
  const { data: deployerAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DEPLOYER",
  });
  const [recent, setRecent] = useState<string[]>([]);
  const [input, setInput] = useState("");

  // Re-read localStorage when the active attestation UID changes so attestations
  // freshly written by the page's route-resolution effect show up immediately.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_ATTESTATIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecent(parsed.slice(0, RECENT_MAX));
      }
    } catch {
      /* ignore */
    }
  }, [activeUID]);

  const go = (uid: string) => {
    const trimmed = uid.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return;
    try {
      const raw = window.localStorage.getItem(RECENT_ATTESTATIONS_KEY);
      const prev: string[] = raw ? JSON.parse(raw) : [];
      const next = [trimmed, ...prev.filter(a => a.toLowerCase() !== trimmed.toLowerCase())].slice(0, RECENT_MAX);
      window.localStorage.setItem(RECENT_ATTESTATIONS_KEY, JSON.stringify(next));
      setRecent(next);
    } catch {
      /* ignore */
    }
    router.push(`/explorer/${trimmed}`);
    setInput("");
  };

  return (
    <>
      <li className="px-2 py-1">
        <div className="flex gap-1">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") go(input);
            }}
            placeholder="0x… attestation UID"
            className="input input-bordered input-xs w-full font-mono text-xs"
            spellCheck={false}
          />
          <button className="btn btn-xs btn-primary" onClick={() => go(input)} disabled={!input}>
            Go
          </button>
        </div>
      </li>
      {(() => {
        const activeLower = activeUID?.toLowerCase();
        const mergedRecent =
          activeUID && !recent.some(u => u.toLowerCase() === activeLower) ? [activeUID, ...recent] : recent;
        return mergedRecent.map(uid => (
          <AttestationEntry
            key={uid}
            uid={uid}
            connectedAddress={connectedAddress}
            deployerAddress={deployerAddress as string | undefined}
            isActive={uid.toLowerCase() === activeLower}
            onSelect={go}
          />
        ));
      })()}
      {recent.length === 0 && !activeUID && <li className="px-2 py-1 text-xs opacity-50">Paste a UID to navigate</li>}
    </>
  );
};

// ----- Main TopicTree -----

export type TopicTreeProps = {
  rootUID: string;
  selectedUID: string | null;
  /** Container classified from the current URL. Drives sidebar highlight + auto-expand. */
  activeContainer?: ClassifiedContainer | null;
  onSelect: (uid: string, path: PathItem[]) => void;
  expandedUIDs?: Set<string>;
  editionAddresses: string[];
  activeSortInfoUID?: string | null;
  sortOverlayAddress?: `0x${string}`;
  sortRefreshKey?: number;
};

export const TopicTree = ({
  rootUID,
  selectedUID,
  activeContainer,
  onSelect,
  expandedUIDs,
  editionAddresses,
  activeSortInfoUID,
  sortOverlayAddress,
  sortRefreshKey,
}: TopicTreeProps) => {
  const { targetNetwork } = useTargetNetwork();

  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });
  const { data: propertySchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });
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

  const chainLabel = useMemo(() => targetNetwork?.name ?? "chain", [targetNetwork?.name]);

  if (!dataSchemaUID || !propertySchemaUID) {
    return <span className="loading loading-dots loading-xs"></span>;
  }

  return (
    <ul className="menu menu-sm p-0 w-full">
      {/* Chain root — always open. Metaphor: C:\, D:\ */}
      <li>
        <details open>
          <summary className="list-none flex items-center gap-2 px-2 py-1.5 rounded-md font-semibold text-sm cursor-pointer hover:bg-base-200">
            <ServerStackIcon className="w-4 h-4" />
            <span className="truncate">{chainLabel}</span>
            <span className="ml-auto text-xs opacity-50 font-mono">\\</span>
          </summary>
          <ul className="pl-3 border-l border-base-300 ml-3 mt-1">
            <TreeNode
              uid={rootUID}
              name="Topics"
              selectedUID={selectedUID}
              onSelect={onSelect}
              dataSchemaUID={dataSchemaUID}
              propertySchemaUID={propertySchemaUID}
              defaultOpen
              expandedUIDs={expandedUIDs}
              editionAddresses={editionAddresses}
              systemTagsUID={systemTagsUID as string | undefined}
              systemSortsUID={systemSortsUID as string | undefined}
              hideAliasAnchors
              activeSortInfoUID={activeSortInfoUID}
              sortOverlayAddress={resolvedSortOverlayAddress}
              sortRefreshKey={sortRefreshKey}
            />

            <Branch
              icon={<UserCircleIcon className="w-4 h-4" />}
              title="Addresses"
              forceOpen={activeContainer?.kind === "address"}
            >
              <AddressesBranch activeAddress={activeContainer?.kind === "address" ? activeContainer.address : null} />
            </Branch>

            <Branch
              icon={<CircleStackIcon className="w-4 h-4" />}
              title="Schemas"
              forceOpen={activeContainer?.kind === "schema"}
            >
              <SchemasBranch activeUID={activeContainer?.kind === "schema" ? activeContainer.uid : null} />
            </Branch>

            <Branch
              icon={<CubeTransparentIcon className="w-4 h-4" />}
              title="Attestations"
              forceOpen={activeContainer?.kind === "attestation"}
            >
              <AttestationsBranch activeUID={activeContainer?.kind === "attestation" ? activeContainer.uid : null} />
            </Branch>
          </ul>
        </details>
      </li>
    </ul>
  );
};
