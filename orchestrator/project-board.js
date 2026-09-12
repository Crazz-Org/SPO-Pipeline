'use strict';
// project-board.js -- adds an already-filed issue to a non-default GitHub Projects v2 board and
// sets its Status, for the maintainer-facing `spo ask --repo <owner/name>` path (bin/spo's
// cmdAsk). NOT used by the daemon: the daemon's only repo is `config.ghRepo` (SPO-WebClient,
// project 1), whose "Auto-add to project" workflow is enabled and is meant to set Status->Todo --
// see intake.js's fileCard header. SOFTENED (post-verification, SF3): `doc/board-audit.md`'s own
// Caveats section records that the Projects v2 `ProjectV2Workflow` GraphQL type exposes only
// `name`/`enabled`, not its target field -- so "Item added to project" being ENABLED is what was
// read from the API (`doc/board-audit.md`'s workflow table); its Todo target, and hence that it
// actually LANDS a freshly filed issue in Todo, is "assumed correct ... per the task's stated
// target; verify visually in the UI", not independently confirmed the way THIS module's own
// placeOnBoard proves its own writes (read-back over the API, see below) -- do not restate that
// assumption as a confirmed fact. This module exists for every OTHER target repo, which has no
// such workflow at all (enabled, targeted, or otherwise).
//
// The defect this exists to fix (`[[two-project-split-daemon-vs-factory]]`, found 2026-09-04):
// `gh project item-add` leaves the new item's `Status` field EMPTY. An item with no Status sits
// on the board in NO COLUMN -- invisible on the Kanban view, `gh project item-list` prints its
// status as blank. Seven cards (#105-#119) accumulated that way before anyone noticed. So this
// module does not just add the item: it sets Status in the same breath, and then reads the value
// back from the API to prove the mutation actually landed -- see placeOnBoard's own comment.
//
// Every mutation here is `gh api graphql` (CLAUDE.md's own "gh conventions" section: board
// mutations -- addProjectV2ItemById, updateProjectV2ItemFieldValue -- have no CLI equivalent).
// `gh api graphql` is exempt from the repo's "-f is a POST unless --method GET" guard
// (test/gh-api-argv.test.js) because a graphql call is a POST by definition; nothing here passes
// --method or a query-string page param, so that guard does not apply to this file at all.
//
// Field ids and option ids are NEVER hardcoded -- both are read at runtime, on every call, via
// `gh project field-list <n> --owner Crazz-Org --format json` (CLAUDE.md's own "gh conventions"
// section). The project's own node id is likewise resolved at runtime, via
// `gh project view <n> --owner Crazz-Org --format json`, rather than pinned as a constant here --
// a deleted-and-recreated project would silently strand a hardcoded id and this module would
// rather fail loudly on a bad `gh` call than write to the wrong project undetected.
//
// Same spawn-injection convention as every other module that shells out to `gh`
// (steps/scripted.js, board.js, park-loop.js, intake.js): `deps.spawnSync` is the test-only
// override, routed through command-timeout.js's armTimeout so these calls share the same `gh`
// timeout class as everything else. Production code never passes it.

const config = require('./config');
const { armTimeout } = require('./command-timeout');

// PROJECT_NUMBER_BY_REPO -- repo (`owner/name`, exactly as it would be passed to `gh --repo`) ->
// the GitHub Projects v2 board it belongs on, all under the `Crazz-Org` org (see
// `PROJECT_OWNER` below; every project this table names is one of that owner's org projects, so
// the table only needs to carry the number). SPO-WebClient deliberately has NO entry: it is
// `config.ghRepo`, and project 1's own "Auto-add to project" workflow is what is meant to land a
// freshly filed issue in Todo (see this file's header: enabled per the API, its Todo target
// assumed, not read), with no code in this repo touching the board. That is the default `spo ask`
// (no `--repo`) behaviour this action left alone. Do not add an entry for it here -- that would be
// a second, redundant board-add racing the workflow's own, unasked-for behaviour change.
//
// `[[two-project-split-daemon-vs-factory]]`: project 2 ("SPO Factory", `PVT_kwDOEyAVD84BiHMr`,
// resolved at runtime below rather than pinned here) spans SPO-Pipeline and SPO-Deploy -- the two
// repos "fixable outside a SPO-WebClient worktree", i.e. everything the daemon cannot claim.
const PROJECT_NUMBER_BY_REPO = {
  'Crazz-Org/SPO-Pipeline': 2,
  'Crazz-Org/SPO-Deploy': 2,
};

