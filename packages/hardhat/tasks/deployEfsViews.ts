import { task } from "hardhat/config";

// The documented post-freeze views command. docs/DEPLOYMENT.md §3 step 9 + §4 tell the operator to
// run, AFTER the freeze ceremony:
//   yarn deploy:efs-views --network <net>
// This task is the real implementation behind that command. It runs ONLY the EFS views deploy (the
// `EFSViews` tag → deploy/10_efs_views.ts) — never the core ceremony, never the downstream/legacy
// scripts. The views (EFSFileView, EFSRouter, ListReader) are stateless, in NO schema UID, and freely
// redeployable: re-running is safe (redeploy-or-no-op). They bind to the proxy addresses + frozen
// schema UIDs that the core (`deploy:efs`) registered; the views step fails clearly if the core hasn't
// run on this network.
task("deploy:efs-views", "Deploy the EFS stateless read views post-freeze (Phase D); EFSViews tag only").setAction(
  async (_args, hre) => {
    console.log(`[deploy:efs-views] network=${hre.network.name} — running EFSViews tag only.`);
    // Run only the views step. hardhat-deploy's `tags` filter restricts execution to
    // 10_efs_views.ts (+ its EFSCore dependency, a no-op if already deployed).
    await hre.run("deploy", { tags: "EFSViews" });
  },
);
