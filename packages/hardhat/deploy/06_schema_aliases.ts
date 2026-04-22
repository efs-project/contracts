import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) — match 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

/**
 * Per ADR-0033, root is special: URLs like `/0x<schemaUID>/...` resolve via an
 * *alias anchor* at root whose name IS the schema UID in lowercase 0x-hex. The
 * alias carries EFS-native metadata (a `name` value for the human label, plus
 * any user PROPERTYs / sub-anchors / TAGs). Client sidebars enumerate schemas
 * by iterating TAGs whose `definition` is the `/tags/schema` anchor.
 *
 * Display-name values use the unified model (ADR-0034 / ADR-0035 / ADR-0041):
 *   Container → Anchor<PROPERTY>(name="name") → PIN → PROPERTY(value="ANCHOR")
 * The bind step uses **PIN** (cardinality 1) rather than TAG because a name
 * is an exclusive value: rebinding must supersede, never accumulate. Schema
 * discovery (`/tags/schema`) stays on TAG because it's a list of N alias
 * anchors per attester.
 *
 * At deploy we seed:
 *   - `/tags/schema/` — a regular tag definition under the existing `/tags/`
 *     anchor; acts as the category "this anchor is a schema alias."
 *   - One alias anchor per core EFS schema, as a direct child of root.
 *     Each alias gets:
 *       - `Anchor<PROPERTY>(refUID=aliasUID, name="name")` key anchor.
 *       - Free-floating `PROPERTY(value=<label>)`.
 *       - `PIN(definition=keyAnchor, refUID=property, weight=1)` from the
 *         deployer (Shape A — singleton per attester).
 *     …and a `/tags/schema` TAG from the deployer so sidebars find it (Shape B
 *     — list).
 *
 * Kernel auto-tagging of user-created aliases is deferred (see FUTURE_WORK) —
 * for now, user-created aliases need a follow-up tx to attach the `/tags/schema`
 * tag. The sidebar is seeded from deployer-attested TAGs at launch.
 */
