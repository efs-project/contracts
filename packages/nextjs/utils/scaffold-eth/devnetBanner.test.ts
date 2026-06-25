import assert from "node:assert/strict";
import { test } from "node:test";

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

const { shouldShowDevnetBanner } = await import("./devnetBanner.ts");

const DEVNET_CHAIN_ID = 26001993;
const SEPOLIA_CHAIN_ID = 11155111;
const HARDHAT_CHAIN_ID = 31337;

test("Devnet banner only shows for active Devnet", () => {
  assert.equal(
    shouldShowDevnetBanner({
      chainId: DEVNET_CHAIN_ID,
      dismissed: false,
      message: "EFS Devnet resets weekly.",
    }),
    true,
  );

  assert.equal(
    shouldShowDevnetBanner({
      chainId: SEPOLIA_CHAIN_ID,
      dismissed: false,
      message: "EFS Devnet resets weekly.",
    }),
    false,
  );

  assert.equal(
    shouldShowDevnetBanner({
      chainId: HARDHAT_CHAIN_ID,
      dismissed: false,
      message: "EFS Devnet resets weekly.",
    }),
    false,
  );
});

test("Devnet banner still requires a configured message and an undismissed session", () => {
  assert.equal(
    shouldShowDevnetBanner({
      chainId: DEVNET_CHAIN_ID,
      dismissed: false,
      message: undefined,
    }),
    false,
  );

  assert.equal(
    shouldShowDevnetBanner({
      chainId: DEVNET_CHAIN_ID,
      dismissed: true,
      message: "EFS Devnet resets weekly.",
    }),
    false,
  );
});