const PROJECT_OWNER = 'Crazz-Org';

// The Status this module always sets a newly-added item to. `spo ask --repo` only ever *files* a
// card -- there is no verdict here that could justify landing anywhere but the front of the
// queue, the same place project 1's own auto-add workflow is meant to land a SPO-WebClient card.
const STATUS_FIELD_NAME = 'Status';
const TARGET_STATUS_NAME = 'Todo';

// Priority -- the card's criticity as a FIELD. Created on project 2 ("SPO Factory") on
// 2026-09-12; project 1 does not have it yet, which is exactly why placeOnBoard fails OPEN on a
// board that lacks the field rather than refusing to file.
//
// The vocabulary is not invented here: CRITICAL / HIGH / MEDIUM / LOW are the four words the
// backlog corpus already used in issue TITLES and bodies ("CRITICAL -- auto-triage loops forever"
// #161, "HIGH -- dispatcher-stopped is emitted after killAllChildren" #162, "MEDIUM -- ..." #165,
// "LOW -- amendCard passes cat:/size:" #198), so the backfill of the existing board was lossless.
// Deliberately NOT GitHub's own P0/P1/P2 template: renaming the corpus would have made every
// historical card's own prose disagree with its field.
//
// What is NOT in this vocabulary, on purpose: **DECISION**. "A human must arbitrate before any
// code is written" (#166, #79) is an orthogonal axis, not a rung on this ladder -- a DECISION card
// can be CRITICAL or LOW. It stays a title prefix; see CLAUDE.md's "Filling a card" section.
const PRIORITY_FIELD_NAME = 'Priority';
const VALID_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

// projectNumberForRepo(ghRepo) -- null for a repo with no board entry (SPO-WebClient, or any
// repo nobody has mapped yet). The caller (bin/spo's cmdAsk) uses this to decide whether
// placeOnBoard needs to run at all.
//
// Case-insensitive lookup (action 184/185, post-verification fix F4): GitHub owner/repo names
// are themselves case-insensitive -- `gh issue create --repo crazz-org/spo-pipeline` really does
// file into Crazz-Org/SPO-Pipeline -- but PROJECT_NUMBER_BY_REPO's keys are written in the one
// canonical casing above. A bare `PROJECT_NUMBER_BY_REPO[ghRepo]` lookup on a differently-cased
// but valid `--repo` MISSES: the issue gets filed for real, but this function reports "no project
// mapped" and no board call is ever attempted -- an invisible card indistinguishable, on the
// board, from one that was never filed at all. Comparing lowercased keeps the map's own keys (and
// every `gh` call this module makes) in whatever casing the caller actually passed -- this
// function only ever answers "which project", never rewrites what gets sent to `gh`.
function projectNumberForRepo(ghRepo) {
  if (typeof ghRepo !== 'string' || !ghRepo) return null;
  const target = ghRepo.toLowerCase();
  for (const key of Object.keys(PROJECT_NUMBER_BY_REPO)) {
    if (key.toLowerCase() === target) return PROJECT_NUMBER_BY_REPO[key];
  }
  return null;
}

