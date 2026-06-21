import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { legacySuperseded } from "../deploy-lib/superseded";

// EAS Addresses (Sepolia) — same constants as 01_indexer.ts / 05_mirrors.ts.
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

// WHITEOUT deploy (ADR-0055) — LOCAL/DEVNET path. The cross-lens negative mask resolver + its
// WHITEOUT (per-name) schema (additive 10th schema, post-freeze) against the WhiteoutResolver proxy.
//
// On CreateX networks (Sepolia / mainnet / pinned fork) WHITEOUT is deployed by the orchestrated core
// (deploy/00_efs_core.ts → deploy-lib/orchestrate.ts: WhiteoutResolver is the 7th RESOLVERS entry,
// predicted/deployed/verified/registered/smoked alongside the other six), and the views pick up its
// proxy via deploy-lib/views.ts. So this script neutralizes wherever CreateX is present — matching
// 01/02/03/05/09 — and only runs on a local/devnet node with no CreateX, where it deploys a
// WhiteoutResolver proxy + registers the WHITEOUT schema so 02_fileview / 03_router can wire it.
//
// Ordering: numbered 08 so it runs BEFORE the view redeploys pick it up. 02_fileview / 03_router read
// the saved "WhiteoutResolver" deployment (getOrNull) and pass it as the extra constructor arg; both
// tolerate its absence (pass ZeroAddress = whiteout disabled) so a partial/legacy deploy still works.
const deployWhiteout: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (await legacySuperseded(hre, "08_whiteout")) return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying WhiteoutResolver with account:", deployer);

  // 1. Resolve EAS + SchemaRegistry (matches 01_indexer.ts fallback pattern).
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
  const schemaRegistry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    schemaRegistryAddress,
  );

  // 2. The deployed Indexer proxy (WhiteoutResolver reads getParent + ANCHOR_SCHEMA_UID; no writes).
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  console.log("Using EFSIndexer at:", indexer.target);

  // 3. Predict the WhiteoutResolver PROXY address (the resolver baked into the WHITEOUT schema UID).
  //    Two deployer txs: (impl) then (proxy). The proxy is the resolver — predict at nonce+1.
  const nonce = await ethers.provider.getTransactionCount(deployer);
  const futureProxyAddr = ethers.getCreateAddress({ from: deployer, nonce: nonce + 1 });
  const whiteoutDefinition = ""; // empty field string (ADR-0055) — pure-identity negative marker.
  const whiteoutRevocable = true;
  const whiteoutSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [whiteoutDefinition, futureProxyAddr, whiteoutRevocable],
  );
  console.log("Predicted WhiteoutResolver proxy:", futureProxyAddr);
  console.log("Pre-computed WHITEOUT_SCHEMA_UID:", whiteoutSchemaUID);

  // 4. Deploy the implementation (constructor: IEAS) then the proxy, initialized with the indexer.
  await deploy("WhiteoutResolverImpl", {
    contract: "WhiteoutResolver",
    from: deployer,
    args: [EAS_ADDRESS],
    log: true,
    autoMine: true,
  });
  const impl = await ethers.getContract<Contract>("WhiteoutResolverImpl", deployer);

  const initData = impl.interface.encodeFunctionData("initialize", [indexer.target]);
  await deploy("WhiteoutResolver", {
    contract: "TestERC1967Proxy",
    from: deployer,
    args: [impl.target, initData],
    log: true,
    autoMine: true,
  });
  const proxy = await ethers.getContract<Contract>("WhiteoutResolver", deployer);
  const deployerSigner = await ethers.getSigner(deployer);
  const whiteoutResolver = await ethers.getContractAt("WhiteoutResolver", proxy.target as string, deployerSigner);
  console.log("WhiteoutResolver (proxy) deployed at:", whiteoutResolver.target);

  if (whiteoutResolver.target !== futureProxyAddr) {
    console.warn(
      `WARNING: WhiteoutResolver proxy address differs from predicted (got ${whiteoutResolver.target}, ` +
        `expected ${futureProxyAddr}) — the WHITEOUT schema UID will not match; check the nonce offset.`,
    );
  }

  // 5. Register the WHITEOUT schema against the proxy (try/catch — idempotent if already registered).
  try {
    const tx = await schemaRegistry.register(whiteoutDefinition, whiteoutResolver.target, whiteoutRevocable);
    await tx.wait();
    console.log("Registered WHITEOUT schema:", whiteoutSchemaUID);
  } catch {
    console.log("Failed to register WHITEOUT (likely already exists). Skipping.");
  }

  // 6. Verify gate (local mirror of deploy-lib/verify.ts): the resolver self-derived the UID.
  const onchainUID = await whiteoutResolver.whiteoutSchemaUID();
  if (onchainUID.toLowerCase() !== whiteoutSchemaUID.toLowerCase()) {
    throw new Error(
      `WHITEOUT verify gate: WhiteoutResolver.whiteoutSchemaUID() ${onchainUID} != computed ${whiteoutSchemaUID}`,
    );
  }
  console.log("WhiteoutResolver deployment complete (self-UID verified).");
};

export default deployWhiteout;
deployWhiteout.tags = ["Whiteout"];
// Deploy before the view redeploys (02_fileview / 03_router) so they can wire the whiteout proxy.
deployWhiteout.dependencies = ["Indexer"];
