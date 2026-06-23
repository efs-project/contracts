import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, parseAbiItem, zeroAddress } from "viem";

type ResolveHookContext = { parentURL?: string };
type ResolveHookResult = { url: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveHookContext) => ResolveHookResult;
type ModuleWithRegisterHooks = {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveHookContext, nextResolve: NextResolve) => ResolveHookResult;
  }): void;
};

const { registerHooks } = (await import("node:module")) as unknown as ModuleWithRegisterHooks;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~~/")) {
      return { url: new URL(`../../${specifier.slice(3)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
      }
      throw e;
    }
  },
});

const { createExternalFileReference, uploadOnchainFile } = await import("../../lib/efs/uploadOnchainFile.ts");

const zero = `0x${"0".repeat(64)}` as const;
const account = `0x${"a".repeat(40)}` as const;
const easAddress = `0x${"e".repeat(40)}` as const;
const indexerAddress = `0x${"1".repeat(40)}` as const;
const edgeResolverAddress = `0x${"2".repeat(40)}` as const;

const rootUID = uid(1);
const transportsUID = uid(2);
const onchainTransportUID = uid(3);
const parentAnchorUID = uid(4);
const ipfsTransportUID = uid(5);

const anchorSchemaUID = uid(11);
const dataSchemaUID = uid(12);
const propertySchemaUID = uid(13);
const pinSchemaUID = uid(14);
const tagSchemaUID = uid(15);
const mirrorSchemaUID = uid(16);

const attestedEvent = parseAbiItem(
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
);

function uid(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function address(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function tx(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function attestedLog(schema: `0x${string}`, mintedUID: `0x${string}`) {
  return {
    address: easAddress,
    topics: encodeEventTopics({
      abi: [attestedEvent],
      eventName: "Attested",
      args: { recipient: zeroAddress, attester: account, schemaUID: schema },
    }),
    data: encodeAbiParameters([{ name: "uid", type: "bytes32" }], [mintedUID]),
  };
}

test("createExternalFileReference batches a pasted IPFS link with metadata and no storage deploys", async () => {
  const events: string[] = [];
  const readCalls: { functionName: string; args?: readonly unknown[] }[] = [];
  const sendTransactionCalls: unknown[] = [];
  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 600;
  let nextTx = 600;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    sendTransaction: async (args: unknown) => {
      sendTransactionCalls.push(args);
      return tx(nextTx++);
    },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      events.push(`write:${requests.map(request => `${request.schema}:${request.data.length}`).join(",")}`);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      readCalls.push({ functionName, args });
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "ipfs") return ipfsTransportUID;
      }
      if (functionName === "resolveAnchor") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await createExternalFileReference({
    name: "essay.md",
    mirrorUri: "ipfs://bafybeigdyrzt/example",
    transportName: "ipfs",
    contentType: "text/markdown",
    contentHash: uid(99),
    fileSize: 123n,
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    knownFileAnchorUID: null,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
    onCanCancelChange: (canCancel: boolean) => {
      events.push(`canCancel:${canCancel}`);
    },
  });

  assert.equal(sendTransactionCalls.length, 0, "pasted external links should not deploy SSTORE2 storage");
  assert.equal(writeCalls.length, 4, "external link save should use the same 4 layered multiAttest calls");
  assert.ok(
    readCalls.some(
      call => call.functionName === "resolvePath" && call.args?.[0] === transportsUID && call.args?.[1] === "ipfs",
    ),
    "should resolve /transports/ipfs before writing",
  );
  assert.equal(
    readCalls.filter(call => call.functionName === "resolveAnchor").length,
    0,
    "should trust the caller's checked-absent anchor hint and skip the duplicate pre-prompt read",
  );

  const mirrorRequest = writeCalls.flat().find(request => request.schema === mirrorSchemaUID);
  assert.ok(mirrorRequest, "expected a MIRROR multiAttest request");
  const [transportUID, uri] = decodeAbiParameters(
    [
      { name: "transport", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    mirrorRequest.data[0].data,
  );
  assert.equal(transportUID, ipfsTransportUID);
  assert.equal(uri, "ipfs://bafybeigdyrzt/example");

  const propertyValues = writeCalls
    .flat()
    .filter(request => request.schema === propertySchemaUID)
    .flatMap(request => request.data)
    .map(({ data }) => decodeAbiParameters([{ name: "value", type: "string" }], data)[0]);
  assert.deepEqual(propertyValues, ["text/markdown", uid(99), "123"]);

  const commitStart = events.indexOf("canCancel:false");
  const firstCommitWrite = events.findIndex(event => event === `write:${anchorSchemaUID}:1`);
  assert.ok(commitStart !== -1, "should notify the UI when app-level cancellation is no longer safe");
  assert.ok(firstCommitWrite !== -1, "expected a file-anchor commit write");
  assert.ok(commitStart < firstCommitWrite, "app-level cancellation must be disabled before commit writes are sent");
});

test("createExternalFileReference skips unknown pasted-link hash and size claims", async () => {
  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 700;
  let nextTx = 700;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "ipfs") return ipfsTransportUID;
      }
      if (functionName === "resolveAnchor") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await createExternalFileReference({
    name: "unknown.bin",
    mirrorUri: "ipfs://bafybeigdyrzt/unknown",
    transportName: "ipfs",
    contentType: "application/octet-stream",
    contentHash: zero,
    fileSize: 0n,
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  const propertyValues = writeCalls
    .flat()
    .filter(request => request.schema === propertySchemaUID)
    .flatMap(request => request.data)
    .map(({ data }) => decodeAbiParameters([{ name: "value", type: "string" }], data)[0]);
  assert.deepEqual(propertyValues, ["application/octet-stream"]);
});

test("createExternalFileReference rejects unsafe URI inputs before writing", async () => {
  const runRejectedCase = async (args: {
    mirrorUri: string;
    transportName: string;
    transportUID: `0x${string}` | null;
    message: RegExp;
  }) => {
    const readCalls: { functionName: string; args?: readonly unknown[] }[] = [];
    const sendTransactionCalls: unknown[] = [];
    const writeCalls: unknown[] = [];
    const walletClient = {
      account: { address: account },
      chain: { id: 31337 },
      sendTransaction: async (txArgs: unknown) => {
        sendTransactionCalls.push(txArgs);
        return tx(800 + sendTransactionCalls.length);
      },
      writeContract: async (writeArgs: unknown) => {
        writeCalls.push(writeArgs);
        return tx(900 + writeCalls.length);
      },
    };
    const publicClient = {
      readContract: async ({ functionName, args: readArgs }: { functionName: string; args?: readonly unknown[] }) => {
        readCalls.push({ functionName, args: readArgs });
        if (functionName === "rootAnchorUID") return rootUID;
        if (functionName === "resolvePath") {
          if (readArgs?.[0] === rootUID && readArgs?.[1] === "transports") return transportsUID;
          if (readArgs?.[0] === transportsUID && readArgs?.[1] === args.transportName) {
            return args.transportUID ?? zero;
          }
        }
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
      waitForTransactionReceipt: async () => {
        throw new Error("no writes should be submitted");
      },
    };

    await assert.rejects(
      createExternalFileReference({
        name: "bad-link",
        mirrorUri: args.mirrorUri,
        transportName: args.transportName,
        contentType: "application/octet-stream",
        contentHash: zero,
        fileSize: 0n,
        parentAnchorUID,
        fileAnchorRefUID: zero,
        fileAnchorRecipient: account,
        knownFileAnchorUID: null,
        walletClient: walletClient as any,
        publicClient: publicClient as any,
        chainId: 31337,
        easAddress,
        indexerAddress,
        indexerAbi: [],
        anchorSchemaUID,
        dataSchemaUID,
        propertySchemaUID,
        pinSchemaUID,
        tagSchemaUID,
        mirrorSchemaUID,
        edgeResolverAddress,
        edgeResolverAbi: [],
      }),
      args.message,
    );

    assert.equal(sendTransactionCalls.length, 0, "invalid pasted links must not deploy storage");
    assert.equal(writeCalls.length, 0, "invalid pasted links must not submit attestations");
    return readCalls;
  };

  const dataReads = await runRejectedCase({
    mirrorUri: "data:text/plain;base64,aGVsbG8=",
    transportName: "ipfs",
    transportUID: ipfsTransportUID,
    message: /Inline data: URIs/,
  });
  assert.equal(dataReads.length, 0, "data: rejection should happen before any RPC read");

  const mismatchReads = await runRejectedCase({
    mirrorUri: "ipfs://bafybeigdyrzt/mismatch",
    transportName: "https",
    transportUID: uid(61),
    message: /does not match transport 'https'/,
  });
  assert.equal(mismatchReads.length, 0, "transport mismatch should happen before any RPC read");

  const missingReads = await runRejectedCase({
    mirrorUri: "ipfs://bafybeigdyrzt/missing",
    transportName: "ipfs",
    transportUID: null,
    message: /Transport anchor '\/transports\/ipfs' not found/,
  });
  assert.ok(
    missingReads.some(
      call => call.functionName === "resolvePath" && call.args?.[0] === transportsUID && call.args?.[1] === "ipfs",
    ),
    "missing transport should read /transports/ipfs before aborting",
  );
});

test("createExternalFileReference resolves supported external transports consistently", async () => {
  const cases: { transportName: string; mirrorUri: string; transportUID: `0x${string}` }[] = [
    { transportName: "ipfs", mirrorUri: "ipfs://bafybeigdyrzt/example", transportUID: uid(71) },
    { transportName: "arweave", mirrorUri: "ar://abc123", transportUID: uid(72) },
    { transportName: "https", mirrorUri: "https://example.com/file.txt", transportUID: uid(73) },
    { transportName: "magnet", mirrorUri: "magnet:?xt=urn:btih:0123456789abcdef", transportUID: uid(74) },
    { transportName: "onchain", mirrorUri: `web3://${address(75)}:31337`, transportUID: uid(75) },
  ];

  for (const item of cases) {
    const readCalls: { functionName: string; args?: readonly unknown[] }[] = [];
    const sendTransactionCalls: unknown[] = [];
    const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
    const receipts = new Map<`0x${string}`, unknown>();
    let nextUID = 1000;
    let nextTx = 1000;

    const walletClient = {
      account: { address: account },
      chain: { id: 31337 },
      sendTransaction: async (txArgs: unknown) => {
        sendTransactionCalls.push(txArgs);
        return tx(nextTx++);
      },
      writeContract: async ({ args }: { args: readonly unknown[] }) => {
        const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
        writeCalls.push(requests);
        const hash = tx(nextTx++);
        const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
        receipts.set(hash, { status: "success", logs });
        return hash;
      },
    };
    const publicClient = {
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        readCalls.push({ functionName, args });
        if (functionName === "rootAnchorUID") return rootUID;
        if (functionName === "resolvePath") {
          if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
          if (args?.[0] === transportsUID && args?.[1] === item.transportName) return item.transportUID;
        }
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
      waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
        const receipt = receipts.get(hash);
        if (!receipt) throw new Error(`missing receipt for ${hash}`);
        return receipt;
      },
    };

    await createExternalFileReference({
      name: `${item.transportName}.ref`,
      mirrorUri: item.mirrorUri,
      transportName: item.transportName,
      contentType: "application/octet-stream",
      contentHash: zero,
      fileSize: 0n,
      parentAnchorUID,
      fileAnchorRefUID: zero,
      fileAnchorRecipient: account,
      knownFileAnchorUID: null,
      walletClient: walletClient as any,
      publicClient: publicClient as any,
      chainId: 31337,
      easAddress,
      indexerAddress,
      indexerAbi: [],
      anchorSchemaUID,
      dataSchemaUID,
      propertySchemaUID,
      pinSchemaUID,
      tagSchemaUID,
      mirrorSchemaUID,
      edgeResolverAddress,
      edgeResolverAbi: [],
    });

    assert.equal(sendTransactionCalls.length, 0, `${item.transportName} should not deploy storage`);
    assert.ok(
      readCalls.some(
        call =>
          call.functionName === "resolvePath" &&
          call.args?.[0] === transportsUID &&
          call.args?.[1] === item.transportName,
      ),
      `should resolve /transports/${item.transportName}`,
    );
    const mirrorRequest = writeCalls.flat().find(request => request.schema === mirrorSchemaUID);
    assert.ok(mirrorRequest, `expected a MIRROR request for ${item.transportName}`);
    const [transportUID, uri] = decodeAbiParameters(
      [
        { name: "transport", type: "bytes32" },
        { name: "uri", type: "string" },
      ],
      mirrorRequest.data[0].data,
    );
    assert.equal(transportUID, item.transportUID);
    assert.equal(uri, item.mirrorUri);
  }
});

