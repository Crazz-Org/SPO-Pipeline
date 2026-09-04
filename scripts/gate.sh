#!/usr/bin/env bash
# gate.sh -- the verification gate for THIS repo's own code. Deterministic, empirical, and cheap:
# it runs SPO-Pipeline's test suite and exits non-zero if anything fails. Nothing else. No LLM
# judge, no network, no dependencies (this repo has no package.json and no node_modules -- the
# suite is stdlib `node --test` only), so the same commit produces the same verdict on any machine
# and in CI.
#
# WHY THIS EXISTS. Before it, four things could have verified a change to this repo and not one of
# them did: there was no CI (no .github/workflows at all), `main` was unprotected with zero
# required checks, the pre-push gate hook was retired on 2026-08-29 while three documents still
# described it as live, and a PR could be merged by its own author with no review. The only thing
# standing between an agent's edit and `main` was that agent's own claim to have run the tests --
# self-attestation by the party being checked, which is the exact failure class C1 ("truthful
# judges") and B2 ("the attestation carries its evidence") already name.
#
# ---- what it deliberately does NOT run, and why that is not a loophole -----------------------
#
# Three test files assert agreement with the SIBLING repos -- SPO-WebClient (the product repo this
# pipeline drives) and SPO-Deploy. They are excluded here, and the exclusion is pinned by name in
# test/gate-scope.test.js so it cannot quietly grow:
#
#   test/doc-constant-sweep.test.js        -- citations/constants resolved against the real trees
#   test/gate-stderr-literal-sweep.test.js -- realGate's stderr literals vs SPO-WebClient's source
#   test/heartbeat-contract-pin.test.js    -- HEARTBEAT_STALE_MS pinned to paths.ts's own literal
#
# Measured 2026-09-04 with neither sibling on disk: those three files produce 10 failures, and
# every other test file passes -- 1729 of 1729. They fail LOUDLY on an absent repo by design
# ("an ABSENT product or deploy repo is never a silent pass" -- doc-constant-sweep's own header),
# which is correct for a drift check and wrong for a merge gate.
#
# The distinction is not convenience, it is scope. Those three do not test this repo's code; they
# test whether ANOTHER repo has moved out from under this one's citations. Their verdict changes
# when SPO-WebClient changes and this repo does not, so folding them in would make this gate red
# for work that is not the author's -- and an advisory gate that reds for someone else's reasons
# is one people learn to ignore. This repo has already paid for that: the bench gate went advisory
# on 2026-08-29 and silent on 2026-08-30, with 11 PRs merged behind it.
#
# They still run -- in the full local suite (`node --test test/*.test.js`, siblings present), which
# is how PR #96, #98 and #104 each caught real citation drift. They are a drift check on a
# schedule of their own, not a gate on a diff.
#
# ---- usage -----------------------------------------------------------------------------------
#
#   scripts/gate.sh              # the gate: this repo's own suite
#   scripts/gate.sh --list       # print the file list it would run, one per line, and exit
#
# Called by .github/workflows/gate.yml (required check on `main`) and by
# scripts/git-hooks/pre-push (the same verdict before a push that never becomes a PR).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Pinned by name in test/gate-scope.test.js. Basenames, matched exactly -- never a substring, so a
# future `test/doc-constant-sweep-v2.test.js` is NOT silently excluded by resembling one of these.
CROSS_REPO_FILES=(
  doc-constant-sweep.test.js
  gate-stderr-literal-sweep.test.js
  heartbeat-contract-pin.test.js
)

files=()
for f in test/*.test.js; do
  base="$(basename "$f")"
  skip=""
  for x in "${CROSS_REPO_FILES[@]}"; do
    [ "$base" = "$x" ] && skip=1 && break
  done
  [ -n "$skip" ] || files+=("$f")
done

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

# A glob that matched nothing would run zero tests and exit 0 -- a gate that passes by testing
# nothing is worse than no gate, because it reports success. Refuse instead. The floor is a
# tripwire on "did the glob break", not a second pin on the population (test/gate-scope.test.js
# is that), so it sits well below the 76 files measured 2026-09-04.
if [ "${#files[@]}" -lt 50 ]; then
  echo "!! gate: found only ${#files[@]} test file(s) under test/ -- expected 50+. Refusing to report a pass on a suite that did not run." >&2
  exit 2
fi

echo "== gate: ${#files[@]} test file(s), SPO-Pipeline's own suite (sibling-repo drift checks excluded -- see this script's header)"
exec node --test "${files[@]}"