function runSync(deps, command, args, opts = {}) {
  return armTimeout(deps, config, command, args, opts);
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

// runGh(deps, args) -- one `gh` spawn, normalized to {ok, stdout, error}. Every step below is
// this shape: a non-zero/errored exit is a hard stop, verdict by exit code (never by scraping
// `gh`'s human text output), same rule CLAUDE.md's "gh conventions" section states for the rest
// of the codebase.
function runGh(deps, args) {
  const result = runSync(deps, 'gh', args);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    return {
      ok: false,
      error: `gh ${args.join(' ')} exited ${exit}${result && result.stderr ? `: ${result.stderr}` : ''}`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

// runGhJson(deps, args, label) -- runGh, then JSON.parse the stdout. A parse failure is reported
// as an ordinary failure (bad/empty JSON from `gh` is exactly as untrustworthy as a non-zero
// exit) rather than thrown -- this module never throws, every caller gets {ok:false, error}.
function runGhJson(deps, args, label) {
  const ran = runGh(deps, args);
  if (!ran.ok) return ran;
  try {
    return { ok: true, data: JSON.parse(ran.stdout) };
  } catch (err) {
    return { ok: false, error: `${label}: could not parse gh's JSON output (${err.message})` };
  }
}

// resolveProjectId(deps, projectNumber) -- `gh project view <n> --owner Crazz-Org --format
// json`'s own `id` field, the project's GraphQL node id (`PVT_...`). Resolved fresh on every
// call rather than pinned as a constant -- see this file's header.
function resolveProjectId(deps, projectNumber) {
  const viewed = runGhJson(
    deps,
    ['project', 'view', String(projectNumber), '--owner', PROJECT_OWNER, '--format', 'json'],
    'resolveProjectId'
  );
  if (!viewed.ok) return viewed;
  const id = viewed.data && viewed.data.id;
  if (!id) return { ok: false, error: `resolveProjectId: project ${projectNumber} view carried no "id"` };
  return { ok: true, projectId: id };
}

// listFields(deps, projectNumber) -- ONE `gh project field-list <n> --owner Crazz-Org --format
// json` per placeOnBoard call, whose payload every single-select this module writes is then
// resolved out of. Deliberately one read, not one per field: Status and Priority are set in the
// same breath and a second identical `gh` call would only add latency and a second way for the
// two resolutions to disagree about what the board looks like.
function listFields(deps, projectNumber) {
  const listed = runGhJson(
    deps,
    ['project', 'field-list', String(projectNumber), '--owner', PROJECT_OWNER, '--format', 'json'],
    'listFields'
  );
  if (!listed.ok) return listed;
  return { ok: true, fields: (listed.data && listed.data.fields) || [] };
}

// pickSingleSelect(fields, projectNumber, fieldName, optionName) -- pure: finds `fieldName` among
// an already-read field-list payload and `optionName` among its options. Never hardcodes a field
// id or an option id (CLAUDE.md's "gh conventions" section) -- both come back out of that JSON,
// every call. The two failure shapes are distinguished ON PURPOSE and the caller acts on them
// differently: `missingField` means this board has never been given the field at all (an older
// board, or project 2 before Priority was added on 2026-09-12), which placeOnBoard tolerates for
// an OPTIONAL field; a missing OPTION means the field exists and the value asked for is not one
// of its values, which is a caller bug and always fails loudly.
function pickSingleSelect(fields, projectNumber, fieldName, optionName) {
  const field = (fields || []).find((f) => f.name === fieldName);
  if (!field || !field.id) {
    return {
      ok: false,
      missingField: true,
      error: `pickSingleSelect: project ${projectNumber} has no "${fieldName}" field`,
    };
  }
  const option = (field.options || []).find((o) => o.name === optionName);
  if (!option || !option.id) {
    return {
      ok: false,
      missingField: false,
      error: `pickSingleSelect: project ${projectNumber}'s "${fieldName}" field has no "${optionName}" option`,
    };
  }
  return { ok: true, fieldId: field.id, optionId: option.id };
}

// resolveIssueNodeId(deps, ghRepo, issueNumber) -- `gh issue view` (not `gh api`: no -f, nothing
// for test/gh-api-argv.test.js's guard to police) with `--json id` returns the issue's GraphQL
// node id, NOT the issue number -- `addProjectV2ItemById`'s `contentId` needs the former.
function resolveIssueNodeId(deps, ghRepo, issueNumber) {
  const viewed = runGhJson(
    deps,
    ['issue', 'view', String(issueNumber), '--repo', ghRepo, '--json', 'id'],
    'resolveIssueNodeId'
  );
  if (!viewed.ok) return viewed;
  const id = viewed.data && viewed.data.id;
  if (!id) return { ok: false, error: `resolveIssueNodeId: issue ${ghRepo}#${issueNumber} view carried no "id"` };
  return { ok: true, contentId: id };
}

// addItem(deps, projectId, contentId) -- `addProjectV2ItemById`. Board mutations have no CLI
// equivalent (CLAUDE.md) -- this is `gh api graphql`, exempt from the -f/POST guard because a
// graphql call is a POST by definition.
function addItem(deps, projectId, contentId) {
  const added = runGhJson(
    deps,
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}',
      '-f',
      `project=${projectId}`,
      '-f',
      `content=${contentId}`,
    ],
    'addItem'
  );
  if (!added.ok) return added;
  const itemId = added.data && added.data.data && added.data.data.addProjectV2ItemById && added.data.data.addProjectV2ItemById.item && added.data.data.addProjectV2ItemById.item.id;
  if (!itemId) return { ok: false, error: 'addItem: addProjectV2ItemById response carried no item id' };
  return { ok: true, itemId };
}

// setSingleSelect(deps, projectId, itemId, fieldId, optionId) -- `updateProjectV2ItemFieldValue`,
// the same mutation board.js's own header names as the CLI-less way to move a card. Field-agnostic
// by construction: the ids it writes are whatever pickSingleSelect resolved, so Status and
// Priority go through this one call site rather than two near-identical ones.
function setSingleSelect(deps, projectId, itemId, fieldId, optionId) {
  const updated = runGhJson(
    deps,
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}',
      '-f',
      `project=${projectId}`,
      '-f',
      `item=${itemId}`,
      '-f',
      `field=${fieldId}`,
      '-f',
      `option=${optionId}`,
    ],
    'setSingleSelect'
  );
  if (!updated.ok) return updated;
  return { ok: true };
}

