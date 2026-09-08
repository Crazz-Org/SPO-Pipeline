# How a driver session waits for a subagent

> Measured 2026-09-07 over the 152 top-level transcripts of this project
> (`~/.claude/projects/-home-crazz-SPO-Pipeline/*.jsonl`, `isSidechain` excluded), after a driver
> session was caught spending four minutes alternating `echo idle` and `git status --short`.
> The operative rule is in `CLAUDE.md` § *Working a chantier*; this file is the evidence.

## The behaviour

A driver dispatches a Sonnet builder, then has nothing to do until the builder reports. It fills
the gap with tool calls whose only purpose is to **not end the turn**:

```
15:55:51  Bash  echo idle
15:55:53  Bash  git diff --stat        →  same 6 files, unchanged
15:55:54  Bash  echo idle
15:55:57  Bash  git status --short     →  same 6 ` M ` lines, unchanged
15:55:58  Bash  echo idle
…                                          (repeats every ~2s)
```

Session `2598d9cc`: **287 top-level tool calls, of which 100 pure no-op keepalives and 112
`git status` / `git diff --stat` polls — 74 % of the session spent waiting**, all of it
uninformative. The maintainer had to interrupt to break the loop.

That session is the acute case. The chronic one is repo-wide: of **94 `Monitor` calls**, **50 are
literally `sleep 600; echo tick`** and ~10 more are `for i in $(seq 1 N); do sleep 30; done`
heartbeats — blind clocks, not conditions. Plus **335** `sleep` attempts in `Bash` and **281**
`ListAgents` calls, the great majority of them "has it finished yet".

## Why it happens

Three things compose, and none of them is the model being lazy:

1. **Ending a turn feels like abandoning the card.** Emitting plain text with no tool call returns
   control to the human, which reads as stopping mid-chantier. So the driver keeps the turn alive,
   and the cheapest allowlisted call wins — `Bash(echo *)` is in `.claude/settings.json`.
2. **`git status` looks like a progress channel and is not.** *Subagents never commit* (CLAUDE.md),
   so the worktree is exactly as dirty at the builder's first write as at its last. The polled
   answer cannot change in a way the driver can act on. It came back identical 112 times.
3. **Nothing in the repo said how to wait.** `doc/`, `prompts/`, `README.md`,
   `orchestrator/README.md` and `.claude/commands/` contained no guidance on waiting for a
   subagent, so every session invented its own. The daemon has the opposite: its one blocking wait,
   `waitForBenchIdle`, is bounded (`benchIdleWaitMaxPolls` × `benchIdleWaitPollIntervalMs`),
   condition-based, and journals every poll. The CLI driver had no such rule.

## This class was measured once already — and fixed on the wrong side

`doc/improvisation-analysis.md` (a dated 2026-08 record of the *retiring* product driver, never
re-verified since) is the same finding: row **R5**, "a spawned sub-agent had not returned" — 63
polling calls, `ListAgents` up to 27× in one session, twice a second execution agent spawned while
the first was still live. Its disposition was **BRANCH (blocking join + deadline) → PARK**, and
disposition 6 states it flatly: *a step is a synchronous `claude -p` with a wall-clock deadline;
there is no "check whether it finished"*.

That disposition was implemented — in the **state machine**. Every LLM step the daemon runs is a
one-shot spawn under a deadline, and the polling class is genuinely unreachable there. It was never
carried across to the **human-facing driver loop**, which spawns real background subagents and had
no rule at all. So the behaviour did not survive in the daemon; it moved into the CLI.

## The measurement that settles it

**77 of 81 agent-completion `task-notification` turns (95 %) arrived while the session was idle** —
the last assistant turn before them carried no tool call at all. The harness re-invokes the session
when a background subagent finishes. **The keepalive buys nothing.** It is not a cheap insurance
policy against missing the notification; there is nothing to insure against.

## The protocol

1. **End the turn and wait.** Say what was dispatched and stop. The completion notification wakes
   the session. No `echo idle`, no `ListAgents` sweep, no `git status`.
2. **If work remains that does not depend on the subagent, do that work** — reading the spec,
   preparing the next action's brief. Waiting is not an activity, but neither is filler.
3. **If you must block inside a turn, block on a condition, never a clock.** `Monitor` with a real
   predicate. The two shapes in this corpus that actually worked:
   ```
   tail -n 0 -f journal/issue-<n>/journal.jsonl | grep -E --line-buffered '"event":"(transition|parked|done)"'
   until [ -s <named-report-path> ]; do sleep 15; done; cat <named-report-path>
   ```
   Never `sleep 600; echo tick`.
4. **A subagent that has gone quiet past its deadline gets one `SendMessage`** asking for an
   immediate report, then `TaskStop`. Not a third ping, and never a second builder spawned onto the
   same files while the first is still live.
5. **Read the diff when you have a reason to** — after the report lands, or to verify a claim. That
   is review, and it is the driver's job. Reading it every two seconds is not review.
