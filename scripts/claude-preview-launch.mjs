#!/usr/bin/env node
/**
 * Claude Code Preview launcher — one command that brings the full EFS dev
 * stack up: hardhat fork → deploy → next dev. Handles the "another instance
 * is already running" case by scanning for a free port starting from the
 * default and incrementing.
 *
 * Invoked via `yarn preview` (see root package.json) and wired into
 * `.claude/launch.json` so the Claude Code "Preview" button runs it.
 *
 * Env overrides:
 *   EFS_PREVIEW_HARDHAT_PORT  (default 8545) — starting port for the fork scan
 *   EFS_PREVIEW_NEXT_PORT     (default 3000) — starting port for next dev scan
 *
 * Foreground process follows the lifetime of `next dev`. The hardhat fork
 * runs as a child process and is torn down on SIGINT / SIGTERM / exit.
 */

import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const HARDHAT_START = Number(process.env.EFS_PREVIEW_HARDHAT_PORT ?? 8545);
const NEXT_START = Number(process.env.EFS_PREVIEW_NEXT_PORT ?? 3000);
const PORT_SCAN_ATTEMPTS = 20;
const FORK_READY_TIMEOUT_MS = 120_000;

function log(msg) {
  process.stdout.write(`[preview] ${msg}\n`);
}

function isFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start, attempts = PORT_SCAN_ATTEMPTS) {
  for (let p = start; p < start + attempts; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`No free port in range ${start}..${start + attempts - 1}`);
}

function waitForPort(port, timeoutMs = FORK_READY_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timeout waiting for 127.0.0.1:${port}`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function runToCompletion(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.once("error", reject);
  });
}

/**
 * Pre-warm the next dev server so the first compile runs against OUR request
 * rather than the Claude Code Preview iframe's. Claude Code Preview uses
 * `autoPort: true` (see `.claude/launch.json`), which opens the iframe the
 * moment the dev port binds — but Next.js only begins compiling on the first
 * HTTP request, so a cold boot otherwise shows a blank iframe for 5–15s and
 * the user has to hit refresh.
 *
 * Fire a GET here immediately after bind; Next.js serializes per-route
 * compilation, so the iframe's slightly-later request piggybacks on the same
 * compile and gets the warm response.
 *
 * Non-fatal: any failure (including timeout) falls through and we continue
 * startup. Worst case we're back to the old blank-iframe behavior.
 */
function prewarm(port, path = "/", timeoutMs = 45_000) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, res => {
      // Drain so the socket closes cleanly and Next.js doesn't log a warning.
      res.resume();
      res.once("end", () => resolve(true));
      res.once("error", () => resolve(false));
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
  });
}

const children = [];
let shuttingDown = false;

function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill(signal ?? "SIGTERM");
      } catch {
        /* child already gone */
      }
    }
  }
  if (typeof exitCode === "number") {
    // Give children a tick to flush before exit.
    setTimeout(() => process.exit(exitCode), 100);
  }
}

process.on("SIGINT", () => shutdown("SIGINT", 130));
process.on("SIGTERM", () => shutdown("SIGTERM", 143));
process.on("exit", () => shutdown("SIGTERM"));

async function main() {
  const hardhatPort = await findFreePort(HARDHAT_START);
  const rpcUrl = `http://127.0.0.1:${hardhatPort}`;

  if (hardhatPort !== HARDHAT_START) {
    log(`port ${HARDHAT_START} busy; using ${hardhatPort} for the hardhat fork`);
  }
  log(`starting hardhat fork on :${hardhatPort}`);

  const fork = spawn(
    "yarn",
    ["hardhat:fork", "--port", String(hardhatPort)],
    {
      stdio: ["ignore", "inherit", "inherit"],
      // MAINNET_FORKING_ENABLED=true makes hardhat actually fork Sepolia at the pinned
      // FORK_BLOCK (see hardhat.config.ts, ADR-0037). Without it, `networks.hardhat.forking`
      // is ignored and deployments land on a bare chain with no EAS state — broken.
      env: { ...process.env, MAINNET_FORKING_ENABLED: "true" },
    },
  );
  children.push(fork);
  fork.once("exit", code => {
    if (shuttingDown) return;
    log(`hardhat fork exited unexpectedly (code ${code}); shutting down`);
    shutdown("SIGTERM", code ?? 1);
  });

  await waitForPort(hardhatPort);
  log(`fork accepting connections on :${hardhatPort}`);

  // Run deploy and next dev in parallel. Both only need the fork to be up;
  // next dev's first compile (5–15s for the Scaffold-ETH graph) overlaps with
  // the deploy so by the time we pre-warm the root route, compilation is
  // largely done. The home page '/' doesn't call contracts at mount time, so
  // it's safe to render before deploy finishes — anything that reads chain
  // state is under /debug or /explorer and is only hit after user navigation.
  const nextPort = await findFreePort(NEXT_START);
  if (nextPort !== NEXT_START) {
    log(`port ${NEXT_START} busy; using ${nextPort} for next dev`);
  }

  log(`deploying contracts to ${rpcUrl} (next dev starting in parallel on :${nextPort})`);

  const deployPromise = runToCompletion("yarn", ["deploy"], {
    ...process.env,
    LOCALHOST_RPC_URL: rpcUrl,
  });

  const next = spawn(
    "yarn",
    ["workspace", "@se-2/nextjs", "dev", "-p", String(nextPort)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_HARDHAT_RPC_URL: rpcUrl,
      },
    },
  );
  children.push(next);
  next.once("exit", code => {
    if (shuttingDown) return;
    log(`next dev exited (code ${code}); shutting down`);
    shutdown("SIGTERM", code ?? 0);
  });

  // Race: pre-warm as soon as the dev port binds, so the first compile is
  // driven by our request rather than the Claude Code Preview iframe's. The
  // iframe opens immediately on port bind (autoPort: true in .claude/launch.json),
  // and Next.js serializes compilation, so both our pre-warm request and the
  // iframe's request wait on the same compile and return together.
  waitForPort(nextPort)
    .then(async () => {
      log(`next dev listening on :${nextPort}; pre-warming /`);
      const ok = await prewarm(nextPort, "/");
      log(ok ? "pre-warm complete" : "pre-warm did not complete (non-fatal)");
    })
    .catch(err => log(`pre-warm skipped: ${err?.message ?? err}`));

  try {
    await deployPromise;
    log("deploy complete");
  } catch (err) {
    // Deploy failure is fatal — the app is wired to deployedContracts.ts and
    // expects chain state to match. Tear down everything.
    log(`deploy failed: ${err?.message ?? err}`);
    shutdown("SIGTERM", 1);
    return;
  }

  log(`preview ready — http://127.0.0.1:${nextPort}`);
}

main().catch(err => {
  process.stderr.write(`[preview] fatal: ${err?.stack ?? err}\n`);
  shutdown("SIGTERM", 1);
});
