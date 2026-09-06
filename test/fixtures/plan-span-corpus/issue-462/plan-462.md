# Plan — task 462: cite the six Directory Server RDO members

## Verdict of the verification (already performed during planning, read directly from the Pascal)

All six entries in `/home/crazz/SPO-Pipeline/worktrees/issue-462/src/shared/rdo-members.ts` have the **correct `kind` and `arity`**. No entry value changes. This task is **comments-only**: six catalogue comments gain their `File.pas:Line` citation and their corrected call-site line. **This is NOT a rewrite of existing behaviour** — no emitted byte changes, so no output-equivalence (`comm`) or degenerate-input checks apply.

### The declarations, verified against the source (not the hand-maintained index)

⚠ **Two divergent copies of `DirectoryServer.pas` exist**: `~/SPO-Original/DServer/DirectoryServer.pas` and `~/SPO-Original/Directory Server/DirectoryServer.pas`. The declaration text is identical but the line numbers differ (e.g. `RDOOpenSession` is at :143 in `DServer/`, :110 in `Directory Server/`). The project's index (`doc/spo-original-reference.md:17`) and the existing comment at `/home/crazz/SPO-Pipeline/worktrees/issue-462/src/server/session/login-handler.ts:190` both cite **`DServer/`** — cite `DServer/DirectoryServer.pas` consistently and never mix the two copies. (`login-handler.ts:319` cites the other copy; leave that file alone — it is out of scope.)

| member | declaration (verified byte-for-byte) | catalogue entry | verdict |
|---|---|---|---|
| `RDOEndSession` | `DServer/DirectoryServer.pas:31` — `procedure RDOEndSession;` | procedure, 0 | MATCH |
| `RDOSetCurrentKey` | `DServer/DirectoryServer.pas:36` — `function RDOSetCurrentKey( FullPathKey : widestring ) : olevariant;` | function, 1 | MATCH |
| `RDOSearchKey` | `DServer/DirectoryServer.pas:84` — `function RDOSearchKey( SearchPattern, ValueNameList : widestring ) : olevariant;` | function, 2 | MATCH |
| `RDOLogonUser` | `DServer/DirectoryServer.pas:92` — `function RDOLogonUser( Alias, Password : widestring ) : olevariant;` | function, 2 | MATCH |
| `RDOOpenSession` | `DServer/DirectoryServer.pas:143` — `function RDOOpenSession : olevariant;` (0-arg published function on `TDirectoryServer`) | accessor, `get` | **DIVERGES, excused by rule 1**: verb follows the reference client — `get` on a 0-arg function is what Voyager emits, served by the Delphi get→CallMethod fallthrough (`RDOObjectServer.pas:112-116`). Keep the entry, add the note. |
| `RDOLogonClient` | `Kernel/World.pas:412` — `procedure RDOLogonClient(name, password : widestring);` (this one is a world-server member, not Directory Server) | procedure, 2 | MATCH |

### Call-site lines in THIS worktree (verified)

`RDOOpenSession` → `login-handler.ts:194` · `RDOLogonUser` → `:203` · `RDOEndSession` → `:215` · `RDOSetCurrentKey` → `:309` · `RDOSearchKey` → `:324` · `RDOLogonClient` → `spo_session.ts:997`. These match the issue's table exactly.

## What changes