// readBackSingleSelect(deps, itemId, fieldName) -- the verification step this whole module exists
// for: a fresh `gh api graphql` READ of the item's own `fieldName` field, not a re-derivation of
// what we just wrote and not a read of the list view (`gh project item-list`, which is what the
// maintainer would eyeball and the exact surface the empty-Status defect was invisible on).
// Returns the option NAME currently stored server-side, or null if the field genuinely carries no
// value. `fieldName` is a GraphQL VARIABLE, not interpolated into the query text -- the field name
// reaches this function from PRIORITY_FIELD_NAME/STATUS_FIELD_NAME below, but a query built by
// string concatenation is one refactor away from taking an attacker-shaped name.
function readBackSingleSelect(deps, itemId, fieldName) {
  const read = runGhJson(
    deps,
    [
      'api',
      'graphql',
      '-f',
      'query=query($item:ID!,$field:String!){node(id:$item){... on ProjectV2Item{fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}',
      '-f',
      `item=${itemId}`,
      '-f',
      `field=${fieldName}`,
    ],
    'readBackSingleSelect'
  );
  if (!read.ok) return read;
  const node = read.data && read.data.data && read.data.data.node;
  const name = node && node.fieldValueByName && node.fieldValueByName.name;
  return { ok: true, optionName: name || null };
}