const deploySchemaAliases: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const ethers = hre.ethers;

  console.log("Seeding schema alias anchors with account:", deployer);

  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );

  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  const edgeResolver = await ethers.getContract<Contract>("EdgeResolver", deployer);

  const anchorSchemaUID: string = await indexer.ANCHOR_SCHEMA_UID();
  const propertySchemaUID: string = await indexer.PROPERTY_SCHEMA_UID();
  const dataSchemaUID: string = await indexer.DATA_SCHEMA_UID();
  const mirrorSchemaUID: string = await indexer.MIRROR_SCHEMA_UID();
  const sortInfoSchemaUID: string = await indexer.SORT_INFO_SCHEMA_UID();
  const pinSchemaUID: string = await indexer.PIN_SCHEMA_UID();
  const tagSchemaUID: string = await indexer.TAG_SCHEMA_UID();

  // ADR-0028 graceful degradation: if earlier steps couldn't create anchors
  // (e.g. CI deploying against vanilla hardhat with no EAS registered, where
  // `eas.attest(...)` reverts silently and the try/catch in 01_indexer.ts
  // swallows it), rootUID / tagsUID stay zero. Skip-with-log rather than throw
  // so the rest of the deploy (07, 08, etc.) can still run — matching the
  // "Failed to find Attested event / Failed to get naming anchor UID"
  // skip-log pattern in 01_indexer.ts and 05_sort_functions.ts.
  const rootUID: string = await indexer.rootAnchorUID();
  if (rootUID === ethers.ZeroHash) {
    console.log("Skipping schema aliases — root anchor missing (likely no EAS in this environment).");
    return;
  }
  const tagsUID: string = await indexer.resolvePath(rootUID, "tags");
  if (tagsUID === ethers.ZeroHash) {
    console.log("Skipping schema aliases — '/tags/' anchor missing (likely no EAS in this environment).");
    return;
  }

  const extractUID = (receipt: any): string | undefined => {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        // not ours
      }
    }
    return undefined;
  };

  // Helper: attest the three-record `name` binding under a container (refUID = containerUID).
  // ADR-0041: bind step uses PIN. Idempotent — skips when the deployer's active
  // PIN already resolves to a PROPERTY whose value is `label`.
  const upsertNameOnAnchor = async (containerUID: string, label: string) => {
    // 1. Resolve (or create) the "name" key anchor under the container.
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, "name", propertySchemaUID);
    if (keyAnchorUID === ethers.ZeroHash) {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false,
          refUID: containerUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["name", propertySchemaUID]),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      keyAnchorUID = extractUID(receipt) ?? ethers.ZeroHash;
      if (keyAnchorUID === ethers.ZeroHash) throw new Error("Failed to create 'name' key anchor");
    }

    // 2. Skip if the deployer's active PIN under this key anchor already binds
    //    to a PROPERTY whose value matches `label`. PIN is genuinely singleton
    //    (ADR-0041) so this is a single O(1) read — no defensive newest-by-time
    //    walk needed (compare with the pre-PIN history in git blame).
    const existingPropertyUID: string = await edgeResolver.getActivePinTarget(
      keyAnchorUID,
      deployer,
      propertySchemaUID,
    );
    if (existingPropertyUID && existingPropertyUID !== ethers.ZeroHash) {
      try {
        const att = await eas.getAttestation(existingPropertyUID);
        const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], att.data);
        if ((decoded as string) === label) {
          return { keyAnchorUID, propertyUID: existingPropertyUID, skipped: true };
        }
      } catch {
        // Unresolvable — fall through and re-attest.
      }
    }

    // 3. Attest free-floating PROPERTY(value=label).
    const propTx = await eas.attest({
      schema: propertySchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: ethers.ZeroHash,
        data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], [label]),
        value: 0,
      },
    });
    const propReceipt = await propTx.wait();
    const propertyUID = extractUID(propReceipt);
    if (!propertyUID) throw new Error("Failed to create PROPERTY");

    // 4. PIN(definition=keyAnchor, refUID=property) — singleton bind.
    //    Re-attest at the same slot supersedes; revoke clears. PIN carries no
    //    per-entry metadata (cardinality 1 has no sort order to encode).
    await (
      await eas.attest({
        schema: pinSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: propertyUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [keyAnchorUID]),
          value: 0,
        },
      })
    ).wait();

    return { keyAnchorUID, propertyUID, skipped: false };
  };

  // 1. Create `/tags/schema/` — tag category the kernel uses to mark schema aliases.
  let tagsSchemaUID: string = await indexer.resolvePath(tagsUID, "schema");
  if (tagsSchemaUID === ethers.ZeroHash) {
    console.log("Creating '/tags/schema' Anchor...");
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: tagsUID,
        data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["schema", ethers.ZeroHash]),
        value: 0,
      },
    });
    const receipt = await tx.wait();
    tagsSchemaUID = extractUID(receipt) ?? ethers.ZeroHash;
    console.log("  '/tags/schema' created:", tagsSchemaUID);
  } else {
    console.log("  '/tags/schema' already exists:", tagsSchemaUID);
  }

  // 2. Seed one alias anchor per core schema.
  //    The alias's *name* is the schema UID in lowercase 0x-hex. Clients / the
  //    router treat a root anchor whose name matches a registered schema UID
  //    as the EFS-native representation of that schema.
  const systemSchemas: { label: string; uid: string }[] = [
    { label: "ANCHOR", uid: anchorSchemaUID },
    { label: "DATA", uid: dataSchemaUID },
    { label: "PROPERTY", uid: propertySchemaUID },
    { label: "PIN", uid: pinSchemaUID },
    { label: "TAG", uid: tagSchemaUID },
    { label: "MIRROR", uid: mirrorSchemaUID },
    { label: "SORT_INFO", uid: sortInfoSchemaUID },
  ];

  for (const schema of systemSchemas) {
    if (!schema.uid || schema.uid === ethers.ZeroHash) {
      console.log(`  Skipping ${schema.label} alias — schema UID not set (deployment order bug?).`);
      continue;
    }
    const aliasName = schema.uid.toLowerCase();

    let aliasUID: string = await indexer.resolvePath(rootUID, aliasName);
    if (aliasUID === ethers.ZeroHash) {
      console.log(`Creating alias Anchor for ${schema.label} (${aliasName})...`);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false,
          refUID: rootUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [aliasName, ethers.ZeroHash]),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      aliasUID = extractUID(receipt) ?? ethers.ZeroHash;
      console.log(`  ${schema.label} alias created:`, aliasUID);
    } else {
      console.log(`  ${schema.label} alias already exists:`, aliasUID);
    }
    if (aliasUID === ethers.ZeroHash) continue;

    // 2a. Attach the unified-model `name` binding (ADR-0035 + ADR-0041).
    const res = await upsertNameOnAnchor(aliasUID, schema.label);
    console.log(`  name binding for ${schema.label}: ${res.skipped ? "unchanged" : "attested"}`);

    // 2b. Attest `/tags/schema` TAG from the deployer so the sidebar enumerator
    //     finds it. Shape B (list of schema aliases per attester) — stays on TAG.
    //     Kernel-side auto-tagging (onAttest) will replace this for user-created
    //     aliases in a follow-up PR.
    if (tagsSchemaUID !== ethers.ZeroHash) {
      // _activeByAAS for (tagDef=/tags/schema, attester=deployer, ANCHOR_SCHEMA) stores the
      // anchor UIDs deployer has actively tagged as a schema alias.
      const existingTags: string[] = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        tagsSchemaUID,
        deployer,
        anchorSchemaUID,
        0,
        64,
      );
      let hasSchemaTag = false;
      for (const tagged of existingTags) {
        if (tagged.toLowerCase() === aliasUID.toLowerCase()) {
          hasSchemaTag = true;
          break;
        }
      }
      if (!hasSchemaTag) {
        await (
          await eas.attest({
            schema: tagSchemaUID,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0,
              revocable: true,
              refUID: aliasUID,
              data: ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "int256"], [tagsSchemaUID, 1n]),
              value: 0,
            },
          })
        ).wait();
        console.log(`  /tags/schema TAG attached for ${schema.label}`);
      }
    }
  }

  console.log("Schema alias anchor seeding complete.");
};

export default deploySchemaAliases;
deploySchemaAliases.tags = ["SchemaAliases"];
// Depends on Mirrors because PIN / TAG / MIRROR / SORT_INFO schema UIDs are wired in
// EFSIndexer only after 05_mirrors.ts runs wireContracts().
deploySchemaAliases.dependencies = ["Mirrors"];
