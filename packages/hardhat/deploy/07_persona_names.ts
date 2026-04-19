import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) — match 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

// Deterministic Hardhat persona addresses (default mnemonic). Kept in sync with
// packages/nextjs/utils/scaffold-eth/hardhatAccounts.ts — localhost/devnet only.
// Seeds are used to populate `name` PROPERTY bindings so the UI can render
// human-readable labels for the burner wallets per ADR-0034 / ADR-0035.
const PERSONAS: { name: string; address: string }[] = [
  { name: "Satoshi Nakamoto", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  { name: "Hal Finney", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  { name: "Joseph Lubin", address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
  { name: "Wei Dai", address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
  { name: "David Chaum", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" },
  { name: "Phil Zimmermann", address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" },
  { name: "Adam Back", address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9" },
  { name: "Tim May", address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" },
  { name: "Eric Hughes", address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f" },
  { name: "Julian Assange", address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" },
  { name: "Vitalik Buterin", address: "0xBcd4042DE499D14e55001CcbB24a551F3b954096" },
  { name: "Austin Griffith", address: "0x71bE63f3384f5fb98995898A86B02Fb2426c5788" },
  { name: "Anthony Sassano", address: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a" },
  { name: "Danny Ryan", address: "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec" },
  { name: "Evan Van Ness", address: "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097" },
  { name: "Edward Snowden", address: "0xcd3B766CCDd6AE721141F452C550Ca635964ce71" },
  { name: "Tim Beiko", address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30" },
  { name: "Dankrad Feist", address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E" },
  { name: "Justin Drake", address: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0" },
  { name: "James Carnley", address: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199" },
];

/**
 * Seeds `name` PROPERTY bindings on each Hardhat persona address per the
 * unified model (ADR-0034, ADR-0035):
 *
 *   Anchor<PROPERTY>(recipient=addr, name="name")  ← TAG  ← PROPERTY(value=personaName)
 *
 * The name anchor uses `recipient=addr` rather than `refUID` because address
 * containers don't have an anchor attestation UID to hang off; the Anchor
 * schema's recipient-fallback rule (specs/02 §Anchor; ADR-0033) makes the
 * anchor's parent `bytes32(uint160(addr))` automatically.
 *
 * Localhost/devnet only — skipped on live networks. The deployer attests;
 * unconfigured viewers fall through to the deployer's edition per ADR-0016,
 * so the personas render correctly out of the box.
 */
const deployPersonaNames: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log(`Skipping persona name seeding on network "${hre.network.name}" (localhost/hardhat only).`);
    return;
  }

  const { deployer } = await hre.getNamedAccounts();
  const ethers = hre.ethers;

  console.log("Seeding persona name bindings with account:", deployer);

  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  const tagResolver = await ethers.getContract<Contract>("TagResolver", deployer);

  const anchorSchemaUID: string = await indexer.ANCHOR_SCHEMA_UID();
  const propertySchemaUID: string = await indexer.PROPERTY_SCHEMA_UID();
  const tagSchemaUID: string = await tagResolver.TAG_SCHEMA_UID();

  const addrToBytes32 = (addr: string): string => ethers.zeroPadValue(ethers.getAddress(addr), 32);

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

  for (const persona of PERSONAS) {
    const containerUID = addrToBytes32(persona.address);
    const addrChecksum = ethers.getAddress(persona.address);

    // 1. Resolve (or create) the "name" key anchor parented at the address container.
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, "name", propertySchemaUID);
    if (keyAnchorUID === ethers.ZeroHash) {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: addrChecksum,
          expirationTime: 0,
          revocable: false,
          refUID: ethers.ZeroHash,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["name", propertySchemaUID]),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      keyAnchorUID = extractUID(receipt) ?? ethers.ZeroHash;
      if (keyAnchorUID === ethers.ZeroHash) {
        console.error(`  ${persona.name} — failed to create name anchor, skipping`);
        continue;
      }
    }

    // 2. Skip if the deployer's active PROPERTY under this key anchor already matches.
    const existing: string[] = await tagResolver.getActiveTargetsByAttesterAndSchema(
      keyAnchorUID,
      deployer,
      propertySchemaUID,
      0,
      1,
    );
    if (existing.length > 0) {
      try {
        const att = await eas.getAttestation(existing[0]);
        const [value] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], att.data);
        if (value === persona.name) {
          console.log(`  ${persona.name} — already seeded`);
          continue;
        }
      } catch {
        // fall through and re-attest
      }
    }

    // 3. Attest free-floating PROPERTY(value=persona.name).
    const propTx = await eas.attest({
      schema: propertySchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: ethers.ZeroHash,
        data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], [persona.name]),
        value: 0,
      },
    });
    const propReceipt = await propTx.wait();
    const propertyUID = extractUID(propReceipt);
    if (!propertyUID) {
      console.error(`  ${persona.name} — failed to attest PROPERTY, skipping`);
      continue;
    }

    // 4. TAG(definition=keyAnchor, refUID=property, applies=true).
    await (
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: propertyUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bool"], [keyAnchorUID, true]),
          value: 0,
        },
      })
    ).wait();
    console.log(`  ${persona.name} — name bound to ${persona.address}`);
  }

  console.log("Persona name seeding complete.");
};

export default deployPersonaNames;
deployPersonaNames.tags = ["PersonaNames"];
// PROPERTY + TAG schemas are set in 01_indexer.ts / wireContracts().
deployPersonaNames.dependencies = ["Indexer", "Mirrors"];
