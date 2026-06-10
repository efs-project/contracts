import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";
import { legacySuperseded } from "./lib/superseded";

// EAS Addresses (Sepolia) — same as 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

// Canonical schema field strings (ADR-0044). These must never change post-mainnet.
const LIST_DEFINITION =
  "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries";
// ADR-0046: LIST_ENTRY is pure membership identity. Order + label are PROPERTYs
// on the (stable) entry UID, not schema fields — so reorder doesn't churn the UID.
const LIST_ENTRY_DEFINITION = "bytes32 listUID, bytes32 target";

const deployLists: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // AGENT-NOTE (Phase D): List/ListEntry resolver deploy + LIST/LIST_ENTRY register are now done by
  // deploy/00_efs_core.ts (orchestrated CREATE3, register-last; ADR-0048). Neutralized. ListReader
  // (a stateless view, in no UID) is redeployable and its rebind to the proxies is deferred to D2.
  if (await legacySuperseded(hre, "09_lists")) return;

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

  // Safe-abort on a *partial* prior deploy. The `+3` nonce offset for ListEntryResolver
  // is only valid on a fully-fresh run (ListResolver + the two schema registrations
  // consume nonces 0..2 before it). If a prior deploy persisted ListResolver but crashed
  // before ListEntryResolver, hardhat-deploy now skips ListResolver (no nonce consumed),
  // so the offset is wrong — predicting a bad address and risking a *stray* LIST_ENTRY
  // schema registered against the wrong resolver. We can't safely recover the original
  // prediction from a fresh nonce, so fail loudly instead of corrupting. (Fresh deploy:
  // neither exists → no abort. Full re-run: both exist → addresses from getOrNull → no
  // abort.) The pinned-fork path always redeploys fresh, so this only guards a crashed
  // mid-deploy on a persistent network.
  if (existingListResolver && !existingListEntryResolver) {
    throw new Error(
      "Partial Lists deploy detected: ListResolver exists but ListEntryResolver does not. " +
        "The nonce prediction can't safely resume this state. Wipe the Lists deployments " +
        "(rm packages/hardhat/deployments/<network>/List*.json) and redeploy from clean.",
    );
  }

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

  // Register a schema, tolerating ONLY a genuine "already registered" state — verified by
  // reading the schema back, not by assuming every revert means AlreadyExists. Any other
  // failure (transient RPC, wrong registry address, insufficient funds, or a nonce-consuming
  // revert that would also invalidate the precomputed resolver address) is re-thrown, so a
  // broken deploy never silently looks successful (Codex review). EAS `AlreadyExists` reverts
  // before sending a tx, so re-runs stay idempotent (no nonce consumed).
  const registerSchema = async (
    definition: string,
    resolver: string,
    revocable: boolean,
    expectedUID: string,
    label: string,
  ) => {
    console.log(`Registering ${label} schema (${expectedUID})...`);
    // Read the schema back. Returns true (registered), false (readable but absent), or null
    // (UNREADABLE — the SchemaRegistry address has no code, e.g. CI's no-EAS hardhat node;
    // getSchema then returns "0x" and ethers throws BAD_DATA). null ⇒ no EAS present, so we
    // can't verify and degrade gracefully (ADR-0028) instead of failing the deploy.
    const isRegistered = async (): Promise<boolean | null> => {
      try {
        const rec = await schemaRegistry.getSchema(expectedUID);
        return !!(rec?.uid && rec.uid.toLowerCase() === expectedUID.toLowerCase());
      } catch {
        return null;
      }
    };
    try {
      const tx = await schemaRegistry.register(definition, resolver, revocable);
      await tx.wait();
    } catch (err) {
      // Tolerate ONLY a genuine "already registered" state — not by assuming every revert is
      // AlreadyExists. Re-throw real failures (transient RPC, insufficient funds, etc.).
      const reg = await isRegistered();
      if (reg === true) {
        console.log(`${label} schema already registered — skipping.`);
        return;
      }
      if (reg === null) {
        console.warn(`${label}: SchemaRegistry unreadable (no EAS?) — skipping registration (ADR-0028).`);
        return;
      }
      console.error(`${label} schema registration failed and the schema is NOT registered.`);
      throw err; // reg === false
    }
    // Verify after success too — a tx to a wrong / code-less SchemaRegistry can "succeed"
    // without registering anything, leaving a deploy that looks fine but can't attest.
    const reg = await isRegistered();
    if (reg === false) {
      throw new Error(
        `${label} schema is not registered at ${expectedUID} after register() — wrong SchemaRegistry address?`,
      );
    }
    if (reg === null) {
      console.warn(`${label}: SchemaRegistry unreadable — skipping post-register verify (ADR-0028).`);
    } else {
      console.log(`${label} schema registered (${expectedUID}).`);
    }
  };

  // 4. Register LIST schema (revocable: false — permanent list identity, like DATA).
  await registerSchema(LIST_DEFINITION, futureListResolverAddress, false, listSchemaUID, "LIST");
  // 5. Register LIST_ENTRY schema (revocable: true — entries removable unless list.appendOnly).
  await registerSchema(LIST_ENTRY_DEFINITION, futureListEntryResolverAddress, true, listEntrySchemaUID, "LIST_ENTRY");

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