test("uploadOnchainFile falls back to SSTORE2/onchain mirror when /transports/data is absent", async () => {
  const readCalls: { functionName: string; args?: readonly unknown[] }[] = [];
  const sendTransactionCalls: unknown[] = [];
  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 100;
  let nextTx = 1;
  let nextContract = 20;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    sendTransaction: async (args: unknown) => {
      sendTransactionCalls.push(args);
      const hash = tx(nextTx++);
      receipts.set(hash, { status: "success", contractAddress: address(nextContract++), logs: [] });
      return hash;
    },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      readCalls.push({ functionName, args });
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "data") return zero;
        if (args?.[0] === transportsUID && args?.[1] === "onchain") return onchainTransportUID;
      }
      if (functionName === "resolveAnchor") return zero;
      if (functionName === "dataByContentKey") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await uploadOnchainFile({
    name: "tiny.md",
    bytes: new TextEncoder().encode("hello"),
    contentType: "text/markdown",
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  assert.equal(sendTransactionCalls.length, 2, "small-file fallback should deploy one chunk and one manager");
  assert.ok(
    readCalls.some(
      call => call.functionName === "resolvePath" && call.args?.[0] === transportsUID && call.args?.[1] === "data",
    ),
    "should probe /transports/data before falling back",
  );
  assert.ok(
    readCalls.some(
      call => call.functionName === "resolvePath" && call.args?.[0] === transportsUID && call.args?.[1] === "onchain",
    ),
    "should resolve /transports/onchain for the fallback mirror",
  );

  const mirrorRequest = writeCalls.flat().find(request => request.schema === mirrorSchemaUID);
  assert.ok(mirrorRequest, "expected a MIRROR multiAttest request");
  const [transportUID, uri] = decodeAbiParameters(
    [
      { name: "transport", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    mirrorRequest.data[0].data,
  );
  assert.equal(transportUID, onchainTransportUID);
  assert.match(uri, /^web3:\/\/0x[0-9a-f]{40}:31337$/);
  assert.ok(!uri.startsWith("data:"), "fallback mirror must not use data:");
});

test("uploadOnchainFile marks cancellation unavailable before the placement commit stage", async () => {
  const events: string[] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 200;
  let nextTx = 50;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      const schemaList = requests.map(request => `${request.schema}:${request.data.length}`).join(",");
      events.push(`write:${schemaList}`);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "data") return uid(5);
      }
      if (functionName === "getAttestation") throw new Error("creator checks are not part of data: transport use");
      if (functionName === "resolveAnchor") return zero;
      if (functionName === "dataByContentKey") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await uploadOnchainFile({
    name: "tiny.md",
    bytes: new TextEncoder().encode("hello"),
    contentType: "text/markdown",
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
    beforePlacement: async () => {
      events.push("beforePlacement");
    },
    onCanCancelChange: (canCancel: boolean) => {
      events.push(`canCancel:${canCancel}`);
    },
  } as any);

  const commitStart = events.findIndex(event => event === "canCancel:false");
  const firstCommitWrite = events.findIndex(
    event => event.startsWith(`write:${anchorSchemaUID}:1`) || event.startsWith(`write:${pinSchemaUID}:`),
  );

  assert.ok(events.includes("beforePlacement"), "pre-placement hook should run before the commit boundary");
  assert.ok(commitStart !== -1, "should notify the UI when app-level cancellation is no longer safe");
  assert.ok(firstCommitWrite !== -1, "expected placement commit writes");
  assert.ok(
    commitStart > events.indexOf("beforePlacement"),
    "commit-stage notification should follow pre-placement work",
  );
  assert.ok(commitStart < firstCommitWrite, "app-level cancellation must be disabled before commit writes are sent");
});