**One file**: `/home/crazz/SPO-Pipeline/worktrees/issue-462/src/shared/rdo-members.ts`. Replace the six stale end-of-line comments (currently at lines 163, 171, 172, 174, 179, 183) with these exact texts (keep the file's column alignment of the `//`):

```ts
  RDOEndSession:             { kind: 'procedure', arity: 0 },                // DServer/DirectoryServer.pas:31; src/server/session/login-handler.ts:215
  RDOLogonClient:            { kind: 'procedure', arity: 2 },                // Kernel/World.pas:412; src/server/spo_session.ts:997
  RDOLogonUser:              { kind: 'function',  arity: 2 },                // DServer/DirectoryServer.pas:92; src/server/session/login-handler.ts:203
```

For `RDOOpenSession`, the divergence note goes on comment lines ABOVE the entry (the criterion requires naming the excusing rule):

```ts
  // DServer/DirectoryServer.pas:143 — a 0-arg published FUNCTION, kept as accessor `get`
  // under rule 1: the verb follows the reference client, which emits `get RDOOpenSession`,
  // served by the Delphi get→CallMethod fallthrough (RDOObjectServer.pas:112-116).
  RDOOpenSession:            { kind: 'accessor',  access: ['get'] },         // src/server/session/login-handler.ts:194
```

```ts
  RDOSearchKey:              { kind: 'function',  arity: 2 },                // DServer/DirectoryServer.pas:84; src/server/session/login-handler.ts:324
  RDOSetCurrentKey:          { kind: 'function',  arity: 1 },                // DServer/DirectoryServer.pas:36; src/server/session/login-handler.ts:309
```

Touch nothing else — no entry values, no other comments, no other files. Do not edit `~/SPO-Original` (read-only artifact) and never probe the live server.

## Why this satisfies the criterion

- Each of the six entries carries a `File.pas:Line` citation establishing kind and arity — five match outright; `RDOOpenSession` is kept with an explicit note naming rule 1.
- All six call-site comments name the line the call is actually on (verified in this worktree above).
- Comments-only change ⇒ no behaviour change, no test edits expected. If `npm run coverage:changed` or any test somehow fails, that is a finding to name in the PR, not something to silence.

## PR

Branch/commit as usual (`docs: cite the six Directory Server RDO members against their Delphi declarations` fits). **The PR body must contain the Pascal citations** (`scripts/check-pr-rules.js` requires at least one `File.pas:Line` for any PR touching `rdo-members.ts`; `citation-verifier` then opens each one). Include this list verbatim in the PR body:

- `DServer/DirectoryServer.pas:31` — `procedure RDOEndSession;`
- `DServer/DirectoryServer.pas:36` — `function RDOSetCurrentKey( FullPathKey : widestring ) : olevariant;`
- `DServer/DirectoryServer.pas:84` — `function RDOSearchKey( SearchPattern, ValueNameList : widestring ) : olevariant;`
- `DServer/DirectoryServer.pas:92` — `function RDOLogonUser( Alias, Password : widestring ) : olevariant;`
- `DServer/DirectoryServer.pas:143` — `function RDOOpenSession : olevariant;` (kept as `get` accessor per rule 1, fallthrough at `RDOObjectServer.pas:112-116`)
- `Kernel/World.pas:412` — `procedure RDOLogonClient(name, password : widestring);`

Also state in the PR body that line numbers cite the `DServer/` copy, because a second, divergent `Directory Server/` copy exists with different line numbers.

## Check commands

Run verbatim; judge by exit code only — never piped into `tail`/`head`, never backgrounded with `&`.

```bash
# 1. Design-executable probe (driver runs this first): the six declarations and the catalogue are where the plan says
grep -aq 'function RDOOpenSession : olevariant' "$HOME/SPO-Original/DServer/DirectoryServer.pas" && grep -aq 'procedure RDOLogonClient(name, password : widestring)' "$HOME/SPO-Original/Kernel/World.pas" && grep -q 'RDOSearchKey:' /home/crazz/SPO-Pipeline/worktrees/issue-462/src/shared/rdo-members.ts

# 2. Verification aliases
npm run typecheck
npm run lint
npm run coverage:changed

# 3. Falsification sweep (one per claim; exit 0 = nothing documented contradicts the plan)
! grep -rn "procedure RDOOpenSession" doc .claude CLAUDE.md src/shared/rdo-members.ts
! grep -n "DServer" CLAUDE.md
! grep -rn "function RDOEndSession\|procedure RDOSearchKey\|procedure RDOLogonUser\|procedure RDOSetCurrentKey\|function RDOLogonClient" doc .claude CLAUDE.md
```

All commands were prototyped green against `/home/crazz/SPO-Pipeline/worktrees/issue-462` during planning. (Not a rewrite ⇒ no `comm`/degenerate-input commands.)
