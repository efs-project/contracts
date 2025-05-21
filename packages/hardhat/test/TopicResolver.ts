import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer, ContractTransactionResponse } from "ethers";
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("TopicResolver", function() {
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
    registry = await SchemaRegistryFactory.deploy() as unknown as Contract;
    
    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress()) as unknown as Contract;
    
    // Deploy topic validator
    const TopicResolverFactory = await ethers.getContractFactory("TopicResolver");
    TopicResolver = await TopicResolverFactory.deploy(await eas.getAddress()) as unknown as Contract;
    
    // Register schema with the validator
    const tx = await registry.register(schemaDefinition, await TopicResolver.getAddress(), true);
    const receipt = await tx.wait();
    
    // Get schema UID from event
    const registeredEventFormat = registry.interface.getEvent("Registered")?.format("sighash") || "";
    const registeredEvent = receipt.logs
      .filter((log: any) => log.topics[0] === registeredEventFormat)
      .map((log: any) => registry.interface.parseLog({
        data: log.data,
        topics: log.topics
      }))[0];
    
    schemaId = registeredEvent?.args?.uid;
  });
  
  it("should validate a valid topic attestation", async function() {
    // Create a valid topic (name is not empty)
    const topicName = "Test Topic";
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [topicName]);
    
    // Make attestation
    const senderAddress = await sender.getAddress();
    const recipientAddress = await recipient.getAddress();
    
    const tx = await eas.attest({
      schema: schemaId,
      data: {
        recipient: recipientAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodedData,
        value: 0n
      }
    });
    
    const receipt = await tx.wait();
    
    // Get UID from event
    const attestedEventFormat = eas.interface.getEvent("Attested")?.format("sighash") || "";
    const attestedEvent = receipt.logs
      .filter((log: any) => log.topics[0] === attestedEventFormat)
      .map((log: any) => eas.interface.parseLog({
        data: log.data,
        topics: log.topics
      }))[0];
    
    const uid = attestedEvent?.args?.uid;
    
    // Verify attestation was created
    const attestation = await eas.getAttestation(uid);
    expect(attestation.uid).to.equal(uid);
  });
  
  it("should reject an invalid topic attestation", async function() {
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
          value: 0n
        }
      })
    ).to.be.revertedWithCustomError(eas, "AttestationRejected");
  });
});
