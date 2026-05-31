import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";

// EAS Addresses (Sepolia) — same as 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

// Canonical schema field strings (ADR-0044). These must never change post-mainnet.
const LIST_DEFINITION =
  "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries";
// ADR-0046: LIST_ENTRY is pure membership identity. Order + label are PROPERTYs
// on the (stable) entry UID, not schema fields — so reorder doesn't churn the UID.
const LIST_ENTRY_DEFINITION = "bytes32 listUID, bytes32 target";

const deployLists: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, getOrNull } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFS Lists contracts with account:", deployer);

  // 1. Get EAS and SchemaRegistry
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

  // 2. Nonce prediction
  // Fresh-deploy order (nonces consumed in sequence):
  //   nonce+0: Deploy ListResolver
  //   nonce+1: Register LIST schema (tx to SchemaRegistry)
  //   nonce+2: Register LIST_ENTRY schema (tx to SchemaRegistry)
  //   nonce+3: Deploy ListEntryResolver
  //   nonce+4: Deploy ListReader
  //
  // Re-runs are idempotent: schema registration try/catches AlreadyExists (no nonce
  // consumed). BUT nonce prediction is only valid on a FRESH deploy — on a re-run the
  // resolvers already exist (hardhat-deploy skips them, consuming no nonce), so the
  // deployer's current nonce no longer maps to ListResolver's create-address and the
  // assertions below would throw (the schemas are already registered at the original
  // addresses anyway). So prefer the already-deployed address when present, and only
  // nonce-predict the addresses that don't exist yet.
  const existingListResolver = await getOrNull("ListResolver");
  const existingListEntryResolver = await getOrNull("ListEntryResolver");
  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureListResolverAddress =
    existingListResolver?.address ?? ethers.getCreateAddress({ from: deployer, nonce: currentNonce });
  const futureListEntryResolverAddress =
    existingListEntryResolver?.address ?? ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 3 });
  console.log("Predicted ListResolver Address:      ", futureListResolverAddress);
  console.log("Predicted ListEntryResolver Address: ", futureListEntryResolverAddress);

  // Schema UIDs are deterministic: keccak256(definition, resolverAddress, revocable).
  // These are Etched once registered on mainnet — changing either string or address orphans all
  // existing LIST/LIST_ENTRY attestations.
  const listSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [LIST_DEFINITION, futureListResolverAddress, false],
  );
  const listEntrySchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [LIST_ENTRY_DEFINITION, futureListEntryResolverAddress, true],
  );
  console.log("Pre-computed LIST_SCHEMA_UID:        ", listSchemaUID);
  console.log("Pre-computed LIST_ENTRY_SCHEMA_UID:  ", listEntrySchemaUID);

  // 3. Deploy ListResolver (nonce+0)
  // Stateless — validates LIST attestation shape only. No args depend on other deployed contracts.
  await deploy("ListResolver", {
    contract: "ListResolver",
    from: deployer,
    args: [EAS_ADDRESS],
    log: true,
    autoMine: true,
  });

  const listResolver = await ethers.getContract<Contract>("ListResolver", deployer);
  console.log("ListResolver deployed at:", listResolver.target);

  if (listResolver.target !== futureListResolverAddress) {
    throw new Error(
      `ListResolver deployed at wrong address — LIST_SCHEMA_UID would be wrong.\n` +
        `Expected: ${futureListResolverAddress}\n` +
        `Got:      ${listResolver.target}\n` +
        `Adjust the nonce offset in the deploy script and redeploy.`,
    );
  }

  // 4. Register LIST schema (nonce+1)
  // revocable: false — LIST is a permanent list identity (like DATA for content).
  console.log(`Registering LIST schema (${listSchemaUID})...`);
  try {
    const tx = await schemaRegistry.register(LIST_DEFINITION, futureListResolverAddress, false);
    await tx.wait();
    console.log("Registered LIST schema");
  } catch {
    console.log("LIST schema already exists. Skipping.");
  }

  // 5. Register LIST_ENTRY schema (nonce+2)
  // revocable: true — entries are removable (unless list.appendOnly).
  console.log(`Registering LIST_ENTRY schema (${listEntrySchemaUID})...`);
  try {
    const tx = await schemaRegistry.register(LIST_ENTRY_DEFINITION, futureListEntryResolverAddress, true);
    await tx.wait();
    console.log("Registered LIST_ENTRY schema");
  } catch {
    console.log("LIST_ENTRY schema already exists. Skipping.");
  }

  // 6. Deploy ListEntryResolver (nonce+3)
  // Stateful: EntryRecord[] wide storage, entryCount, swap-and-pop index.
  // Constructor needs LIST_SCHEMA_UID to validate entry → list linkage.
  const listEntryResolverArgs = [EAS_ADDRESS, listSchemaUID];
  await redeployIfArgsChanged(hre, "ListEntryResolver", listEntryResolverArgs);
  await deploy("ListEntryResolver", {
    contract: "ListEntryResolver",
    from: deployer,
    args: listEntryResolverArgs,
    log: true,
    autoMine: true,
  });

  const listEntryResolver = await ethers.getContract<Contract>("ListEntryResolver", deployer);
  console.log("ListEntryResolver deployed at:", listEntryResolver.target);

  if (listEntryResolver.target !== futureListEntryResolverAddress) {
    throw new Error(
      `ListEntryResolver deployed at wrong address — LIST_ENTRY_SCHEMA_UID would be wrong.\n` +
        `Expected: ${futureListEntryResolverAddress}\n` +
        `Got:      ${listEntryResolver.target}\n` +
        `Adjust the nonce offset in the deploy script and redeploy.`,
    );
  }

  // 7. Deploy ListReader (nonce+4)
  // Stateless view layer — redeployable without breaking any schema UID. Address is NOT baked
  // into either schema (that's ListResolver + ListEntryResolver). Safe to redeploy at any time.
  const listReaderArgs = [EAS_ADDRESS, listEntryResolver.target, listSchemaUID, listEntrySchemaUID];
  await redeployIfArgsChanged(hre, "ListReader", listReaderArgs);
  await deploy("ListReader", {
    contract: "ListReader",
    from: deployer,
    args: listReaderArgs,
    log: true,
    autoMine: true,
  });

  const listReader = await ethers.getContract<Contract>("ListReader", deployer);
  console.log("ListReader deployed at:", listReader.target);

  // 8. Freeze invariant check
  // Read LIST_SCHEMA_UID back from ListEntryResolver's immutable and assert it matches what we
  // registered. If they differ, the nonce prediction was wrong and the LIST schema points at a
  // different resolver than the one that will enforce entries — a silent protocol break.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storedListSchemaUID = await (listEntryResolver as any).LIST_SCHEMA_UID();
  if (storedListSchemaUID !== listSchemaUID) {
    throw new Error(
      `LIST_SCHEMA_UID mismatch — resolver wiring is broken.\n` +
        `Expected: ${listSchemaUID}\n` +
        `Got:      ${storedListSchemaUID}`,
    );
  }
  console.log("✓ Freeze invariant check passed: LIST_SCHEMA_UID consistent");

  console.log("\nEFS Lists deployment complete.");
  console.log("  LIST_SCHEMA_UID:       ", listSchemaUID);
  console.log("  LIST_ENTRY_SCHEMA_UID: ", listEntrySchemaUID);
  console.log("  ListResolver:          ", listResolver.target);
  console.log("  ListEntryResolver:     ", listEntryResolver.target);
  console.log("  ListReader:            ", listReader.target);
};

export default deployLists;
deployLists.tags = ["Lists"];
deployLists.dependencies = ["Indexer"];