test("uploadOnchainFile uses a resolved /transports/data anchor regardless of creator", async () => {
  const dataTransportUID = uid(5);
  const sendTransactionCalls: unknown[] = [];
  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 300;
  let nextTx = 80;
  let nextContract = 40;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    sendTransaction: async (args: unknown) => {
      sendTransactionCalls.push(args);
      const hash = tx(nextTx++);
      receipts.set(hash, { status: "success", contractAddress: address(nextContract++), logs: [] });
      return hash;
    },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "data") return dataTransportUID;
        if (args?.[0] === transportsUID && args?.[1] === "onchain") return onchainTransportUID;
      }
      if (functionName === "getAttestation") throw new Error("creator checks are not part of data: transport use");
      if (functionName === "resolveAnchor") return zero;
      if (functionName === "dataByContentKey") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await uploadOnchainFile({
    name: "tiny.md",
    bytes: new TextEncoder().encode("hello"),
    contentType: "text/markdown",
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  assert.equal(sendTransactionCalls.length, 0, "resolved data: transport should avoid chunk/manager deploys");
  const mirrorRequest = writeCalls.flat().find(request => request.schema === mirrorSchemaUID);
  assert.ok(mirrorRequest, "expected a MIRROR multiAttest request");
  const [transportUID, uri] = decodeAbiParameters(
    [
      { name: "transport", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    mirrorRequest.data[0].data,
  );
  assert.equal(transportUID, dataTransportUID);
  assert.match(uri, /^data:text\/markdown;base64,/, "should mint an inline data: mirror");
});

test("uploadOnchainFile falls back when the final data URI would exceed the mirror URI cap", async () => {
  const readCalls: { functionName: string; args?: readonly unknown[] }[] = [];
  const sendTransactionCalls: unknown[] = [];
  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 400;
  let nextTx = 90;
  let nextContract = 60;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    sendTransaction: async (args: unknown) => {
      sendTransactionCalls.push(args);
      const hash = tx(nextTx++);
      receipts.set(hash, { status: "success", contractAddress: address(nextContract++), logs: [] });
      return hash;
    },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      readCalls.push({ functionName, args });
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "data") return uid(5);
        if (args?.[0] === transportsUID && args?.[1] === "onchain") return onchainTransportUID;
      }
      if (functionName === "resolveAnchor") return zero;
      if (functionName === "dataByContentKey") return zero;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await uploadOnchainFile({
    name: "tiny.md",
    bytes: new TextEncoder().encode("hello"),
    contentType: `text/plain;${"x".repeat(8_200)}`,
    parentAnchorUID,
    fileAnchorRefUID: zero,
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  assert.equal(sendTransactionCalls.length, 2, "oversized data URI should fall back to chunk + manager deploys");
  assert.ok(
    !readCalls.some(
      call => call.functionName === "resolvePath" && call.args?.[0] === transportsUID && call.args?.[1] === "data",
    ),
    "should skip /transports/data lookup when the final URI cannot pass MirrorResolver",
  );
  const mirrorRequest = writeCalls.flat().find(request => request.schema === mirrorSchemaUID);
  assert.ok(mirrorRequest, "expected a MIRROR multiAttest request");
  const [transportUID, uri] = decodeAbiParameters(
    [
      { name: "transport", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    mirrorRequest.data[0].data,
  );
  assert.equal(transportUID, onchainTransportUID);
  assert.match(uri, /^web3:\/\//, "should use an on-chain mirror when data: would exceed the cap");
});

test("uploadOnchainFile ancestor walk stops at a synthetic address-root parent", async () => {
  // Scenario: /0xaddr/folder/file.txt — folderUID is a real EAS attestation;
  // EFSIndexer returns bytes32(addr) as its parent (synthetic, not a real attestation).
  // Without the fix the walk queues a TAG for the synthetic UID → EAS NotFound revert
  // (or the mock throws and suppresses all TAGs). With the fix the walk breaks at the
  // synthetic parent and submits exactly one TAG (for the real folder).
  const folderUID = parentAnchorUID; // uid(4) — real EAS attestation
  // bytes32(uint160(account)): 24 zero hex chars followed by the 40-char address hex
  const syntheticAddressRoot = `0x${"0".repeat(24)}${account.slice(2)}` as `0x${string}`;

  const writeCalls: { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[][] = [];
  const receipts = new Map<`0x${string}`, unknown>();
  let nextUID = 500;
  let nextTx = 110;
  let nextContract = 80;

  const walletClient = {
    account: { address: account },
    chain: { id: 31337 },
    sendTransaction: async () => {
      const hash = tx(nextTx++);
      receipts.set(hash, { status: "success", contractAddress: address(nextContract++), logs: [] });
      return hash;
    },
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const requests = args[0] as { schema: `0x${string}`; data: readonly { data: `0x${string}` }[] }[];
      writeCalls.push(requests);
      const hash = tx(nextTx++);
      const logs = requests.flatMap(request => request.data.map(() => attestedLog(request.schema, uid(nextUID++))));
      receipts.set(hash, { status: "success", logs });
      return hash;
    },
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolvePath") {
        if (args?.[0] === rootUID && args?.[1] === "transports") return transportsUID;
        if (args?.[0] === transportsUID && args?.[1] === "data") return zero;
        if (args?.[0] === transportsUID && args?.[1] === "onchain") return onchainTransportUID;
      }
      if (functionName === "resolveAnchor") return zero;
      if (functionName === "isActiveEdge") return false;
      if (functionName === "getParent" && args?.[0] === folderUID) return syntheticAddressRoot;
      throw new Error(`unexpected readContract call: ${functionName}(${JSON.stringify(args)})`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`missing receipt for ${hash}`);
      return receipt;
    },
  };

  await uploadOnchainFile({
    name: "file.txt",
    bytes: new TextEncoder().encode("hello"),
    contentType: "text/plain",
    parentAnchorUID: folderUID,
    fileAnchorRefUID: folderUID, // real folder UID → ancestor walk is NOT skipped
    fileAnchorRecipient: account,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
    chainId: 31337,
    easAddress,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  const tagCount = writeCalls
    .flat()
    .filter(r => r.schema === tagSchemaUID)
    .reduce((n, r) => n + r.data.length, 0);
  assert.equal(tagCount, 1, "ancestor walk must emit exactly one TAG (real folder) and stop before the synthetic address root");
});
