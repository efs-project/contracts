import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

const deploySortFunctions: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying sort functions with account:", deployer);

  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );

  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  const sortOverlay = await hre.ethers.getContract<Contract>("EFSSortOverlay", deployer);

  // ---- Deploy NameSort and TimestampSort ----

  await deploy("NameSort", {
    contract: "NameSort",
    from: deployer,
    args: [EAS_ADDRESS],
    log: true,
    autoMine: true,
  });
  const nameSort = await hre.ethers.getContract<Contract>("NameSort", deployer);
  console.log("NameSort deployed at:", nameSort.target);

  await deploy("TimestampSort", {
    contract: "TimestampSort",
    from: deployer,
    args: [EAS_ADDRESS],
    log: true,
    autoMine: true,
  });
  const timestampSort = await hre.ethers.getContract<Contract>("TimestampSort", deployer);
  console.log("TimestampSort deployed at:", timestampSort.target);

  // ---- Create /sorts/ system anchor ----

  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const sortInfoSchemaUID = await sortOverlay.SORT_INFO_SCHEMA_UID();
  const rootUID = await indexer.rootAnchorUID();

  const extractUID = (receipt: any): string | undefined => {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        // Not our event
      }
    }
    return undefined;
  };

  let sortsAnchorUID: string = await indexer.sortsAnchorUID();

  if (sortsAnchorUID === ethers.ZeroHash) {
    console.log("Creating '/sorts/' anchor under root...");
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: rootUID,
        data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["sorts", ethers.ZeroHash]),
        value: 0,
      },
    });
    const receipt = await tx.wait();
    sortsAnchorUID = extractUID(receipt) ?? ethers.ZeroHash;
    console.log("'/sorts/' anchor created:", sortsAnchorUID);

    // Register sortsAnchorUID in EFSIndexer
    await (await indexer.setSortsAnchor(sortsAnchorUID)).wait();
    console.log("EFSIndexer.sortsAnchorUID set:", sortsAnchorUID);
  } else {
    console.log("'/sorts/' anchor already exists:", sortsAnchorUID);
  }

  // ---- Create system sort naming anchors and SORT_INFO attestations ----
  // Each sort = a naming anchor in /sorts/ + a SORT_INFO attestation referencing it.
  // anchorSchema for naming anchors = SORT_INFO_SCHEMA_UID (marks them as sort concept anchors).

  const systemSorts = [
    {
      name: "ByName",
      label: "Name",
      sortFunc: nameSort.target as string,
      targetSchema: ethers.ZeroHash, // sort all anchor types
      sourceType: 0, // _children
    },
    {
      name: "ByDate",
      label: "Date",
      sortFunc: timestampSort.target as string,
      targetSchema: ethers.ZeroHash, // sort all anchor types
      sourceType: 0, // _children
    },
  ];

  for (const sort of systemSorts) {
    // Check if naming anchor already exists
    const existingNamingAnchor = await indexer.resolvePath(sortsAnchorUID, sort.name);
    let namingAnchorUID: string;

    if (existingNamingAnchor === ethers.ZeroHash) {
      console.log(`Creating naming anchor '${sort.name}' under /sorts/...`);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false,
          refUID: sortsAnchorUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "bytes32"],
            [sort.name, sortInfoSchemaUID], // anchorSchema = SORT_INFO_SCHEMA_UID marks this as a sort concept
          ),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      namingAnchorUID = extractUID(receipt) ?? ethers.ZeroHash;
      console.log(`Naming anchor '${sort.name}' created:`, namingAnchorUID);
    } else {
      namingAnchorUID = existingNamingAnchor;
      console.log(`Naming anchor '${sort.name}' already exists:`, namingAnchorUID);
    }

    if (namingAnchorUID === ethers.ZeroHash) {
      console.error(`Failed to get naming anchor UID for ${sort.name}, skipping SORT_INFO.`);
      continue;
    }

    // Check if SORT_INFO attestation already exists (deployer attester, referencing naming anchor)
    const existingCount = await indexer.getReferencingBySchemaAndAttesterCount(
      namingAnchorUID,
      sortInfoSchemaUID,
      deployer,
    );

    if (existingCount === 0n) {
      console.log(`Creating SORT_INFO for '${sort.name}' (${sort.label})...`);
      const sortInfoData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint8"],
        [sort.sortFunc, sort.targetSchema, sort.sourceType],
      );

      const tx = await eas.attest({
        schema: sortInfoSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: namingAnchorUID,
          data: sortInfoData,
          value: 0,
        },
      });
      const receipt = await tx.wait();
      const sortInfoUID = extractUID(receipt);
      console.log(`SORT_INFO for '${sort.name}' created:`, sortInfoUID);
    } else {
      console.log(`SORT_INFO for '${sort.name}' already exists — skipping.`);
    }
  }

  console.log("\nSort functions deployment complete.");
  console.log("  NameSort:      ", nameSort.target);
  console.log("  TimestampSort: ", timestampSort.target);
  console.log("  /sorts/ anchor:", sortsAnchorUID);
};

export default deploySortFunctions;
deploySortFunctions.tags = ["SortFunctions"];
deploySortFunctions.dependencies = ["SortOverlay"];
