---
description: Turn this brainstorm into a draft backlog card, show the maintainer the draft and the review verdict, and file it only on explicit confirmation
argument-hint: "[optional: extra context or constraints for the card]"
---

# SPO-Draft

You are the interactive-session front end for `orchestrator/intake.js`'s **brainstorm lane** —
the human-facing wrapper around `bin/spo ask --draft-file <path>` described in
`orchestrator/README.md` § Intake. It replaces typing the JSON and the CLI flags by hand; the
underlying mechanism (`intake.loadDraftFile` → `intake.reviewCard` → `intake.fileCard`) is
unchanged.

**Never file a card without the maintainer's explicit yes.** That is the one rule this command
exists to enforce — everything below is in service of it.

## 1. Synthesize the draft

Read back over this conversation (and `$ARGUMENTS`, if given) and turn the brainstorm into a
single draft card, in your own words, in English — the exact contract `prompts/draft-card.md`
produces (see that file for the fuller rules on tone and citation quality):

```json
{
  "title": "<English, short and specific>",
  "body_markdown": "<English, synthetic — what is wrong or missing, file:line references where you have them (or the explicit reason there are none), a '## Done means' section, a trailing 'Source: <short description of this conversation>, <today's date>' line>",
  "category": "defect" | "latent-trap" | "feature" | "observation" | "doc-infra",
  "size": "S" | "M" | "L",
  "area": "docs" | "rdo" | "bench" | "renderer" | "gateway" | "client" | "e2e" | "shared" | "ci",
  "is_bug_report": true | false,
  "confirmed": true | false
}
```

- `title` / `body_markdown` are English regardless of what language the conversation was in —
  translate the substance, never transcribe the words.
- `is_bug_report: true` only for something genuinely broken; `confirmed: true` only when the
  conversation supplied a reproduction precise enough to replay, or you verified the behaviour
  yourself against the code. Do not mark a thin report `confirmed: true` to make it look
  stronger — `review-card`'s own confirmation gate reads this field, and a bug report that isn't
  confirmed here fails that gate later anyway.
- If the brainstorm covers more than one card's worth of work, say so and ask which one to draft
  first rather than merging two ideas into one title.

Write the JSON to a file in **the session scratchpad** (never inside a repo worktree — same rule
as any other multi-line hand-off text this project produces). Note the exact path; you need it
in both steps below.

## 2. Show the draft and the judge's verdict — dry run only

From `~/SPO-Pipeline`, run exactly:

```bash
cd ~/SPO-Pipeline && bin/spo ask --draft-file <scratchpad-path>/draft.json --dry
```

`--dry` runs the draft through `review-card` (the same neutral second reader every other
backlog card gets) and prints the draft plus the verdict — it **files nothing**. Show the
maintainer both blocks **verbatim** — the draft JSON and the full review output, including
`verdict`, `corrections`, and `first_comment_markdown`. Do not summarize or paraphrase the
verdict; the maintainer needs to see exactly what `review-card` said.

If the verdict is `DO_NOT_FILE`: say so plainly and stop here. **A `DO_NOT_FILE` verdict is
final for this draft** — the fix is to revise the draft (a missing citation, a wrong category, a
report that needs a stronger reproduction) and run step 2 again, never to override the verdict
or file anyway.

## 3. Ask for confirmation, then file only on yes

For a `FILE` or `FILE_AMENDED` verdict, use `AskUserQuestion` to ask the maintainer an explicit
yes/no: file this card now, or not? Frame it plainly — name the verdict, and if it was
`FILE_AMENDED`, name what `review-card` corrected.

- **Yes** → re-run the identical command **without** `--dry`:

  ```bash
  cd ~/SPO-Pipeline && bin/spo ask --draft-file <scratchpad-path>/draft.json
  ```

  This applies review's mechanical corrections and files the issue for real (`gh issue create` +
  the review verdict posted as the first comment). Report the filed issue number and URL back to
  the maintainer.

- **No** → stop. Do not file. Keep the draft file in the scratchpad and tell the maintainer its
  path, so it can be edited and re-run through step 2 later without redoing the synthesis.

Never skip straight from step 2 to filing on an assumed "looks good" — the confirmation in this
step is not optional, and it is not satisfied by the maintainer having asked for a card in
general terms earlier in the conversation.
