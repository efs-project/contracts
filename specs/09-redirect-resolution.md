# REDIRECT Read-Time Resolution

**Status:** Accepted (James ratified 2026-06-20 — see `docs/adr/0059-redirect-read-time-resolution.md`). The **rules** here are accepted; the on-chain read-time follower **implementation is DEFERRED** (see "Implementation status" below).
**Governs:** the read-time behavior of the REDIRECT schema (ADR-0050). The on-wire schema and its write-time guards are frozen; this spec is the **Durable** half ADR-0050 §"Write-time guards vs read-time resolution" requires before any durable REDIRECT data is seeded on Sepolia.
**Related:** ADR-0050 (REDIRECT schema), ADR-0055 (WHITEOUT negative terminal — reserved here), ADR-0031 (lens first-attester-wins), ADR-0058 (depth-cap precedent), specs/02 §10 (REDIRECT fields), specs/overview.md (read flow).

> **Implementation status — DEFERRED (follower not yet built).** No on-chain redirect-follower exists today, by design: it will be built when REDIRECTs are actually used. This document is the **specification that the future follower must satisfy** — the rules are pinned now (Accepted) because they must be fixed *before* any durable REDIRECT data is seeded (see §10), but the read-time code itself is deferred until there is real redirect data to resolve. An earlier draft follower (a `resolveRedirect` view on `EFSFileView` plus an `AliasResolver.getActiveRedirect` reverse-by-source index) was removed pending that need; when the follower is implemented, this spec may be refined in light of what implementation surfaces ("we might find things"). Treat every "a reader MUST …" / "the follower …" sentence below as a **requirement on that future implementation**, not a description of shipped code. The write-time guards referenced as `AliasResolver.sol:NNN` ARE shipped (the frozen REDIRECT resolver); only the *read-time follower* is deferred.

---

## 1. Scope

This spec defines how a **reader** (router, on-chain view, off-chain indexer, or client) resolves a path or DATA UID *through* REDIRECT attestations. It is normative for the on-chain navigational follower and for any client/indexer that claims conformance.

What this spec governs:

- **Following semantics by `kind`** — which redirects are walked, and to what.
- **The hop cap `D_MAX`** — how far a walk may go before stopping.
- **Cycle handling** — bounded-walk cycle-stop (navigational) and the `sameAs` canonicalization rule (dedup).
- **Lens precedence** — which redirects are even visible to follow.
- **Dangling targets** — what a walk returns when a target is missing/revoked/mistyped.
- **The WHITEOUT negative-terminal reservation** — the room the resolution loop must leave for a future suppression terminal.

What this spec does **not** govern (out of scope, frozen elsewhere):

- The REDIRECT field string `"bytes32 target, uint16 kind"` (FROZEN, ADR-0050).
- `AliasResolver` write-time guards (no self-loop, per-kind typing). The resolver does **not** follow, detect multi-hop cycles, cap depth, or apply lens precedence — verified `AliasResolver.sol:161-198`.
- WHITEOUT's own schema/resolver/readdir behavior — that is a future dedicated schema (ADR-0055). Only the *terminal reservation* is in scope here.

**Baseline fact this spec changes.** The production reader follows nothing today. `EFSRouter._findDataAtPath` (`EFSRouter.sol:889-895`) reads the active placement PIN target in O(1) and returns it — it never inspects REDIRECT. `EFSIndexer.resolvePath` (`EFSIndexer.sol:531-533`) is a pure `_nameToAnchor` lookup. So REDIRECT-following is **new read-side logic**, additively layered on top of the existing path walk; it is not implicit in any deployed read path.

---

## 2. Following semantics by `kind`

Resolution is **positive-only and navigational**: a walk follows an edge only when the kind is a *navigational* kind AND the edge is lens-visible (§5) AND the target type-checks at read time (§6). Following yields a new node; the walk continues from it. **Only `symlink` (2) is auto-followed** (James ratified 2026-06-20); every other kind is a **non-followed terminal**.

**Versioning model: path = newest, UID = exact (James ratified 2026-06-20).** A *path* resolves to the newest content because the publisher re-points the path's placement PIN; a specific *DATA UID* is permanent and resolves to exactly that version. "Give me the latest version" is therefore answered by the **path/placement**, NOT by chasing `supersededBy`. A version chain is a **discoverable on-chain breadcrumb** (read by clients/indexers walking `supersededBy` deliberately), not auto-navigation by the follower. This preserves EFS's **"no silent revision"** property: a fixed UID or link never silently advances to a newer version under a reader's feet.

