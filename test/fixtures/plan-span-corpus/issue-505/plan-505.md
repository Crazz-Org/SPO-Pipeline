# Plan — issue 505: Compose accepts a subject-less letter and an unbounded body, and hides why a send failed

Size S. **Not a rewrite of existing behaviour** — this tightens the existing compose form (one more Send precondition, a body cap, a hint, a clearer failure toast). No output-equivalence or degenerate-input checks apply.

## What exists today

- `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/mail/MailPanel.tsx:104` — `canSend` requires only a non-blank To. Subject is free-form and unchecked; the textarea at `:258-266` has no length limit and no counter.
- `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/mail/MailPanel.tsx:114-115` — `canSaveDraft` is true when any one of To / Subject / Body is non-blank. **Unchanged by this plan.**
- `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/store/mail-store.ts:145-146` — `setComposeField(field, value)` stores the string verbatim. The cap is applied in the component, not the store, so `startEditDraft` / `startReply` prefill is untouched.
- `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/bridge/client-bridge.ts:685-689` — on `RESP_MAIL_SENT` with `success: false` the bridge calls `mail.setSending(false)` and toasts `'Message not sent. Your draft is kept.'`. The gateway only forwards a boolean: `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/server/session/mail-handler.ts:146-148` maps the `Post` wordbool (`#-1` / `#0`) to `success`, and `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/server/ws-handlers/mail-handlers.ts:61` attaches a generic string. Nothing on the wire names the failing recipient — hence the criterion's "without asserting which".
- `showToast(message, variant, options?)` is exported from `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/common/index.ts:2` (`Toast.tsx:75`); components already call it (`SettingsDialog.tsx`, `AuthStage.tsx`). It is a plain module function that works in jsdom without mocking.

## Changes

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/mail/MailPanel.tsx`

- Add an exported constant `export const MAIL_BODY_MAX_CHARS = 10240;` near the top (after `FOLDERS`), with a one-line comment that the cap is a client-side budget on the letter body.
- Import `useRef` from `react` and `showToast` from `'../common'` (extend the existing `import { TabBar, Skeleton } from '../common';`).
- **Send needs a subject.** Change `canSend` to `composeTo.trim().length > 0 && composeSubject.trim().length > 0 && !isBusy`. Update the Send button `title` so the tooltip names the missing piece: `!composeTo.trim() ? 'Add a recipient' : !composeSubject.trim() ? 'Add a subject' : undefined`. `handleSend` keeps sending `composeSubject` as typed (not trimmed) — no other behaviour change. `canSaveDraft` and `handleSaveDraft` are **not touched**.
- **Body cap with a single warning.** Add `const bodyWarnedRef = useRef(false);` and a `handleBodyChange` callback:
  ```ts
  const handleBodyChange = useCallback((value: string) => {
    if (value.length > MAIL_BODY_MAX_CHARS) {
      if (!bodyWarnedRef.current) {
        bodyWarnedRef.current = true;
        showToast(`The message was cut to ${MAIL_BODY_MAX_CHARS} characters — that is the most a letter can hold.`, 'warning');
      }
      setComposeField('body', value.slice(0, MAIL_BODY_MAX_CHARS));
      return;
    }
    setComposeField('body', value);
  }, [setComposeField]);
  ```
  Wire the textarea `onChange={(e) => handleBodyChange(e.target.value)}`. Reset the flag when the compose view is (re)opened: a small `useEffect(() => { if (currentView === 'compose') bodyWarnedRef.current = false; }, [currentView]);` so the next letter warns again once. Do **not** add a `maxLength` attribute to the textarea: the browser would silently clip a paste before `onChange` fires and the warning would never show.
- **Remaining-budget counter.** Under the textarea render `<span className={styles.composeCounter} role="status" aria-live="polite">{MAIL_BODY_MAX_CHARS - composeBody.length} characters left</span>`. Give the textarea `aria-describedby="mail-body-counter"` and the span `id="mail-body-counter"`.
- **To-field hint.** Keep `placeholder="To"` and `aria-label="To"` (tests find the field by placeholder). Below the To input add `<span className={styles.composeHint} id="mail-to-hint">Several recipients? Separate the addresses with ;</span>` and set `aria-describedby="mail-to-hint"` on the To input.

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/mail/MailPanel.module.css`

After the `.composeBody:focus` rule (`:260-262`) add two small rules, `.composeHint` and `.composeCounter`: `font-size: var(--text-xs); color: var(--text-muted); font-family: var(--font-sans);` — the counter additionally `text-align: right;`. Tokens only, no new colours.

