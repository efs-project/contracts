"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAccount, usePublicClient } from "wagmi";
import { DrawerTagFilterState, FileBrowser } from "~~/components/explorer/FileBrowser";
import { TagFilterDrawer } from "~~/components/explorer/TagFilterDrawer";
import { PathItem, Toolbar } from "~~/components/explorer/Toolbar";
import { TopicTree } from "~~/components/explorer/TopicTree";
import deployedContracts from "~~/contracts/deployedContracts";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

export default function ExplorerPage() {
  const [currentPath, setCurrentPath] = useState<PathItem[]>([]);
  const [currentAnchorUID, setCurrentAnchorUID] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  // Editions: resolved addresses from explicit ?editions= param (ENS resolution is async)
  const [resolvedEditionAddresses, setResolvedEditionAddresses] = useState<string[]>([]);
  const [isResolvingEditions, setIsResolvingEditions] = useState(false);

  // Tag filter drawer
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [drawerTagFilters, setDrawerTagFilters] = useState<Record<string, DrawerTagFilterState>>({});

  // Incremented after processItems completes — causes FileBrowser to re-fetch sorted data
  const [sortRefreshKey, setSortRefreshKey] = useState(0);
  const [reverseOrder, setReverseOrder] = useState(false);
  const [autoProcessKey, setAutoProcessKey] = useState(0);

  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  // Active sort (from ?sort= URL param)
  const sortParam = searchParams.get("sort");
  const activeSortInfoUID = sortParam || null;
  const publicClient = usePublicClient();
  const { address: connectedAddress } = useAccount();

  const editionsParam = searchParams.get("editions");

  // Derive edition addresses synchronously — always in the same render as connectedAddress.
  // This prevents any flash of unfiltered data during account switches.
  const editionAddresses = useMemo(() => {
    if (editionsParam) return resolvedEditionAddresses;
    return connectedAddress ? [connectedAddress] : [];
  }, [editionsParam, connectedAddress, resolvedEditionAddresses]);

  // Fetch Root UID
  const { data: rootUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "rootAnchorUID",
  });

  // Fetch DATA Schema UID (needed for FileView)
  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });

  // Fetch ANCHOR Schema UID (needed for Creation)
  const { data: anchorSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "ANCHOR_SCHEMA_UID",
  });

  // Sort overlay addresses
  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: sortOverlayInfo } = useDeployedContractInfo({ contractName: "EFSSortOverlay" });
  // EAS is an external contract — read its address from the Indexer rather than deployedContracts
  const { data: easAddressRaw } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getEAS",
  });

  const indexerAddress = indexerInfo?.address as `0x${string}` | undefined;
  const sortOverlayAddress = sortOverlayInfo?.address as `0x${string}` | undefined;
  const easAddress = easAddressRaw as `0x${string}` | undefined;

  // Editions Resolution Effect — only needed for ENS name resolution in explicit ?editions= param.
  // Plain address filtering is handled synchronously via useMemo above.
  useEffect(() => {
    if (!editionsParam) {
      setIsResolvingEditions(false);
      return;
    }

    const resolveEditions = async () => {
      setIsResolvingEditions(true);

      const editionNames = editionsParam
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const resolvedAddresses: string[] = [];

      for (const name of editionNames) {
        if (name.endsWith(".eth")) {
          try {
            const addr = await publicClient?.getEnsAddress({ name });
            if (addr) resolvedAddresses.push(addr);
          } catch (e) {
            console.error(`Failed to resolve ENS name ${name}`, e);
          }
        } else if (name.startsWith("0x") && name.length === 42) {
          resolvedAddresses.push(name);
        }
      }

      setResolvedEditionAddresses(resolvedAddresses);
      setIsResolvingEditions(false);
    };

    resolveEditions();
  }, [editionsParam, publicClient]);

  // Path Resolution Effect
  useEffect(() => {
    const resolveUrlPath = async () => {
      // 1. Basic Checks
      if (!rootUID || rootUID === "0x0000000000000000000000000000000000000000000000000000000000000000" || !publicClient)
        return;

      // Get Chain ID to find contract address
      const chainId = publicClient.chain.id;
      const indexerConfig = deployedContracts[chainId as keyof typeof deployedContracts]?.Indexer;

      if (!indexerConfig) {
        console.error("Indexer contract not found for chain", chainId);
        return;
      }

      const pathSegments = params?.path;
      // params.path can be string, string[], or undefined.
      // Next.js catch-all [[...path]] returns array of strings.

      const segments = Array.isArray(pathSegments) ? pathSegments : pathSegments ? [pathSegments] : [];

      setIsResolving(true);
      setPathError(null);

      try {
        const resolvedPath: PathItem[] = [{ uid: rootUID, name: "Root" }];
        let currentUID = rootUID;

        for (const segment of segments) {
          // Resolve segment
          const childUID = (await publicClient.readContract({
            address: indexerConfig.address as `0x${string}`,
            abi: indexerConfig.abi,
            functionName: "resolvePath",
            args: [currentUID, segment],
          })) as string;

          if (childUID === "0x0000000000000000000000000000000000000000000000000000000000000000") {
            // Path not found - stop here or handle 404
            const errorMsg = `Folder '${decodeURIComponent(segment)}' not found in path.`;
            console.warn(errorMsg);
            setPathError(errorMsg);
            setIsResolving(false);
            return; // Stop resolution
          }

          resolvedPath.push({ uid: childUID as string, name: decodeURIComponent(segment) });
          currentUID = childUID as `0x${string}`;
        }

        setCurrentPath(resolvedPath);
        setCurrentAnchorUID(currentUID);
      } catch (err) {
        console.error("Failed to resolve path", err);
        setPathError("Failed to resolve path due to an error.");
      } finally {
        setIsResolving(false);
      }
    };

    resolveUrlPath();
  }, [rootUID, params?.path, publicClient]);

  const navigateToPath = (newPathItems: PathItem[]) => {
    // Skip Root ("Root") when building URL
    const urlSegments = newPathItems.slice(1).map(p => encodeURIComponent(p.name));

    // Preserve URL parameters (especially editions and sort)
    const currentQuery = searchParams.toString();
    const queryPart = currentQuery ? `?${currentQuery}` : "";
    const url = `/explorer/${urlSegments.join("/")}${queryPart}`;

    router.push(url);
  };

  const handleSortChange = (sortInfoUID: string | null) => {
    const currentQuery = new URLSearchParams(searchParams.toString());
    if (sortInfoUID) {
      currentQuery.set("sort", sortInfoUID);
    } else {
      currentQuery.delete("sort");
    }
    const urlSegments = currentPath.slice(1).map(p => encodeURIComponent(p.name));
    const queryPart = currentQuery.toString() ? `?${currentQuery.toString()}` : "";
    router.push(`/explorer/${urlSegments.join("/")}${queryPart}`);
  };

  if (!rootUID || !dataSchemaUID || !anchorSchemaUID) return <div>Loading System...</div>;
  if (isResolvingEditions) return <div>Resolving Editions...</div>;
  // We could show a specific "Resolving..." skeleton here if we want, but keeping global loading is safer for now.

  return (
    <div className="flex flex-col h-screen w-full bg-base-100 p-4 gap-4">
      <h1 className="text-3xl font-bold">EFS Explorer</h1>

      <div
        className={`flex flex-col gap-2 rounded-xl bg-base-200 p-4 shadow-lg flex-grow terminal-panel ${isResolving || isResolvingEditions ? "opacity-50 pointer-events-none" : ""}`}
      >
        <Toolbar
          currentPath={currentPath}
          currentAnchorUID={currentAnchorUID}
          anchorSchemaUID={anchorSchemaUID}
          dataSchemaUID={dataSchemaUID}
          indexerAddress={indexerAddress}
          easAddress={easAddress}
          sortOverlayAddress={sortOverlayAddress}
          editionAddresses={editionAddresses}
          activeSortInfoUID={activeSortInfoUID}
          onSortChange={handleSortChange}
          onSortProcessed={() => setSortRefreshKey(k => k + 1)}
          isFilterDrawerOpen={isFilterDrawerOpen}
          onToggleFilterDrawer={() => setIsFilterDrawerOpen(prev => !prev)}
          onNavigate={uid => {
            // Find path up to this UID
            const index = currentPath.findIndex(p => p.uid === uid);
            if (index !== -1) {
              navigateToPath(currentPath.slice(0, index + 1));
            }
          }}
          reverseOrder={reverseOrder}
          onReverseOrderChange={setReverseOrder}
          autoProcessKey={autoProcessKey}
          onFileCreated={() => setAutoProcessKey(k => k + 1)}
          onFolderCreated={(uid, name) => {
            navigateToPath([...currentPath, { uid, name }]);
          }}
        />

        {pathError && (
          <div role="alert" className="alert alert-error">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="stroke-current shrink-0 h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{pathError}</span>
          </div>
        )}

        <div className="flex flex-row gap-4 h-full overflow-hidden mt-1">
          {/* Left Pane - Tree */}
          <div className="w-1/4 min-w-[200px] border-r border-primary/10 pr-2 overflow-y-auto">
            <div className="h-full overflow-y-auto pr-2">
              <TopicTree
                rootUID={rootUID}
                selectedUID={currentAnchorUID}
                editionAddresses={editionAddresses}
                onSelect={(uid, path) => {
                  // Path needs to be constructed from tree logic.
                  // For now, let's just use the tree as navigation and update URL.
                  // But tree node sends us [Root, Child, Leaf]
                  // We want [Child, Leaf] for the URL if Root is hidden from URL or is empty path.
                  // Assuming rootUID corresponds to "Root" name in tree but "/" in URL logic.

                  // Simplified: Just take the path provided by Tree, map UIDs?
                  // Actually, Explorer page handles path resolution.
                  // Let's just trust path provided by `onSelect` from Tree?
                  // Tree provides `path` array of objects {uid, name}.
                  navigateToPath(path);
                }}
                expandedUIDs={new Set(currentPath.map(p => p.uid))}
              />
            </div>
          </div>

          {/* Right Pane - Browser + Tag Filter Drawer */}
          <div className="flex-grow flex flex-row overflow-hidden">
            <div className="flex-grow overflow-y-auto">
              {!pathError && (
                <FileBrowser
                  currentAnchorUID={currentAnchorUID}
                  dataSchemaUID={dataSchemaUID}
                  editionAddresses={editionAddresses}
                  tagFilter={searchParams.get("tags") || ""}
                  drawerTagFilters={drawerTagFilters}
                  currentPathNames={currentPath.slice(1).map(p => p.name)}
                  activeSortInfoUID={activeSortInfoUID}
                  sortOverlayAddress={sortOverlayAddress}
                  sortRefreshKey={sortRefreshKey}
                  reverseOrder={reverseOrder}
                  onNavigate={(uid, name) => {
                    navigateToPath([...currentPath, { uid, name }]);
                  }}
                />
              )}
            </div>
            {isFilterDrawerOpen && (
              <TagFilterDrawer
                tagFilters={drawerTagFilters}
                onUpdateFilter={(name, state) => setDrawerTagFilters(prev => ({ ...prev, [name]: state }))}
                onAddTag={name => setDrawerTagFilters(prev => ({ ...prev, [name]: "neutral" }))}
                onRemoveTag={name =>
                  setDrawerTagFilters(prev => {
                    const next = { ...prev };
                    delete next[name];
                    return next;
                  })
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
