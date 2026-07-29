import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Interface, Wallet } from "ethers";
import { buildArtifactBuffer } from "../src/build-artifact.js";
import { CONTRACTS, EAS_ABI, SCHEMAS, ZERO_BYTES32 } from "../src/constants.js";
import {
  buildStage1,
  buildStage2,
  buildStage3,
  interpretStage1,
  interpretStage2,
  interpretStage3,
} from "../src/efs.js";
import { rawFileCid } from "../src/ipfs-cid.js";
import {
  manifestDigest,
  recoverManifestSigner,
  typedManifest,
  validateManifest,
} from "../src/manifest.js";
import { verifyProof } from "../src/verifier.js";

function manifest(overrides = {}) {
  return {
    format: "efs-walk-away-proof/v0",
    artifactName: "efs-sepolia-deployment-reference-v0.tar.gz",
    artifactSha256: "d7fb518cef787833a38c0de78bf3dfda8f721c7f1f066bfd72b0e43a208abd38",
    artifactByteLength: 61495,
    builderCommit: "c6b4075308dd37bb36665eabecb66ec8b47fc7dd",
    compressor: "fflate@0.8.2",
    configSha256: "1".repeat(64),
    sourceRepository: "https://github.com/efs-project/contracts",
    sourceCommit: "c6b4075308dd37bb36665eabecb66ec8b47fc7dd",
    tarSha256: "2".repeat(64),
    signer: Wallet.createRandom().address,
    ipfsCid: "bafkreigx7niyz33ypaz2hdan46f7hx62r5zby7y7azv724vq4q5cbcv5ha",
    arweaveId: "test-arweave-id",
    ...overrides,
  };
}

async function signedFixture(bytes) {
  const wallet = Wallet.createRandom();
  const value = manifest({
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    artifactByteLength: bytes.length,
    ipfsCid: await rawFileCid(bytes),
    signer: wallet.address,
  });
  const typed = typedManifest(value);
  const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  return {
    manifest: value,
    proof: {
      manifestDigest: manifestDigest(value),
      signature,
      signer: wallet.address,
    },
  };
}

