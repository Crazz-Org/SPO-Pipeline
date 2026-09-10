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
const TARGET_STATUS_NAME = 'Todo';

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

// resolveStatusField(deps, projectNumber, statusName) -- reads `gh project field-list <n>
// --owner Crazz-Org --format json`, finds the `Status` field, and finds `statusName` among its
// options. Never hardcodes a field id or an option id (CLAUDE.md's "gh conventions" section) --
// both come back out of this JSON, every call.
function resolveStatusField(deps, projectNumber, statusName) {
  const listed = runGhJson(
    deps,
    ['project', 'field-list', String(projectNumber), '--owner', PROJECT_OWNER, '--format', 'json'],
    'resolveStatusField'
  );
  if (!listed.ok) return listed;
  const fields = (listed.data && listed.data.fields) || [];
  const statusField = fields.find((f) => f.name === 'Status');
  if (!statusField || !statusField.id) {
    return { ok: false, error: `resolveStatusField: project ${projectNumber} has no "Status" field` };
  }
  const options = statusField.options || [];
  const option = options.find((o) => o.name === statusName);
  if (!option || !option.id) {
    return {
      ok: false,
      error: `resolveStatusField: project ${projectNumber}'s "Status" field has no "${statusName}" option`,
    };
  }
  return { ok: true, fieldId: statusField.id, optionId: option.id };
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

// setStatus(deps, projectId, itemId, fieldId, optionId) -- `updateProjectV2ItemFieldValue`, the
// same mutation board.js's own header names as the CLI-less way to move a card.
function setStatus(deps, projectId, itemId, fieldId, optionId) {
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
    'setStatus'
  );
  if (!updated.ok) return updated;
  return { ok: true };
}

// readBackStatus(deps, itemId) -- the verification step this whole module exists for: a fresh
// `gh api graphql` READ of the item's own `Status` field, not a re-derivation of what we just
// wrote and not a read of the list view (`gh project item-list`, which is what the maintainer
// would eyeball and the exact surface the empty-Status defect was invisible on). Returns the
// option NAME currently stored server-side, or null if the field genuinely carries no value.
function readBackStatus(deps, itemId) {
  const read = runGhJson(
    deps,
    [
      'api',
      'graphql',
      '-f',
      'query=query($item:ID!){node(id:$item){... on ProjectV2Item{fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}',
      '-f',
      `item=${itemId}`,
    ],
    'readBackStatus'
  );
  if (!read.ok) return read;
  const node = read.data && read.data.data && read.data.data.node;
  const name = node && node.fieldValueByName && node.fieldValueByName.name;
  return { ok: true, statusName: name || null };
}

// placeOnBoard(issueNumber, ghRepo, deps) -- the whole sequence: resolve the project id, resolve
// the Status field/option ids, resolve the issue's node id, add the item, set Status, then READ
// STATUS BACK FROM THE API and gate success on that read matching TARGET_STATUS_NAME. Any single
// step failing -- including a read-back that comes back empty or wrong -- is the whole call
// failing: {ok: false, error}. This function never throws and never partially succeeds silently;
// the caller (bin/spo's cmdAsk) is expected to print `error` to stderr and exit non-zero, because
// a card that fileCard filed but this function could not place is exactly the invisible-card
// failure this module exists to kill (see this file's header).
function placeOnBoard(issueNumber, ghRepo, deps = {}) {
  const projectNumber = projectNumberForRepo(ghRepo);
  if (!projectNumber) {
    return { ok: false, error: `placeOnBoard: no project mapped for repo "${ghRepo}"` };
  }

  const project = resolveProjectId(deps, projectNumber);
  if (!project.ok) return project;

  const field = resolveStatusField(deps, projectNumber, TARGET_STATUS_NAME);
  if (!field.ok) return field;

  const issue = resolveIssueNodeId(deps, ghRepo, issueNumber);
  if (!issue.ok) return issue;

  const added = addItem(deps, project.projectId, issue.contentId);
  if (!added.ok) return added;

  const set = setStatus(deps, project.projectId, added.itemId, field.fieldId, field.optionId);
  if (!set.ok) return set;

  const readBack = readBackStatus(deps, added.itemId);
  if (!readBack.ok) return readBack;

  if (readBack.statusName !== TARGET_STATUS_NAME) {
    return {
      ok: false,
      error: `placeOnBoard: read back Status="${readBack.statusName || '(empty)'}" for item ${added.itemId}, expected "${TARGET_STATUS_NAME}" -- the card is on the board with no/wrong column and is effectively invisible`,
      itemId: added.itemId,
    };
  }

  return { ok: true, itemId: added.itemId, projectNumber, statusName: readBack.statusName };
}

module.exports = {
  PROJECT_NUMBER_BY_REPO,
  PROJECT_OWNER,
  TARGET_STATUS_NAME,
  projectNumberForRepo,
  placeOnBoard,
};