| `kind` | Name | Source → Target type | Navigational? | Follow rule |
|---|---|---|---|---|
| 0 | `sameAs` | DATA → DATA | **No** (canonicalization only) | Not followed. Used by clients/indexers to pick a canonical representative for dedup (§4.2). A navigational walk that lands on a DATA does **not** chase `sameAs`. Non-followed terminal. |
| 1 | `supersededBy` | DATA → DATA | **No** (breadcrumb only) | **NOT auto-followed** (James ratified 2026-06-20). An active `supersededBy` means "a newer version of this DATA exists at `target`," but the follower does **not** advance to it — "latest" is reached by the path/placement, not by chasing this edge. The follower **stops at the DATA holding the edge** and returns `Resolved`. Clients/indexers MAY walk the chain deliberately (a discoverable breadcrumb); the navigational follower does not. Non-followed terminal. |
| 2 | `symlink` | ANCHOR → (ANCHOR or DATA) | **Yes** | When path resolution lands on an Anchor that is the **source** of a `symlink`, follow to `target`. If `target` is an ANCHOR, continue path resolution there (remaining path segments, if any, resolve under it). If `target` is a DATA, that DATA is the resolved file. The **only** auto-followed kind. |
| 3 | `relatedVersion` (convention) | (untyped) | **No** | Never auto-followed (ADR-0050). A discovery hint only. Non-followed terminal. |
| ≥ 4 | reserved | (untyped) | **No** | Recorded by the resolver, not type-checked, **not followed** by a conformant navigational walk. Meaning is assigned by a future taxonomy revision, never by silent client guesswork. Non-followed terminal. |

**Rationale for `symlink`-only following.** `symlink` is a *navigational shortcut* — "this path points at that node" — exactly what navigation means, so it is followed. `supersededBy` is a *directed version chain* whose terminal ("newest") is real but is reached the EFS way — by the **path's placement PIN**, which the publisher re-points to the newest DATA — not by the follower chasing the chain. Auto-following `supersededBy` would mean a fixed DATA UID silently resolves to a different (newer) version, violating "no silent revision." `sameAs` is an *equivalence relation* (dedup) with no inherent direction or terminal; walking it as if directional would teleport navigation arbitrarily, so it is resolved by *canonicalization* (§4.2), not navigation (the SKOS discipline ADR-0050 cites: keep equivalence out of the follow path). The net: the follower auto-follows only `symlink`; `supersededBy`/`sameAs`/reserved are non-followed terminals.

---

## 3. Hop cap `D_MAX`

- **`D_MAX = 16` hops** is the default navigational ceiling (James ratified 2026-06-20).
- **Hard ceiling = 32 hops.** A reader MUST NOT walk further than 32 hops regardless of configuration. `D_MAX` is a *policy* knob between 1 and 32; 32 is the *structural* ceiling.
- A "hop" is one followed navigational edge — i.e. a `symlink` (the only auto-followed kind, §2). Plain path-segment descent (`resolvePath`) is **not** a hop and is bounded separately by `MAX_ANCHOR_DEPTH = 1024` (`EFSIndexer.sol:149`, ADR-0058). The two budgets are independent: a deep path with no redirects costs 0 hops; a shallow path through 17 chained symlinks exceeds `D_MAX`.

**Return contract on cap exceedance.** When a walk would take a 17th hop (i.e. it has already followed `D_MAX` edges and the current node still has a lens-visible navigational edge out), the walk **stops** and returns status `DepthExceeded`, surfacing the **last node reached** (the node at depth `D_MAX`) as the partial result. It does **not** revert and does **not** silently return the entry node. `DepthExceeded` is a distinct status from `Dangling` — the difference matters for diagnostics (a too-long-but-healthy chain vs. a broken target).

**Why 16 (and why a 32 ceiling).** ADR-0050 proposed `D_MAX ≈ 8`; James ratified **16** (2026-06-20). Sixteen covers any long real symlink chain with comfortable headroom: a symlink-of-symlink beyond 2-3 levels is already a configuration smell, so 16 truncates nothing legitimate, and the gas cost is trivial — 16 × a per-hop `getAttestation` + lens scan is a tiny constant for a read-only `eth_call`. (`sameAs` and `supersededBy` are non-followed terminals, §2, so they consume **zero** hops; only chained symlinks count toward `D_MAX`.) The hard ceiling 32 borrows the *bounded-walk* discipline of the original `MAX_ANCHOR_DEPTH = 32` (ADR-0021): an on-chain walk must never be unbounded, and 32 is the historically-blessed "deep enough that nothing real reaches it, shallow enough that gas is predictable" number for read-side walks. (ADR-0058 raised the *anchor-depth* cap to 1024 because real filesystems nest deeply; redirect *chains* have no such real-world depth pressure, so the small cap stays.)

