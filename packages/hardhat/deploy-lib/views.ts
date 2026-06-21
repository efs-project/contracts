// EFS read-views deploy (Phase D views) — the post-freeze, NON-FROZEN view layer.
//
// The three stateless read views — EFSFileView, EFSRouter, ListReader — are in NO schema UID and are
// freely redeployable (docs/DEPLOYMENT.md §0, specs/overview.md "Core contracts"). On a CreateX
// network (Sepolia/mainnet/pinned fork) `yarn deploy:efs` (the EFSCore tag → deploy/00_efs_core.ts)
// stands up the frozen foundation (7 CREATE3 proxies + 10 registered schemas) but deploys NONE of the
// views. This module is the single source for the views on those networks: the operator runs it AFTER
// the freeze ceremony via `yarn deploy:efs-views`.
//
// It binds to the proxy addresses that 00 registered (saved as hardhat-deploy named deployments
// "Indexer" / "EdgeResolver" / "ListEntryResolver") and reads the now-frozen schema UIDs off the
// proxies (e.g. indexer.DATA_SCHEMA_UID()). It NEVER redeploys a proxy or registers a schema. The
// views' addresses are not baked into any UID, so re-running is safe (redeploy-or-no-op via
// redeployIfArgsChanged + hardhat-deploy's bytecode dedupe).
//
// This step is deliberately NOT legacySuperseded — it's the intended post-freeze view deploy on
// CreateX networks. (02/03/09 remain the local/devnet path; they short-circuit where CreateX exists.)

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";
import { EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS } from "./addresses";

export interface ViewsDeployResult {
  efsFileView: string;
  efsRouter: string;
  listReader: string;
}

/// Deploy the 3 stateless read views against the proxy addresses that deploy/00_efs_core.ts
/// registered. Idempotent: re-running redeploys only if a constructor arg changed, else no-ops.
///
/// Guards: fails clearly if the frozen foundation (proxies + schemas) isn't present — i.e. if 00 (the
/// EFSCore tag) hasn't run on this network yet.
export async function deployViews(hre: HardhatRuntimeEnvironment): Promise<ViewsDeployResult> {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, getOrNull } = hre.deployments;
  const ethers = hre.ethers;
  // A signer for the view-binding read calls (getContractAt needs a runner that can .call()).
  const signer = await ethers.getSigner(deployer);

  // ── Guard: the frozen foundation must already exist. 00 saves the proxies as named deployments
  //    "Indexer" (=EFSIndexer proxy), "EdgeResolver", "ListEntryResolver" (see 00_efs_core.ts saveAs).
  const indexerDep = await getOrNull("Indexer");
  const edgeDep = await getOrNull("EdgeResolver");
  const listEntryDep = await getOrNull("ListEntryResolver");
  // WhiteoutResolver (ADR-0055) — saved by 00_efs_core.ts. Optional for forward-compat: an older
  // core deploy (pre-WHITEOUT) won't have it, so the views pass ZeroAddress (whiteout disabled) and
  // keep their exact prior behavior. A current core deploy always has it (7th RESOLVERS entry).
  const whiteoutDep = await getOrNull("WhiteoutResolver");
  const whiteoutAddr = whiteoutDep?.address ?? ethers.ZeroAddress;
  if (!indexerDep || !edgeDep || !listEntryDep) {
    throw new Error(
      "[efs-views] frozen foundation not found — the EFS core proxies (Indexer/EdgeResolver/" +
        "ListEntryResolver) are not deployed on this network. Run `yarn deploy:efs` (the EFSCore " +
        "tag → deploy/00_efs_core.ts) BEFORE deploying the views.",
    );
  }

  // Bind to the proxies. Read the frozen schema UIDs off the indexer/listEntry proxies — these are
  // now the registered, permanent UIDs (the view's address is in no UID, but it must reference the
  // right schema UIDs to read the right attestations).
  const indexer = await ethers.getContractAt("EFSIndexer", indexerDep.address, signer);
  const dataSchemaUID: string = await indexer.DATA_SCHEMA_UID();
  if (dataSchemaUID === ethers.ZeroHash) {
    throw new Error("[efs-views] indexer.DATA_SCHEMA_UID() is zero — core not initialized; run deploy:efs first.");
  }

  // Resolve SchemaRegistry via EAS (matches 03_router.ts / orchestrate.ts fallback pattern).
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  let schemaRegistryAddress: string;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }

  // ── EFSFileView(indexerProxy, edgeResolverProxy, whiteoutResolverProxy) ──────────────────────
  // ADR-0055: the 3rd arg is the WhiteoutResolver proxy (cross-lens negative mask). ZeroAddress
  // disables the negative-mask predicate (older core without WHITEOUT).
  const fileViewArgs = [indexerDep.address, edgeDep.address, whiteoutAddr];
  await redeployIfArgsChanged(hre, "EFSFileView", fileViewArgs);
  await deploy("EFSFileView", { from: deployer, args: fileViewArgs, log: true, autoMine: true });
  const fileView = await ethers.getContract<Contract>("EFSFileView", deployer);

  // ── EFSRouter(indexerProxy, EAS, edgeResolverProxy, schemaRegistry, dataSchemaUID, systemAccount)
  // ADR-0053: the router's default-lens fallback points at SystemAccount (the `system` lens), not
  // the deployer EOA. SystemAccount is saved by 00_efs_core.ts as a named deployment. If absent
  // (older core deploy), pass zero — the router constructor falls back to indexer.DEPLOYER().
  const systemAccountDep = await getOrNull("SystemAccount");
  const systemAccountAddr = systemAccountDep?.address ?? ethers.ZeroAddress;
  const routerArgs = [
    indexerDep.address,
    EAS_ADDRESS,
    edgeDep.address,
    schemaRegistryAddress,
    dataSchemaUID,
    systemAccountAddr,
    whiteoutAddr, // ADR-0055: cross-lens negative mask (ZeroAddress = disabled).
  ];
  await redeployIfArgsChanged(hre, "EFSRouter", routerArgs);
  await deploy("EFSRouter", { from: deployer, args: routerArgs, log: true, autoMine: true });
  const router = await ethers.getContract<Contract>("EFSRouter", deployer);

  // ── ListReader(EAS, listEntryResolverProxy, LIST_SCHEMA_UID, LIST_ENTRY_SCHEMA_UID) ─────────
  // The list schema UIDs are immutables on the ListEntry proxy (LIST_SCHEMA_UID) and self-derivable
  // (listEntrySchemaUID()); read them off-chain to bind the reader to the frozen UIDs.
  const listEntryResolver = await ethers.getContractAt("ListEntryResolver", listEntryDep.address, signer);
  const listSchemaUID: string = await listEntryResolver.LIST_SCHEMA_UID();
  const listEntrySchemaUID: string = await listEntryResolver.listEntrySchemaUID();
  const listReaderArgs = [EAS_ADDRESS, listEntryDep.address, listSchemaUID, listEntrySchemaUID];
  await redeployIfArgsChanged(hre, "ListReader", listReaderArgs);
  await deploy("ListReader", { from: deployer, args: listReaderArgs, log: true, autoMine: true });
  const listReader = await ethers.getContract<Contract>("ListReader", deployer);

  return {
    efsFileView: fileView.target as string,
    efsRouter: router.target as string,
    listReader: listReader.target as string,
  };
}
