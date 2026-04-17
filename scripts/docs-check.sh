#!/usr/bin/env bash
# scripts/docs-check.sh — verify internal doc references resolve
#
# Catches the classes of drift most commonly found in PR review:
# - markdown links to files that no longer exist (e.g. deleted docs)
# - ADR-NNNN references where no matching ADR file exists
# - ADR-NNNN references above the highest-numbered ADR in docs/adr/
#
# Exits non-zero on any failure. Run from repo root.
# Used by .github/workflows/lint.yaml and runnable locally via `yarn docs:check`.

set -euo pipefail

FAIL=0

# Files we check: top-level *.md + everything under docs/, specs/, reference/
DOCS=()
while IFS= read -r -d '' f; do DOCS+=("$f"); done < <(
  find docs specs reference -name '*.md' -type f -print0 2>/dev/null
)
for f in AGENTS.md CLAUDE.md README.md CONTRIBUTING.md; do
  [[ -f "$f" ]] && DOCS+=("$f")
done

# ---------------------------------------------------------------------------
# 1. Markdown links pointing at docs/, specs/, or reference/ must resolve.
# ---------------------------------------------------------------------------
echo "Checking internal markdown links..."
for doc in "${DOCS[@]}"; do
  # Extract [text](path) where path is a docs/, specs/, or reference/ target.
  # Strip leading ./ and trailing anchors (#section). Skip http(s) URLs.
  links=$(grep -oE '\]\(\./(docs|specs|reference)/[^)]+\)' "$doc" 2>/dev/null | \
          sed -E 's|^\]\(\./||; s|\)$||; s|#.*$||' || true)
  for link in $links; do
    if [[ ! -e "$link" ]]; then
      echo "ERROR: $doc references missing path: $link"
      FAIL=1
    fi
  done
done

# ---------------------------------------------------------------------------
# 2. ADR-NNNN references resolve to an actual ADR file.
# ---------------------------------------------------------------------------
echo "Checking ADR-NNNN references..."
if [[ -d docs/adr ]]; then
  # Highest existing ADR number
  MAX_ADR=$(ls docs/adr/*.md 2>/dev/null | \
            grep -oE '/[0-9]{4}-' | grep -oE '[0-9]{4}' | sort -n | tail -1 || echo "0000")

  # All ADR-NNNN references across tracked docs
  refs=$(grep -rhoE 'ADR-[0-9]{4}' "${DOCS[@]}" 2>/dev/null | \
         grep -oE '[0-9]{4}' | sort -u || true)

  for num in $refs; do
    # Skip the 0000 sentinel; that's not a real reference
    [[ "$num" == "0000" ]] && continue

    if (( 10#$num > 10#$MAX_ADR )); then
      echo "ERROR: ADR-$num referenced but highest ADR file is ADR-$MAX_ADR"
      FAIL=1
      continue
    fi

    if ! ls docs/adr/"$num"-*.md >/dev/null 2>&1; then
      echo "ERROR: ADR-$num referenced but no docs/adr/$num-*.md file found"
      FAIL=1
    fi
  done
fi

# ---------------------------------------------------------------------------
# 3. ADR file Status lines that cite a superseding ADR must resolve.
# ---------------------------------------------------------------------------
echo "Checking ADR supersession references..."
if [[ -d docs/adr ]]; then
  for adr in docs/adr/[0-9]*.md; do
    sup=$(grep -oE 'Superseded by ADR-[0-9]{4}' "$adr" 2>/dev/null | \
          grep -oE '[0-9]{4}' | head -1 || true)
    if [[ -n "${sup:-}" ]]; then
      if ! ls docs/adr/"$sup"-*.md >/dev/null 2>&1; then
        echo "ERROR: $adr says 'Superseded by ADR-$sup' but no such ADR file exists"
        FAIL=1
      fi
    fi
  done
fi

if (( FAIL == 0 )); then
  echo "OK: doc references are consistent."
fi
exit $FAIL
