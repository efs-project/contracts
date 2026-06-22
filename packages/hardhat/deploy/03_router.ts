import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";
import { legacySuperseded } from "../deploy-lib/superseded";

const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

const deployEFSRouter: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // AGENT-NOTE (Phase D, I-3): EFSRouter is a stateless view (redeployable, in no UID). Not on the
  // Sepolia freeze path (`yarn deploy:efs` runs the EFSCore tag only). A plain `yarn deploy` would
  // bind via getContract("Indexer") + indexer.DATA_SCHEMA_UID() against the proxies, untested.
  // Neutralize wherever CreateX is present, matching 01/04/05/09. Local/devnet still deploys it.
  if (await legacySuperseded(hre, "03_router")) return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSRouter with account:", deployer);

  // Get Deployed Indexer
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  if (!indexer) {
    throw new Error("EFSIndexer not found! Make sure 01_indexer.ts ran.");
  }

  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();

  // Get EdgeResolver (deployed in 01_indexer.ts)
  const edgeResolverDeployment = await hre.deployments.get("EdgeResolver");

  // Resolve SchemaRegistry via EAS (matches 01_indexer.ts fallback pattern)
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  let schemaRegistryAddress: string;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    console.log("Could not fetch SchemaRegistry from EAS, defaulting to known address.");
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }

  // WhiteoutResolver (ADR-0055) — deployed by 08_whiteout.ts on the local/devnet path. Optional:
  // ZeroAddress disables the cross-lens negative terminal (a partial deploy without 08).
  const whiteoutDep = await hre.deployments.getOrNull("WhiteoutResolver");
  const whiteoutAddr = whiteoutDep?.address ?? ethers.ZeroAddress;

  // Legacy/devnet path: no SystemAccount (ADR-0053) here — pass zero so the router falls back to
  // indexer.DEPLOYER() for the default lens, preserving the pre-ADR-0053 devnet behavior exactly.
  const routerArgs = [
    indexer.target,
    EAS_ADDRESS,
    edgeResolverDeployment.address,
    schemaRegistryAddress,
    dataSchemaUID,
    ethers.ZeroAddress,
    whiteoutAddr,
  ];
  await redeployIfArgsChanged(hre, "EFSRouter", routerArgs);

  await deploy("EFSRouter", {
    from: deployer,
    args: routerArgs,
    log: true,
    autoMine: true,
  });

  const router = await ethers.getContract<Contract>("EFSRouter", deployer);
  console.log("EFSRouter deployed at:", router.target);
};

export default deployEFSRouter;
deployEFSRouter.tags = ["EFSRouter"];
// Depend on "WhiteoutResolver" (08_whiteout) so it runs BEFORE this router on a plain local
// `hardhat deploy` — hardhat-deploy runs scripts lexicographically (08 after 03) and only recurses
// declared dependencies, so without this the getOrNull("WhiteoutResolver") read below is null and
// the router deploys with ZeroAddress (whiteout negative-terminal silently disabled until a manual
// redeploy). The 08_whiteout script neutralizes on CreateX networks, where the orchestrated core
// wires whiteout via deploy-lib/views.ts instead — so the dependency is a no-op there.
deployEFSRouter.dependencies = ["Indexer", "WhiteoutResolver"];
