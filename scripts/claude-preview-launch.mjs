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
 * runs as a child process and is torn down on SIGINT / SIGTERM / exit — see
 * `killTree` for how signal propagation reaches `hardhat node` through the
 * yarn layers above it.
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
  // Probe the same binding footprint Next.js uses. A naive
  // `listen(port, "127.0.0.1")` check reports 3000 as free on macOS even when
  // another dev server already holds `*:3000` on IPv6 only — Next then dies
  // with EADDRINUSE on first boot and trips the fork-teardown path, which
  // cascades into a deploy HH108.
  //
  // Check v6 then v4 sequentially: Node's default `listen(port, "::")` is
  // dual-stack on macOS (IPV6_V6ONLY=0), so running in parallel would
  // self-collide (v6 probe grabs v4 too). One probe at a time.
  const probe = host =>
    new Promise(resolve => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
  return (async () => {
    if (!(await probe("::"))) return false;
    return probe("0.0.0.0");
  })();
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

/**
 * Kill a child AND all of its descendants.
 *
 * Each `yarn` invocation here fans out to a longer process tree than you'd
 * guess: `yarn hardhat:fork` → `yarn workspace @se-2/hardhat fork` → `hardhat
 * node`. `yarn` does NOT forward signals to its children, so `child.kill()`
 * on the outer yarn exits yarn but leaves `hardhat node` orphaned under
 * launchd — which is why previous preview runs left zombie forks eating CPU
 * across reboots (the user noticed fans spinning hard with 7 stale forks
 * accumulated).
 *
 * The workaround is `detached: true` at spawn time — it makes each child the
 * leader of a new process group — paired with `process.kill(-pid, signal)`
 * here, which signals the *whole group* (negative pid == group id). Every
 * descendant inherits the group, so yarn + hardhat + any grandchildren go
 * together. Same pattern applies to `next dev`, which itself spawns
 * `next-server`.
 */
function killTree(child, signal) {
  if (child.killed || child.exitCode !== null || child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH = group already gone; any other error we can't recover from
    // inside a shutdown path, so swallow.
  }
}

function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    killTree(child, signal ?? "SIGTERM");
  }
  if (typeof exitCode !== "number") return; // `exit` event path — Node is already unwinding

  // Wait up to 5s for children's full process trees to exit before terminating
  // the launcher ourselves. Next.js can take 2–3s to flush its compiler state
  // after SIGTERM; the previous 100ms grace routinely orphaned `next-server`
  // on :3000 when Claude Code sent SIGTERM at session close. After the
  // deadline, escalate any stragglers to SIGKILL — at shutdown, port release
  // trumps clean teardown.
  const DEADLINE_MS = 5000;
  const startedAt = Date.now();
  const poll = setInterval(() => {
    const alive = children.filter(c => c.exitCode === null && c.signalCode === null);
    const elapsed = Date.now() - startedAt;
    if (alive.length === 0 || elapsed >= DEADLINE_MS) {
      clearInterval(poll);
      for (const child of alive) {
        log(`child pid ${child.pid} still alive after ${elapsed}ms; escalating to SIGKILL`);
        killTree(child, "SIGKILL");
      }
      process.exit(exitCode);
    }
  }, 200);
}

process.on("SIGINT", () => shutdown("SIGINT", 130));
process.on("SIGTERM", () => shutdown("SIGTERM", 143));
process.on("exit", () => shutdown("SIGTERM"));

/**
 * Parent-death watchdog.
 *
 * Claude Code can exit abruptly (SIGKILL on quit, crash, OS shutdown) without
 * giving this launcher a chance to run its SIGTERM handler. When that happens,
 * our detached child groups survive as launchd-reparented orphans — the
 * hardhat fork stays bound to :8545, `next-server` stays bound to :3000, and
 * the ports are only freed on manual `kill -- -<pgid>`.
 *
 * Poll PPID every 2s: the moment it changes (parent died, OS reparented us to
 * launchd/init = pid 1), run the normal shutdown path. `shutdown()` is
 * idempotent — if a SIGTERM *did* reach us, the guard short-circuits here.
 *
 * Design notes:
 *   - Closing only the Claude Code preview *pane* (iframe hide) does not kill
 *     the MCP bridge process that spawned us, so PPID stays stable and this
 *     watchdog stays silent. That's intentional: users often want to keep
 *     testing in their own browser after closing the pane for screen space.
 *   - We can't solve this by dropping `detached:true` on the children —
 *     `yarn` doesn't forward signals, so without a dedicated process group we
 *     have no way to reach `hardhat node` or `next-server` through the yarn
 *     wrapper layers. See `killTree` doc for the full story.
 *   - `.unref()` so this interval doesn't hold the event loop open on its own
 *     once the children exit under normal shutdown.
 */
const originalPpid = process.ppid;
setInterval(() => {
  if (!shuttingDown && process.ppid !== originalPpid) {
    log(`parent pid ${originalPpid} gone (reparented to ${process.ppid}); shutting down`);
    shutdown("SIGTERM", 143);
  }
}, 2000).unref();

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
      // Own process group so `killTree` can reach `hardhat node` through the
      // `yarn → yarn workspace → hardhat` chain. See `killTree` doc for why.
      detached: true,
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
      // Own process group for the same reason as the fork: yarn spawns
      // `next dev`, which spawns `next-server`. Without detached+group kill,
      // stopping the launcher leaves `next-server` orphaned on the port.
      detached: true,
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
