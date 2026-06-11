import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { CREATEX_ADDRESS } from "../deploy-lib/addresses";
import { orchestrate, OrchestrationResult, RunMode } from "../deploy-lib/orchestrate";
import { orchestrateViaSafe } from "../deploy-lib/orchestrateSafe";
import { SAFE_PROXY_FACTORY_141, deployTestSafe } from "../deploy-lib/safe";

// EFS orchestrated CREATE3 deploy (Phase D core) — the single source of truth for standing up the
// upgradeable EFS system per docs/DEPLOYMENT.md §3. Replaces the nonce-prediction + TestERC1967Proxy
// path that lived across 01_indexer/04_sortoverlay/05_mirrors/09_lists (those registration paths are
// now neutralized; see the AGENT-NOTE at the top of each).
//
// Modes (env EFS_DEPLOY_MODE, default "full"):
//   full              — deploy + verify + wire + register-last + transfer-to-Safe + per-schema smoke
//   until-freeze-gate — deploy + verify + wire, then STOP before any schema is registered (the human
//                       reviews + signs docs/SEPOLIA_FREEZE_TABLE.md). For the real Sepolia run.
//   after-freeze-gate — re-predict (idempotent) then register + transfer-to-Safe + smoke.
//
// Runs only where the CreateX factory is present (Sepolia, mainnet, or the pinned Sepolia fork). On a
// vanilla hardhat node with no fork it skips gracefully (ADR-0028 graceful degradation) so plain
// `yarn deploy` against a bare node doesn't fail.
const deployEfsCore: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const signer = await hre.ethers.getSigner(deployer);

  const createxCode = await hre.ethers.provider.getCode(CREATEX_ADDRESS);
  if (createxCode === "0x") {
    console.log(
      `[efs-core] CreateX not present at ${CREATEX_ADDRESS} on this network — skipping orchestrated ` +
        `deploy (run against a Sepolia fork: MAINNET_FORKING_ENABLED=true, or real Sepolia/mainnet).`,
    );
    return;
  }

  // Safe-native path (docs/DEPLOYMENT.md §1/§3, ADR-0048/0053): deploy the whole system FROM the
  // EFS.eth Safe (the team multisig) as two owner-signed MultiSend batches, BORN owned by the Safe (no
  // ownership-transfer phase — no hot key ever holds the nascent system). The CREATE3 addresses become
  // Safe-keyed (the Safe is the CreateX caller). The EOA path below stays intact as the simpler
  // fallback. Toggle with EFS_DEPLOY_VIA_SAFE=1 + EFS_SAFE_ADDRESS=<Safe>.
  const viaSafe = process.env.EFS_DEPLOY_VIA_SAFE === "1" || process.env.EFS_DEPLOY_VIA_SAFE === "true";
  let result: OrchestrationResult;
  if (viaSafe) {
    const onFork = (await hre.ethers.provider.getCode(SAFE_PROXY_FACTORY_141)) !== "0x";
    const isLocalNetwork = hre.network.name === "hardhat" || hre.network.name === "localhost";
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    // FIX A (PR #24 P2): the deciding axis is which Safe we hold owner signatures for — NOT whether
    // we're on a fork. SELF-EXECUTION is valid ONLY against the auto-deployed 1-of-1 test Safe (its
    // single owner IS a local signer). For ANY supplied real EFS_SAFE_ADDRESS, the gas-paying deployer
    // is just an EOA, NOT a Safe owner — even on the fork. Self-signing + execTransaction would
    // fabricate invalid signatures and revert Batch 1 (the bug this fix closes). So:
    //
    //   no EFS_SAFE_ADDRESS  → auto-deploy a 1-of-1 test Safe (fork only) → `execute` (self-sign).
    //   real EFS_SAFE_ADDRESS → `propose` REGARDLESS of network (fork or real): build the MultiSend
    //                           batches + emit safe-batches.json + a ceremony summary against the real
    //                           Safe-keyed addresses, and DO NOT call execTransaction. On a fork this is
    //                           the useful pre-flight (it shows the REAL Safe-keyed predicted addresses /
    //                           freeze-table values, no revert); on a real network the operator
    //                           proposes/signs/executes each batch in Safe{Wallet} (DEPLOYMENT.md §4).
    //
    // Escape hatch (unchanged): real address + EFS_SAFE_OWNER_KEYS (operator loaded the real owner keys
    // as local signers) → `execute`. That is the only way a supplied real Safe self-executes.
    const signers = await hre.ethers.getSigners();
    const owner = signers[1] ?? signers[0];
    const isForkRehearsal = isLocalNetwork && chainId === 31337;
    const ownerKeysAvailable = !!process.env.EFS_SAFE_OWNER_KEYS;
    let safe = process.env.EFS_SAFE_ADDRESS;
    let mode: "execute" | "propose";
    let owners = [owner];
    if (!safe) {
      if (!(isForkRehearsal && onFork)) {
        throw new Error(
          "[efs-core] EFS_DEPLOY_VIA_SAFE=1 requires EFS_SAFE_ADDRESS on a real network. " +
            "On the hardhat fork, a 1-of-1 test Safe is deployed automatically.",
        );
      }
      safe = await deployTestSafe(signer, [await owner.getAddress()], 1);
      console.log(`[efs-core] Safe-native rehearsal — deployed 1-of-1 test Safe ${safe}`);
      mode = "execute"; // auto test-Safe: its single owner is a local signer (real signatures).
    } else {
      // Real EFS_SAFE_ADDRESS supplied. The local signer can't be assumed to own it, so build/propose by
      // default on ANY network (fork pre-flight or real ceremony). Self-execute ONLY when the operator
      // explicitly loaded the real owner keys as local signers via EFS_SAFE_OWNER_KEYS.
      mode = ownerKeysAvailable ? "execute" : "propose";
      if (mode === "propose") owners = []; // no owner signatures used in propose mode
    }
    console.log(
      `[efs-core] Safe-native CREATE3 deploy — safe=${safe}, deployer=${deployer}, mode=${mode} (born Safe-owned)`,
    );
    const proposeArtifactPath = `${hre.config.paths.root}/deployments/${hre.network.name}/safe-batches.json`;
    const safeResult = await orchestrateViaSafe(signer, safe, owners, { mode, proposeArtifactPath });
    if (safeResult.mode === "propose") {
      // Built + emitted the propose artifact; the operator executes the batches in Safe{Wallet}. Save
      // the precomputed Safe-keyed proxies as named deployments (their addresses are deterministic and
      // known pre-execution) so downstream tooling resolves them, then exit cleanly — nothing is
      // self-executed on a real network. We do NOT run the post-deploy on-chain assertions (no proxy
      // is deployed yet) nor the per-schema summary.
      console.log("[efs-core] Safe-native build/propose complete — see safe-batches.json. Exiting (no txs sent).");
      const proposeSaveAs: Record<string, string> = {
        Indexer: "EFSIndexer",
        EdgeResolver: "EdgeResolver",
        MirrorResolver: "MirrorResolver",
        ListResolver: "ListResolver",
        ListEntryResolver: "ListEntryResolver",
        AliasResolver: "AliasResolver",
      };
      for (const [name, resolver] of Object.entries(proposeSaveAs)) {
        const artifact = await hre.deployments.getArtifact(resolver);
        await hre.deployments.save(name, {
          address: (safeResult.proxies as Record<string, string>)[resolver],
          abi: artifact.abi,
        });
      }
      const saArtifact = await hre.deployments.getArtifact("SystemAccount");
      await hre.deployments.save("SystemAccount", { address: safeResult.systemAccount, abi: saArtifact.abi });
      return;
    }
    result = safeResult;
  } else {
    const mode = (process.env.EFS_DEPLOY_MODE as RunMode) ?? "full";
    console.log(`[efs-core] orchestrated CREATE3 deploy — mode=${mode}, deployer=${deployer}`);
    result = await orchestrate(signer, mode);
  }

  // Save the CREATE3 proxies as hardhat-deploy named deployments so the legacy downstream consumer
  // scripts (02/03/06/07/08, rebind deferred to D2) and external tooling can resolve them by name.
  // hardhat-deploy keys EFSIndexer as "Indexer" historically; preserve that alias.
  const saveAs: Record<string, string> = {
    Indexer: "EFSIndexer",
    EdgeResolver: "EdgeResolver",
    MirrorResolver: "MirrorResolver",
    ListResolver: "ListResolver",
    ListEntryResolver: "ListEntryResolver",
    AliasResolver: "AliasResolver",
  };
  for (const [name, resolver] of Object.entries(saveAs)) {
    const artifact = await hre.deployments.getArtifact(resolver);
    await hre.deployments.save(name, {
      address: (result.proxies as Record<string, string>)[resolver],
      abi: artifact.abi,
    });
  }

  // SystemAccount (ADR-0053): save as a named deployment too. NOT a resolver (in no schema UID),
  // but a deterministic CREATE3 proxy whose address is Etched at first canonical write — downstream
  // tooling + the views resolve it by name.
  {
    const artifact = await hre.deployments.getArtifact("SystemAccount");
    await hre.deployments.save("SystemAccount", { address: result.systemAccount, abi: artifact.abi });
  }

  console.log("[efs-core] summary:");
  console.log("  proxies:", result.proxies);
  console.log("  systemAccount:", result.systemAccount);
  console.log("  registered:", result.registered, "ownershipTransferred:", result.ownershipTransferred);
  if (result.registered) console.log("  safe:", result.safe);
};

export default deployEfsCore;
deployEfsCore.tags = ["EFSCore"];
// Run before the legacy/downstream scripts. The downstream consumer scripts (02/03/06/07/08) still
// bind via getContract("Indexer") etc. — rebinding them to the CREATE3 proxies is deferred to D2.
deployEfsCore.runAtTheEnd = false;