### 3. `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/bridge/client-bridge.ts`

Line 688 only: replace the failure toast text with
`'Message not sent. Most likely one of the recipients does not exist — the server does not say which. Your draft is kept.'` (variant stays `'error'`, no options). Keep `mail.setSending(false)` and the surrounding comment; extend the comment with one line: the gateway forwards only the `Post` boolean, so the toast names the most likely cause without claiming to know.

### 4. `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/bridge/client-bridge.test.ts`

Line 224: update the expected string to the new toast text verbatim. This is the criterion changing, not a test bent to pass.

### 5. `/home/crazz/SPO-Pipeline/worktrees/issue-505/src/client/components/__tests__/mail-compose-integration.test.tsx`

- **Existing test at `:281-292`** (`'a send in flight locks the draft button too — one letter, one gesture'`) fills only To before clicking Send. With Send now requiring a subject, add a `fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'ping' } })` before the click. Nothing else in the file needs changing: `:83` and `:183` (`Re: Hello there`) already carry a subject; `:108-117` and `:224` already expect Send disabled.
- **New `describe('#505 — compose guards')` block** with L0 unit tests on `MailPanel`, importing `MAIL_BODY_MAX_CHARS` from `'../mail/MailPanel'`:
  1. *Send disabled with an empty subject*: fill To = `player42` and Body, leave Subject blank → Send button `disabled === true`, its `title` is `'Add a subject'`, clicking it does not call `onMailSend`; Save draft is enabled (unchanged rule). Then fill Subject → Send enabled.
  2. *Send disabled with a whitespace-only subject* (`'   '`).
  3. *A 20000-character paste leaves 10240 in the field*: `fireEvent.change(textarea, { target: { value: 'x'.repeat(20000) } })` → `useMailStore.getState().composeBody.length === MAIL_BODY_MAX_CHARS` (=== 10240) and the textarea `.value.length === 10240`; the counter reads `0 characters left`.
  4. *Warns once*: spy on the toast by `jest.spyOn` is not possible on an ES module import from the component, so assert via the toast store: import `subscribeToToasts`/listener API is not needed — simpler: mock the common barrel's `showToast` at file top with `jest.mock('../common', () => ({ ...jest.requireActual('../common'), showToast: jest.fn() }))` and assert it is called exactly once across two oversized pastes, with variant `'warning'`, and not at all for an in-budget paste. Clear the mock in `beforeEach`.
  5. *Counter tracks the budget*: type 5 characters → `10235 characters left`.
  6. *To hint present*: `screen.getByText(/Separate the addresses with ;/)` exists and the To input's `aria-describedby` is `mail-to-hint`.

  Use `renderWithProviders` / `createSpiedCallbacks` from `../../__tests__/setup/render-helpers` as the rest of the file does.

## Why this satisfies the criterion

| Criterion line | Where |
|---|---|
| Send disabled while Subject blank; Save Draft unchanged | `canSend` gains the subject check; `canSaveDraft` untouched; tests 1–2 |
| Past 10240 chars warns once and truncates; counter shows remaining budget | `handleBodyChange` + `bodyWarnedRef` + counter span; tests 3–5 |
| To field states several addresses separated by `;` | hint span tied by `aria-describedby`; test 6 |
| Refused send says the most likely cause without asserting which | new toast text in `client-bridge.ts:688`, bridge test updated |
| L0 unit on MailPanel: empty subject / 20000-char paste | tests 1 and 3 |

## Coverage and style

New lines are all in `MailPanel.tsx` (fully exercised by the new tests), one CSS file, and one string in the bridge (covered by the existing bridge test). `npm run coverage:changed` must stay ≥ 93 % on changed lines. No new dependency. LF only.

## Check commands

```bash
npx jest src/client/components/__tests__/mail-compose-integration.test.tsx
npm run typecheck
npm run lint
npm run coverage:changed
! grep -rn "Message not sent. Your draft is kept" doc .claude CLAUDE.md
! grep -rn -i "10240\|maxLength" doc .claude CLAUDE.md
! grep -rn "Add a recipient" doc .claude CLAUDE.md
! grep -rn -i "subject is optional\|without a subject" doc .claude CLAUDE.md
```

The first command proves the component test harness (jsdom project, `renderWithProviders`) runs in this worktree; it passes on the baseline and must pass with the new tests. The four `!`-negated greps are the falsification sweep: no document in `doc/`, `.claude/` or `CLAUDE.md` names the old toast text, a body cap, the old Send tooltip, or a subject-less send, so nothing elsewhere claims this ground works differently.

Skills used: none (read-only planning against the worktree).
