'use strict';
// bash-policy.js -- the per-policy `Bash` deny lists the orchestrator passes to `claude` on the
// command line (`--disallowedTools`, steps/llm.js's buildArgv). Card #240.
//
// WHY THIS FILE EXISTS
//
// Seven of the eight in-repo tool policies (five step contracts in step-contracts.js, three
// intake steps in intake.js) declare bare `Bash` in `allowedTools`. The CLI reads a bare tool
// name as an allow rule covering the whole tool -- its own rule description for it is "Any Bash
// command", against "Any Bash command starting with <x>" for `Bash(x *)`. `.claude/settings.json`
// carries no bare `Bash`: 92 scoped `Bash(...)` allows and 14 scoped `Bash(...)` denies. So those
// 92 curated patterns bound exactly one policy -- CITATION_VERIFIER, the only contract that omits
// `Bash` -- and for the other seven the effective shell boundary was the 14 denies alone.
//
// WHAT WAS MEASURED BEFORE THESE LISTS WERE WRITTEN (2026-09-22)
//
// Corpus: every pool-account transcript, `~/.claude-accounts/pool{1,2}/projects/**/*.jsonl`
// (1520 files; 1379 classified by the step heading of the prompt the session was launched with,
// 141 unclassifiable -- subagent/side transcripts and hand-run sessions -- left out rather than
// guessed at). Window 2026-08-29 .. 2026-09-22. 13001 `Bash` tool_use calls:
//
//   PLAN 3581 (276 sessions) · IMPLEMENT 6384 (354) · VALIDATE 969 (212) · DIAGNOSE 706 (87)
//   reviewCard 776 (261) · triageBugReport 580 (159) · draftCard 4 (7)
//   CITATION_VERIFIER 1 (23)
//
// Three findings drove every choice below.
//
// 1. A SCOPED `allowedTools` CANNOT EXPRESS THIS CORPUS. 10886 of the 13001 calls (83.7%) are
//    compound shell -- `&&`, `;`, pipes, newlines, heredocs, `$( )`, backticks. Splitting every
//    call into top-level segments and testing each against the 92 curated allow patterns, only
//    5543 of 13001 (42.6%) have EVERY segment covered. Dropping bare `Bash` to let the curated
//    rules bind would therefore refuse roughly 57% of the pipeline's real shell traffic. And
//    widening the allowlist to fit means adding `grep` (~8300 segment hits, the single largest
//    verb and absent from the 92), `head`, `find`, `rg`, `awk`, `sort`, `tr`, `python3`,
//    `npx jest`, `bash -c`, plus heredocs (213 in IMPLEMENT) and `for` loops (138 in IMPLEMENT) --
//    84 distinct verbs for IMPLEMENT alone, 54 for PLAN. That allowlist is "any shell" with
//    extra maintenance, which is what bare `Bash` already is.
//
// 2. A DENY DOES BIND, AND IT BINDS PER SUBCOMMAND. Three real IMPLEMENT calls in the corpus were
//    refused by `.claude/settings.json`'s existing denies WHILE bare `Bash` was granted, and all
//    three were compound, one with the denied part in the MIDDLE of the chain:
//      `git status --porcelain && git reset --hard 3fa2a115 && git log --oneline -5 && ...`
//        -> "Permission to use Bash with command ... has been denied."
//    So deny beats the bare-`Bash` allow, and it is evaluated against the parsed subcommands, not
//    against the raw string. `--disallowedTools` is the same channel from the command line, and
//    it needs no edit to `.claude/settings.json` (which no agent can edit -- see doc/permissions.md
//    § Walls that settings.json can't tune).
//
// 3. THE READ-ONLY CONTRACTS ARE NOT READ-ONLY. PLAN, DIAGNOSE, VALIDATE and the three intake
//    steps are all documented `Bash(ro)` (doc/state-machine-spec.md's step table,
//    prompts/README.md's table, and each prompt's own "never edit a file"). step-contracts.js
//    says in its own words that the "(ro)" is "enforced by the prompt's own text ... not by a
//    distinct --allowedTools value". The corpus shows the prose losing: PLAN, in
//    `permissionMode: 'plan'`, ran `cp /tmp/te-probe.test.tsx src/client/report/__te_probe.test.tsx`
//    twice and `rm -rf "$TMPD/bench" "$TMPD/paths.js"` seven times. Plan mode blocks Edit/Write;
//    it does not block a write made through the shell.
//    The three intake steps, by contrast, mutated nothing at all: across their 1360 calls the
//    only verbs that touch anything are `gh issue list/view` (694), `curl -s ... -o /tmp/...`
//    (53), `gh api <path> --jq` (37), `gh pr view` (8), `git branch -a --contains` (2) and
//    `gh project item-list` (1) -- zero writes, zero `gh` mutations, zero package installs. Their
//    deny list therefore costs nothing measured, and they are the policies that run against
//    `~/SPO-WebClient`, the LIVE product checkout, outside any card's lifecycle.
//
// HOW THESE LISTS LAYER
//
// `.claude/settings.json`'s 14 denies stay the single shared source and are NOT repeated here:
// they already reach every LLM step, because `spo account sync-settings` installs that file as
// the user layer of every pool account (doc/permissions.md § The account layer). What follows is
// the per-policy DELTA on top of them.
//
// WHAT THESE LISTS DO NOT DO -- read this before trusting one
//
// They narrow the accidental and the observable surface. They are not a sandbox:
//   - `bash -c '<script>'`, `sh -c`, `python3 -c`, `node -e`, `xargs` and `env` carry their
//     payload inside a string argument, and the rule matcher sees only the outer verb. PLAN made
//     46 `bash -c` calls and IMPLEMENT 29 in the measured window; both remain allowed, because
//     denying them would break real work.
//   - Shell redirection is not a command. `cat > f <<'EOF'` parses as `cat`, which is allowed;
//     IMPLEMENT used 213 heredocs. A read-only step can still write a file that way.
//   - The rules are prefix patterns, so a flag whose position varies cannot be targeted:
//     `gh api <path> -X POST` is denied below by the two spellings that were measured, and a
//     third spelling would not match.
// The point of the list is that the irreversible verbs no longer pass BY DEFAULT and no longer
// pass SILENTLY, not that a determined caller cannot reach them.

