# Documentation-and-comment corpus audit — measurement (action 9.1)

> **Status: a dated record.** Measured 2026-09-03 against this worktree at
> `7902164309c1766d7b785daab9ba94ff6472bc1d` (clean), cross-checked against
> `~/SPO-WebClient` at `d03ea8b7` and the live Crazz-Org project 1. Two passes: a sweep
> (`sweep-c9-docs.md`) and an adversarial verification (`verify-c9.md`) that re-ran every
> scanner independently. **Where they disagree, this document uses the verification's
> numbers** — both reports are kept in the scratchpad, not in this repo.

Empirical input to action 9.2 (build the sweeps) and 9.3 (fix the sites). The corpus is
`doc/accepted-gaps.md` §3d's accepted gap — 65 files, 14,368 comment/doc lines, the
documentation surface chantier 7bis handed to this chantier unread. This document answers
one question per class: **is the defect pattern something a sweep can catch by construction,
or does catching it need a human?** — and states, for every class the answer is yes, what
property the sweep checks and what its allowlist keys on.

---

## 1 · The sample

**Scope.** `git ls-files doc orchestrator bin/spo console scripts accounts README.md
prompts/README.md`, minus the four already-classified-historical files
(`doc/accepted-gaps.md` §3a/3b) — 64 tracked files, plus `prompts/README.md` as the 65th of
§3d. `scripts/` and `accounts/` (the register's own measured blind spot) were read in full.
The two moving-target files, `doc/state-machine-spec.md` and `doc/environments.md`, were read
for context only — a parallel chantier is rewriting both — and findings whose *subject* is one
of them are deferred (§5), not reported here.

**Scanners.** `cite-scan.js` (every `file:line` citation, resolved and EOF-checked),
`xrepo.js` (the misses, re-resolved in the product), `path-scan.js` (dir-prefixed path
references), `basename-scan.js` (bare `name.ext` references), `symbol-scan2.js`
(`<file>'s <ident>` possessives), `const-scan.js` (constant name near a number+unit),
`vocab-scan.js` (journal-event literals at call sites vs. backticked doc vocabulary),
`quote-scan.js` (a quoted phrase on a line naming a file). Plus one-line greps for env vars,
npm aliases, commit SHAs, `#NNN`, present-tense markers, and CLI flags.

**Verification method.** The adversarial pass re-implemented every scanner independently
rather than reading the sweep's prose, re-ran three read-only GitHub probes (`gh auth
status`, `gh project field-list 1 --owner Crazz-Org`, `gh label list`), diffed one file
against its full commit history for two "never existed" claims, and hand-planted a defect
(a timeout changed `120000 → 90000`) to test whether a "clean" scanner would actually catch
it. Its own self-check reproduced the sweep's citation ledger exactly (131/131) and a blind
resample of 15 citations landed exactly where the sweep said — the citation discipline holds.
Four conclusions did not: one manufactured finding, one scanner with the sink-aliasing bug
this project has already been burned by once, and two "clean" verdicts with wrong
denominators. §4 covers what that means for trusting this kind of document.

**This document's own citations.** Every `file:line` carried into §2–§5 below was
independently re-read with `sed -n 'Np'` against this worktree before being written (the two
cross-repo/deleted-file citations — `scripts/board-move.sh`'s line counts and
`sanctuarize.test.ts`'s deletion — were re-read against the pinned product commit the same
way). 55 distinct `file:line` pairs were re-resolved this way, plus six structural checks
(the PINS array's membership and spec-file count, the citation ratchet's regex and floor,
`.claude/settings.json`'s line count, and `config.js`'s absence of a `deployRepo` path).

---

## 2 · The taxonomy, frequency-ordered

Each row: **corrected count** (the verification's number where it corrected the sweep) ·
**enumerable?** · **the property a scanner would check** · **what its allowlist keys on**.

| rank | class | corrected count | enumerable? | scanner property | allowlist key |
|---|---|---|---|---|---|
| 1 | **E2** — undocumented journal events | **50** (35 task + 15 daemon) | **YES** | `appendEvent` arg 3 / `appendDaemonEvent` arg 2, resolving one level of sink aliasing; "documented" = backticked/fenced token in spec or README | event string |
| 2 | **E18** — citation ratchet's own coverage | ratchet checks **9 of 63** (14%) | **YES** (the ratchet itself) | widen `CITATION_RE` to more extensions, add `(line N)`/`` `:N` `` shapes, scan all 65 files, exact-pin `checked` | citation string |
| 3 | **E3** — dangling in-repo references | **9 sites / 7 targets** | **YES** | every path/basename/`<name>/`-directory reference resolves here → product → SPO-Deploy → gitignored/runtime → allowlist | reference string |
| 4 | **E6** — derived lists incomplete against source | **8** | **YES** | read `cmd === '<x>'` leaves and `--flag` parses off `bin/spo`/`daemon.js`; each appears in `orchestrator/README.md` | subcommand / flag |
| 5 | **E15** — line-wrapped identifiers | **6** wrap sites | scanner requirement, not a defect class | normalise each comment block (strip markers, join `X-\n//Y`) before matching; report by block | — |
| 6 | **E7a** — stale `N of M` live claims | **4** | **YES** — sweep said no | every `N of M <noun>` carries a same-line date, or `M` matches a live count the sweep computes | claim string |
| 6 | **E7b** — undated audit/inventory docs | **2** | **YES** | any `doc/*.md` titled audit/inventory or dated `20xx-` opens with the dated-record header | file |
| 8 | **E5** — phantom symbol citations | **3 sites / 2 symbols** | **YES** | `<file>'s <ident>` / `<ident> (<file>)`, code-shaped, over unwrapped comment blocks | `file::ident` |
| 8 | **E12** — unanchored action ids | **1 id / 3 sites** | **YES**, trivially | every `action N(bis)?.N[a-z]?` matches a `\| N.N \|` row or heading in the two plan docs | action id |
| 10 | **E4** — citation resolves to the wrong line | **2** | partially (existence: yes; correctness: heuristic) | existence+EOF hard; backticked-identifier-within-±3-lines as an advisory column only | citation string |
| 10 | **E10** — two in-scope docs disagreeing | **2** | for command lines, yes | every fenced `node --test …` / `bin/spo …` line prefix-matches one pinned canonical | the command line |
| 10 | **E11** — stale quoted phrases | **2** | advisory only | ≥20-char quote on a line naming a file occurs in it after Unicode-punctuation folding | the phrase |
| 13 | **E1** — cross-repo claims | **1** live defect (board 12→10) | **YES, conditionally** | resolve every `src/`, `scripts/`, `.claude/`, `*.ts`, `SPO-WebClient/…`, `SPO-Deploy/…` reference under `config.productRepo` **and a new `deployRepo`**; absent checkout must fail loudly, never pass vacuously | citation string |
| 13 | **E9** — superseded strategy statement | **1** | **YES** | no doc/script names a subcommand whose dispatch is `cmd<X>Deprecated` without "deprecat" within ±2 lines | subcommand |

Rows without a rank number (E8, E13, E14a–d, E16, E17) are the checked-clean and unchecked
classes — kept out of the frequency ranking on purpose, because a defect *count* means nothing
until you know whether zero came from a check or from a blind spot. §3 separates them.

### Cited examples, one per class (each re-verified with `sed -n` in this session)

- **E2** — `orchestrator/park-loop.js:755,989,1112` alias the sink: `const journal = (event,
  detail) => appendEvent(taskDir, 'PARKED', event, detail);`. Every literal reached only
  through that binding — `orchestrator/park-loop.js:825`: `if (exit === 0)
  journal('abandon-branch-deleted', …)` — was invisible to `vocab-scan.js`, which matches only
  a literal third argument at the call site.
- **E18** — `test/doc-constant-sweep.test.js:352`: `assert.ok(checked >= 8, …)`, with `checked`
  at 9 today (line 263's `CITATION_DOCS` names only `doc/state-machine-spec.md` and
  `orchestrator/README.md`, two of the corpus's 65 files).
- **E3** — `orchestrator/config.js:489`: `see doc/daemon-crash-recovery.md for the incident
  this covers` — no such file, ever (`git log --all` on it returns nothing); the incident is
  recorded only in the maintainer's own memory file. `README.md:37` and
  `doc/jewels-inventory.md:14` both promise a `bench/` directory that does not exist
  (`ls -d bench` — no such directory).
- **E6** — `README.md:34`'s subcommand list omits `bin/spo:1838`: `if (cmd === 'tokens') return
  cmdTokens(opts);` (and five siblings).
- **E15** — `orchestrator/park-loop.js:179`: `// machine.js's buildCtx resets it to 0 …` is the
  wrapped continuation of `state-` on the line above — and the same pattern at
  `bin/spo:407-408` (`// … (state-machine.js's` / `// isEligibleNow reads …`) hid a real E5
  defect from the line-based scanner (below).
- **E7a** — `orchestrator/README.md:1062`: `**14 of 18 tasks' journals stop at`, no date on the
  line; `ls -d journal/*/ | wc -l` in this worktree gives **23** today. The safe form exists
  two files over: `orchestrator/park-loop.js:925`'s own `of 18` comment is dated.
- **E7b** — `doc/board-audit.md` and `doc/jewels-inventory.md` both open with a plain `#`
  title, no `> **Status: a dated record.**` line, though `doc/board-audit.md:20` speaks in the
  present tense about live GitHub state.
- **E5** — `bin/spo:715`: `state-machine.js's isEligibleNow would take it` — no such function;
  `orchestrator/state-machine.js:1564` defines `function isQueueEntryEligibleNow(task, nowMs)`.
- **E12** — `orchestrator/park-loop.js:219`: `---- action 5.1d: surface DIAGNOSE on the card
  ----`; `grep -c "5\.1d" doc/remediation-plan-2026-08.md doc/remediation-progress.md` → 0, 0.
- **E4** — `orchestrator/README.md:790` cites `doc/state-machine-spec.md:98` for the "invariant
  substring check"; line 98 today is an unrelated `transient-retry` note — the row is at
  `doc/state-machine-spec.md:121`.
- **E10** — `README.md:35`: `` `node --test test/*.test.js` suite `` vs.
  `orchestrator/README.md:2371`: `node --test --test-timeout=30000 test/*.test.js`.
- **E11** — `bin/spo:1654` and `orchestrator/README.md:2056` both quote `CLAUDE.md` as
  "Verdict by exit code, never by reading text output"; `CLAUDE.md:35` reads "**Verdict by exit
  code**, never by reading `gh`'s text output" — close, but not verbatim in either repo.
- **E1** — `doc/board-audit.md:20`: `currently holds all 12 options`; `gh project field-list 1
  --owner Crazz-Org` returns 10 today (`Todo | Planning | Implementing | Checks & PR | Gate |
  Validation | Merging | Done | Parked | Intake`).
- **E9** — `scripts/daemon-install.sh:103`: `cost: bin/spo cost`; `bin/spo:993` names the
  handler `cmdCostDeprecated`, and every other of the six sites naming `spo cost` says so.

---

## 3 · Checked-clean vs. unchecked — not the same zero

A class with zero defects because a mechanical check ran and found none is not the same as a
class with zero *reported* defects because the checker cannot see the defect shape. Sharing a
row would say the same thing about both; they earn opposite recommendations.

### 3a · Checked and genuinely clean

| class | what was checked | result |
|---|---|---|
| **E13** commit SHAs | every backticked 7–10-hex string in the corpus is a commit here or in the product | **9 distinct, 0 unresolved** (sweep said 13 — see §4) |
| **E14a** env vars | every `SPO_*` named in the corpus is read somewhere in code, here or in the product | **57 distinct, 0 unread** (sweep said 44 — see §4); one, `SPO_REPORT_PULL_TOKEN`, is read only in the product |
| **E14b** npm aliases | every `npm run <alias>` in prose is a script in the product `package.json` | **12/12** — entirely cross-repo; this repo has no `package.json` at all |
| **E14c** hyphenated vocabulary | every backticked `a-b-c` token in docs occurs in code | **227/229** (the 2 misses are a live GitHub label and a connector name, not phantoms) |
| **E17** embedded settings copy | the JSON fence in `doc/permissions.md:114-169` equals `.claude/settings.json` | **98 allow / 14 deny, deep-equal including array order** — the strongest result in either report |
| **E14d** board columns | every column literal in code is a live `Status` option | **10/10** — but this is a network read; see below |

**E14d's trap.** `gh project field-list` succeeding and returning the right 10 options is a
live-GitHub-state check, not a source-reading sweep. If it goes in the default suite it must
fail loudly offline or rate-limited, never skip silently — the exact trap
`gh api -f` already cost this project a channel (`doc/comment-corpus-audit-2026-09-03.md`
§4 names the pattern again). Safer as a `spo`-side check the daemon runs, or a hand-refreshed
dated pin, not a `node --test` assertion.

### 3b · Unchecked, and one of them unsafe to trust

- **E8 — constant + number pairs, "74 pairs, 0 mismatches."** `const-scan.js` **prints 74 rows
  for a human to eyeball; nothing in the sweep compared a doc number to a resolved config value
  programmatically.** It also **excludes `doc/state-machine-spec.md` by filename** — and 15 of
  the 17 hand-written PINS in `test/doc-constant-sweep.test.js` have their doc side in that
  file (confirmed by reading the PINS array: 15 of 17 entries carry a
  `{ file: 'doc/state-machine-spec.md', … }` check). The verification planted a timeout change
  (`120000 → 90000`) in `orchestrator/README.md`'s table and in the spec's mirror: the README
  plant is invisible because a bare table cell (`| 90000 |`) has no unit word for the regex to
  anchor on, and the spec plant is invisible because the file is excluded outright. **Retiring
  the 17 PINS in favour of this scanner would silently delete real coverage — this is the most
  dangerous conclusion the sweep could have reached, and it reached the opposite one.** The 17
  PINS must stay; a table-aware `deepEqual` check belongs *alongside* them, not instead.
- **E16 — "must never"/"must not" without an asserting test.** 880–903 comment lines (depending
  on grep shape) carry the words; "there is a test for this sentence" is not a decidable
  property, so this stays a bound, not a measurement. Its two enumerable sub-classes already
  have rows above: "every event is documented" (E2) and "every cited symbol exists" (E5).

---

## 4 · What the audit got wrong about itself

This project's documents are expected to state their own errors — `doc/accepted-gaps.md` §7 is
the precedent: a plan claim that its own quoted grep command, if actually run, would have
contradicted. The same class of slip happened twice while producing this one.

**A manufactured finding, retracted.** The sweep read `orchestrator/config.js:839`'s comment —
"`board-move.sh` is 125 lines of `gh api graphql`" — reported the line count as **drifted**
(`wc -l` → 147), and added a supporting sentence: "grew 22 lines since 2026-09-01." Both halves
are wrong. `grep -c . scripts/board-move.sh` (non-blank lines) is **exactly 125** — the comment
is correct — and 147 − 125 = 22 is the blank-line count, not a growth figure. The file's commit
history (`git log --format=%H -- scripts/board-move.sh`) shows it unchanged since **2026-08-30
04:19**, two days before the comment's own claimed re-read date, and it was **never 125 total
lines at any point in its history**; the two edits on record shrank it, 156 → 147. The lesson
is not "the sweep was careless" — it re-read the file, which is more than most citations get —
it is that **"N lines" is an ambiguous pin**: total (147), non-blank (125), and non-comment
(122) disagree here, and a check that assumes one of the three will fail a correct comment. Any
future line-count pin must name its metric.

**The sweep's own event scanner had the exact bug it claimed immunity from.** E2's
property statement is "`appendEvent`'s third argument in place of `new ParkSignal`'s first" —
correctly modeled on `park-reason-doc-sweep`, the sweep that closed this class inside
`ParkSignal` two chantiers ago. But its *implementation*, `vocab-scan.js`, matches only a
literal third argument at a direct `appendEvent(...)` call site. `orchestrator/park-loop.js`
aliases the sink three times (`const journal = (event, detail) => appendEvent(…)`, twice, plus
one object-literal form) and `orchestrator/report-intake.js` wraps `appendDaemonEvent` the same
way — hiding 7 literals, 6 of them undocumented, and moving the true count from 79/29 to 86/35.
This is the throw-site-vs-sink failure this class of sweep has already died from once in this
project; naming it here is the point.

**Two "clean" verdicts had wrong denominators.** E13 (commit SHAs) was reported 13/13; the
corpus holds 9 distinct backticked SHAs, not 13 — the answer (0 unresolved) survives, the count
that produced it does not. E14a (env vars) was reported 44/44; the corpus names 57 distinct
`SPO_*` variables once shell `$VAR` forms and `timeoutFromEnv('SPO_…')`-style string arguments
are counted, not just `process.env.X` — again the verdict survives, the denominator does not.

**The citation ratchet's own coverage was over-stated.** The sweep reported the existing
`doc-constant-sweep.test.js` citation check covers 13 of the corpus's 63 citations (21%).
Re-running its exact logic (`stripFences`, `KNOWN_FICTIONAL`, the same regex) at the scope it
actually runs at gives **9** (14%) — the gap is `stripFences` removing a format-template line,
`KNOWN_FICTIONAL` removing one, and the ratchet's regex missing shapes `cite-scan.js` catches
(`, line N`, bare `` `:N` `` continuations). Worse: its floor assertion is `checked >= 8` with
`checked === 9` today — **one deleted citation from vacuous**, in a file whose own comment
already records that count being corrected twice (11 → 10 → 9).

---

## 5 · Limits of the method

- **60% of `orchestrator/README.md` — the largest document in the corpus — was never read
  linearly.** Lines 700–2060 were grep-swept for present-tense markers only, and a further
  123 lines (2120–2175, 2300–2368) sat in neither the "read" nor the "swept" range; 1,483 of
  2,451 lines total. Within the swept range, marker hits were read in context — roughly 1.2%
  of it. This is not a hypothetical gap: the two stale "N of 18 tasks" numbers in §2's E7a row
  (`orchestrator/README.md:1062`, `:1180`, against a live journal of 23) came directly out of
  that unread range on a five-minute targeted probe. The coverage gap is where the live defects
  were, not a safe corner.
- **Cross-repo checks are pinned to one commit, with no fetch.** Every product-repo claim in
  this document and its two inputs was checked against `~/SPO-WebClient` at `d03ea8b7`; neither
  the sweep nor the verification ran `git fetch` against the product's remote. A claim true at
  `d03ea8b7` may already be false on the product's upstream `main`.
- **E7 and E16's counts are marker-word bounds, not measurements.** "180 lines contain
  `measured`" and "880–903 lines contain `never`/`must not`" are grep counts of vocabulary,
  deliberately over-inclusive; they bound the class from above and say nothing about how many
  of those lines are actually stale or actually unasserted. E7's one enumerable sub-class
  (`N of M` claims checked against a live count) only became visible by testing the bound
  against real data, not by reading the grep output.
- **A third repository, `/home/crazz/SPO-Deploy`, is referenced 19 times across the corpus**
  (`doc/setup.md:15`: `cd ~/SPO-Deploy && ./deploy.sh setup dev`; `console/prod-version.js:13`)
  **with no resolution root in any scanner.** `orchestrator/config.js` has exactly one comment
  mentioning "SPO-Deploy" (line 812) and no `deployRepo` path constant. Any cross-repo resolver
  built for E1/E3 needs a `deployRepo` alongside `config.productRepo`, or these 19 references
  become permanent, unexplained allowlist noise.
- **`doc/state-machine-spec.md` and `doc/environments.md` were deliberately not audited for
  findings** — both are being rewritten by a parallel chantier, so any finding whose subject is
  one of them would be stale on arrival. Four references from those two files were read for
  context and are recorded here, not as findings: `doc/state-machine-spec.md:9` names
  `doc/prompts/orchestrator-comment` (no such path in either repo); `:117` names
  `.claude/settings.local.json` (product-only); `:445` names `scripts/pr-wait.sh` (product);
  `doc/environments.md:32` names `doc/bench-worker.md` and `doc/E2E-TESTING.md` (both exist,
  product-only — holds).
- **Every `file:line` citation in this document was independently re-resolved with `sed -n`
  against the live worktree before being written** (55 distinct pairs, plus six structural
  checks — the PINS array's spec-file membership, the citation ratchet's regex and floor,
  `.claude/settings.json`'s line count, `scripts/board-move.sh`'s three line-count metrics, and
  `config.js`'s absence of a `deployRepo` path). This is the same discipline
  `doc/accepted-gaps.md` §7 names as having failed once already in this project's own audit
  trail; restating it here is the check, not a claim to be exempt from it.

**Nothing in the two inputs was left unreconciled.** Every place the sweep and the
verification disagreed resolved to one number or one verdict — this document carries the
resolved figure in every case, per the corrections listed above.