function response(bytes, ok = true, status = 200) {
  return {
    ok,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function receipt(schemas, hashByte) {
  const iface = new Interface(EAS_ABI);
  return {
    hash: `0x${hashByte.repeat(64)}`,
    logs: schemas.map((schema, index) => {
      const encoded = iface.encodeEventLog(iface.getEvent("Attested"), [
        Wallet.createRandom().address,
        Wallet.createRandom().address,
        `0x${String(index + 1).padStart(64, "0")}`,
        schema,
      ]);
      return { address: CONTRACTS.eas, topics: encoded.topics, data: encoded.data };
    }),
  };
}

test("artifact rebuild is byte-for-byte deterministic and pinned to reviewed metadata", async () => {
  const first = await buildArtifactBuffer();
  const second = await buildArtifactBuffer();
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.tarBytes, second.tarBytes);
  assert.match(createHash("sha256").update(first.bytes).digest("hex"), /^[0-9a-f]{64}$/);
  assert.match(await rawFileCid(first.bytes), /^bafkrei/);
  assert.ok(first.bytes.length < 100 * 1024);
});

test("manifest signing is portable and detects a changed manifest", async () => {
  const wallet = Wallet.createRandom();
  const value = manifest({ signer: wallet.address });
  validateManifest(value);
  const typed = typedManifest(value);
  const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  assert.equal(recoverManifestSigner(value, signature), wallet.address);
  assert.notEqual(recoverManifestSigner({ ...value, arweaveId: "changed" }, signature), wallet.address);
});

test("EFS requests preserve the DATA, PROPERTY, ANCHOR, MIRROR, and PIN graph", () => {
  const value = manifest();
  const stage1 = buildStage1(value);
  assert.deepEqual(stage1.map(request => request.schema), [SCHEMAS.data, SCHEMAS.property]);
  assert.equal(stage1[0].data.length, 1);
  assert.equal(stage1[1].data.length, 3);

  const result1 = {
    dataUid: `0x${"11".repeat(32)}`,
    properties: {
      contentHash: `0x${"12".repeat(32)}`,
      size: `0x${"13".repeat(32)}`,
      cid: `0x${"14".repeat(32)}`,
    },
  };
  const stage2 = buildStage2(value, value.signer, result1);
  assert.deepEqual(stage2.map(request => request.schema), [SCHEMAS.anchor, SCHEMAS.mirror]);
  assert.equal(stage2[0].data.length, 4);
  assert.equal(stage2[1].data.length, 2);
  assert.equal(stage2[0].data[3].refUID, ZERO_BYTES32);

  const result2 = {
    anchors: {
      contentHash: `0x${"21".repeat(32)}`,
      size: `0x${"22".repeat(32)}`,
      cid: `0x${"23".repeat(32)}`,
    },
    fileAnchorUid: `0x${"24".repeat(32)}`,
  };
  const stage3 = buildStage3(result1, result2);
  assert.deepEqual(stage3.map(request => request.schema), [SCHEMAS.pin]);
  assert.equal(stage3[0].data.length, 4);
});

test("receipt interpretation assigns EAS UIDs in request order", () => {
  const result1 = interpretStage1(
    receipt([SCHEMAS.data, SCHEMAS.property, SCHEMAS.property, SCHEMAS.property], "a"),
  );
  assert.equal(result1.dataUid, `0x${"1".padStart(64, "0")}`);
  assert.equal(result1.properties.contentHash, `0x${"2".padStart(64, "0")}`);
  assert.equal(result1.properties.cid, `0x${"4".padStart(64, "0")}`);

  const result2 = interpretStage2(
    receipt(
      [
        SCHEMAS.anchor,
        SCHEMAS.anchor,
        SCHEMAS.anchor,
        SCHEMAS.anchor,
        SCHEMAS.mirror,
        SCHEMAS.mirror,
      ],
      "b",
    ),
  );
  assert.equal(result2.anchors.contentHash, `0x${"1".padStart(64, "0")}`);
  assert.equal(result2.fileAnchorUid, `0x${"4".padStart(64, "0")}`);
  assert.equal(result2.mirrors.arweave, `0x${"6".padStart(64, "0")}`);

  const result3 = interpretStage3(
    receipt([SCHEMAS.pin, SCHEMAS.pin, SCHEMAS.pin, SCHEMAS.pin], "c"),
  );
  assert.equal(result3.pins.contentHash, `0x${"1".padStart(64, "0")}`);
  assert.equal(result3.pins.file, `0x${"4".padStart(64, "0")}`);
});

test("offline verification distinguishes valid bytes, tampering, and unavailability", async () => {
  const bytes = new TextEncoder().encode("public infrastructure should survive its author");
  const fixture = await signedFixture(bytes);

  const verified = await verifyProof(fixture.manifest, fixture.proof, {
    expectedSigner: fixture.manifest.signer,
    verifyEfs: false,
    fetchImpl: async () => response(bytes),
  });
  assert.equal(verified.outcome, "VERIFIED");

  const untrustedSigner = await verifyProof(fixture.manifest, fixture.proof, {
    verifyEfs: false,
    fetchImpl: async () => response(bytes),
  });
  assert.equal(untrustedSigner.outcome, "INVALID");

  const tampered = await verifyProof(fixture.manifest, fixture.proof, {
    expectedSigner: fixture.manifest.signer,
    verifyEfs: false,
    fetchImpl: async () => response(new TextEncoder().encode("tampered bytes")),
  });
  assert.equal(tampered.outcome, "INVALID");

  const unavailable = await verifyProof(fixture.manifest, fixture.proof, {
    expectedSigner: fixture.manifest.signer,
    verifyEfs: false,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(unavailable.outcome, "UNAVAILABLE");
});