// Irreversible at the host or daemon level, and outside every policy's contract -- including
// IMPLEMENT's, the one policy that must be free to write. Zero uses in the 13001-call corpus
// except `ssh` (one connectivity probe from PLAN, `ssh -T -o BatchMode=yes git@github.com`);
// `ssh-keygen`, which IMPLEMENT used twice, does not match `ssh *` (no space after `ssh`).
const BASH_DENY_HOST_CONTROL = Object.freeze([
  'Bash(sudo *)',
  'Bash(su *)',
  'Bash(doas *)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(poweroff*)',
  'Bash(halt*)',
  'Bash(crontab *)',
  'Bash(mkfs*)',
  'Bash(mount *)',
  'Bash(umount *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(sftp *)',
  // Irreversible off-machine, and no policy's contract reaches them: publishing a package, and
  // touching the pool account's own GitHub credentials. Zero uses in the corpus, IMPLEMENT
  // included -- which is why these sit here rather than in the intake-only list below.
  'Bash(npm publish*)',
  'Bash(gh auth login*)',
  'Bash(gh auth logout*)',
  'Bash(gh auth refresh*)',
  // The orchestrator's own CLI. `spo` moves cards, parks tasks and writes ~/.spo-state; an LLM
  // step reaching for it is out of contract by construction, and no step in the corpus did.
  // (`spo-original`, `spo.zz.works` and the like appear as grep ARGUMENTS and do not match --
  // every pattern here needs the trailing space.)
  'Bash(spo *)',
  'Bash(bin/spo *)',
  'Bash(./bin/spo *)',
]);

