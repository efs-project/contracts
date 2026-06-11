import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CREATEX_ADDRESS } from "./addresses";

// Phase D neutralization helper.
//
// The orchestrated CREATE3 deploy (deploy/00_efs_core.ts) is now the SINGLE source of truth for
// deploying + registering the EFS resolver proxies and the 9 schemas (docs/DEPLOYMENT.md §3,
// ADR-0048). The legacy scripts 01_indexer / 04_sortoverlay / 05_mirrors / 09_lists used
// nonce-prediction + the transitional TestERC1967Proxy and registered schemas inline — that path is
// superseded and conflicts with register-last. They are neutralized: wherever CreateX is present (the
// orchestrated core can/does run — Sepolia, mainnet, or the pinned fork), the legacy body short-
// circuits. On a bare hardhat node with no CreateX they remain inert too (the core skips there as
// well). Rebinding the downstream consumer scripts (02/03/06/07/08) to the proxies is deferred to D2.
export async function legacySuperseded(hre: HardhatRuntimeEnvironment, script: string): Promise<boolean> {
  const code = await hre.ethers.provider.getCode(CREATEX_ADDRESS);
  if (code !== "0x") {
    console.log(`[${script}] superseded by deploy/00_efs_core.ts (orchestrated CREATE3 deploy) — skipping.`);
    return true;
  }
  console.log(`[${script}] no CreateX on this network; legacy script also inert (Phase D). Skipping.`);
  return true;
}
