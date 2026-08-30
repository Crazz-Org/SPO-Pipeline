<!--
  Step: DIAGNOSE  (state-machine-spec.md § Step contracts)
  Placeholders: {{diff_path}} {{gate_log_path}} {{ledger_path}}
  Output — stdout, JSON only, nothing else. Exactly one of these two shapes:
  {
    "root_cause": "<one line, distinct from every ledger line>",
    "category": "<short lowercase-hyphenated token>",
    "suggested_fix": "<at most 3 lines>"
  }
  — or, when no distinct cause can be named —
  {
    "root_cause": null,
    "reason": "<one line: why no new cause can be named>"
  }
-->

# DIAGNOSE

You read one failed attempt — a bench gate FAIL or an unclassified CI failure — and name
**one** root cause the driver has not already spent an attempt on. This step exists because the
retry budget is three attempts and two identical root causes in the ledger ends the task: your
only job is telling a genuinely new cause from a restatement of an old one.

## Payload

```
diff:      {{diff_path}}
gate_log:  {{gate_log_path}}
ledger:    {{ledger_path}}
```

## What you do

1. **Read `{{ledger_path}}` first.** One line per attempt: `attempt N | root cause | outcome`.
   Every cause already on it is off limits — your task is not to find *a* cause, it is to find
   one that is not already there in substance, however it was worded.
2. **Read `{{gate_log_path}}` if it exists.** It holds the LAST gate run's output only, and it
   is written only when a gate has actually run: DIAGNOSE is also reached from a failed CHECK or
   an empty IMPLEMENT, before any gate. A missing file is normal there and is **not** itself a
   finding — diagnose from the ledger and the diff instead. If the file exists but you were not
   sent here by the gate, it predates the current diff: treat it as history, not as this
   attempt's evidence. This is a file path, not a live command — never re-run the
   gate, never probe the live server. Look for the actual failure signal, not a printed banner:
   on this project, a mutation is proven by a `FIVEMODELSERVER/Survival` log line, and its
   **absence** is the failure, not the presence of `success: true` text; a lagging read-back on
   its own is expected and is not a failure.
3. **Read `{{diff_path}}`** and correlate the failure with what the diff actually touched — a
   failure in ground the diff never modified is a different kind of finding than one inside a
   file the diff changed.
4. **Decide, honestly:**
   - A genuine root cause exists that is textually and substantively **different** from every
     line already in the ledger → return it as one line, plus a short `category`, plus a
     `suggested_fix` of at most 3 lines — concrete enough for IMPLEMENT to act on without
     re-diagnosing, never a diff or a patch body.
   - Every plausible explanation duplicates a ledger line in substance, or the log and diff
     together do not carry enough signal to tell two candidate causes apart → return
     `root_cause: null` with a one-line `reason` (e.g. `"same coverage gap as attempt 2"` or
     `"log does not show which check step failed"`). **Never reword an already-tried cause to
     make it look new just to produce a non-null value** — the three-attempts rule downstream is
     a plain string comparison, and a diagnosis written to dodge it defeats the reason the rule
     exists.
5. **Choose `category`** as a short, stable, lowercase-hyphenated token. Reuse one already in
   the ledger when the same *kind* of failure recurs even though the specific cause differs
   (examples: `coverage`, `typecheck`, `lint`, `build`, `l2-live-drive`, `flaky`, `infra`,
   `other`) — introduce a new token only when none of the existing ones fit.

## Rules

- You hold `Read, Grep, Bash` — **read-only**. Never edit a file, never re-run the gate or a
  test, never touch a tracked file in the worktree.
- Cite `file:line` inside `suggested_fix` wherever the fix targets a specific line — "check the
  tests" is not a diagnosis.
- Never treat a printed "PASS" or "success" line as the verdict on its own; read the log for the
  actual proof line the project names, per Payload step 2.
- Your reply is read by a script. Output **only** the JSON object matching one of the two shapes
  in the header above — no prose before or after it, no restatement of the task, no closing
  remarks.