// Writes to a working tree or to git's own refs. Applied to the policies whose contract is
// read-only. `systemctl` is deliberately NOT here: DIAGNOSE is the pipeline's CI-forensics step
// and used `systemctl --user list-units` (2 calls) and `journalctl --user -u ...` (6) for exactly
// that, and a prefix rule cannot separate those from `systemctl --user stop` without enumerating
// both flag spellings of every mutating subcommand. Recorded as a residual gap in
// doc/accepted-gaps.md rather than covered badly.
const BASH_DENY_TREE_WRITES = Object.freeze([
  'Bash(rm *)',
  'Bash(rmdir *)',
  'Bash(mv *)',
  'Bash(cp *)',
  'Bash(install *)',
  'Bash(chmod *)',
  'Bash(chown *)',
  'Bash(ln *)',
  'Bash(dd *)',
  'Bash(truncate *)',
  'Bash(shred *)',
  'Bash(tee *)',
  'Bash(touch *)',
  'Bash(sed -i*)',
  'Bash(perl -i*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git pull*)',
  'Bash(git checkout*)',
  'Bash(git switch*)',
  'Bash(git restore*)',
  // `git merge ` with the trailing space, so `git merge-base` and `git merge-tree` -- both read-only
  // and both measured (PLAN 4, VALIDATE 2) -- keep working.
  'Bash(git merge *)',
  'Bash(git rebase*)',
  'Bash(git cherry-pick*)',
  'Bash(git revert*)',
  'Bash(git am*)',
  'Bash(git apply*)',
  // Only the mutating halves of `git stash`: `git stash list` is read-only and DIAGNOSE used it.
  'Bash(git stash push*)',
  'Bash(git stash save*)',
  'Bash(git stash pop*)',
  'Bash(git stash apply*)',
  'Bash(git stash drop*)',
  'Bash(git stash clear*)',
  'Bash(git tag*)',
  'Bash(git mv*)',
  'Bash(git rm*)',
  'Bash(git init*)',
  // `git reset*` is WIDER than settings.json's own `git reset --hard*`, on purpose: a read-only
  // step has no business resetting at all, and `--soft`/`--mixed` still move a branch.
  'Bash(git reset*)',
  'Bash(git update-ref*)',
  // `git clean*`, `git branch -D*`, `git push --force*`, `git filter-branch*`, `git gc --prune*`,
  // `git prune*`, `git reflog expire*`, `git rm -rf*`, `gh pr edit*`, `gh issue delete*` and
  // `gh repo delete*` are NOT repeated here: .claude/settings.json already denies all fourteen,
  // and that file reaches every pool account as its user layer through `spo account
  // sync-settings`. test/bash-deny-policy.test.js fails on any duplicate, so the two layers
  // cannot fork.
  // Only the mutating halves of `git branch` / `git worktree`: `git branch -vv`, `git branch -r`,
  // `git branch -a --contains` and `git worktree list` are read-only and all appear in the corpus.
  'Bash(git branch -d*)',
  'Bash(git branch -m*)',
  'Bash(git branch -M*)',
  'Bash(git worktree add*)',
  'Bash(git worktree remove*)',
  'Bash(git worktree move*)',
  'Bash(git worktree prune*)',
]);

