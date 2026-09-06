# Plan — task 508: hide Reply on `noReply` mail

**Skills used:** none (read-only plan; spo-testing conventions applied from CLAUDE.md).

## What is wrong

The read view of `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/mail/MailPanel.tsx` (lines 236-245) chooses between two buttons only by folder: Drafts get "Edit draft", everything else gets "Reply". The `noReply` flag that the gateway already parses from the message header (`/home/crazz/SPO-Pipeline/worktrees/issue-508/src/server/session/mail-handler.ts:112`, `headers['NoReply'] === '1'`) and carries on `MailMessageHeader.noReply` (`/home/crazz/SPO-Pipeline/worktrees/issue-508/src/shared/types/domain-types.ts:760`) is never read by the client. So a broadcast letter that the server marked `NoReply=1` still shows a Reply control, and answering it fails.

The legacy page did guard it: `~/SPO-ASP/Five/0/Visual/Voyager/Mail/MessageHeader.asp:197` wraps only the reply button in `if NoReply <> "1"`; the forward button at `:217-221` sits outside that guard. Welcome/zoning/system HTML mail carries no `NoReply` header on either side, so `noReply` is `false` for them and Reply stays.

## What changes

**This is not a rewrite of existing behaviour** — it adds one condition to an existing render branch. No output-equivalence or degenerate-input commands are needed.

1. `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/mail/MailPanel.tsx` — in the read view's `readActions` block, keep the Drafts branch as is and render the Reply button only when `!currentMessage.noReply`. Simplest shape: replace the ternary's `else` branch with `currentMessage.noReply ? null : (<button …Reply…/>)`, or an equivalent `&&`. The Delete button stays unconditional. Add a one-line comment naming the legacy guard (`MessageHeader.asp:197`) and stating that Forward, when it exists, is deliberately outside this guard. Do not touch the store's `startReply`, the Draft branch, or the Delete button. No new props, no new component, no CSS change (the actions row already lays out one or two buttons).

2. `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/__tests__/mail-compose-integration.test.tsx` — inside the existing `describe` that holds `'a message outside Drafts still offers Reply'` (around line 282), add two L0 tests following that exact pattern (`renderWithProviders(<MailPanel />)`, `act(() => useMailStore.getState().setCurrentMessage(msg))`, `screen.getByRole('button', { name: … })`):
   - `noReply: true` message in Inbox → `queryByRole('button', { name: 'Reply' })` is `null`, `getByRole('button', { name: 'Delete' })` is present, `queryByRole('button', { name: 'Edit draft' })` is `null`.
   - `noReply: false` message in Inbox → both `Reply` and `Delete` buttons present.
   Build each fixture as a `MailMessageFull` literal like the one at lines 283-287. Do not modify any existing test.

Nothing else changes. `MailMessageHeader` already has the field; the gateway already sets it; no wire, store, or handler work.

## Why this satisfies the criterion

- `noReply: true` → no Reply control in the read view (bullet 1).
- System HTML mail has no `NoReply` header → `mail-handler.ts:112` yields `false` → Reply still shown (bullet 2). Nothing in this change keys on content type.
- Only the Reply button is wrapped; the Delete button and any future Forward button are outside the condition, matching `MessageHeader.asp:197` vs `:217` (bullet 3).
- The two new tests are exactly bullet 4.

## Files to change

- `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/mail/MailPanel.tsx`
- `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/__tests__/mail-compose-integration.test.tsx`

## Check commands

Run from `/home/crazz/SPO-Pipeline/worktrees/issue-508`. Judge by exit code only.

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('src/client/components/mail/MailPanel.tsx','utf8');const t=fs.readFileSync('src/shared/types/domain-types.ts','utf8');process.exit(s.includes('startReply(currentMessage)')&&t.includes('noReply: boolean;')?0:1)"
npm run typecheck
npm run lint
npm run verdict -- coverage:changed
git grep -n -e "noReply" -e "NoReply" -- doc CLAUDE.md .claude ':!doc/ux/audit.md'
git grep -n -i "reply is always\|always offers reply\|reply on every" -- doc CLAUDE.md .claude
```

- Command 1 (executability probe): exit 0 confirms the Reply call site and the `noReply` field are where this plan expects them. Run it before editing; it will legitimately keep passing after the edit as long as `startReply(currentMessage)` is still the click handler.
- Commands 2-4: must exit 0.
- Commands 5-6 (falsification sweeps): `git grep` exits 1 when nothing matches, and **1 is the expected result** — it means no document claims Reply is unconditional or describes `noReply` differently. `doc/ux/audit.md` is excluded because it lists `noReply` only as a field-inventory row, not as a behaviour claim. A match (exit 0) means a doc must be read and, if it contradicts this plan, updated in the same PR.
