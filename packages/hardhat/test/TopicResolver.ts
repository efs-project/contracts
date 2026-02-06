import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("TopicResolver", function () {
  let accounts: Signer[];
  let sender: Signer;
  let recipient: Signer;

  let registry: Contract;
  let eas: Contract;
  let TopicResolver: Contract;
  let schemaId: string;

  const schemaDefinition = "string name";

  before(async () => {
    accounts = await ethers.getSigners();
    [sender, recipient] = accounts;
  });

  beforeEach(async () => {
    // Deploy schema registry and EAS
    const SchemaRegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = (await SchemaRegistryFactory.deploy()) as unknown as Contract;

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = (await EASFactory.deploy(await registry.getAddress())) as unknown as Contract;

    // Deploy topic validator
    const TopicResolverFactory = await ethers.getContractFactory("TopicResolver");
    TopicResolver = (await TopicResolverFactory.deploy(await eas.getAddress())) as unknown as Contract;

    // Register schema with the validator
    const tx = await registry.register(schemaDefinition, await TopicResolver.getAddress(), true);
    const receipt = await tx.wait();

    // Get schema UID
    const logs = receipt?.logs || [];
    const registeredLog = logs.find((log: any) => {
      try {
        const parsed = registry.interface.parseLog(log);
        return parsed?.name === "Registered";
      } catch {
        return false;
      }
    });

    // Safety check
    if (!registeredLog) throw new Error("Registered event not found");
    const parsedLog = registry.interface.parseLog(registeredLog);
    if (!parsedLog) throw new Error("Failed to parse log");
    schemaId = parsedLog.args.uid;
  });

  it("should validate a valid topic attestation", async function () {
    // Create a valid topic (name is not empty)
    const topicName = "TestTopic";
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [topicName]);

    const recipientAddress = await recipient.getAddress();

    // Make attestation
    const tx = await eas.attest({
      schema: schemaId,
      data: {
        recipient: recipientAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodedData,
        value: 0n,
      },
    });

    const receipt = await tx.wait();
    const uid = receipt.logs[0].topics[1]; // Attested event is usually first? Or parse it.

    // Just verify no revert
    expect(uid).to.not.be.undefined;
  });

  it("should reject an invalid topic attestation", async function () {
    // Create an invalid topic (empty name)
    const topicName = "";
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [topicName]);

    const recipientAddress = await recipient.getAddress();

    // Attempt to make attestation should fail
    await expect(
      eas.attest({
        schema: schemaId,
        data: {
          recipient: recipientAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: encodedData,
          value: 0n,
        },
      }),
    ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
  });
});
