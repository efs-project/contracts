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
      env: process.env,
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

  log(`deploying contracts to ${rpcUrl}`);
  await runToCompletion("yarn", ["deploy"], {
    ...process.env,
    LOCALHOST_RPC_URL: rpcUrl,
  });
  log("deploy complete");

  const nextPort = await findFreePort(NEXT_START);
  if (nextPort !== NEXT_START) {
    log(`port ${NEXT_START} busy; using ${nextPort} for next dev`);
  }
  log(`starting next dev on :${nextPort} (NEXT_PUBLIC_HARDHAT_RPC_URL=${rpcUrl})`);

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
}

main().catch(err => {
  process.stderr.write(`[preview] fatal: ${err?.stack ?? err}\n`);
  shutdown("SIGTERM", 1);
});
