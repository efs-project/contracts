import {
  LayeredWriteError,
  type PlannedAttestation,
  type RefOrUID,
  isSymbolicRef,
  submitLayered,
} from "./submitLayered.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";

const ZERO_UID = `0x${"0".repeat(64)}` as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const EAS_ADDRESS = "0x000000000000000000000000000000000000eaa5" as const;
const ATTESTER = "0x000000000000000000000000000000000000a11c" as const;
const SCHEMA_A = `0x${"a".repeat(64)}` as const;
const SCHEMA_B = `0x${"b".repeat(64)}` as const;
const SCHEMA_C = `0x${"c".repeat(64)}` as const;

const attestedEvent = parseAbiItem(
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
);

function uid(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function attestedLog(schemaUID: `0x${string}`, mintedUID: `0x${string}`) {
  return {
    address: EAS_ADDRESS,
    data: encodeAbiParameters([{ type: "bytes32", name: "uid" }], [mintedUID]),
    topics: encodeEventTopics({
      abi: [attestedEvent],
      eventName: "Attested",
      args: {
        recipient: ZERO_ADDRESS,
        attester: ATTESTER,
        schemaUID,
      },
    }) as [`0x${string}`, ...`0x${string}`[]],
  };
}

function makeCtx(receiptUidsByTx: readonly (readonly [`0x${string}`, `0x${string}`][])[]) {
  const receipts = [...receiptUidsByTx];
  const writes: unknown[] = [];
  let writeIndex = 0;
  const walletClient = {
    writeContract: async (args: unknown) => {
      writes.push(args);
      writeIndex += 1;
      return uid(10_000 + writeIndex);
    },
  };
  const publicClient = {
    waitForTransactionReceipt: async () => {
      const layer = receipts.shift();
      if (!layer) throw new Error("unexpected receipt wait");
      return {
        status: "success" as const,
        logs: layer.map(([schema, minted]) => attestedLog(schema, minted)),
      };
    },
  };
  return { walletClient, publicClient, writes };
}

function plan(overrides: Partial<PlannedAttestation> & Pick<PlannedAttestation, "ref" | "layer" | "schema">) {
  return {
    data: "0x" as const,
    revocable: false,
    refUID: ZERO_UID as RefOrUID,
    ...overrides,
  } satisfies PlannedAttestation;
}

test("isSymbolicRef only accepts symbolic ref objects", () => {
  assert.equal(isSymbolicRef({ ref: "DATA" }), true);
  assert.equal(isSymbolicRef(ZERO_UID), false);
});

test("submitLayered submits one multiAttest per layer and threads mined UIDs into later layers", async () => {
  const dataUID = uid(1);
  const mirrorUID = uid(2);
  const pinUID = uid(3);
  const { walletClient, publicClient, writes } = makeCtx([
    [[SCHEMA_A, dataUID]],
    [
      [SCHEMA_B, mirrorUID],
      [SCHEMA_C, pinUID],
    ],
  ]);

  const result = await submitLayered(
    [
      plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
      plan({
        ref: "MIRROR",
        layer: 2,
        schema: SCHEMA_B,
        revocable: true,
        refUID: { ref: "DATA" },
        data: "0x1234",
      }),
      plan({
        ref: "PIN",
        layer: 2,
        schema: SCHEMA_C,
        revocable: true,
        refUID: { ref: "DATA" },
        pinDefinitionRef: { ref: "DATA" },
      }),
    ],
    {
      walletClient,
      publicClient,
      easAddress: EAS_ADDRESS,
      account: ATTESTER,
    },
  );

  assert.equal(writes.length, 2);
  assert.equal(result.get("DATA"), dataUID);
  assert.equal(result.get("MIRROR"), mirrorUID);
  assert.equal(result.get("PIN"), pinUID);

  const secondWrite = writes[1] as {
    args: readonly [
      readonly {
        schema: `0x${string}`;
        data: readonly { refUID: `0x${string}`; data: `0x${string}` }[];
      }[],
    ];
  };
  const [, pinRequest] = secondWrite.args[0];
  assert.equal(pinRequest.schema, SCHEMA_C);
  assert.equal(pinRequest.data[0].refUID, dataUID);
  assert.equal(pinRequest.data[0].data, encodeAbiParameters([{ name: "definition", type: "bytes32" }], [dataUID]));
});

test("submitLayered maps Attested events using grouped-by-schema request order", async () => {
  const alphaUID = uid(11);
  const gammaUID = uid(33);
  const betaUID = uid(22);
  const { walletClient, publicClient, writes } = makeCtx([
    [
      [SCHEMA_A, alphaUID],
      [SCHEMA_A, gammaUID],
      [SCHEMA_B, betaUID],
    ],
  ]);

  const result = await submitLayered(
    [
      plan({ ref: "alpha", layer: 1, schema: SCHEMA_A }),
      plan({ ref: "beta", layer: 1, schema: SCHEMA_B }),
      plan({ ref: "gamma", layer: 1, schema: SCHEMA_A }),
    ],
    {
      walletClient,
      publicClient,
      easAddress: EAS_ADDRESS,
      account: ATTESTER,
    },
  );

  assert.equal(result.get("alpha"), alphaUID);
  assert.equal(result.get("gamma"), gammaUID);
  assert.equal(result.get("beta"), betaUID);

  const write = writes[0] as {
    args: readonly [
      readonly {
        schema: `0x${string}`;
        data: readonly unknown[];
      }[],
    ];
  };
  assert.deepEqual(
    write.args[0].map(request => [request.schema, request.data.length]),
    [
      [SCHEMA_A, 2],
      [SCHEMA_B, 1],
    ],
  );
});

test("submitLayered rejects a forward symbolic ref before sending the layer", async () => {
  const { walletClient, publicClient, writes } = makeCtx([]);

  await assert.rejects(
    () =>
      submitLayered([plan({ ref: "bad", layer: 1, schema: SCHEMA_A, refUID: { ref: "future" } })], {
        walletClient,
        publicClient,
        easAddress: EAS_ADDRESS,
        account: ATTESTER,
      }),
    /unresolved symbolic ref 'future'/,
  );
  assert.equal(writes.length, 0);
});

test("submitLayered marks pre-layer cancellation so callers can keep the user-cancel path", async () => {
  const { walletClient, publicClient, writes } = makeCtx([[[SCHEMA_A, uid(1)]]]);
  let cancelled = false;

  await assert.rejects(
    async () => {
      await submitLayered(
        [
          plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
          plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
        ],
        {
          walletClient,
          publicClient,
          easAddress: EAS_ADDRESS,
          account: ATTESTER,
          isCancelled: () => cancelled,
          onLayer: () => {
            cancelled = true;
          },
        },
      );
    },
    (error: unknown) => {
      assert.ok(error instanceof LayeredWriteError);
      assert.equal(error.cancelled, true);
      assert.equal(error.layer, 2);
      return true;
    },
  );
  assert.equal(writes.length, 1);
});

test("submitLayered announces a layer before opening the wallet prompt", async () => {
  const events: { layer: number; refs: readonly string[]; writes: number }[] = [];
  const { walletClient, publicClient, writes } = makeCtx([[[SCHEMA_A, uid(1)]], [[SCHEMA_B, uid(2)]]]);

  await submitLayered(
    [
      plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
      plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
    ],
    {
      walletClient,
      publicClient,
      easAddress: EAS_ADDRESS,
      account: ATTESTER,
      onBeforeLayer: ({ layer, refs }) => {
        events.push({ layer, refs, writes: writes.length });
      },
    },
  );

  assert.deepEqual(events, [
    { layer: 1, refs: ["DATA"], writes: 0 },
    { layer: 2, refs: ["MIRROR"], writes: 1 },
  ]);
});

test("submitLayered preserves landed UIDs when a later wallet prompt is rejected", async () => {
  const dataUID = uid(101);
  const mirrorUID = uid(102);
  const writes: unknown[] = [];
  const walletClient = {
    writeContract: async (args: unknown) => {
      writes.push(args);
      if (writes.length === 3) throw new Error("User rejected the request");
      return uid(20_000 + writes.length);
    },
  };
  const receipts = [[[SCHEMA_A, dataUID]], [[SCHEMA_B, mirrorUID]]];
  const publicClient = {
    waitForTransactionReceipt: async () => {
      const layer = receipts.shift();
      if (!layer) throw new Error("unexpected receipt wait");
      return {
        status: "success" as const,
        logs: layer.map(([schema, minted]) => attestedLog(schema as `0x${string}`, minted as `0x${string}`)),
      };
    },
  };

  await assert.rejects(
    () =>
      submitLayered(
        [
          plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
          plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
          plan({ ref: "PIN", layer: 3, schema: SCHEMA_C, refUID: { ref: "DATA" } }),
        ],
        {
          walletClient,
          publicClient,
          easAddress: EAS_ADDRESS,
          account: ATTESTER,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof LayeredWriteError);
      assert.equal(error.cancelled, false);
      assert.equal(error.layer, 3);
      assert.equal(error.txHash, undefined);
      assert.equal(error.landed.get("DATA"), dataUID);
      assert.equal(error.landed.get("MIRROR"), mirrorUID);
      assert.match(error.message, /User rejected the request/);
      return true;
    },
  );
  assert.equal(writes.length, 3);
});

test("submitLayered preserves tx hash and landed UIDs when receipt waiting fails", async () => {
  const dataUID = uid(301);
  const writes: unknown[] = [];
  const txHashes = [uid(30_001), uid(30_002)];
  const walletClient = {
    writeContract: async (args: unknown) => {
      writes.push(args);
      return txHashes[writes.length - 1]!;
    },
  };
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      if (hash === txHashes[1]) throw new Error("receipt timeout");
      return {
        status: "success" as const,
        logs: [attestedLog(SCHEMA_A, dataUID)],
      };
    },
  };

  await assert.rejects(
    () =>
      submitLayered(
        [
          plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
          plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
        ],
        {
          walletClient,
          publicClient,
          easAddress: EAS_ADDRESS,
          account: ATTESTER,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof LayeredWriteError);
      assert.equal(error.cancelled, false);
      assert.equal(error.layer, 2);
      assert.equal(error.txHash, txHashes[1]);
      assert.equal(error.landed.get("DATA"), dataUID);
      assert.match(error.message, /receipt timeout/);
      return true;
    },
  );
  assert.equal(writes.length, 2);
});

