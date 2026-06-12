"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { ContainerInfoPanel } from "~~/components/explorer/ContainerInfoPanel";
import { FileActionsBar } from "~~/components/explorer/FileActionsBar";
import { DrawerTagFilterState, FileBrowser } from "~~/components/explorer/FileBrowser";
import { OverviewPane } from "~~/components/explorer/OverviewPane";
import { PathBar } from "~~/components/explorer/PathBar";
import { TagFilterDrawer } from "~~/components/explorer/TagFilterDrawer";
import { TopicTree } from "~~/components/explorer/TopicTree";
import type { PathItem } from "~~/components/explorer/types";
import deployedContracts from "~~/contracts/deployedContracts";
import { useContainerName } from "~~/hooks/efs/useContainerName";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import {
  ClassifiedContainer,
  DEVNET_BOOTSTRAP_CURATOR,
  DEVNET_DEV_ATTESTER,
  buildRouterPathNames,
  classifyTopLevelSegment,
  defaultLensesForContainer,
} from "~~/utils/efs/containers";

export default function ExplorerClient() {
  const [currentPath, setCurrentPath] = useState<PathItem[]>([]);
  const [currentAnchorUID, setCurrentAnchorUID] = useState<string | null>(null);
  const [currentContainer, setCurrentContainer] = useState<ClassifiedContainer | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  const [resolvedLensAddresses, setResolvedLensAddresses] = useState<string[]>([]);
  const [isResolvingLenses, setIsResolvingLenses] = useState(false);

  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [drawerTagFilters, setDrawerTagFilters] = useState<Record<string, DrawerTagFilterState>>({
    nsfw: "exclude",
    system: "exclude",
  });

  const [sortRefreshKey, setSortRefreshKey] = useState(0);
  // Bumped after the Overview editor saves; flows into useItemOverview (via
  // OverviewPane's refreshKey) to force the pane to re-resolve the README.
  const [overviewRefreshKey, setOverviewRefreshKey] = useState(0);
  // Bumped when out-of-FileBrowser mutations add items to the current directory
  // (file upload, folder create). `CreateItemModal` lives under FileActionsBar,
  // not FileBrowser, so it can't call FileBrowser's internal `refetch*` hooks
  // directly. Delete is in-component and uses those directly; this key is the
  // parallel escape hatch for create. Without it, users had to hard-refresh to
  // see a newly-created file/folder appear.
  const [directoryRefreshKey, setDirectoryRefreshKey] = useState(0);
  const [recreatedListAnchor, setRecreatedListAnchor] = useState<string | undefined>(undefined);
  const [reverseOrder, setReverseOrder] = useState(false);
  const [autoProcessKey, setAutoProcessKey] = useState(0);
  const [autoProcessSortUIDs, setAutoProcessSortUIDs] = useState<string[]>([]);

  // Info band — externally controlled by PathBar's ItemButton.
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  // Sidebar — below `lg` it renders as an overlay, toggled via PathBar button.
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Static-export gotcha: with `output: "export"` every `/explorer/*` URL is
  // served by the single pre-rendered shell at `/explorer/index.html`
  // (generated from `generateStaticParams` returning the empty catch-all).
  // Reverse-proxies (Caddy on the devnet VPS, IPFS gateways honoring our
  // `public/_redirects`) rewrite deep URLs to that shell transparently — the
  // browser URL stays `/explorer/0xAbCd…/` but the HTML is the empty-path
  // shell. Next's `useParams()` then returns the pre-rendered params
  // (`path: undefined`) even though `window.location` clearly shows segments,
  // so the whole classifier path silently short-circuits to the root anchor.
  //
  // `usePathname()` is URL-derived — it always reflects `window.location`
  // after hydration — so it's the reliable source. We keep `params` as a
  // secondary signal (in dev it updates on `router.push` slightly before
  // `pathname`, though both converge within a tick) and prefer whichever
  // has segments. See the PR that introduced this comment for the
  // reproducing test (curl + static `spa-serve` + Chromium = same bug).
  const pathSegmentsFromParams = (() => {
    const p = params?.path;
    return Array.isArray(p) ? p : p ? [p] : [];
  })();
  const pathSegmentsFromPathname = (() => {
    if (!pathname) return [] as string[];
    // strip leading/trailing slashes, peel off the leading `/explorer/` prefix
    const trimmed = pathname.replace(/^\/+|\/+$/g, "");
    if (trimmed === "explorer") return [];
    if (!trimmed.startsWith("explorer/")) return [];
    return trimmed.slice("explorer/".length).split("/").map(decodeURIComponent).filter(Boolean);
  })();
  const pathSegments = pathSegmentsFromPathname.length > 0 ? pathSegmentsFromPathname : pathSegmentsFromParams;

  const sortParam = searchParams.get("sort");
  const activeSortInfoUID = sortParam || null;
  const publicClient = usePublicClient();
  // Mainnet client for ENS resolution only. `targetNetworks` in
  // `scaffold.config.ts` is `[hardhat]`, so the active `publicClient` above is
  // hardhat and has no ENS registry — `getEnsAddress` / `getEnsName` against
  // it throws and the catch branch silently drops the name, which is exactly
  // what the two P1 Codex comments flagged. `services/web3/wagmiConfig.tsx`
  // always adds mainnet to `enabledChains` for this reason; pulling the
  // `chainId: 1` client here is the same pattern `useDisplayName` uses. If
  // mainnet isn't reachable (offline, bad Alchemy key) the ENS lookup catches
  // and we fall through — no worse than the current behavior on hardhat.
  const mainnetPublicClient = usePublicClient({ chainId: 1 });
  const { address: connectedAddress } = useAccount();

  const lensesParam = searchParams.get("lenses");
  // `URLSearchParams.get` returns `null` when the param is absent, `""` when
  // present with empty value (`?lenses=`), and the string otherwise. A
  // truthy check collapses `null` and `""` into the same branch, but they
  // mean different things under ADR-0031: `null` = "no explicit lenses,
  // use defaults"; `""` = "explicitly scope to nothing" (e.g. a share-link
  // stripped of lens addresses — must NOT widen to default content).
  // Use `!== null` everywhere we care about the parameter's presence.
  const hasLensesParam = lensesParam !== null;

  // System tail-fallback tier (ADR-0039). On devnet: a bootstrap curator
  // address, the dev/demo attester, and the EFS deployer, so fresh users
  // see seeded + live-demo content before configuring any web of trust.
  // Deployer is a runtime read from the indexer; `Indexer.DEPLOYER` is an
  // immutable set in its constructor. Mainnet will replace all three with
  // a user-configurable list.
  const { data: deployerAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DEPLOYER",
  });

  const systemLenses = useMemo(() => {
    const out: string[] = [DEVNET_BOOTSTRAP_CURATOR, DEVNET_DEV_ATTESTER];
    if (deployerAddress && typeof deployerAddress === "string") out.push(deployerAddress);
    return out;
  }, [deployerAddress]);

  const lensAddresses = useMemo(() => {
    return defaultLensesForContainer({
      container: currentContainer,
      connectedAddress,
      explicitLenses: hasLensesParam ? resolvedLensAddresses : null,
      // Web of trust is not yet designed (ADR-0039). Empty array today;
      // slot exists so adding it later is a config-only change.
      webOfTrust: [],
      systemLenses,
    });
  }, [hasLensesParam, connectedAddress, resolvedLensAddresses, currentContainer, systemLenses]);

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
  // PIN (cardinality 1) and TAG (cardinality N) are sibling schemas served by EdgeResolver
  // (ADR-0041). Both UIDs are mirrored on the Indexer for convenient one-source reads.
  const { data: pinSchemaUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PIN_SCHEMA_UID",
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
  // OverviewPane (Task 13) reads file content via the router and lists the
  // Overview README via EFSFileView. These are deployed contracts whose
  // addresses aren't known until after `yarn deploy`, so pull them the same
  // way `indexerInfo`/`sortOverlayInfo` are pulled above.
  const { data: fileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });
  const { data: routerInfo } = useDeployedContractInfo({ contractName: "EFSRouter" });
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
  //
  // The third arg is the *container root* UID, not the leaf. For schema /
  // attestation containers the `name` PROPERTY is attached to the alias
  // anchor at root (ADR-0033 §2); navigating into a sub-path would otherwise
  // cause `useContainerName` to resolve labels off a descendant anchor and
  // mislabel the header with whatever short-hex or PROPERTY happens to live
  // there. `currentPath[0].uid` is the seed UID set during path resolution
  // (alias anchor when one exists, else the raw container UID), so it stays
  // stable across sub-path navigation within the same container.
  const { name: containerDisplayName } = useContainerName(
    currentContainer,
    connectedAddress,
    currentPath[0]?.uid ?? null,
  );

  // Lenses Resolution Effect — only needed for ENS name resolution in explicit ?lenses= param.
  // Cancel-guarded: ENS lookups are slow and a rapid `?lenses=` change can
  // complete out of order. Without the `cancelled` flag a stale query's
  // resolution could overwrite a newer one's addresses (or its "done" signal),
  // leaving the explorer rendering with the wrong lenses until the next nav.
  useEffect(() => {
    // Skip ONLY when the param is absent. An empty string (`?lenses=`) is
    // an explicit "scope to nothing" signal under ADR-0031 and must continue
    // through the resolver loop — `.split(",").filter(Boolean)` naturally
    // produces an empty name list, the loop is a no-op, and the resolver
    // writes `resolvedLensAddresses = []` at the bottom. Without this
    // distinction, navigating from `?lenses=alice.eth` to `?lenses=` would
    // leave a stale resolved list in state and silently broaden results.
    if (lensesParam === null) {
      setIsResolvingLenses(false);
      return;
    }

    let cancelled = false;

    const resolveLenses = async () => {
      setIsResolvingLenses(true);

      const lensNames = lensesParam
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const resolvedAddresses: string[] = [];

      for (const name of lensNames) {
        if (cancelled) return;
        // Lowercase once for suffix/prefix classification. ENS is
        // case-insensitive by spec (ENSIP-15 requires canonicalization before
        // resolution), and 0x/0X are equivalent for hex addresses. A URL like
        // `?lenses=Vitalik.ETH,0X1a2b…` must resolve identically to the
        // lowercase version — otherwise `resolvedLensAddresses` silently
        // drops the mixed-case tokens and the explorer falls back to the
        // default chain, breaking URL shareability (ADR-0031 / ADR-0033).
        const classifier = name.toLowerCase();
        if (classifier.endsWith(".eth")) {
          try {
            // Pass the lowercased label to viem; ENS resolution is insensitive
            // but some upstream libraries fail-closed on mixed case. A proper
            // UTS-46 `normalize()` is correct-er but lowercase covers the
            // `?lenses=Vitalik.ETH` class of regressions at zero cost.
            //
            // Resolve on MAINNET, not the active (hardhat) chain — hardhat has
            // no ENS registry, so using `publicClient` throws and the catch
            // silently drops the token, leaving the explorer to render the
            // wrong fallback lens. `mainnetPublicClient` is always present
            // (mainnet is unconditionally added in wagmiConfig for this
            // purpose); guard + skip if somehow absent.
            const addr = mainnetPublicClient
              ? await mainnetPublicClient.getEnsAddress({ name: classifier })
              : undefined;
            if (cancelled) return;
            // viem returns a checksummed address on success; normalize defensively
            // in case a future wagmi/viem version relaxes this.
            if (addr && isAddress(addr, { strict: false })) {
              resolvedAddresses.push(getAddress(addr));
            }
          } catch (e) {
            if (cancelled) return;
            console.error(`Failed to resolve ENS name ${name}`, e);
          }
        } else if (classifier.startsWith("0x") && name.length === 42) {
          // Validate raw-hex before forwarding downstream: wagmi/viem contract
          // reads pass lens addresses as an `address[]` and throw
          // InvalidAddressError on malformed entries, which would break
          // lens-scoped browsing wholesale rather than ignoring the bad
          // token. Accept any valid hex regardless of checksum case
          // (`strict: false`) — users hand-typing URLs won't have a correct
          // EIP-55 checksum — and normalize via getAddress so downstream
          // dedup / comparison is case-stable.
          //
          // Validate against `classifier` (lowercased prefix) rather than the
          // original `name`: viem rejects `0X…`-prefixed strings as invalid,
          // so an explicit token like `?lenses=0X1a2b…` would silently drop
          // despite the classifier check accepting it. `getAddress` normalizes
          // to checksummed form regardless of input case.
          if (isAddress(classifier, { strict: false })) {
            resolvedAddresses.push(getAddress(classifier as `0x${string}`));
          } else {
            console.warn(`Ignoring invalid lens address in ?lenses=: ${name}`);
          }
        } else {
          console.warn(`Ignoring unrecognized lens token in ?lenses=: ${name}`);
        }
      }

      if (cancelled) return;
      setResolvedLensAddresses(resolvedAddresses);
      setIsResolvingLenses(false);
    };

    resolveLenses();

    return () => {
      cancelled = true;
    };
  }, [lensesParam, mainnetPublicClient]);

  // Path Resolution Effect — cancel-guarded.
  //
  // Path resolution fires an arbitrary number of async `resolvePath` RPC reads
  // (one per segment, plus classifier + optional alias lookup). Rapid navigation
  // — especially on slow RPC — can leave an older resolution in flight after
  // the URL has already moved on; without cancellation, that stale resolution
  // would clobber `currentPath` / `currentAnchorUID` / `currentContainer` and
  // the UI would silently mutate a different folder than the URL indicates.
  // That's a create/delete correctness hazard, not just a cosmetic glitch.
  //
  // We flip `cancelled` in the effect cleanup and short-circuit before every
  // `setState` after an `await`. `setIsResolving(true)` at the top is the only
  // pre-await mutation; the cleanup itself overlaps with React's commit of the
  // next effect run, which will re-assert `setIsResolving(true)` immediately.
  useEffect(() => {
    // Wait for easAddress too — the top-level classifier needs it to
    // distinguish schema / attestation UIDs from anchor names. Running
    // before it loads misclassifies 64-hex segments as anchors.
    // `dataSchemaUID` is needed for last-segment file-leaf resolution
    // (mirrors EFSRouter.request: file anchors live under DATA_SCHEMA_UID,
    // not the default generic schema that `resolvePath` queries).
    if (
      !rootUID ||
      rootUID === "0x0000000000000000000000000000000000000000000000000000000000000000" ||
      !publicClient ||
      !easAddress ||
      !dataSchemaUID
    ) {
      return;
    }

    const chainId = publicClient.chain.id;
    const indexerConfig = deployedContracts[chainId as keyof typeof deployedContracts]?.Indexer;

    if (!indexerConfig) {
      console.error("Indexer contract not found for chain", chainId);
      return;
    }

    // `pathSegments` is derived above from pathname ∪ params; see the comment
    // next to the hooks for why useParams alone isn't reliable in static export.
    const segments = pathSegments;

    let cancelled = false;

    const resolveUrlPath = async () => {
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
            mainnetPublicClient,
            easAddress,
          });
          if (cancelled) return;
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
                if (cancelled) return;
                if (aliasUID && aliasUID !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
                  seedUID = aliasUID;
                }
              } catch (e) {
                if (cancelled) return;
                console.warn("Alias anchor lookup failed; falling back to raw UID", e);
              }
            }
          }
        }

        // Seed head PathItem. `urlSegment` carries the verbatim user-typed
        // segment for container walks (address/schema/attestation) so URL
        // builders can round-trip even when `name` is a shortened display
        // label like `0x8626…1199`. Anchor walks leave it unset — the head
        // is the root anchor and is never written to the URL.
        const resolvedPath: PathItem[] = [
          {
            uid: seedUID,
            name: rootLabel,
            urlSegment: container ? container.rawSegment : undefined,
          },
        ];
        let currentUID: `0x${string}` = seedUID;

        const ZERO_UID = "0x0000000000000000000000000000000000000000000000000000000000000000";
        for (let i = 0; i < walkSegments.length; i++) {
          const segment = walkSegments[i];
          const isLast = i === walkSegments.length - 1;

          // Mirror EFSRouter.request (EFSRouter.sol §container walk):
          //   - intermediate segments must be folders (generic-schema anchors) → resolvePath
          //   - the last segment may be a file leaf (DATA-schema anchor) OR a folder; try
          //     DATA first, fall back to generic. Without this fallback, deep-linking to
          //     `/explorer/docs/readme.txt` 404s even though the router serves the same
          //     URL correctly — the debug UI and the public router would silently disagree.
          let childUID: `0x${string}` = ZERO_UID;
          if (isLast) {
            childUID = (await publicClient.readContract({
              address: indexerConfig.address as `0x${string}`,
              abi: indexerConfig.abi,
              functionName: "resolveAnchor",
              args: [currentUID, segment, dataSchemaUID as `0x${string}`],
            })) as `0x${string}`;
            if (cancelled) return;
          }
          if (childUID === ZERO_UID) {
            childUID = (await publicClient.readContract({
              address: indexerConfig.address as `0x${string}`,
              abi: indexerConfig.abi,
              functionName: "resolvePath",
              args: [currentUID, segment],
            })) as `0x${string}`;
            if (cancelled) return;
          }

          if (childUID === ZERO_UID) {
            // "Folder" in the error text kept deliberately for intermediate segments;
            // for the last segment we checked both folder and file so the user's path
            // is genuinely missing either way.
            const errorMsg = `'${decodeURIComponent(segment)}' not found in path.`;
            console.warn(errorMsg);
            setPathError(errorMsg);
            setIsResolving(false);
            return;
          }

          // Preserve the original URL-encoded segment so rebuilding the URL
          // round-trips losslessly (matters for non-ASCII names that were
          // percent-encoded by the browser).
          resolvedPath.push({ uid: childUID, name: decodeURIComponent(segment), urlSegment: segment });
          currentUID = childUID;
        }

        if (cancelled) return;
        setCurrentPath(resolvedPath);
        setCurrentAnchorUID(currentUID);
        setCurrentContainer(container);

        // localStorage writes are side-effects on global state; keep them
        // inside the cancel guard so a stale resolution can't promote a
        // revisited address/attestation to the top of the "recent" list.
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
        if (cancelled) return;
        console.error("Failed to resolve path", err);
        setPathError("Failed to resolve path due to an error.");
      } finally {
        if (!cancelled) setIsResolving(false);
      }
    };

    resolveUrlPath();

    return () => {
      cancelled = true;
    };
    // Depend on the pathname string directly — it's stable across renders
    // and covers both the dev (`useParams`) and static-export (`usePathname`)
    // code paths. The derived `pathSegments` array would change identity
    // every render and thrash the effect, so we intentionally exclude it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootUID, pathname, publicClient, mainnetPublicClient, easAddress, dataSchemaUID]);

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
    // (e.g. "vitalik.eth"). Prefer `urlSegment` over `name` because `name` may
    // be a shortened display label (e.g. `0x8626…1199`) that won't round-trip
    // through the top-level container classifier.
    const skipHead = newPathItems[0]?.uid === rootUID;
    const urlSegments = newPathItems.slice(skipHead ? 1 : 0).map(p => p.urlSegment ?? encodeURIComponent(p.name));
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
    const urlSegments = currentPath.slice(skipHead ? 1 : 0).map(p => p.urlSegment ?? encodeURIComponent(p.name));
    const queryPart = currentQuery.toString() ? `?${currentQuery.toString()}` : "";
    router.push(`/explorer/${urlSegments.join("/")}${queryPart}`);
  };

  if (
    !rootUID ||
    !dataSchemaUID ||
    !anchorSchemaUID ||
    !propertySchemaUID ||
    !pinSchemaUID ||
    !tagSchemaUID ||
    !mirrorSchemaUID
  )
    return <div>Loading System...</div>;
  if (isResolvingLenses) return <div>Resolving Lenses...</div>;

  const containerKind = currentContainer?.kind ?? "anchor";

  // Overview edit/create gate. Requires a connected wallet that is also one of
  // the active lenses — the README is written under the connected wallet, but
  // the pane only queries `lensAddresses`, so authoring into a lens set that
  // excludes the writer (an explicit `?lenses=other` URL) would spend the
  // transactions yet never show the result. Also excludes the *synthetic
  // address-container root* (currentAnchorUID === container.uid): that parent
  // anchor isn't real, so the upload helper hard-reverts under it. Deeper
  // address paths resolve to a real anchor and are writable.
  const writerInActiveLenses =
    !!connectedAddress && lensAddresses.some(l => l.toLowerCase() === connectedAddress.toLowerCase());
  const overviewEditable =
    writerInActiveLenses &&
    !(currentContainer?.kind === "address" && currentAnchorUID?.toLowerCase() === currentContainer.uid.toLowerCase());

  return (
    <div className="flex flex-col h-screen w-full bg-base-100 p-4 gap-3">
      <div
        className={`flex flex-col rounded-xl bg-base-200 shadow-lg flex-grow overflow-hidden terminal-panel ${
          isResolving || isResolvingLenses ? "opacity-50 pointer-events-none" : ""
        }`}
      >
        {/* PathBar — prominent navigation control, inside the framed panel */}
        <div className="px-3 pt-3 pb-2 border-b border-base-content/10">
          <PathBar
            currentPath={currentPath}
            containerKind={containerKind}
            lensAddresses={lensAddresses}
            container={currentContainer}
            containerDisplayName={containerDisplayName}
            isInfoOpen={isInfoOpen}
            onToggleInfo={() => setIsInfoOpen(v => !v)}
            onToggleSidebar={() => setIsSidebarOpen(v => !v)}
            disabled={isResolving || isResolvingLenses}
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
              lensAddresses={lensAddresses}
              // Same semantics as FileBrowser.explicitLenses — whenever the
              // URL carries `?lenses=` (even empty), the sidebar must stay
              // lens-scoped so it doesn't silently render the unscoped tree.
              // ADR-0031 "explicit param must not widen results".
              explicitLenses={hasLensesParam}
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

          {/* Middle Pane — Overview (Task 13). Renders the directory's Overview
              markdown/file when one exists; the pane itself returns null when
              there's no Overview, so the layout naturally falls back to the
              two-pane (tree + file) arrangement. Hidden below `lg` to mirror
              how the tree `<aside>` collapses on narrow screens. */}
          {!pathError && (
            <div className="hidden lg:block">
              <OverviewPane
                key={currentAnchorUID ?? "none"}
                anchorUID={currentAnchorUID as `0x${string}` | null}
                lensAddresses={lensAddresses}
                resourcePathNames={buildRouterPathNames(currentContainer, currentPath)}
                publicClient={publicClient}
                fileViewAddress={fileViewInfo?.address as `0x${string}` | undefined}
                fileViewAbi={fileViewInfo?.abi}
                routerAddress={routerInfo?.address as `0x${string}` | undefined}
                routerAbi={routerInfo?.abi}
                dataSchemaUID={dataSchemaUID as `0x${string}` | undefined}
                refreshKey={overviewRefreshKey}
                canEdit={overviewEditable}
                editAnchorUID={currentAnchorUID as `0x${string}` | undefined}
                anchorSchemaUID={anchorSchemaUID as `0x${string}` | undefined}
                propertySchemaUID={propertySchemaUID as `0x${string}` | undefined}
                pinSchemaUID={pinSchemaUID as `0x${string}` | undefined}
                tagSchemaUID={tagSchemaUID as `0x${string}` | undefined}
                mirrorSchemaUID={mirrorSchemaUID as `0x${string}` | undefined}
                indexerAddress={indexerAddress}
                onOverviewSaved={() => setOverviewRefreshKey(k => k + 1)}
              />
            </div>
          )}

          {/* Right Pane — file actions + browser + (optional) tag drawer */}
          <section className="flex-grow flex flex-col min-w-0">
            {!pathError && (
              <FileActionsBar
                currentAnchorUID={currentAnchorUID}
                container={currentContainer}
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
                  setDirectoryRefreshKey(k => k + 1);
                }}
                onFolderCreated={() => {
                  setSortRefreshKey(k => k + 1);
                  setDirectoryRefreshKey(k => k + 1);
                }}
                onListCreated={(uid: string) => {
                  // Surface the (possibly reused) slot anchor so FileBrowser can lift any
                  // delete-suppression on it — recreating a deleted list reuses its anchor.
                  setRecreatedListAnchor(uid);
                  setDirectoryRefreshKey(k => k + 1);
                }}
              />
            )}

            <div className="flex flex-row flex-grow overflow-hidden">
              <div className="flex-grow overflow-y-auto">
                {!pathError && (
                  <FileBrowser
                    currentAnchorUID={currentAnchorUID}
                    dataSchemaUID={dataSchemaUID}
                    anchorSchemaUID={anchorSchemaUID}
                    lensAddresses={lensAddresses}
                    // True whenever the URL carries `?lenses=…`, INCLUDING
                    // `?lenses=` with an empty value (explicit "scope to
                    // nothing") and any failed-resolution case. FileBrowser
                    // keeps the view lens-scoped so unresolved or
                    // deliberately-empty explicit links render empty instead
                    // of silently falling back to the unscoped default —
                    // Codex P2 on PR #9, ADR-0031 "explicit param must not
                    // widen results". `hasLensesParam` uses `!== null`
                    // because `URLSearchParams.get` returns `""` for
                    // `?lenses=` and `null` only for the absent case.
                    explicitLenses={hasLensesParam}
                    tagFilter={searchParams.get("tags") || ""}
                    drawerTagFilters={drawerTagFilters}
                    currentPathNames={buildRouterPathNames(currentContainer, currentPath)}
                    activeSortInfoUID={activeSortInfoUID}
                    sortOverlayAddress={sortOverlayAddress}
                    sortRefreshKey={sortRefreshKey}
                    directoryRefreshKey={directoryRefreshKey}
                    recreatedListAnchor={recreatedListAnchor}
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
