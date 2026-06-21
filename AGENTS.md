# AGENTS.md

EFS — Ethereum File System. On-chain file system built on EAS attestations. Pre-launch, devnet target April 19, 2026. Breaking changes are acceptable for now as there's no real data created yet. Good design and future proofing is key.

**Production web client** (Vite/Lit, separate repo): https://github.com/efs-project/client. The internal UI at `packages/nextjs/` in this repo is a Scaffold-ETH-based devtools/debug interface — not the production client. Don't apply Scaffold-ETH patterns (`useScaffoldReadContract` etc.) to the production client.

## Read on init

**If your tool does not auto-load `@`-imported files (non-Claude-Code agents: Codex CLI, Cursor, Gemini, GitHub Actions agents, etc.), you MUST read all of these before starting any task:**

- **[docs/agent-workflow.md](./docs/agent-workflow.md)** — escalation tiers, decision logging, asking-the-human protocol. **Required before any task.**
- **[specs/overview.md](./specs/overview.md)** — architecture at a glance.
- **[docs/QUESTIONS.md](./docs/QUESTIONS.md)** — open items needing the human's input. Check before working in any area.

(Claude Code auto-loads the above via `CLAUDE.md`'s `@` imports.)

## Read as needed

- **[specs/README.md](./specs/README.md)** — index of detailed specs (authoritative current behavior)
- **[docs/adr/](./docs/adr/)** — past decisions and reasoning
- **[docs/FUTURE_WORK.md](./docs/FUTURE_WORK.md)** — backlog
- **[docs/LAUNCH_CHECKLIST.md](./docs/LAUNCH_CHECKLIST.md)** — pre-launch blockers
- **[reference/README.md](./reference/README.md)** — EAS, EIP, Scaffold-ETH docs (indexed by task)

## Cross-repo coordination — the planning vault

EFS uses a separate **planning vault** as the cross-repo coordination point across this repo, the production client (`efs-project/client`), and the future SDK. Repo: [efs-project/planning](https://github.com/efs-project/planning); typically cloned alongside this one (target layout: `/efs/{contracts,client,sdk,planning}/`).

The vault holds:

- **Cross-repo designs** with a name-first → numbered-at-promotion lifecycle. Designs that span multiple repos are tracked there; per-repo decisions stay here as ADRs.
- **Cross-repo Kanban board**, milestones (e.g., OnionDAO hackathon 2026-06-01), and an append-only decisions log.
- **Glossary** of cross-cutting EFS terms.
- **Onboarding** for AI agents (start-here, conventions, escalation, write-a-design walkthrough).

Read the vault's [`AGENTS.md`](https://github.com/efs-project/planning/blob/main/AGENTS.md) on init when your task is cross-repo. **A landed cross-repo design typically produces one or more ADRs here** — the planning design is the cross-cutting proposal; the resulting ADR(s) in this repo's `docs/adr/` are the per-repo decision artifacts. Don't duplicate substantive content; the design tombstones to point at the per-repo ADRs once implementation lands.

For tasks fully scoped to this repo, the planning vault is optional context. For tasks spanning repos or unblocking a milestone, it's required reading.

## PR review quick start

When reviewing a PR, do not prompt agents with only `review PR #<N>`. That is
too weak and reliably produces messy shared-account output.

Use the canonical prompt shape from `docs/review/review-squad.md`, or an
equivalent prompt that explicitly requires all of the following:

- read the PR description first, including `Agents involved`
- read the governing specs / ADRs before commenting
- use GitHub's native Review feature, not loose PR comments
- when reviewing from James's GitHub account, submit a native `COMMENT` review
  with inline threads; do not use `APPROVE` or `REQUEST_CHANGES`
- open resolvable inline review threads whenever the finding maps to a diff hunk
- mark the review body `Same-account advisory review: BLOCKING` when any
  unresolved P0/P1/P2 finding remains, or `NO BLOCKING FINDINGS` otherwise
- prefix every review body, inline comment, and thread reply with
  `[<model-name> · <role>]`
- avoid placeholder / probe / "testing anchor" comments
- if native review threads are unavailable, return one paste-ready structured
  review comment instead of spraying ad hoc comments into the PR timeline

## Change-type → required reads

If your task fits one of these categories, load the listed ADRs *before* writing code. Most Tier 1 mistakes come from missing the right governing decision.

| Change type | Required reads |
|---|---|
| Schema field change (ANCHOR, DATA, MIRROR, PIN, TAG, PROPERTY, SORT_INFO) | ADR-0005, ADR-0030, ADR-0032, ADR-0041, `specs/02-Data-Models-and-Schemas.md` |
| New transport type or priority change | ADR-0011, ADR-0012, ADR-0023, `specs/02` §Mirror |
| Kernel index / indexing logic (EFSIndexer / EdgeResolver) | ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0021, ADR-0041, `specs/03-Onchain-Indexing-Strategy.md` |
| Edge writes (PIN vs TAG choice; cardinality) | ADR-0041, `specs/02-Data-Models-and-Schemas.md` §Pin/Tag |
| Lenses / router resolution | ADR-0013, ADR-0014, ADR-0016, ADR-0017, ADR-0020, ADR-0031, ADR-0033, `specs/04-Core-Workflows.md` |
| Root URL classification / schema alias anchors | ADR-0033, ADR-0019, ADR-0025 |
| Display-name / address-label rendering | ADR-0014, ADR-0034, `specs/02` §Property |
| Security limits (MAX_*) | ADR-0021 through ADR-0026 |
| Deploy / wiring / contract addresses | ADR-0027, ADR-0028, ADR-0030 |
| Sort overlay | ADR-0011 (transports pattern analog), `specs/07-Sort-Overlay-Architecture.md` |
| Licensing / legal | ADR-0029 |

## Setup

**One-command path (preferred — also what Claude Code's "Preview" button runs):**

```bash
yarn preview   # fork + deploy + next dev, with auto-port selection
```

This launches the hardhat Sepolia fork, deploys contracts, then starts Next.js dev,
all wired together. If `8545` or `3000` are busy (another worktree / preview
already running), it scans upward and picks free ports automatically and passes
them through as `LOCALHOST_RPC_URL` / `NEXT_PUBLIC_HARDHAT_RPC_URL`. The hardhat
fork is a child process and is torn down when `next dev` exits.

**Three-terminal path (when you want each piece under separate control):**

```bash
yarn fork     # Terminal 1 — local Sepolia fork (required, not plain hardhat node)
yarn deploy   # Terminal 2 — deploy contracts (handles workspace + env)
yarn start    # Terminal 3 — Next.js debug UI at http://localhost:3000
```

Open the wallet menu (address chip, top right of UI) and click **Fund wallet (1 ETH)** to top up the burner — attestations need gas.

### Running alongside another project (parallel agents / worktrees)

The default ports are `8545` (hardhat RPC) and `3000` (Next.js). When another agent or
worktree is already bound to them, pick free ports and wire them through two env vars.
**Nothing else changes** — yarn forwards trailing args to the underlying scripts, so
`--port` / `-p` flags flow through unchanged.

```bash
# Terminal 1 — second hardhat node on 8546
yarn fork --port 8546

# Terminal 2 — deploy against it
#   LOCALHOST_RPC_URL retargets hardhat's `localhost` network (deploy/simulate/seed)
LOCALHOST_RPC_URL=http://127.0.0.1:8546 yarn deploy

# Terminal 3 — Next.js on 3001, pointed at the same node
#   NEXT_PUBLIC_HARDHAT_RPC_URL retargets wagmi's hardhat transport
NEXT_PUBLIC_HARDHAT_RPC_URL=http://127.0.0.1:8546 yarn start -p 3001
```

Or (preferred for long-running agents) set them once in `packages/hardhat/.env` and
`packages/nextjs/.env.local` — templates in the matching `.env.example` files. Leaving
the vars unset keeps the original `127.0.0.1:8545` / `:3000` behavior.

The two vars are **independent**: `LOCALHOST_RPC_URL` governs hardhat CLI (`yarn deploy`,
`yarn simulate*`, `yarn seed`); `NEXT_PUBLIC_HARDHAT_RPC_URL` governs the in-browser
wagmi client. Set both to the same URL when running end-to-end.

**Smoke test**: navigate to `http://localhost:3000/debug/schemas`, submit a test TAG attestation via the Tag Schema form, and confirm it appears in the Attestation Viewer below. This verifies EAS is reachable, schemas are registered, and the resolver chain is wired correctly.

### Seeding demo data (devnet + local first-run)

Demo data is seeded as a hardhat-deploy step (`deploy/10_seed_demo_tree.ts`),
so a fresh deploy populates a small demo tree (`/docs/`, `/images/`, `/shared/`)
with a lenses demo on `shared/photo.png` automatically. The step runs as
part of `hardhat deploy` itself, not as a chained-after-deploy script —
meaning **any** deploy entry point auto-seeds: root `yarn deploy`,
`yarn workspace @se-2/hardhat deploy` (devnet VPS path), `yarn preview`, CI.

The seed is **idempotent** — each top-level subtree is guarded by a
`resolveAnchor` call, so re-running after a partial failure only fills in
what's missing, and re-running after a successful seed is a zero-write
no-op. It is also **fail-soft**: if the Indexer contract isn't registered
(e.g. CI deploy against a vanilla hardhat node with no EAS) the seed logs
a skip and returns cleanly rather than failing the deploy.

The step is **localhost/hardhat-only** — on real Sepolia or mainnet it
short-circuits before any writes, matching the gate in `07_persona_names.ts`.

Run seed by itself (e.g. after manual contract deployment or to re-seed
after a data wipe) with `yarn hardhat:seed`.

### Pinned Sepolia fork (coordination unit for devnet / client)

The hardhat network forks Sepolia at a **pinned block** (see `packages/hardhat/hardhat.config.ts` → `networks.hardhat.forking.blockNumber`; default set via `FORK_BLOCK`). This makes contract addresses, EAS schema UIDs, and `packages/nextjs/contracts/deployedContracts.ts` byte-identical across every environment that runs this commit — local hardhat, CI, the devnet VPS, the statically hosted Vite client. See ADR-0037.

**Invariant**: `packages/nextjs/contracts/deployedContracts.ts` is committed and is the contract-address source of truth. It's regenerated by `yarn deploy` against the pinned fork. If you bump `FORK_BLOCK`, regenerate and commit `deployedContracts.ts` in the same commit. The commit SHA is the cross-environment coordination unit.

`deployedContracts.ts` is **multi-chain** — a block per chain (`31337` fork, `11155111` real Sepolia, mainnet later). `generateTsAbis` **merges per-chain**: a single-network deploy regenerates only its own block and preserves the others (so a local fork deploy never wipes the frozen Sepolia block). `deploy-pin-check` diffs the whole file and works across all chains unchanged. See ADR-0061.

**Verifying the pin held after a deploy:**

```bash
git diff --exit-code packages/nextjs/contracts/deployedContracts.ts
```

Exit 0 means `yarn deploy` regenerated the file byte-identically to what's committed — the pin is working. Non-zero means the fork state your deploy ran against differs from the pin, and any downstream consumer (Vite client, devnet, CI) will see drifted addresses. CI runs this same check on every PR as the `deploy-pin-check` job.

### Running Foundry anvil directly (devnet VPS / long-lived nodes)

`yarn fork` and `yarn preview` both wrap **Hardhat's node**, which reads `blockNumber` from `hardhat.config.ts` automatically — the pin is inherited, nothing to do. But a long-lived devnet is typically run with **Foundry `anvil`** directly (faster, lighter, supports `--state` for restart persistence). Foundry does not read hardhat's config, so the pin must be passed on the CLI:

```bash
anvil \
  --host 0.0.0.0 \
  --port 8545 \
  --chain-id 31337 \
  --fork-url "$SEPOLIA_FORK_RPC_URL" \
  --fork-block-number "${FORK_BLOCK:-10691000}" \
  --state /data/anvil-state.json \
  --state-interval 30
```

**Trap: `--state` + pin bump.** `--state` persists live chain state (accumulated nonces, new blocks) across restarts. When you bump `FORK_BLOCK` or first introduce the pin on an already-running node, the state file encodes drifted state — loading it on startup replays that drift on top of the fresh pin and addresses still come out wrong. Wipe or rotate the state file when bumping the pin:

```bash
rm /data/anvil-state.json   # or: mv … /data/anvil-state.json.prepinned
```

After a pinned restart + fresh `yarn deploy`, anvil's head should be `FORK_BLOCK + ~80` (roughly one block per deploy/seed tx). If `eth_blockNumber` reports a number ~1000+ above the pin, the state file was still loaded.

### Static export for IPFS / eth.limo (`app.efs.eth.limo`, `app.efs.eth.link`)

The Next.js app ships as a **pure static export** — `output: "export"` in `packages/nextjs/next.config.js`. `yarn workspace @se-2/nextjs build` writes `out/`, a flat file tree with no server, no edge runtime, no ISR. Target deployment: pin `out/` to IPFS and point the ENS name (`app.efs.eth`) at the CID. `eth.limo` / `eth.link` then serve it directly to browsers; no reverse proxy needed for the frontend.

**Service endpoints must be absolute VPS URLs baked at build time.** The app loads from the `app.efs.eth.limo` origin but talks to the devnet VPS across origins — so RPC, IPFS gateway, Arweave gateway, and WS URLs all need absolute values. See `packages/nextjs/.env.example` for the canonical list; all four variables are `NEXT_PUBLIC_*` and thus inlined by webpack at build time.

**Minimal `out/`-producing build command** (run in CI or VPS publish pipeline):

```bash
cd packages/nextjs
NEXT_PUBLIC_SITE_URL=https://app.efs.eth.limo \
NEXT_PUBLIC_HARDHAT_RPC_URL=https://<vps-host>/rpc \
NEXT_PUBLIC_IPFS_GATEWAY=https://<vps-host>/ipfs/ \
NEXT_PUBLIC_ARWEAVE_GATEWAY=https://<vps-host>/arweave/ \
NEXT_PUBLIC_DEVNET_BANNER="DEVNET — resets weekly." \
yarn build
```

Outputs `packages/nextjs/out/`. `ipfs add -r out/` → copy the resulting root CID to the ENS name.

**Deep-link SPA fallback.** The only truly dynamic route is `/explorer/[[...path]]` — anchor / address / schema / attestation URLs aren't enumerable at build time. Next's static export emits one shell at `/explorer/index.html`; `public/_redirects` tells IPFS gateways (per the [web-redirects spec](https://specs.ipfs.tech/http-gateways/web-redirects-file/), honored by Kubo ≥ 0.23 and eth.limo) to serve that shell with status 200 for any `/explorer/*` URL. The shell is a client component that reads `useParams()` at runtime and renders the real path. Blockexplorer's `/address/[address]` and `/transaction/[txHash]` use the same trick via dummy `generateStaticParams` values.

**CORS prerequisite on the VPS.** Because the app origin (`app.efs.eth.limo`) is different from the service origin (the VPS), the VPS reverse proxy (Caddy/nginx) MUST respond with:

```
Access-Control-Allow-Origin: https://app.efs.eth.limo, https://app.efs.eth.link
Access-Control-Allow-Headers: content-type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

on the `/rpc`, `/ipfs/`, `/arweave/` paths. Without this, the browser blocks every read from the app and you'll see CORS errors in the console. Local dev (`yarn start`) stays same-origin so this concern doesn't apply there.

**Smoke test after publishing.** Visit these URLs and confirm each renders the expected content without reloading:

1. `https://app.efs.eth.limo/` — landing page
2. `https://app.efs.eth.limo/explorer/` — Explorer root
3. `https://app.efs.eth.limo/explorer/docs/readme.txt` — deep path (tests `_redirects`)
4. DevTools → Network tab: every XHR should target `<vps-host>`, none should target `localhost` or `eth.limo`.

## Commands

```bash
yarn hardhat:test           # contract tests
yarn hardhat:simulate       # run simulate-file-browser.ts against localhost
yarn hardhat:seed           # idempotent demo tree (/docs /images /shared)
yarn next:check-types       # TypeScript check
yarn lint && yarn format    # both packages
```

Single test file:
```bash
cd packages/hardhat && npx hardhat test test/EFSIndexer.test.ts --network hardhat
```

## Critical

- **Specs are authoritative.** If specs and code disagree, surface it (likely Tier 2). Don't guess which is right.
- **ADRs are immutable once Accepted.** Don't edit historical ones. Supersede instead.
- **Permanence-tier awareness.** Before any non-trivial work, identify whether you're on an Etched, Durable, or Ephemeral surface (see `docs/agent-workflow.md` → Permanence tiers). On Etched surfaces (mainnet contracts, schema UIDs, append-only index shapes, ADR-codified invariants), the frame is "minimum irreversible assumptions" and the 50-year test applies. Simplicity heuristics that bias toward "minimum code" are subordinate to future-proofing on these surfaces.

## Invariants

**Hardened (load-bearing — don't violate without writing a superseding ADR):**

- **Cardinality is declared at the schema level (PIN vs TAG), not per-attestation.** The schema UID is the only permanent, globally-coordinated, machine-readable slot in EFS. PIN = cardinality 1 (file placement, PROPERTY value binding); TAG = cardinality N with an `int256 weight` (folder visibility, descriptive labels, schema-alias discovery). See ADR-0041.
  - **Active TAG** (kernel) = unrevoked edge exists. Weight does not affect kernel activity. Use this definition in contracts, resolver helpers, and any non-filter code path.
  - **Effective TAG** (client convention, ADR-0042) = active TAG with `weight >= 0`. Only applied in `FileBrowser.resolveTagSet` for the explorer's descriptive-label include/exclude filter. `weight < 0` = suppressed for that filter but still active on-chain. Do not call suppressed/negative-weight TAGs "inactive" in shared code.
- **Removal is via `eas.revoke()`, not `applies=false`.** PIN replacement is automatic when re-attesting at the same `(attester, definition, targetSchema)` slot; the prior PIN is superseded in O(1).

**Soft (working draft — flag any reshaping as Tier 1):**

- **Database (kernel) and File System (overlay) are separate concerns.** Don't put file-system-specific primitives in the kernel. The layer-2 vs layer-3 boundary inside `EFSIndexer.sol` and what counts as "layer-4 file-system overlay" vs "layer-3 graph primitive" (e.g. `_containsAttestations`, qualifying-folder index) are still being shaped — see `specs/01-System-Architecture.md` for the working sketch. Reshaping the layers is a Tier 1 design conversation.

---

*Claude Code: see CLAUDE.md (pointer to this file).*
