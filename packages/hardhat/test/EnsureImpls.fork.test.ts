import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance, takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { CREATEX_ADDRESS } from "../deploy-lib/addresses";
import { Create3Name, getCreateX, predictImplAddress } from "../deploy-lib/create3";
import { ensureImpls } from "../deploy-lib/safePlan";
import { RESOLVERS } from "../deploy-lib/schemas";

// Fork rehearsal for the HARDENED impl deploy (this PR — see safePlan.ensureImpls / create3.predictImplAddress).
//
// The Safe-native deploy used to deploy the 7 resolver impls at NON-deterministic addresses every
// Phase-0 invocation, so losing the regenerable safe-batches.json artifact (or a mid-loop out-of-gas)
// forced a full re-deploy of all 7 impls at real cost — a mainnet-money hazard. The hardening makes
// impls CONTENT-ADDRESSED via CreateX CREATE2 (`f(deployer, salt, initCode)`) so a re-run reuses what is
// already on-chain (zero gas), and adds a PREFLIGHT BALANCE GUARD that fails before spending if the
// deployer can't finish. These tests prove: (1) realized == predicted, (2) a second ensureImpls deploys
// nothing (deployer nonce flat), (3) an underfunded deployer is rejected before any tx.
//
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/EnsureImpls.fork.test.ts --network hardhat
// Self-skips when CreateX isn't present (default unit suite unaffected).
describe("EnsureImpls.fork — deterministic, idempotent, preflight-guarded impl deploys", function () {
  this.timeout(240_000);

  const ALL_NAMES: Create3Name[] = [...RESOLVERS, "SystemAccount"];
  let forked = false;
  let base: SnapshotRestorer;

  before(async function () {
    forked = (await ethers.provider.getCode(CREATEX_ADDRESS)) !== "0x";
    if (!forked) {
      console.log("    (skipping EnsureImpls.fork — CreateX not present; run with MAINNET_FORKING_ENABLED=true)");
      this.skip();
    }
    base = await takeSnapshot();
  });

  afterEach(async function () {
    if (forked) await base.restore();
  });

  it("deploys every impl at its predicted CREATE2 content-addressed address", async function () {
    const [deployer] = await ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    const createx = await getCreateX(deployer);

    const predicted: Record<string, string> = {};
    for (const name of ALL_NAMES) {
      predicted[name] = (await predictImplAddress(createx, deployerAddr, name)).predicted;
    }

    const impls = await ensureImpls(deployer, false);

    for (const name of ALL_NAMES) {
      expect(impls[name], `${name} realized == predicted`).to.equal(predicted[name]);
      expect(await ethers.provider.getCode(impls[name]), `${name} has code`).to.not.equal("0x");
    }
  });

  it("is idempotent — a second ensureImpls deploys nothing (deployer nonce flat, same addresses)", async function () {
    const [deployer] = await ethers.getSigners();
    const deployerAddr = await deployer.getAddress();

    const first = await ensureImpls(deployer, false);

    const nonceBefore = await ethers.provider.getTransactionCount(deployerAddr);
    const second = await ensureImpls(deployer, false);
    const nonceAfter = await ethers.provider.getTransactionCount(deployerAddr);

    expect(nonceAfter, "no impl re-deployed on the second run (nonce unchanged)").to.equal(nonceBefore);
    for (const name of ALL_NAMES) {
      expect(second[name], `${name} reused at same address`).to.equal(first[name]);
    }
  });

  it("rejects an underfunded deployer BEFORE any deploy tx (preflight balance guard)", async function () {
    // A fresh random deployer keys its own content-addressed impl addresses (salt embeds the deployer),
    // so they are guaranteed not-yet-deployed regardless of shared fork state — the preflight path runs.
    const poor = ethers.Wallet.createRandom().connect(ethers.provider);
    await setBalance(poor.address, 1n); // 1 wei — cannot afford 7 large contract deploys at fork gas price

    const nonceBefore = await ethers.provider.getTransactionCount(poor.address);
    await expect(ensureImpls(poor, false)).to.be.rejectedWith(/INSUFFICIENT FUNDS/);
    const nonceAfter = await ethers.provider.getTransactionCount(poor.address);
    expect(nonceAfter, "guard fired before any tx was sent (nonce unchanged)").to.equal(nonceBefore);
  });
});