---

## 4. Cycle handling

Two distinct concerns live under "cycles." Keep them separate — they belong to different layers.

### 4.1 Navigational cycle-stop (on-chain follower — required)

The navigational walk maintains a **visited-set** of node UIDs seen *in this walk*. Before following an edge to `target`, if `target` is already in the visited-set, the walk **stops** and returns status `CycleStopped`, surfacing the node at which the cycle was detected (the last node before the repeat). Because only `symlink` is auto-followed (§2), the cycles the follower can actually encounter are **symlink cycles**. This catches:

- a **direct cycle** the resolver could not (A `symlink` B authored by one attester, B `symlink` A authored by another — each write is individually loop-free, so `AliasResolver`'s `SelfLoop` guard at `AliasResolver.sol:179` does not fire);
- a **multi-hop cycle** (A → B → C → A).

The visited-set is bounded by `D_MAX` (the walk stops at `D_MAX` anyway), so it is a small fixed-size array — no unbounded memory. **The on-chain navigational follower needs only this**: bounded walk + visited-set + cycle-stop. It does NOT compute strongly-connected components.

### 4.2 `sameAs` canonicalization (client/indexer — defined, not on-chain-navigational)

For **dedup** — "which DATA UID is the canonical representative of this `sameAs` cluster?" — the rule is:

> The canonical representative of a `sameAs` strongly-connected component (SCC) is the **lowest UID in the SCC**, by unsigned `bytes32` byte-comparison.

This is **start-independent and deterministic**: every reader, regardless of which member they entered from, lands on the same representative. It is the rule ADR-0050 §"Cycle rule" fixes ("lowest UID in the strongly-connected component… not last safe node, which is entry-dependent and attacker-influenceable").

**Layer assignment (be explicit):**

- The **on-chain navigational follower** (router/view) does the bounded-walk-with-cycle-stop of §4.1. It does **not** run SCC analysis — graph-walking a `sameAs` cluster to its lowest-UID representative is unbounded-in-the-general-case work that does not belong in a per-read on-chain path. When navigation lands on a DATA, it returns that DATA; `sameAs` canonicalization is layered *above* by the caller if dedup is wanted.
- **Clients and off-chain indexers** that present dedup ("you already have this file") compute the `sameAs` SCC (lens-scoped, §5) and resolve to its lowest UID. They MUST use the lowest-UID-in-SCC rule so all conformant clients converge.

`supersededBy` cycles never arise in the navigational follower, because `supersededBy` is a non-followed terminal (§2) — the follower stops at the first DATA holding such an edge, so it cannot loop through a version chain at all. A client/indexer that deliberately walks a `supersededBy` chain (the discoverable breadcrumb) handles a malformed looping chain with its own bounded walk + visited-set; there is no "canonical version" to elect, unlike a `sameAs` equivalence class.

---

## 5. Lens precedence

Resolution is **per-lens, first-attester-wins** (ADR-0031). The reader carries an ordered lens set `[L0, L1, …, system]` (≤ `MAX_LENSES = 20`, `EFSRouter.sol:154`).

- A REDIRECT is **followable only if its attester is a member of the active lens set.** A redirect authored by an attester outside the lens set is **invisible** — it is never followed, never enters the visited-set, never canonicalizes. Foreign redirects cannot reroute a viewer's resolution. This is the structural enforcement of viewer sovereignty (ADR-0031): nobody teleports your reads but an attester you chose to trust.
- A `symlink` resolves **within the same lens scope** as the surrounding path walk. After following a symlink to an Anchor, continued path resolution uses the *same* lens set in the *same* precedence order. The lens scope does not reset or widen at a symlink boundary.
- When more than one lens-visible navigational redirect exists out of a node (e.g. two trusted attesters each assert a different `symlink` for the same Anchor), **first-attester-wins by lens order** selects which to follow: the redirect authored by the earliest lens in the list. Ties within a single attester (a malformed double-assert) break by lowest redirect UID — deterministic and start-independent, the same discipline as §4.2.

---

## 6. Dangling targets

A target is **dangling** at read time if any of the following hold when the walk attempts to follow to it:

- `target` does not resolve to an existing attestation;
- the target attestation is **revoked** (REDIRECTs are revocable; default reads exclude revoked, ADR-0051);
- the target **fails the kind's read-time typing** (e.g. a `symlink` whose `target` is no longer an ANCHOR-or-DATA, or a `sameAs`/`supersededBy` target that is not DATA). Write-time typing was enforced at attest, but targets are independent attestations whose validity is not frozen by the redirect; a reader re-checks.

On encountering a dangling target the walk **stops** and returns status `Dangling`, surfacing the **last good node** (the node holding the dangling edge). It **never reverts**. Because the follower auto-follows only `symlink` (§2), the only `Dangling` it can produce is a **dangling symlink** → "no file at this path" (404-equivalent at the router). A `supersededBy` target that dangles is never reached by the follower (it is a non-followed terminal); a client/indexer that deliberately walks a version chain applies the same "broken pointer absent → last good DATA is the latest reachable version" rule in its own walk.

---

## 7. The WHITEOUT negative-terminal reservation (binding)

This spec freezes a **positive-only** resolution order today. It MUST NOT freeze it in a way that contradicts a future **negative terminal**. Per ADR-0055 (Accepted) the WHITEOUT schema will be added additively post-freeze; its read-time meaning is a *non-following terminal*: "this path is suppressed/empty in this lens — STOP, serve empty, do not fall through to lower lenses."

**Reservation (the room this loop leaves):**

- The lens-scan / resolution loop is defined so that a lens entry at a path may terminate the scan with **one of two terminal kinds**: a *positive* terminal (a placement PIN → serve that DATA, possibly after navigational redirect-following per §2) **or**, in the future, a *negative* terminal (a WHITEOUT → serve empty, stop, no fall-through, no `system` gap-fill). Today only positives terminate; the loop's control flow already admits "terminate with empty without following" as a reachable outcome — see the reference algorithm's `Suppressed-reserved` status (§8), which is a defined-but-never-returned placeholder.
- The cycle / lowest-UID-in-SCC / kind-following rules in §§2-6 are all **follow** rules; none of them assumes that *every* terminal is a thing-to-follow. A terminal that **stops** rather than **follows** is consistent with this order, not a contradiction of it.
- A negative terminal is evaluated in the **same lens precedence** as positives (§5): a WHITEOUT by `Lk` terminates the scan for lenses strictly below `Lk` and is transparent to lenses above `Lk`.

**This spec does NOT implement WHITEOUT.** It reserves the terminal slot. The follower returns `Suppressed-reserved` from no input today; the status exists only so the future schema slots in without a control-flow change to the resolution loop.

---

## 8. Reference algorithm (on-chain navigational follower)

Pseudocode for the bounded, lens-scoped, cycle-stopping navigational follower. `firstInLensRedirect(node, lenses)` returns the first-attester-wins (§5) active, lens-visible redirect out of `node` (of **any** kind), or ∅ — the follower then decides whether the kind is auto-followed.

```
struct Result {
  bytes32 uid;          // resolvedDataUID or resolvedAnchorUID (the surfaced node)
  bool    isData;       // true => uid is a DATA; false => uid is an ANCHOR
  Status  status;       // Resolved | Dangling | CycleStopped | DepthExceeded | Suppressed-reserved
}

// Entry: `node` is the Anchor the path walk landed on (symlink case)
//        or the DATA just placed by a PIN (version case — note: the follower does
//        NOT chase supersededBy; "latest" comes from the path's placement PIN, §2).
function resolve(node, isData, lenses) -> Result {
  visited = {}                       // bounded by D_MAX
  hops = 0

  loop {
    // ── reserved negative terminal (WHITEOUT, ADR-0055) ──────────────
    // if negativeTerminal(node, lenses):  return Result(0, false, Suppressed-reserved)
    //   ^ NOT implemented today; the branch is reserved so the loop can
    //     terminate with "empty, stop, no fall-through" without restructuring.

    // ── pick the first lens-visible redirect out of `node` ───────────
    edge = firstInLensRedirect(node, lenses)
    if edge == ∅:
      return Result(node, isData, Resolved)                  // terminal: nothing to follow

    // ── follow ONLY symlink (2); every other kind is a non-followed ──
    //    terminal (supersededBy/sameAs/reserved). James ratified 2026-06-20.
    if edge.kind != symlink:
      return Result(node, isData, Resolved)                  // non-followed terminal

    // ── dangling check (existence, revocation, read-time typing) ─────
    if !targetValidForKind(edge.target, edge.kind):
      return Result(node, isData, Dangling)                  // surface last good node

    // ── depth cap (hard ceiling 32; default D_MAX = 16) ──────────────
    if hops == D_MAX:
      return Result(node, isData, DepthExceeded)             // surface last node

    // ── cycle-stop (visited-set within this walk) ────────────────────
    if edge.target ∈ visited:
      return Result(node, isData, CycleStopped)              // surface node before repeat
    visited.add(node)

    // ── advance ──────────────────────────────────────────────────────
    node   = edge.target
    isData = (schemaOf(edge.target) == DATA)                 // symlink may cross ANCHOR→DATA
    hops  += 1
    // If symlink landed on an ANCHOR with remaining path segments, the caller
    // resumes resolvePath() under `node` in the SAME lens scope (§5), then
    // re-enters resolve() if that lands on a new symlink-source.
  }
}
```

Notes:
- `supersededBy` and `sameAs` are **non-followed terminals** — the loop returns `Resolved` at the node holding either. `supersededBy` is a discoverable version-chain breadcrumb (clients/indexers may walk it deliberately, §2); `sameAs` canonicalization (§4.2) is a separate, caller-layered, off-the-navigational-path computation. Only `symlink` advances the loop.
- The follower returns a node + status; the **router** maps `Resolved`+DATA → serve that DATA's best mirror (existing `_findDataAtPath` + `_getBestMirrorURI` flow), `Dangling`/`DepthExceeded`/`CycleStopped` → 404-equivalent (with the surfaced node available for diagnostics), `Suppressed-reserved` → (future) serve empty without fall-through.
- The follower, once built, is a **stateless redeployable view** — it adds no kernel storage (§ADR-0059 Consequences). It can be re-deployed without touching any frozen schema UID, so the exact landing site (EFSFileView vs EFSRouter vs a dedicated follower) is not frozen by this spec (flagged in ADR-0059 SPICY). Because the implementation is **deferred** (see "Implementation status"), even the reverse-by-source read it needs from `AliasResolver` (the earlier draft's `getActiveRedirect` index) is not present today and will be added — additively, off the frozen REDIRECT schema UID — when the follower is built.

---

## 9. Conformance Vectors

Every conformant reader (on-chain follower, router, off-chain indexer, client) MUST produce these results. UIDs are symbolic and ordered `A < B < C < …` by `bytes32` byte-comparison. All redirects are authored by a lens-visible attester unless stated otherwise. "Latest"/"resolved node" is the `Result.uid`; status is `Result.status`.

| # | Name | Setup | Expected result |
|---|---|---|---|
| 1 | Simple symlink | Path `/x` Anchor `Ax` is `symlink` source → DATA `D1`. | `{uid: D1, isData: true, status: Resolved}`. Router serves `D1`'s mirror. 1 hop. |
| 2 | Symlink to anchor + descent | `Ax` (`/x`) `symlink` → Anchor `Ay` (`/y`); requested path `/x/file`; `Ay` has child `file` placed → `D2`. | Resolve `Ax`→`Ay` (1 hop), resume `resolvePath(Ay,"file")` in same lens scope, land on PIN → `{uid: D2, status: Resolved}`. |
| 3 | `supersededBy` is a non-followed terminal | DATA `D1` `supersededBy` `D2`; `D2` `supersededBy` `D3`. Read lands on `D1`. | `{uid: D1, isData: true, status: Resolved}`. **0 hops** — `supersededBy` is NOT auto-followed (James ratified 2026-06-20). The follower stops at `D1`. "Latest" is reached by the path's placement PIN, not by chasing this chain; the chain is a discoverable breadcrumb for clients/indexers (path=newest / UID=exact). |
| 4 | Depth exceeded (symlinks) | Chain of 17 `symlink` hops `A0→A1→…→A17` (all lens-visible, healthy). `D_MAX = 16`. Read lands on `A0`. | After 16 hops the walk is at `A16`, which still has a lens-visible symlink out → `{uid: A16, status: DepthExceeded}`. Not `A17`, not reverted. |
| 5 | Direct cycle (symlinks) | `A1` `symlink` `A2` (attester α); `A2` `symlink` `A1` (attester β); both in lens set. Each write passes `AliasResolver` (no direct self-loop). Read lands on `A1`. | Walk: `A1`→`A2` (1 hop), next edge target `A1` ∈ visited → `{uid: A2, status: CycleStopped}`. No infinite loop, no revert. (Only symlinks can cycle the follower — `supersededBy` cycles never arise, §4.2.) |
| 6 | Multi-hop cycle (symlinks) | `A1`→`A2`→`A3`→`A1` (all `symlink`, lens-visible). Read lands on `A1`. | `A1`→`A2`→`A3` (2 hops), next target `A1` ∈ visited → `{uid: A3, status: CycleStopped}`. |
| 7 | Dangling target (revoked) | `A1` `symlink` `A2`; `A2` exists. `A2` `symlink` `A3`, but `A3` is revoked / does not exist. Read lands on `A1`. | `A1`→`A2` (1 hop), edge out of `A2` is dangling → `{uid: A2, status: Dangling}`. `A2` is the last good node. Router 404s only if `A2` resolves to no file. |
| 8 | Cross-lens not followed | `A1` `symlink` `A2` authored by attester γ. Reader's lens set is `[α, system]`; γ ∉ set. Read lands on `A1`. | γ's redirect is invisible → no edge out of `A1` → `{uid: A1, status: Resolved}`. The foreign redirect does not reroute. 0 hops. |
| 9 | `supersededBy` not followed even with a fork | `D1` `supersededBy` `D2` (attester α, lens index 0); `D1` `supersededBy` `D9` (attester β, lens index 1). Lens set `[α, β]`. Read lands on `D1`. | `{uid: D1, status: Resolved}`, **0 hops** — neither supersession is taken; `supersededBy` is a non-followed terminal regardless of lens precedence. The competing edges are breadcrumbs only. |
| 10 | `sameAs` not navigated | `D1` `sameAs` `D2`. Navigational read lands on `D1` (e.g. a PIN placed `D1`). | `sameAs` is not in the follow loop → `{uid: D1, status: Resolved}`. (Dedup layer *may* separately canonicalize the `{D1,D2}` cluster to lowest UID `D1` — vector 11.) |
| 11 | `sameAs` canonicalization (client/indexer) | `sameAs` cluster SCC `{C, A, B}` (e.g. `A↔B`, `B↔C`, all lens-visible). Dedup query enters from `C`. | Canonical representative = **lowest UID in SCC = `A`**, regardless of entry node. (On-chain navigational follower is not required to compute this; client/indexer layer is.) |
| 12 | Reserved-suppressed terminal (placeholder) | A future WHITEOUT terminal at path `/x` in lens `Lk` (NOT seedable today — see §10 / ADR-0055). | Reserved: `{uid: 0, isData: false, status: Suppressed-reserved}` — serve empty, STOP, no fall-through to lower lenses. **No input produces this today**; the vector pins the future contract so the loop slot is honored when WHITEOUT ships. |

---

## 10. Seeding ban (binding, pre-freeze)

Until the dedicated WHITEOUT schema exists (ADR-0055), **NO durable EFS data may encode whiteout/suppression via any sentinel.** Specifically banned on permanent data:

- a **reserved/sentinel REDIRECT kind** (e.g. `kind ≥ 4` meaning "void") — `AliasResolver` does not type-check `kind ≥ 3` (`AliasResolver.sol:193`), so such a redirect is *writable* but is an **inert, ignored redirect** to every conformant reader (it is never a navigational kind per §2); it MUST NOT be read as suppression;
- a **`weight < 0` TAG** used as suppression;
- a **sentinel PIN → reserved PROPERTY** "deleted" marker;
- a **tombstone DATA** UID meaning "deleted."

Any such encoding, once on permanent data, becomes a forever-fact every client must honor — foreclosing the clean WHITEOUT schema and baking in a category error (a *follow* vocabulary used as a *stop* terminal). The generic ban above is the only protection needed; per ADR-0055 §3 (James-ratified) no on-chain guard is added, because a stray reserved-kind REDIRECT is inert and does not foreclose the independent WHITEOUT schema.

**This is why this spec must be pinned before any durable REDIRECT data is seeded on Sepolia.** A redirect minted before the resolution rules are fixed either carries no defined read behavior or risks an ad-hoc convention hardening into a forever-fact.
