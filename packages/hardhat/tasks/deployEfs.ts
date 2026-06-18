import { task } from "hardhat/config";

// I-2: the documented runbook command. docs/DEPLOYMENT.md §4 tells the operator to run
//   yarn deploy:efs --network <net> [--until-freeze-gate | --after-freeze-gate]
// This task is the real implementation behind that command. It maps the freeze-gate flags onto the
// EFS_DEPLOY_MODE env var that deploy/00_efs_core.ts reads, then runs ONLY the EFS core deploy (the
// `EFSCore` tag → 00_efs_core.ts) — never the downstream/legacy scripts. The flags are mutually
// exclusive; omitting both is the default `full` run (deploy + verify + wire + register + transfer +
// smoke), which is what the fork rehearsal (`--network hardhat`) exercises end-to-end.
//
// EFS_DEPLOY_MODE remains the underlying mechanism (a single env switch is the cleanest way to thread
// a run-mode through hardhat-deploy's tag system); this task is the thin, documented front door.
task("deploy:efs", "Run the EFS core CREATE3 deploy ceremony (Phase D); EFSCore tag only")
  .addFlag("untilFreezeGate", "Deploy + verify + wire, then STOP before any schema is registered")
  .addFlag("afterFreezeGate", "Re-bind the existing proxies, then register + transfer-to-Safe + smoke")
  .addFlag("viaSafe", "Deploy FROM the EFS.eth Safe (born Safe-owned, two MultiSend batches; no transfer)")
  .setAction(async (args, hre) => {
    const { untilFreezeGate, afterFreezeGate, viaSafe } = args as {
      untilFreezeGate: boolean;
      afterFreezeGate: boolean;
      viaSafe: boolean;
    };

    if (untilFreezeGate && afterFreezeGate) {
      throw new Error("deploy:efs: pass at most one of --until-freeze-gate / --after-freeze-gate.");
    }

    // Safe-native path (docs/DEPLOYMENT.md §1/§3): deploy FROM the EFS.eth Safe as two owner-signed
    // MultiSend batches, born Safe-owned (no transfer phase). The freeze-gate flags don't apply here —
    // the gate is the human signing the freeze table BETWEEN the two Safe batches. Equivalent to
    // setting EFS_DEPLOY_VIA_SAFE=1 + EFS_SAFE_ADDRESS=<Safe>.
    if (viaSafe) {
      if (untilFreezeGate || afterFreezeGate) {
        throw new Error("deploy:efs: --via-safe is its own two-batch flow; don't combine with the freeze-gate flags.");
      }
      process.env.EFS_DEPLOY_VIA_SAFE = "1";
      console.log(`[deploy:efs] via-safe network=${hre.network.name} — born Safe-owned, EFSCore tag only.`);
      await hre.run("deploy", { tags: "EFSCore" });
      return;
    }

    const mode = untilFreezeGate ? "until-freeze-gate" : afterFreezeGate ? "after-freeze-gate" : "full";
    process.env.EFS_DEPLOY_MODE = mode;
    console.log(`[deploy:efs] mode=${mode} network=${hre.network.name} — running EFSCore tag only.`);

    // Run only the orchestrated core. hardhat-deploy's `tags` filter restricts execution to
    // 00_efs_core.ts; the downstream/legacy scripts (01–09) are never invoked from this task.
    await hre.run("deploy", { tags: "EFSCore" });
  });
