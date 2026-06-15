#!/usr/bin/env bash
# scripts/pr-review-intake.sh — enumerate ALL review feedback on a PR
#
# EFS review agents share one GitHub account, and some post malformed inline
# comments (wrong speaker prefix, non-native review). Notifications and comment
# formatting are therefore UNRELIABLE signals — findings have been missed because
# of it. This enumerates every shape feedback can take, format-agnostically:
#   1. review threads — every inline comment becomes a thread with isResolved,
#      no matter how it was posted (native review, lone comment, bot/connector).
#   2. review bodies  — findings written in a review's summary body, which are
#      NOT thread-tracked and so never show isResolved.
#   3. timeline comments — PR-level (non-inline) comments.
#
# A thread "needs a dev reply" when it is unresolved AND its last comment is not
# a `[<model> · dev]` reply — i.e. the finding hasn't been engaged. All agents
# share one login, so the `· dev` speaker prefix (not the comment author)
# distinguishes a dev reply from a reviewer finding.
#
# Usage:  yarn pr:intake <PR>     (or: bash scripts/pr-review-intake.sh <PR>)
# Exits non-zero if any thread still needs a dev reply — run it before declaring
# review feedback addressed. Run from repo root.
#
# Failure modes (by design, not gaps):
#   - Pagination: GraphQL `first:` caps at 100 and has no default; we paginate
#     via `gh api --paginate` + pageInfo so a >100-thread PR can't truncate.
#   - Outdated threads (diff hunk changed) return with line:null and are tagged
#     [outdated] — still printed, never dropped; they can hold real findings.
#   - The `· dev` check over-flags (safe) if a dev reply omits its prefix; a
#     reviewer copying the `· dev` prefix would under-flag — that's a process
#     violation, not a tool bug.

set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" ]]; then
  echo "usage: $(basename "$0") <pr-number>" >&2
  exit 2
fi

# Derive owner/name from the gh-resolved repo — portable, no hardcoded slug.
read -r OWNER NAME < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"')

THREADS="$(mktemp)"; BODIES="$(mktemp)"; TIMELINE="$(mktemp)"
trap 'rm -f "$THREADS" "$BODIES" "$TIMELINE"' EXIT

# 1) Review threads (paginated; --paginate follows pageInfo.endCursor).
gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F num="$PR" \
  -f query='
query($owner:String!,$name:String!,$num:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$num){
    reviewThreads(first:100, after:$endCursor){
      pageInfo{ hasNextPage endCursor }
      nodes{
        isResolved isOutdated path line
        first: comments(first:1){ nodes{ body } }
        last:  comments(last:1){ nodes{ body } }
      }
    }}}}' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]' > "$THREADS"

# 2) Review summary bodies (body-only findings are not thread-tracked).
gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F num="$PR" \
  -f query='
query($owner:String!,$name:String!,$num:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$num){
    reviews(first:100, after:$endCursor){
      pageInfo{ hasNextPage endCursor }
      nodes{ state url author{ login } bodyText }
    }}}}' \
  --jq '.data.repository.pullRequest.reviews.nodes[] | select((.bodyText // "") != "")' > "$BODIES"

# 3) Timeline (PR-level) comments. Warn (don't silently swallow) on failure —
# this is a "never miss" tool, so a hidden fetch error must not read as "none".
if ! gh api --paginate "repos/$OWNER/$NAME/issues/$PR/comments" \
     --jq '.[] | {login: .user.login, body}' > "$TIMELINE" 2>/dev/null; then
  echo "WARNING: timeline comment fetch failed — results may be incomplete" >&2
  : > "$TIMELINE"
fi

echo "── PR #$PR review intake ($OWNER/$NAME) ──"
echo

# Emit one TSV row per UNRESOLVED thread: needsReply, outdated, path, line, firstline
rows="$(jq -rs '
  def firstline(x): (x // "") | gsub("[\r\n\t]+";" ") | .[0:150];
  .[] | select(.isResolved == false)
  | [ ((.last.nodes[0].body // "") | (test("^\\s*\\[[^]]*·\\s*dev\\]") | not)),
      .isOutdated,
      (.path // "—"),
      (.line // 0),
      firstline(.first.nodes[0].body) ] | @tsv
' "$THREADS")"

UNRESOLVED=0; NEEDS_REPLY=0
if [[ -n "$rows" ]]; then
  echo "UNRESOLVED REVIEW THREADS:"
  while IFS=$'\t' read -r needsReply outdated path line first; do
    UNRESOLVED=$((UNRESOLVED + 1))
    tag=""
    [[ "$outdated" == "true" ]] && tag=" [outdated]"
    if [[ "$needsReply" == "true" ]]; then
      NEEDS_REPLY=$((NEEDS_REPLY + 1))
      echo "  ⚠ NEEDS REPLY$tag  $path:$line"
    else
      echo "  • awaiting (has dev reply)$tag  $path:$line"
    fi
    echo "      $first"
  done <<< "$rows"
  echo
fi

# Review bodies (not isResolved-tracked — always surface them, IN FULL). Findings
# in a long review body live AFTER the intro, so truncating would hide them — the
# exact body-only miss this tool guards against. Print author, URL, and full text.
BODY_COUNT="$(jq -rs 'length' "$BODIES")"
if [[ "$BODY_COUNT" -gt 0 ]]; then
  echo "REVIEW BODIES (not thread-tracked — read these IN FULL):"
  jq -rs '.[] | "\n  ── review by \(.author.login // "?") [\(.state)]  \(.url // "")\n\(.bodyText)"' "$BODIES"
  echo
fi

# Timeline comments.
TL_COUNT="$(jq -rs 'length' "$TIMELINE")"
if [[ "$TL_COUNT" -gt 0 ]]; then
  echo "TIMELINE COMMENTS:"
  jq -rs '.[] | "  • \(.login): \((.body // "") | gsub("[\r\n]+";" ") | .[0:150])"' "$TIMELINE"
  echo
fi

echo "── summary: $UNRESOLVED unresolved thread(s), $NEEDS_REPLY need a dev reply; $BODY_COUNT review body(ies), $TL_COUNT timeline comment(s) ──"
if [[ "$NEEDS_REPLY" -gt 0 ]]; then
  echo "Not done: $NEEDS_REPLY thread(s) have no dev reply — fix, push back, or defer each before declaring review addressed." >&2
  exit 1
fi
