"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { FileBrowser } from "~~/components/explorer/FileBrowser";
import { FileTree } from "~~/components/explorer/FileTree";
import { PathItem, Toolbar } from "~~/components/explorer/Toolbar";
import deployedContracts from "~~/contracts/deployedContracts";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

export default function ExplorerPage() {
    const [currentPath, setCurrentPath] = useState<PathItem[]>([]);
    const [currentAnchorUID, setCurrentAnchorUID] = useState<string | null>(null);
    const [isResolving, setIsResolving] = useState(false);
    const [pathError, setPathError] = useState<string | null>(null);

    const router = useRouter();
    const params = useParams();
    const publicClient = usePublicClient();

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
        const url = `/explorer/${urlSegments.join("/")}`;
        router.push(url);
    };

    if (!rootUID || !dataSchemaUID || !anchorSchemaUID) return <div>Loading System...</div>;
    // We could show a specific "Resolving..." skeleton here if we want, but keeping global loading is safer for now.

    return (
        <div className="flex flex-col h-screen w-full bg-base-100 p-4 gap-4">
            <h1 className="text-3xl font-bold">EFS Explorer</h1>

            <div
                className={`flex flex-col gap-2 rounded-xl bg-base-200 p-4 shadow-lg flex-grow ${isResolving ? "opacity-50 pointer-events-none" : ""}`}
            >
                <Toolbar
                    currentPath={currentPath}
                    currentAnchorUID={currentAnchorUID}
                    anchorSchemaUID={anchorSchemaUID}
                    dataSchemaUID={dataSchemaUID}
                    onNavigate={uid => {
                        // Find path up to this UID
                        const index = currentPath.findIndex(p => p.uid === uid);
                        if (index !== -1) {
                            navigateToPath(currentPath.slice(0, index + 1));
                        }
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

                <div className="flex flex-row gap-4 h-full overflow-hidden">
                    {/* Left Pane - Tree */}
                    <div className="w-1/4 min-w-[200px] border-r border-base-300 pr-2 overflow-y-auto">
                        <FileTree
                            rootUID={rootUID}
                            selectedUID={currentAnchorUID}
                            onSelect={(uid, path) => {
                                // Path from Tree includes Root?
                                // Tree logic: `onSelect(uid, [{ uid, name }, ...p])` recursively.
                                // The top level adds Root?
                                // Let's check FileTree.tsx again.
                                // Actually, FileTree passes the *full* path if we structured it right?
                                // FileTree implementation:
                                // Recursive: `(id, p) => onSelect(id, [{ uid, name }, ...p])`
                                // Top level: `onSelect={onSelect}` (just passes `uid, path`)
                                // Top level element: `<TreeNode uid={rootUID} name="Root" ... />`
                                // So yes, the path from Tree includes Root at the end/start depending on order.
                                // My recursive logic was `[{uid, name}, ...p]`.
                                // So Child calls parent with `[Child]`. Parent adds itself `[Parent, Child]`.
                                // So the array is [Root, ..., Leaf].
                                navigateToPath(path);
                            }}
                        />
                    </div>

                    {/* Right Pane - Browser */}
                    <div className="flex-grow overflow-y-auto">
                        {!pathError && (
                            <FileBrowser
                                currentAnchorUID={currentAnchorUID}
                                dataSchemaUID={dataSchemaUID}
                                onNavigate={(uid, name) => {
                                    // Append to current path
                                    navigateToPath([...currentPath, { uid, name }]);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
