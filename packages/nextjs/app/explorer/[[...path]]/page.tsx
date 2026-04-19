"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAccount, usePublicClient } from "wagmi";
import { ContainerInfoPanel } from "~~/components/explorer/ContainerInfoPanel";
import { FileActionsBar } from "~~/components/explorer/FileActionsBar";
import { DrawerTagFilterState, FileBrowser } from "~~/components/explorer/FileBrowser";
import { PathBar } from "~~/components/explorer/PathBar";
import { TagFilterDrawer } from "~~/components/explorer/TagFilterDrawer";
import { TopicTree } from "~~/components/explorer/TopicTree";
import type { PathItem } from "~~/components/explorer/types";
import deployedContracts from "~~/contracts/deployedContracts";
import { useContainerName } from "~~/hooks/efs/useContainerName";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { ClassifiedContainer, classifyTopLevelSegment, defaultEditionsForContainer } from "~~/utils/efs/containers";

export default function ExplorerPage() {
  const [currentPath, setCurrentPath] = useState<PathItem[]>([]);
  const [currentAnchorUID, setCurrentAnchorUID] = useState<string | null>(null);
  const [currentContainer, setCurrentContainer] = useState<ClassifiedContainer | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  const [resolvedEditionAddresses, setResolvedEditionAddresses] = useState<string[]>([]);
  const [isResolvingEditions, setIsResolvingEditions] = useState(false);

  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [drawerTagFilters, setDrawerTagFilters] = useState<Record<string, DrawerTagFilterState>>({ nsfw: "exclude" });

  const [sortRefreshKey, setSortRefreshKey] = useState(0);
  const [reverseOrder, setReverseOrder] = useState(false);
  const [autoProcessKey, setAutoProcessKey] = useState(0);
  const [autoProcessSortUIDs, setAutoProcessSortUIDs] = useState<string[]>([]);

  // Info band — externally controlled by PathBar's ItemButton.
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  // Sidebar — below `lg` it renders as an overlay, toggled via PathBar button.
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  const sortParam = searchParams.get("sort");
  const activeSortInfoUID = sortParam || null;
  const publicClient = usePublicClient();
  const { address: connectedAddress } = useAccount();

  const editionsParam = searchParams.get("editions");

  const editionAddresses = useMemo(() => {
    return defaultEditionsForContainer({
      container: currentContainer,
      connectedAddress,
      explicitEditions: editionsParam ? resolvedEditionAddresses : null,
    });
  }, [editionsParam, connectedAddress, resolvedEditionAddresses, currentContainer]);

  const { data: rootUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "rootAnchorUID",
  });
  const { data: dataSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DATA_SCHEMA_UID",
  });
  const { data: anchorSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "ANCHOR_SCHEMA_UID",
  });
  const { data: propertySchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });
  const { data: tagSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "TAG_SCHEMA_UID",
  });
  const { data: mirrorSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "MIRROR_SCHEMA_UID",
  });

  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: sortOverlayInfo } = useDeployedContractInfo({ contractName: "EFSSortOverlay" });
  const { data: easAddressRaw } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getEAS",
  });

  const indexerAddress = indexerInfo?.address as `0x${string}` | undefined;
  const sortOverlayAddress = sortOverlayInfo?.address as `0x${string}` | undefined;
  const easAddress = easAddressRaw as `0x${string}` | undefined;

  // Resolved display name for the current container via ADR-0034 `name`
  // PROPERTY cascade with deployer fallback (ADR-0016). Surfaces persona /
  // ENS / property-bound labels in PathBar, ContainerInfoPanel, and the tab
  // title.
  const { name: containerDisplayName } = useContainerName(currentContainer, connectedAddress, currentAnchorUID);

  // Editions Resolution Effect — only needed for ENS name resolution in explicit ?editions= param.
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
      // Wait for easAddress too — the top-level classifier needs it to
      // distinguish schema / attestation UIDs from anchor names. Running
      // before it loads misclassifies 64-hex segments as anchors.
      if (
        !rootUID ||
        rootUID === "0x0000000000000000000000000000000000000000000000000000000000000000" ||
        !publicClient ||
        !easAddress
      )
        return;

      const chainId = publicClient.chain.id;
      const indexerConfig = deployedContracts[chainId as keyof typeof deployedContracts]?.Indexer;

      if (!indexerConfig) {
        console.error("Indexer contract not found for chain", chainId);
        return;
      }

      const pathSegments = params?.path;
      const segments = Array.isArray(pathSegments) ? pathSegments : pathSegments ? [pathSegments] : [];

      setIsResolving(true);
      setPathError(null);

      try {
        let container: ClassifiedContainer | null = null;
        let walkSegments = segments;
        let seedUID: `0x${string}` = rootUID as `0x${string}`;
        let rootLabel = "Topics";

        if (segments.length > 0) {
          const classified = await classifyTopLevelSegment(segments[0], {
            publicClient,
            easAddress,
          });
          if (classified.kind !== "anchor") {
            container = classified;
            seedUID = classified.uid;
            walkSegments = segments.slice(1);
            rootLabel = classified.displayName;

            // ADR-0033 §2: for schema / attestation containers, prefer an
            // *alias anchor* at root (name = the UID in lowercase 0x-hex) as the
            // walk seed. EFS-native TAGs / PROPERTYs / sub-anchors live on the
            // alias; the raw UID is kept on `container` so the info panel still
            // shows EAS data. Falls through to raw UID if no alias exists — the
            // file browser renders empty, matching the router's JSON fallback.
            if (classified.kind === "schema" || classified.kind === "attestation") {
              try {
                const aliasUID = (await publicClient.readContract({
                  address: indexerConfig.address as `0x${string}`,
                  abi: indexerConfig.abi,
                  functionName: "resolvePath",
                  args: [rootUID as `0x${string}`, classified.uid.toLowerCase()],
                })) as `0x${string}`;
                if (aliasUID && aliasUID !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
                  seedUID = aliasUID;
                }
              } catch (e) {
                console.warn("Alias anchor lookup failed; falling back to raw UID", e);
              }
            }
          }
        }

        const resolvedPath: PathItem[] = [{ uid: seedUID, name: rootLabel }];
        let currentUID: `0x${string}` = seedUID;

        for (const segment of walkSegments) {
          const childUID = (await publicClient.readContract({
            address: indexerConfig.address as `0x${string}`,
            abi: indexerConfig.abi,
            functionName: "resolvePath",
            args: [currentUID, segment],
          })) as `0x${string}`;

          if (childUID === "0x0000000000000000000000000000000000000000000000000000000000000000") {
            const errorMsg = `Folder '${decodeURIComponent(segment)}' not found in path.`;
            console.warn(errorMsg);
            setPathError(errorMsg);
            setIsResolving(false);
            return;
          }

          resolvedPath.push({ uid: childUID, name: decodeURIComponent(segment) });
          currentUID = childUID;
        }

        setCurrentPath(resolvedPath);
        setCurrentAnchorUID(currentUID);
        setCurrentContainer(container);

        if (container?.kind === "address" && container.address) {
          try {
            const KEY = "efs.recentAddresses";
            const raw = window.localStorage.getItem(KEY);
            const prev: string[] = raw ? JSON.parse(raw) : [];
            const filtered = prev.filter(a => a.toLowerCase() !== container.address!.toLowerCase());
            const next = [container.address, ...filtered].slice(0, 20);
            window.localStorage.setItem(KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
        }

        if (container?.kind === "attestation" && container.uid) {
          try {
            const KEY = "efs.recentAttestations";
            const raw = window.localStorage.getItem(KEY);
            const prev: string[] = raw ? JSON.parse(raw) : [];
            const filtered = prev.filter(a => a.toLowerCase() !== container.uid.toLowerCase());
            const next = [container.uid, ...filtered].slice(0, 20);
            window.localStorage.setItem(KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
        }
      } catch (err) {
        console.error("Failed to resolve path", err);
        setPathError("Failed to resolve path due to an error.");
      } finally {
        setIsResolving(false);
      }
    };

    resolveUrlPath();
  }, [rootUID, params?.path, publicClient, easAddress]);

  // Keep the browser tab title in sync with the deepest path segment. When
  // the container has a resolved display name (ENS / persona / property)
  // and we're at the container root, prefer it over the short-hex label.
  useEffect(() => {
    const leaf = currentPath[currentPath.length - 1];
    const atRoot = currentPath.length === 1;
    const label = (atRoot && containerDisplayName) || leaf?.name?.trim();
    document.title = label ? `${label} - EFS` : "File Explorer - EFS";
  }, [currentPath, containerDisplayName]);

  const navigateToPath = (newPathItems: PathItem[]) => {
    // The first path item is the container root; we skip it in the URL only for
    // anchor walks (where the head *is* rootUID, not a URL segment). For
    // address/schema/attestation containers, the first item *is* a URL segment
    // (e.g. "vitalik.eth").
    const skipHead = newPathItems[0]?.uid === rootUID;
    const urlSegments = newPathItems.slice(skipHead ? 1 : 0).map(p => encodeURIComponent(p.name));
    const currentQuery = searchParams.toString();
    const queryPart = currentQuery ? `?${currentQuery}` : "";
    const url = `/explorer/${urlSegments.join("/")}${queryPart}`;
    router.push(url);
  };

  const handleSortChange = (sortInfoUID: string | null) => {
    const currentQuery = new URLSearchParams(searchParams.toString());
    if (sortInfoUID) currentQuery.set("sort", sortInfoUID);
    else currentQuery.delete("sort");
    const skipHead = currentPath[0]?.uid === rootUID;
    const urlSegments = currentPath.slice(skipHead ? 1 : 0).map(p => encodeURIComponent(p.name));
    const queryPart = currentQuery.toString() ? `?${currentQuery.toString()}` : "";
    router.push(`/explorer/${urlSegments.join("/")}${queryPart}`);
  };

  if (!rootUID || !dataSchemaUID || !anchorSchemaUID || !propertySchemaUID || !tagSchemaUID || !mirrorSchemaUID)
    return <div>Loading System...</div>;
  if (isResolvingEditions) return <div>Resolving Editions...</div>;

  const containerKind = currentContainer?.kind ?? "anchor";

  return (
    <div className="flex flex-col h-screen w-full bg-base-100 p-4 gap-3">
      <div
        className={`flex flex-col rounded-xl bg-base-200 shadow-lg flex-grow overflow-hidden terminal-panel ${
          isResolving || isResolvingEditions ? "opacity-50 pointer-events-none" : ""
        }`}
      >
        {/* PathBar — prominent navigation control, inside the framed panel */}
        <div className="px-3 pt-3 pb-2 border-b border-base-content/10">
          <PathBar
            currentPath={currentPath}
            containerKind={containerKind}
            editionAddresses={editionAddresses}
            container={currentContainer}
            containerDisplayName={containerDisplayName}
            isInfoOpen={isInfoOpen}
            onToggleInfo={() => setIsInfoOpen(v => !v)}
            onToggleSidebar={() => setIsSidebarOpen(v => !v)}
            disabled={isResolving || isResolvingEditions}
          />
        </div>

        {/* Container info band — expand/collapse controlled by PathBar's ITEM button */}
        {!pathError && isInfoOpen && (
          <div className="px-3 pt-3">
            <ContainerInfoPanel
              container={currentContainer}
              currentAnchorUID={currentAnchorUID}
              connectedAddress={connectedAddress}
              easAddress={easAddress}
              pathName={currentPath[currentPath.length - 1]?.name}
              containerDisplayName={containerDisplayName}
              expanded={isInfoOpen}
            />
          </div>
        )}

        {pathError && (
          <div role="alert" className="alert alert-error m-3">
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

        <div className="relative flex flex-row gap-3 flex-grow overflow-hidden">
          {/* Left Pane — sidebar tree. On `lg+` always visible; below `lg` rendered as an overlay
              when `isSidebarOpen`, with a backdrop to dismiss. */}
          {isSidebarOpen && (
            <div
              className="lg:hidden absolute inset-0 bg-black/40 z-10"
              onClick={() => setIsSidebarOpen(false)}
              aria-label="Close sidebar"
            />
          )}
          <aside
            className={`${
              isSidebarOpen ? "absolute top-0 left-0 bottom-0 z-20 bg-base-200 shadow-xl" : "hidden"
            } lg:static lg:block lg:shadow-none lg:bg-transparent w-64 flex-shrink-0 border-r border-base-300 overflow-y-auto p-2`}
          >
            <TopicTree
              rootUID={rootUID}
              selectedUID={currentAnchorUID}
              activeContainer={currentContainer}
              editionAddresses={editionAddresses}
              activeSortInfoUID={activeSortInfoUID}
              sortOverlayAddress={sortOverlayAddress}
              sortRefreshKey={sortRefreshKey}
              onSelect={(_uid, path) => {
                navigateToPath(path);
                setIsSidebarOpen(false);
              }}
              expandedUIDs={new Set(currentPath.map(p => p.uid))}
            />
          </aside>

          {/* Right Pane — file actions + browser + (optional) tag drawer */}
          <section className="flex-grow flex flex-col min-w-0">
            {!pathError && (
              <FileActionsBar
                currentAnchorUID={currentAnchorUID}
                container={currentContainer}
                anchorSchemaUID={anchorSchemaUID}
                dataSchemaUID={dataSchemaUID}
                propertySchemaUID={propertySchemaUID}
                tagSchemaUID={tagSchemaUID}
                mirrorSchemaUID={mirrorSchemaUID}
                indexerAddress={indexerAddress}
                easAddress={easAddress}
                sortOverlayAddress={sortOverlayAddress}
                editionAddresses={editionAddresses}
                activeSortInfoUID={activeSortInfoUID}
                onSortChange={handleSortChange}
                onSortProcessed={() => setSortRefreshKey(k => k + 1)}
                reverseOrder={reverseOrder}
                onReverseOrderChange={setReverseOrder}
                autoProcessKey={autoProcessKey}
                autoProcessSortUIDs={autoProcessSortUIDs}
                isFilterDrawerOpen={isFilterDrawerOpen}
                onToggleFilterDrawer={() => setIsFilterDrawerOpen(prev => !prev)}
                onFileCreated={sortUIDs => {
                  setAutoProcessSortUIDs(sortUIDs);
                  setAutoProcessKey(k => k + 1);
                }}
                onFolderCreated={() => setSortRefreshKey(k => k + 1)}
              />
            )}

            <div className="flex flex-row flex-grow overflow-hidden">
              <div className="flex-grow overflow-y-auto">
                {!pathError && (
                  <FileBrowser
                    currentAnchorUID={currentAnchorUID}
                    dataSchemaUID={dataSchemaUID}
                    editionAddresses={editionAddresses}
                    tagFilter={searchParams.get("tags") || ""}
                    drawerTagFilters={drawerTagFilters}
                    currentPathNames={
                      currentContainer
                        ? [currentContainer.rawSegment, ...currentPath.slice(1).map(p => p.name)]
                        : currentPath.slice(1).map(p => p.name)
                    }
                    activeSortInfoUID={activeSortInfoUID}
                    sortOverlayAddress={sortOverlayAddress}
                    sortRefreshKey={sortRefreshKey}
                    reverseOrder={reverseOrder}
                    onNavigate={(uid, name) => navigateToPath([...currentPath, { uid, name }])}
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
          </section>
        </div>
      </div>
    </div>
  );
}
