import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient, WalletClient } from "viem";

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

const { applySystemTag, createWalletClientAttest } = await import("../../lib/efs/applySystemTag.ts");

const zero = `0x${"0".repeat(64)}` as const;
const account = `0x${"a".repeat(40)}` as const;
const easAddress = `0x${"e".repeat(40)}` as const;
const indexerAddress = `0x${"1".repeat(40)}` as const;
const edgeResolverAddress = `0x${"2".repeat(40)}` as const;

const dataUID = uid(1);
const rootUID = uid(2);
const tagsUID = uid(3);
const systemUID = uid(4);
const anchorSchemaUID = uid(5);
const tagSchemaUID = uid(6);

function uid(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function tx(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

test("applySystemTag can use the same raw wallet client as the Overview upload", async () => {
  const readCalls: { address: `0x${string}`; functionName: string; args?: readonly unknown[] }[] = [];
  const writeCalls: {
    address: `0x${string}`;
    functionName: string;
    args?: readonly unknown[];
    account?: { address: `0x${string}` };
    chain?: { id: number; name: string };
  }[] = [];
  const receiptHashes: `0x${string}`[] = [];

  const walletClient = {
    account: { address: account },
    chain: { id: 11155111, name: "Sepolia" },
    writeContract: async (request: (typeof writeCalls)[number]) => {
      writeCalls.push(request);
      return tx(writeCalls.length);
    },
  };

  const publicClient = {
    readContract: async (request: (typeof readCalls)[number]) => {
      readCalls.push(request);
      if (request.functionName === "rootAnchorUID") return rootUID;
      if (request.functionName === "resolveAnchor" && request.args?.[0] === rootUID) return tagsUID;
      if (request.functionName === "resolveAnchor" && request.args?.[0] === tagsUID) return systemUID;
      if (request.functionName === "hasActiveTagFromAny") return false;
      return zero;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      receiptHashes.push(hash);
      return { logs: [] };
    },
  };

  const typedWalletClient = walletClient as unknown as WalletClient;
  const typedPublicClient = publicClient as unknown as PublicClient;
  const attest = createWalletClientAttest({ walletClient: typedWalletClient, easAddress });

  await applySystemTag({
    dataUID,
    walletClient: typedWalletClient,
    publicClient: typedPublicClient,
    attest,
    indexerAddress,
    indexerAbi: [],
    anchorSchemaUID,
    tagSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi: [],
  });

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].address, easAddress);
  assert.equal(writeCalls[0].functionName, "attest");
  assert.deepEqual(writeCalls[0].account, walletClient.account);
  assert.deepEqual(writeCalls[0].chain, walletClient.chain);
  assert.equal((writeCalls[0].args?.[0] as { schema: `0x${string}` }).schema, tagSchemaUID);
  assert.equal(
    ((writeCalls[0].args?.[0] as { data: { refUID: `0x${string}` } }).data.refUID),
    dataUID,
  );
  assert.deepEqual(receiptHashes, [tx(1)]);
});

test("applySystemTag rejects a reverted system tag receipt before Overview placement", async () => {
  const walletClient = {
    account: { address: account },
    chain: { id: 11155111, name: "Sepolia" },
    writeContract: async () => tx(1),
  };

  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "rootAnchorUID") return rootUID;
      if (functionName === "resolveAnchor" && args?.[0] === rootUID) return tagsUID;
      if (functionName === "resolveAnchor" && args?.[0] === tagsUID) return systemUID;
      if (functionName === "hasActiveTagFromAny") return false;
      return zero;
    },
    waitForTransactionReceipt: async () => ({ status: "reverted", logs: [] }),
  };

  const typedWalletClient = walletClient as unknown as WalletClient;
  const attest = createWalletClientAttest({ walletClient: typedWalletClient, easAddress });

  await assert.rejects(
    () =>
      applySystemTag({
        dataUID,
        walletClient: typedWalletClient,
        publicClient: publicClient as unknown as PublicClient,
        attest,
        indexerAddress,
        indexerAbi: [],
        anchorSchemaUID,
        tagSchemaUID,
        edgeResolverAddress,
        edgeResolverAbi: [],
      }),
    /system TAG transaction reverted/i,
  );
});
