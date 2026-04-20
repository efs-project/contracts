import fs from "fs";
import path from "path";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Force a redeploy of `name` when its constructor args differ from the saved
 * deployment. hardhat-deploy skips when the compiled bytecode hasn't changed —
 * so a contract that wires other contract addresses via its constructor will
 * silently keep pointing at the old addresses after a dependency is
 * redeployed (e.g. a new Indexer leaves EFSFileView pinned to the stale one).
 *
 * Call this just before `deploy(name, { args, ... })`. If args match, no-op.
 */
export async function redeployIfArgsChanged(
  hre: HardhatRuntimeEnvironment,
  name: string,
  desiredArgs: unknown[],
): Promise<void> {
  const existing = await hre.deployments.getOrNull(name);
  if (!existing) return;
  const stored = existing.args ?? [];
  const same =
    stored.length === desiredArgs.length &&
    stored.every((a, i) => String(a).toLowerCase() === String(desiredArgs[i]).toLowerCase());
  if (same) return;

  console.log(
    `[${name}] Constructor args changed — deleting stale deployment record to force redeploy.\n` +
      `  Saved:   ${JSON.stringify(stored)}\n` +
      `  Desired: ${JSON.stringify(desiredArgs)}`,
  );
  const file = path.join(hre.config.paths.deployments, hre.network.name, `${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
