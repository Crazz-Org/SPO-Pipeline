# Plan — issue 506: "Write to <name>" actions that open the mail panel in compose

## What is wrong today

`useMailStore.startCompose(to?, …)` (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/store/mail-store.ts:103-111`) accepts a recipient, but its only caller is the mail panel's own "Compose" button, which calls it with no arguments (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/mail/MailPanel.tsx:188`). A player looking at a tycoon, a facility, or a town hall has no way to write to that person without typing the address by hand.

**This is NOT a rewrite of existing behaviour.** It adds a helper and three call sites; nothing that exists today changes meaning. The `comm` / degenerate-input checks are therefore omitted.

## Addresses — what the server actually creates

The mail accounts the model server registers at creation time, and nothing else, are reachable:

| who | address | declaration |
|-----|---------|-------------|
| a tycoon | `<Name>@<World>.net` | `~/SPO-Original/Kernel/World.pas:6137` — `MailServer.NewMailAccount( name + '@' + self.Name + '.net', name, '', true )` in `TWorld.NewTycoon` |
| a town's mayor | `mayor@<Town>.gov` | `~/SPO-Original/Kernel/Kernel.pas:9250` — `NewMailAccount( mtidMayorEmail.Values[langDefault] + '@' + aName + '.gov', fMayor.Name, '', true )`, with `mtidMayorEmail` defaulting to `'mayor'` (`Kernel.pas:13489`) |
| a company / its CEO | **none** | `~/SPO-Original/Kernel/World.pas:6089-6094` — the two `NewMailAccount('company@…')` / `NewMailAccount('CEO@…')` calls are inside a `{ … }` comment block and never run |