// Writes that leave the machine: the GitHub side, and anything that installs. Applied to the
// three intake policies, whose cwd is the LIVE product checkout and whose 1360 measured calls
// contain none of these. NOT applied to the five step contracts: IMPLEMENT legitimately opened a
// PR (`gh pr create --repo Crazz-Org/SPO-Deploy`, 4 calls) and runs `npm`/`npx` constantly
// (1465 + 812 calls), and PLAN runs `npx jest` (218) and `npm run` (148) to check the commands it
// is about to put in a plan.
const BASH_DENY_REMOTE_WRITES = Object.freeze([
  'Bash(gh issue create*)',
  'Bash(gh issue edit*)',
  'Bash(gh issue close*)',
  'Bash(gh issue reopen*)',
  'Bash(gh issue comment*)',
  'Bash(gh issue transfer*)',
  'Bash(gh issue pin*)',
  'Bash(gh issue unpin*)',
  'Bash(gh issue lock*)',
  'Bash(gh issue unlock*)',
  'Bash(gh pr create*)',
  'Bash(gh pr merge*)',
  'Bash(gh pr close*)',
  'Bash(gh pr reopen*)',
  'Bash(gh pr comment*)',
  'Bash(gh pr review*)',
  'Bash(gh pr ready*)',
  'Bash(gh pr checkout*)',
  'Bash(gh project create*)',
  'Bash(gh project item-add*)',
  'Bash(gh project item-edit*)',
  'Bash(gh project item-delete*)',
  'Bash(gh project item-archive*)',
  'Bash(gh project field-create*)',
  'Bash(gh repo create*)',
  'Bash(gh repo fork*)',
  'Bash(gh repo deploy-key*)',
  'Bash(gh release create*)',
  'Bash(gh release delete*)',
  'Bash(gh release upload*)',
  'Bash(gh workflow run*)',
  'Bash(gh workflow enable*)',
  'Bash(gh workflow disable*)',
  'Bash(gh run cancel*)',
  'Bash(gh run rerun*)',
  'Bash(gh run delete*)',
  'Bash(gh secret *)',
  'Bash(gh variable *)',
  'Bash(gh cache delete*)',
  'Bash(gh label create*)',
  'Bash(gh label edit*)',
  'Bash(gh label delete*)',
  'Bash(gh label clone*)',
  // `gh api graphql` is a POST by definition (CLAUDE.md § gh conventions) -- it is the pipeline's
  // board-mutation channel, and the orchestrator issues it from Node through execFile, never
  // through this layer. No intake session used it.
  'Bash(gh api graphql*)',
  // The two REST-mutation spellings a prefix rule can reach. `gh api -f` is a POST even without
  // -X -- the trap CLAUDE.md records and test/gh-api-argv.test.js guards on the Node side. Intake's
  // own 37 `gh api` calls are all `gh api <path> --jq ...`, which none of these match.
  'Bash(gh api -X *)',
  'Bash(gh api --method P*)',
  'Bash(gh api --method DELETE*)',
  'Bash(gh api * -X *)',
  'Bash(gh api * -f *)',
  'Bash(gh api * -F *)',
  'Bash(npm install*)',
  'Bash(npm ci*)',
  'Bash(npx *)',
  'Bash(yarn *)',
  'Bash(pnpm *)',
  'Bash(pip install*)',
  'Bash(pip3 install*)',
]);

// ---- the three composed lists the policies actually carry -----------------------------------

// PLAN, DIAGNOSE, VALIDATE. Measured cost of applying it, on the window above: PLAN loses 7
// `rm -rf "$TMPD/..."`, 2 `cp` into `src/`, 6 `git apply --check` and 1 `ssh -T` -- 16 of its
// 3581 calls, and the first nine of those are the contract violations finding 3 names. DIAGNOSE
// and VALIDATE lose nothing: neither ran a single matching command.
const READ_ONLY_STEP_BASH_DENY = Object.freeze([...BASH_DENY_HOST_CONTROL, ...BASH_DENY_TREE_WRITES]);

// IMPLEMENT. It is the one policy whose contract is to write, so it keeps the whole worktree and
// GitHub surface its 6384 measured calls use -- `rm` (38), `cp` (36), `git add` (18),
// `git checkout` (15), `git commit` (11), `git stash push` (8), `mkdir` (7), `git reset --soft`
// (6), `chmod` (6), `gh pr create` (4), `git push` (2) and the rest. Measured cost: zero.
const WRITE_STEP_BASH_DENY = Object.freeze([...BASH_DENY_HOST_CONTROL]);

// draftCard, reviewCard, triageBugReport. Measured cost: zero of 1360 calls.
const INTAKE_BASH_DENY = Object.freeze([
  ...BASH_DENY_HOST_CONTROL,
  ...BASH_DENY_TREE_WRITES,
  ...BASH_DENY_REMOTE_WRITES,
]);

module.exports = {
  BASH_DENY_HOST_CONTROL,
  BASH_DENY_TREE_WRITES,
  BASH_DENY_REMOTE_WRITES,
  READ_ONLY_STEP_BASH_DENY,
  WRITE_STEP_BASH_DENY,
  INTAKE_BASH_DENY,
};