// placeOnBoard(issueNumber, ghRepo, deps, opts) -- the whole sequence: resolve the project id,
// read the board's fields ONCE, resolve the issue's node id, add the item, set Status, set
// Priority, then READ EACH BACK FROM THE API and gate success on those reads. Any single step
// failing -- including a read-back that comes back empty or wrong -- is the whole call failing:
// {ok: false, error}. This function never throws and never partially succeeds silently; the
// caller (bin/spo's cmdAsk) is expected to print `error` to stderr and exit non-zero, because a
// card that fileCard filed but this function could not place is exactly the invisible-card
// failure this module exists to kill (see this file's header).
//
// `opts.priority` (one of VALID_PRIORITIES) is the card's criticity as a BOARD FIELD -- the whole
// point of action "Priority is a field, not a sentence" (2026-09-12). Before it, criticity was
// written as prose into the issue body ("**Severity: MEDIUM**", "**Criticity: HIGH**"), which no
// board view, no sort and no `gh` query can read: the maintainer's own 2026-09-11 criticity review
// had to open 18 issue bodies by hand to rank a column. Two failure modes, deliberately different:
//
//   - `opts.priority` omitted -> Priority is simply not written. Lets an older caller keep working
//     and keeps this an additive change.
//   - the BOARD has no `Priority` field -> skipped, reported in the return value as
//     `priorityName: null` + `prioritySkipped: true`, NOT a failure. Status is what makes a card
//     visible; a board that predates the field still gets a correctly-columned card rather than no
//     card at all. This is the same fail-open shape `fileCard` uses for a `cat:`/`size:` label the
//     target repo lacks (#196/#199) -- and the same reason: refusing to file over a missing piece
//     of taxonomy loses the card, which is strictly worse than filing it untagged.
//
// A priority the caller asked for that the field does not OFFER is not fail-open: it is a caller
// bug (a typo, or a vocabulary that drifted from the board's) and fails loudly, because silently
// filing a CRITICAL card as untriaged is the failure this field exists to prevent.
function placeOnBoard(issueNumber, ghRepo, deps = {}, opts = {}) {
  const projectNumber = projectNumberForRepo(ghRepo);
  if (!projectNumber) {
    return { ok: false, error: `placeOnBoard: no project mapped for repo "${ghRepo}"` };
  }

  const project = resolveProjectId(deps, projectNumber);
  if (!project.ok) return project;

  const listed = listFields(deps, projectNumber);
  if (!listed.ok) return listed;

  const statusField = pickSingleSelect(listed.fields, projectNumber, STATUS_FIELD_NAME, TARGET_STATUS_NAME);
  if (!statusField.ok) return { ok: false, error: statusField.error };

  // Resolved BEFORE anything is written, so a bad `opts.priority` costs no board mutation at all.
  let priorityField = null;
  const wantPriority = opts.priority !== undefined && opts.priority !== null && opts.priority !== '';
  if (wantPriority) {
    if (!VALID_PRIORITIES.has(opts.priority)) {
      return {
        ok: false,
        error: `placeOnBoard: unrecognized priority "${opts.priority}" -- expected one of ${[...VALID_PRIORITIES].join(', ')}`,
      };
    }
    const picked = pickSingleSelect(listed.fields, projectNumber, PRIORITY_FIELD_NAME, opts.priority);
    if (!picked.ok && !picked.missingField) return { ok: false, error: picked.error };
    priorityField = picked.ok ? picked : null; // null == the board has no Priority field: fail open
  }

  const issue = resolveIssueNodeId(deps, ghRepo, issueNumber);
  if (!issue.ok) return issue;

  const added = addItem(deps, project.projectId, issue.contentId);
  if (!added.ok) return added;

  const set = setSingleSelect(deps, project.projectId, added.itemId, statusField.fieldId, statusField.optionId);
  if (!set.ok) return set;

  const readBack = readBackSingleSelect(deps, added.itemId, STATUS_FIELD_NAME);
  if (!readBack.ok) return readBack;

  if (readBack.optionName !== TARGET_STATUS_NAME) {
    return {
      ok: false,
      error: `placeOnBoard: read back Status="${readBack.optionName || '(empty)'}" for item ${added.itemId}, expected "${TARGET_STATUS_NAME}" -- the card is on the board with no/wrong column and is effectively invisible`,
      itemId: added.itemId,
    };
  }

  let priorityName = null;
  if (priorityField) {
    const setPrio = setSingleSelect(deps, project.projectId, added.itemId, priorityField.fieldId, priorityField.optionId);
    if (!setPrio.ok) return { ...setPrio, itemId: added.itemId };

    // Read back for the same reason Status is: `updateProjectV2ItemFieldValue` returning the item
    // id proves the call was accepted, not that the value is what a maintainer will see.
    const readPrio = readBackSingleSelect(deps, added.itemId, PRIORITY_FIELD_NAME);
    if (!readPrio.ok) return { ...readPrio, itemId: added.itemId };
    if (readPrio.optionName !== opts.priority) {
      return {
        ok: false,
        error: `placeOnBoard: read back Priority="${readPrio.optionName || '(empty)'}" for item ${added.itemId}, expected "${opts.priority}"`,
        itemId: added.itemId,
      };
    }
    priorityName = readPrio.optionName;
  }

  return {
    ok: true,
    itemId: added.itemId,
    projectNumber,
    statusName: readBack.optionName,
    priorityName,
    prioritySkipped: wantPriority && !priorityField,
  };
}

module.exports = {
  PROJECT_NUMBER_BY_REPO,
  PROJECT_OWNER,
  STATUS_FIELD_NAME,
  TARGET_STATUS_NAME,
  PRIORITY_FIELD_NAME,
  VALID_PRIORITIES,
  projectNumberForRepo,
  placeOnBoard,
};