So the criterion's `<mayorTitle>@<Town>.gov` resolves to the server's mailbox name for the mayor role, which is the literal `mayor` — **not** the display title "Mayor of <Town>" (that is `mtidMayorTitle`, `Kernel.pas:13488`, the role tycoon's *name*, and is what the `.net` account of the role would be, not the `.gov` box the criterion asks for). Implement `mayor@<Town>.gov` and say so in the JSDoc. There is no `.gov` account for the Capitol/president anywhere in `Kernel.pas`, so the Capitol header offers nothing.

The world name the client already holds is `useGameStore.worldName` (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/store/game-store.ts:94`, set by `setWorld` at `:245`). The mock/live captures confirm the form (`SPO_test3@Shamba.net`, `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/mock-server/scenarios/scenario-variables.ts:81`).

## The change

### 1. One helper module — `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/mail/write-to.ts` (new)

Three tiny exports, no React:

```ts
/** `<Name>@<World>.net` — the account `TWorld.NewTycoon` registers (`Kernel/World.pas:6137`). */
export function tycoonAddress(name: string, worldName: string): string {
  return `${name}@${worldName}.net`;
}
/** `mayor@<Town>.gov` — the town's mayor box (`Kernel/Kernel.pas:9250`, name from `:13489`). */
export function mayorAddress(townName: string): string {
  return `mayor@${townName}.gov`;
}
/** Open the mail panel in compose with `address` already in To. Pushes the mail surface so the profile / inspector stays underneath as a chip. */
export function writeTo(address: string): void {
  useMailStore.getState().startCompose(address);
  useUiStore.getState().pushSurface({ kind: 'mail' });
}
```

- `startCompose(address)` leaves subject/body/headers empty and `composeDraftId: null`, and sets `currentView: 'compose'` (`mail-store.ts:103-111`). Do not add a new store action — the existing one already does the job.
- `pushSurface({ kind: 'mail' })` (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/store/ui-store.ts:217-223`) stacks the mail surface on top of whatever is open; the sheet renders `MailPanel` for that kind (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/sheet/Sheet.tsx:71-72`). Push, not `setRootSurface`, so Escape / the chip returns the player to the tycoon or building they were reading — that is the stack's whole purpose (`ui-store.ts:31-37`). Note `pushSurface` is a no-op if the top is already `mail`, which is exactly right.
- Import the two stores from `../../store/mail-store` and `../../store/ui-store` (the components' convention; the barrel `../../store` also works).
- Re-export the three functions from `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/mail/index.ts`.

### 2. Tycoon profile — `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/search/TycoonProfileView.tsx`

The card already shows `profile.name` (`:37`). Add, under the stats grid inside the `GlassCard`, one text button:

```tsx
const worldName = useGameStore((s) => s.worldName);
…
<button
  type="button"
  className={styles.profileWriteBtn}
  onClick={() => writeTo(tycoonAddress(profile.name, worldName))}
>
  <Mail size={14} /> Write to {profile.name}
</button>
```

`Mail` comes from `lucide-react` (already the icon set used in this file). `useGameStore` from `../../store/game-store`. Add a `.profileWriteBtn` rule to `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/search/SearchPanel.module.css` next to `.profileCard` — copy the shape of `.searchBtn` (`:160-179`, gold accent, `display: flex; align-items: center; gap: var(--space-1)`), plus `margin-top: var(--space-2)`. Keep the hover rule.

### 3. Building inspector — owner action in the header — `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/building/BuildingInspector.tsx`

The tycoon behind the facility is `ownerTycoon = findPropertyValue(details.groups, 'Creator')` (`:292`), rendered by `InspectorHeader` which shows whatever `actions` it is given on the name row (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/building/InspectorHeader.tsx:85`). Today `actions` is only built when `!isRenaming && isOwner` (`:371`). Change it so the write action is offered to everyone while the owner's own controls stay owner-only:

```tsx
actions={!isRenaming ? (
  <>
    {ownerTycoon && (
      <IconButton
        icon={<Mail size={14} />}
        label={`Write to ${ownerTycoon}`}
        size="sm"
        variant="ghost"
        onClick={() => writeTo(tycoonAddress(ownerTycoon, worldName))}
      />
    )}
    {isOwner && (
      <>
        … the existing Star / Edit3 / SaveIndicator block, unchanged …
      </>
    )}
  </>
) : undefined}
```

`InspectorHeader` renders the actions container whenever `actions` is truthy, so a non-owner with no `Creator` yet gets an empty fragment — harmless, same as before. Add `Mail` to the existing `lucide-react` import (`:11`), `const worldName = useGameStore((s) => s.worldName);` beside the existing `useGameStore` subscription (`:80`), and `import { tycoonAddress, writeTo } from '../mail/write-to';`. The civic path never reaches this header (`hideHeader` from `BuildingSurface`), which is why the mayor case lives in §4.

### 4. Town hall in view — the civic sheet header — `/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/sheet/BuildingSurface.tsx`

This header is drawn for every civic building as soon as it is focused, on every tab (`:32-49`) — the right place for "where a town hall is in view". The town's name is the `Town` property of the details groups, the same value the bridge feeds `setTownContext` (`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/bridge/client-bridge.ts:508`); read it here with `findPropertyValue(details, 'Town')` from `../building/civic-subtitle` (already imported module, `:12`). The Capitol is told apart with `isCapitolBuilding(details.tabs)` from `../politics/CivicTabConfig` (what `getCivicSubtitle` uses at `civic-subtitle.ts:22`; the existing `BuildingSurface.test.tsx` already mocks that module).

```tsx
const townName = details ? findPropertyValue(details, 'Town') : undefined;
const capitol = details ? isCapitolBuilding(details.tabs) : false;
…
{details && !capitol && townName && (
  <IconButton
    icon={<Mail size={16} />}
    label={`Write to the Mayor of ${townName}`}
    size="sm"
    variant="ghost"
    onClick={() => writeTo(mayorAddress(townName))}
  />
)}
```

Place it in the header `div` before the existing Refresh `IconButton`. Nothing is offered for the Capitol (no `.gov` box exists for it) and nothing while `Town` has not been read.

### 5. Tests (L0 — Jest `unit` project for `.test.ts`, `component` for `.test.tsx`)

- **`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/mail/write-to.test.ts`** (new) — the criterion's unit test. `beforeEach`: `useMailStore.setState({ currentView: 'list', composeTo: '', composeSubject: 'x', composeBody: 'y', composeDraftId: 'd' })`, `useUiStore.getState().clearSurfaces()`. Cases: (a) `writeTo('SPO_test3@Shamba.net')` → `composeTo === 'SPO_test3@Shamba.net'`, `currentView === 'compose'`, `composeSubject === ''`, `composeDraftId === null`, `useUiStore.getState().rightPanel === 'mail'` and the stack's top kind is `mail`; (b) the surface is *pushed* — with `setRootSurface({ kind: 'search' })` first, the stack becomes `['search', 'mail']`; (c) `tycoonAddress('SPO_test3', 'Shamba') === 'SPO_test3@Shamba.net'`; (d) `mayorAddress('Helartia') === 'mayor@Helartia.gov'`; (e) a `.com` address is never produced — assert neither helper's output contains `.com` (documents the World.pas:6089-6094 point).
- **`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/search/TycoonProfileView.test.tsx`** (new) — `renderWithProviders` from `../../__tests__/setup/render-helpers`; seed `useGameStore.setState({ worldName: 'Shamba' })` and `useSearchStore.setState({ tycoonProfileData: { profile: { name: 'Alice', photoUrl: '', fortune: 0, thisYearProfit: 0, ntaRanking: '1', level: 'Apprentice', prestige: 0, profileUrl: '', companiesUrl: '' } } as never })`; click `getByRole('button', { name: /Write to Alice/ })` → `useMailStore.getState().composeTo === 'Alice@Shamba.net'`, `currentView === 'compose'`, `useUiStore.getState().rightPanel === 'mail'`. Second case: no profile → the empty-state text and no button.
- **`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/building/__tests__/inspector-write-owner.test.tsx`** (new) — copy the `focus` / `details` / `seed` scaffolding of `inspector-add-favorite.test.tsx:18-48`, adding `groups: { general: [{ name: 'Creator', value: 'Bob' }] }` and `useGameStore.setState({ worldName: 'Shamba' })`. Cases: non-owner (`seed(false)`) sees `Write to Bob` and clicking it leaves `composeTo === 'Bob@Shamba.net'` with the mail surface on top; owner (`seed(true)`) sees both `Write to Bob` and `Add to Empire list`; with no `Creator` property no write button is rendered.
- **`/home/crazz/SPO-Pipeline/worktrees/issue-506/src/client/components/sheet/BuildingSurface.test.tsx`** (extend) — add to the existing describe: a Town Hall whose `groups` hold `{ townGeneral: [{ name: 'Town', value: 'Helartia' }] }` offers `Write to the Mayor of Helartia`, and clicking it leaves `composeTo === 'mayor@Helartia.gov'` and `currentView === 'compose'`; the Capitol case (`tabs: [{ id: 'capitol' }]`) offers no such button; a Town Hall without a `Town` property offers none either. Reset `useMailStore` / `useUiStore` in `beforeEach` (`resetStores` from the render helpers, or explicit `setState`).

Coverage: every new line is in a helper or a small JSX branch exercised by the cases above; ≥ 93 % on new/modified lines is expected without further effort.

## Why this satisfies the criterion

- "Write to <name>" on the tycoon profile → §2, address `<name>@<World>.net`, mail panel opened in compose with To filled (§1).
- Same for the facility owner → §3, from the `Creator` property the header already shows.
- Mayor's `.gov` address where a town hall is in view → §4, `mayor@<Town>.gov`, the only mayor box the server creates.
- No company / CEO address → none of the three helpers can produce a `.com`, and no call site builds one (`World.pas:6089-6094`, unit case (e)).
- L0 unit → `write-to.test.ts` case (a).

## Out of scope / not done

No new store action, no new dependency, no change to `MailPanel`, no RDO change (the send path is untouched — `onMailSend` already takes the address string). The `RulerCard` on the Politics tab is not touched: the civic header of §4 is visible on every tab and covers "a town hall in view" once.

## Check commands

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('src/client/store/mail-store.ts','utf8');const u=fs.readFileSync('src/client/store/ui-store.ts','utf8');process.exit(s.includes('startCompose: (to = \'\', subject = \'\', body = \'\', headers = \'\') =>')&&u.includes('pushSurface: (surface: Surface) => void;')?0:1)"
npm run typecheck
npm run lint
npm run coverage:changed
node -e "const r=require('child_process').spawnSync('git',['grep','-n','-i','-E','write to (this|the) (tycoon|mayor)|@[A-Za-z]+\\\\.gov|mayorTitle|CEO@|company@','--','doc','.claude','CLAUDE.md'],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status===1?0:1)"
node -e "const r=require('child_process').spawnSync('git',['grep','-n','-E','startCompose\\\\(|composeTo','--','doc','.claude','CLAUDE.md'],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status===1?0:1)"
```

The first command proves the two existing store actions the helper composes are still declared as this plan read them. The two sweeps exit 0 when nothing under `doc/`, `.claude/` or `CLAUDE.md` claims a different address form or a different compose entry point (git grep status 1 = no match); a hit prints the line and exits 1.

Skills used: delphi-archaeologist (reading Kernel.pas / World.pas), spo-testing, zustand-store-ts.