test("submitLayered preserves tx hash and landed UIDs when a layer reverts", async () => {
  const dataUID = uid(351);
  const writes: unknown[] = [];
  const txHashes = [uid(35_001), uid(35_002)];
  const walletClient = {
    writeContract: async (args: unknown) => {
      writes.push(args);
      return txHashes[writes.length - 1]!;
    },
  };
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({
      status: hash === txHashes[1] ? ("reverted" as const) : ("success" as const),
      logs: hash === txHashes[0] ? [attestedLog(SCHEMA_A, dataUID)] : [],
    }),
  };

  await assert.rejects(
    () =>
      submitLayered(
        [
          plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
          plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
        ],
        {
          walletClient,
          publicClient,
          easAddress: EAS_ADDRESS,
          account: ATTESTER,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof LayeredWriteError);
      assert.equal(error.cancelled, false);
      assert.equal(error.layer, 2);
      assert.equal(error.txHash, txHashes[1]);
      assert.equal(error.landed.get("DATA"), dataUID);
      assert.match(error.message, /reverted/);
      return true;
    },
  );
  assert.equal(writes.length, 2);
});

test("submitLayered preserves tx hash and landed UIDs when Attested logs are missing", async () => {
  const dataUID = uid(401);
  const writes: unknown[] = [];
  const txHashes = [uid(40_001), uid(40_002)];
  const walletClient = {
    writeContract: async (args: unknown) => {
      writes.push(args);
      return txHashes[writes.length - 1]!;
    },
  };
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({
      status: "success" as const,
      logs: hash === txHashes[0] ? [attestedLog(SCHEMA_A, dataUID)] : [],
    }),
  };

  await assert.rejects(
    () =>
      submitLayered(
        [
          plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
          plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
        ],
        {
          walletClient,
          publicClient,
          easAddress: EAS_ADDRESS,
          account: ATTESTER,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof LayeredWriteError);
      assert.equal(error.cancelled, false);
      assert.equal(error.layer, 2);
      assert.equal(error.txHash, txHashes[1]);
      assert.equal(error.landed.get("DATA"), dataUID);
      assert.match(error.message, /expected 1 Attested event/);
      return true;
    },
  );
  assert.equal(writes.length, 2);
});

test("submitLayered passes the selected account and chain to every layer write", async () => {
  const chain = {
    id: 11155111,
    name: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  } as const;
  const { walletClient, publicClient, writes } = makeCtx([[[SCHEMA_A, uid(201)]], [[SCHEMA_B, uid(202)]]]);

  await submitLayered(
    [
      plan({ ref: "DATA", layer: 1, schema: SCHEMA_A }),
      plan({ ref: "MIRROR", layer: 2, schema: SCHEMA_B, refUID: { ref: "DATA" } }),
    ],
    {
      walletClient,
      publicClient,
      easAddress: EAS_ADDRESS,
      account: ATTESTER,
      chain,
    },
  );

  assert.equal(writes.length, 2);
  for (const write of writes as { account: `0x${string}`; chain: typeof chain }[]) {
    assert.equal(write.account, ATTESTER);
    assert.equal(write.chain, chain);
  }
});
