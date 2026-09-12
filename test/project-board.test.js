'use strict';
// Unit tests for orchestrator/project-board.js -- action 184/185's board-placement half. Every
// `gh` call is injected via deps.spawnSync (same convention as test/intake.test.js); no real
// `gh` process is ever spawned, so nothing here touches a live GitHub project.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js. Must land before the orchestrator require below.
require('./no-real-spawn');

const projectBoard = require('../orchestrator/project-board');

function fakeSpawnSync(responder) {
  return (command, args, opts) => responder(command, args, opts);
}

function ok(stdoutObj) {
  return { status: 0, stdout: JSON.stringify(stdoutObj), stderr: '', signal: null };
}

// Deliberately non-obvious ids -- CLAUDE.md/the card spec: "make the fake return non-obvious ids
// so a hardcoded id cannot pass". If placeOnBoard ever hardcodes a field/option/project id, these
// tests fail the moment the fixture's ids stop matching whatever constant got baked in.
const FAKE_PROJECT_ID = 'PVT_ZZZ_not_the_real_project_9f2c';
const FAKE_STATUS_FIELD_ID = 'PVTSSF_ZZZ_status_field_7a01';
const FAKE_TODO_OPTION_ID = 'opt_ZZZ_todo_3e91';
const FAKE_OTHER_OPTION_ID = 'opt_ZZZ_other_1b22';
const FAKE_ISSUE_NODE_ID = 'I_ZZZ_issue_node_c001';
const FAKE_ITEM_ID = 'PVTI_ZZZ_item_dead22';
const FAKE_PRIORITY_FIELD_ID = 'PVTSSF_ZZZ_priority_field_4d70';
const FAKE_PRIORITY_OPTION_IDS = {
  Urgent: 'opt_ZZZ_urgent_8a11',
  High: 'opt_ZZZ_high_5c42',
  Medium: 'opt_ZZZ_med_2f93',
  Low: 'opt_ZZZ_low_0e64',
};

function graphqlVar(args, name) {
  const prefix = `${name}=`;
  const hit = args.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

// buildHappyPathSpawn(opts) -- a dispatcher covering every gh call placeOnBoard makes on a fully
// successful run: project view, field-list, issue view, addProjectV2ItemById, the Status
// mutation, and the read-back query. `calls` records every invocation (command+args) for
// assertions on ordering / argv shape / call counts.
// `withPriorityField` adds a `Priority` single-select to the field-list payload -- default false
// so the older tests keep exercising a board that does NOT have the field (the project-1 world,
// and project 2 before 2026-09-12). `readBackPriority` defaults to echoing whatever was written,
// which is what a healthy server does; a test that needs a divergent read passes it explicitly.
function buildHappyPathSpawn({
  readBackStatus = 'Todo',
  withPriorityField = false,
  readBackPriority = undefined,
} = {}) {
  let lastPriorityOptionId = null;
  const calls = [];
  const spawnSync = fakeSpawnSync((command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== 'gh') return { status: 1, stdout: '', stderr: 'unexpected command', signal: null };

    if (args[0] === 'project' && args[1] === 'view') {
      return ok({ id: FAKE_PROJECT_ID, number: 2 });
    }
    if (args[0] === 'project' && args[1] === 'field-list') {
      return ok({
        fields: [
          { id: 'PVTF_title', name: 'Title', type: 'ProjectV2Field' },
          {
            id: FAKE_STATUS_FIELD_ID,
            name: 'Status',
            type: 'ProjectV2SingleSelectField',
            options: [
              { id: FAKE_TODO_OPTION_ID, name: 'Todo' },
              { id: FAKE_OTHER_OPTION_ID, name: 'In progress' },
            ],
          },
          ...(withPriorityField
            ? [
                {
                  id: FAKE_PRIORITY_FIELD_ID,
                  name: 'Priority',
                  type: 'ProjectV2SingleSelectField',
                  options: Object.entries(FAKE_PRIORITY_OPTION_IDS).map(([name, id]) => ({ id, name })),
                },
              ]
            : []),
        ],
      });
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return ok({ id: FAKE_ISSUE_NODE_ID });
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = graphqlVar(args, 'query');
      if (query.includes('addProjectV2ItemById')) {
        assert.equal(graphqlVar(args, 'project'), FAKE_PROJECT_ID);
        assert.equal(graphqlVar(args, 'content'), FAKE_ISSUE_NODE_ID);
        return ok({ data: { addProjectV2ItemById: { item: { id: FAKE_ITEM_ID } } } });
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        assert.equal(graphqlVar(args, 'project'), FAKE_PROJECT_ID);
        assert.equal(graphqlVar(args, 'item'), FAKE_ITEM_ID);
        const fieldId = graphqlVar(args, 'field');
        // The ids are resolved per field, never hardcoded -- assert the pairing, so a Status
        // option id written into the Priority field (or vice versa) fails here.
        if (fieldId === FAKE_STATUS_FIELD_ID) {
          assert.equal(graphqlVar(args, 'option'), FAKE_TODO_OPTION_ID);
        } else {
          assert.equal(fieldId, FAKE_PRIORITY_FIELD_ID);
          lastPriorityOptionId = graphqlVar(args, 'option');
          assert.ok(
            Object.values(FAKE_PRIORITY_OPTION_IDS).includes(lastPriorityOptionId),
            `Priority mutation wrote an option id no Priority option carries: ${lastPriorityOptionId}`
          );
        }
        return ok({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: FAKE_ITEM_ID } } } });
      }
      if (query.includes('fieldValueByName')) {
        assert.equal(graphqlVar(args, 'item'), FAKE_ITEM_ID);
        // The read-back names the field it is reading -- a variable, not baked into the query.
        const fieldName = graphqlVar(args, 'field');
        assert.ok(fieldName === 'Status' || fieldName === 'Priority', `unexpected read-back field: ${fieldName}`);
        if (fieldName === 'Priority') {
          const echoed =
            readBackPriority !== undefined
              ? readBackPriority
              : Object.keys(FAKE_PRIORITY_OPTION_IDS).find((n) => FAKE_PRIORITY_OPTION_IDS[n] === lastPriorityOptionId);
          return ok({ data: { node: { fieldValueByName: echoed ? { name: echoed } : null } } });
        }
        return ok({
          data: { node: { fieldValueByName: readBackStatus ? { name: readBackStatus } : null } },
        });
      }
    }
    return { status: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}`, signal: null };
  });
  return { spawnSync, calls };
}

test('projectNumberForRepo: SPO-Pipeline and SPO-Deploy map to project 2, SPO-WebClient maps to nothing', () => {
  assert.equal(projectBoard.projectNumberForRepo('Crazz-Org/SPO-Pipeline'), 2);
  assert.equal(projectBoard.projectNumberForRepo('Crazz-Org/SPO-Deploy'), 2);
  assert.equal(projectBoard.projectNumberForRepo('Crazz-Org/SPO-WebClient'), null);
  assert.equal(projectBoard.projectNumberForRepo('Crazz-Org/SomeOtherRepo'), null);
});

// action 184/185, post-verification fix F4: GitHub owner/repo names are case-insensitive -- `gh`
// really does file `crazz-org/spo-pipeline` into Crazz-Org/SPO-Pipeline -- but the OLD
// `PROJECT_NUMBER_BY_REPO[ghRepo]` bare lookup only matched the one canonical casing baked into
// that table's keys, so a validly-filed differently-cased --repo made this function report "no
// project mapped" and cmdAsk skipped placeOnBoard entirely: a real issue, on the real repo, on NO
// board -- the exact invisible-card defect this whole module exists to kill, just reached through
// the mapping lookup instead of through a `gh` failure.
test('projectNumberForRepo: is case-insensitive -- a differently-cased but validly-mapped repo still resolves its project number', () => {
  assert.equal(projectBoard.projectNumberForRepo('crazz-org/spo-pipeline'), 2);
  assert.equal(projectBoard.projectNumberForRepo('CRAZZ-ORG/SPO-PIPELINE'), 2);
  assert.equal(projectBoard.projectNumberForRepo('Crazz-Org/spo-deploy'), 2);
  // An unmapped repo stays unmapped regardless of casing -- this is not "match anything".
  assert.equal(projectBoard.projectNumberForRepo('crazz-org/spo-webclient'), null);
  assert.equal(projectBoard.projectNumberForRepo('crazz-org/some-other-repo'), null);
});

test('placeOnBoard: a lowercase --repo resolves the same project 2 as the canonical casing, and the `gh` calls carry the repo string AS TYPED (not force-cased)', () => {
  const { spawnSync, calls } = buildHappyPathSpawn();
  const result = projectBoard.placeOnBoard(501, 'crazz-org/spo-pipeline', { spawnSync });

  assert.equal(result.ok, true);
  assert.equal(result.projectNumber, 2);
  assert.equal(result.statusName, 'Todo');

  const projectViewCall = calls.find((c) => c.args[0] === 'project' && c.args[1] === 'view');
  assert.ok(projectViewCall);
  assert.equal(projectViewCall.args[2], '2');

  // resolveIssueNodeId's own `gh issue view --repo <ghRepo>` gets exactly what the caller passed
  // -- this module resolves the PROJECT case-insensitively, it never rewrites what `gh` itself
  // sees (GitHub's own API is already case-insensitive on that end).
  const issueViewCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'view');
  assert.ok(issueViewCall);
  assert.equal(issueViewCall.args[issueViewCall.args.indexOf('--repo') + 1], 'crazz-org/spo-pipeline');
});

test('placeOnBoard: happy path adds the item, sets Status using ids resolved from field-list, and reads it back', () => {
  const { spawnSync, calls } = buildHappyPathSpawn();
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });

  assert.equal(result.ok, true);
  assert.equal(result.itemId, FAKE_ITEM_ID);
  assert.equal(result.statusName, 'Todo');

  // The read-back actually happened -- not inferred from the write succeeding.
  const readBackCalls = calls.filter(
    (c) => c.command === 'gh' && c.args[0] === 'api' && c.args.some((a) => typeof a === 'string' && a.includes('fieldValueByName'))
  );
  assert.equal(readBackCalls.length, 1);

  // view -> field-list -> issue view -> add -> set -> read-back, in that order.
  function shapeOf(c) {
    if (c.args[0] !== 'api') return `${c.args[0]} ${c.args[1]}`;
    const query = graphqlVar(c.args, 'query');
    if (query.includes('addProjectV2ItemById')) return 'graphql add';
    if (query.includes('updateProjectV2ItemFieldValue')) return 'graphql set';
    if (query.includes('fieldValueByName')) return 'graphql read-back';
    return 'graphql ???';
  }
  assert.deepEqual(calls.map(shapeOf), [
    'project view',
    'project field-list',
    'issue view',
    'graphql add',
    'graphql set',
    'graphql read-back',
  ]);
});

test('placeOnBoard: an empty read-back is a failure, not a silent success', () => {
  const { spawnSync } = buildHappyPathSpawn({ readBackStatus: null });
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /read back Status="\(empty\)"/);
  assert.match(result.error, /invisible/);
});

test('placeOnBoard: a read-back that resolves to the WRONG status is a failure', () => {
  const { spawnSync } = buildHappyPathSpawn({ readBackStatus: 'In progress' });
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /read back Status="In progress"/);
});

test('placeOnBoard: a non-zero exit on `gh project view` fails loudly and never reaches the mutation calls', () => {
  const calls = [];
  const spawnSync = fakeSpawnSync((command, args) => {
    calls.push(args);
    return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found', signal: null };
  });
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited 1/);
  assert.equal(calls.length, 1, 'must stop at the first failing gh call, never proceed to add/set/read-back');
});

test('placeOnBoard: a repo with no project mapping refuses without spawning anything', () => {
  const spawnSync = fakeSpawnSync(() => {
    throw new Error('must not spawn for an unmapped repo');
  });
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-WebClient', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /no project mapped/);
});

test('placeOnBoard: a missing Status option in field-list is a clean failure, not a thrown exception', () => {
  const spawnSync = fakeSpawnSync((command, args) => {
    if (args[0] === 'project' && args[1] === 'view') return ok({ id: FAKE_PROJECT_ID });
    if (args[0] === 'project' && args[1] === 'field-list') {
      return ok({ fields: [{ id: FAKE_STATUS_FIELD_ID, name: 'Status', options: [{ id: 'x', name: 'Done' }] }] });
    }
    return { status: 1, stdout: '', stderr: 'unreached', signal: null };
  });
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /no "Todo" option/);
});

test('placeOnBoard: malformed JSON from gh is a clean failure, not a thrown exception', () => {
  const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: 'not json{{', stderr: '', signal: null }));
  const result = projectBoard.placeOnBoard(501, 'Crazz-Org/SPO-Pipeline', { spawnSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not parse gh's JSON output/);
});

// --- Priority as a FIELD (2026-09-12) -------------------------------------------------------
// Criticity used to be prose in the issue body ("**Severity: MEDIUM**"), which no board view can
// sort on. These tests pin that placeOnBoard writes it to the board's own `Priority` single-select
// and PROVES the write by reading it back, exactly as it already did for Status.

test('placeOnBoard: writes Priority to the board field with ids resolved from field-list, and reads it back', () => {
  const { spawnSync, calls } = buildHappyPathSpawn({ withPriorityField: true });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: 'High' });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.statusName, 'Todo');
  assert.equal(result.priorityName, 'High');
  assert.equal(result.prioritySkipped, false);

  // The option id actually written is the one the fixture's field-list carries for HIGH -- so a
  // hardcoded option id, or the MEDIUM id, fails here rather than silently mis-filing the card.
  const priorityMutation = calls.find(
    (c) =>
      c.args[0] === 'api' &&
      c.args[1] === 'graphql' &&
      graphqlVar(c.args, 'query').includes('updateProjectV2ItemFieldValue') &&
      graphqlVar(c.args, 'field') === FAKE_PRIORITY_FIELD_ID
  );
  assert.ok(priorityMutation, 'no updateProjectV2ItemFieldValue call targeted the Priority field');
  assert.equal(graphqlVar(priorityMutation.args, 'option'), FAKE_PRIORITY_OPTION_IDS.High);

  // One field-list read for BOTH fields -- not one per field.
  const fieldLists = calls.filter((c) => c.args[0] === 'project' && c.args[1] === 'field-list');
  assert.equal(fieldLists.length, 1);
});

test('placeOnBoard: each priority word resolves to its OWN option id -- the fixture cannot pass by echoing one constant', () => {
  for (const word of ['Urgent', 'High', 'Medium', 'Low']) {
    const { spawnSync, calls } = buildHappyPathSpawn({ withPriorityField: true });
    const result = projectBoard.placeOnBoard(1, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: word });
    assert.equal(result.ok, true, `${word}: ${result.error}`);
    assert.equal(result.priorityName, word);
    const mutation = calls.find(
      (c) =>
        c.args[0] === 'api' &&
        c.args[1] === 'graphql' &&
        graphqlVar(c.args, 'query').includes('updateProjectV2ItemFieldValue') &&
        graphqlVar(c.args, 'field') === FAKE_PRIORITY_FIELD_ID
    );
    assert.equal(graphqlVar(mutation.args, 'option'), FAKE_PRIORITY_OPTION_IDS[word], `${word} wrote the wrong option id`);
  }
});

test('placeOnBoard: a board with no Priority field still files the card -- skipped, reported, not a failure', () => {
  const { spawnSync, calls } = buildHappyPathSpawn({ withPriorityField: false });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: 'Urgent' });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.statusName, 'Todo', 'the card must still land in a column');
  assert.equal(result.priorityName, null);
  assert.equal(result.prioritySkipped, true, 'the caller must be able to tell the priority was dropped');

  // Fail-open means NOTHING was written to a Priority field, not that a write was attempted and
  // swallowed: exactly one updateProjectV2ItemFieldValue call, and it is the Status one.
  const mutations = calls.filter(
    (c) => c.args[0] === 'api' && c.args[1] === 'graphql' && graphqlVar(c.args, 'query').includes('updateProjectV2ItemFieldValue')
  );
  assert.equal(mutations.length, 1);
  assert.equal(graphqlVar(mutations[0].args, 'field'), FAKE_STATUS_FIELD_ID);
});

test('placeOnBoard: a priority word the vocabulary does not know fails loudly BEFORE any board mutation', () => {
  const { spawnSync, calls } = buildHappyPathSpawn({ withPriorityField: true });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: 'P0' });

  assert.equal(result.ok, false);
  assert.match(result.error, /unrecognized priority "P0"/);
  // Nothing was added and nothing was written -- a typo must not leave a half-placed card behind.
  assert.equal(calls.filter((c) => graphqlVar(c.args, 'query') || '').filter((c) => (graphqlVar(c.args, 'query') || '').includes('addProjectV2ItemById')).length, 0);
  assert.equal(calls.filter((c) => (graphqlVar(c.args, 'query') || '').includes('updateProjectV2ItemFieldValue')).length, 0);
});

test('placeOnBoard: a Priority read-back that disagrees with what was written is a failure, not a silent success', () => {
  const { spawnSync } = buildHappyPathSpawn({ withPriorityField: true, readBackPriority: 'Low' });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: 'Urgent' });

  assert.equal(result.ok, false);
  assert.match(result.error, /read back Priority="Low".*expected "Urgent"/);
  assert.equal(result.itemId, FAKE_ITEM_ID, 'the caller needs the item id to repair the half-placed card');
});

test('placeOnBoard: an EMPTY Priority read-back is a failure -- the same invisible-field defect Status guards against', () => {
  const { spawnSync } = buildHappyPathSpawn({ withPriorityField: true, readBackPriority: null });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync }, { priority: 'Medium' });

  assert.equal(result.ok, false);
  assert.match(result.error, /read back Priority="\(empty\)"/);
});

test('placeOnBoard: no priority asked for -- the older 3-arg call is unchanged and writes no Priority', () => {
  const { spawnSync, calls } = buildHappyPathSpawn({ withPriorityField: true });
  const result = projectBoard.placeOnBoard(207, 'Crazz-Org/SPO-Pipeline', { spawnSync });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.priorityName, null);
  assert.equal(result.prioritySkipped, false, 'nothing was asked for, so nothing was skipped');
  const mutations = calls.filter(
    (c) => (graphqlVar(c.args, 'query') || '').includes('updateProjectV2ItemFieldValue')
  );
  assert.equal(mutations.length, 1);
  assert.equal(graphqlVar(mutations[0].args, 'field'), FAKE_STATUS_FIELD_ID);
});

test("VALID_PRIORITIES is GitHub's own built-in Priority vocabulary, and DECISION is deliberately not in it", () => {
  // GitHub Projects' own built-in Priority options, spelled and ORDERED exactly as the platform
  // ships them. A house re-spelling (`CRITICAL`, `P0`) is what this assertion exists to refuse.
  assert.deepEqual([...projectBoard.VALID_PRIORITIES], ['Urgent', 'High', 'Medium', 'Low']);
  assert.equal(projectBoard.VALID_PRIORITIES.has('DECISION'), false);
  assert.equal(projectBoard.VALID_PRIORITIES.has('CRITICAL'), false, 'the pre-correction house vocabulary must not creep back');
  assert.equal(projectBoard.VALID_PRIORITIES.has('URGENT'), false, 'the spelling is case-exact at the contract boundary');
  assert.equal(projectBoard.PRIORITY_FIELD_NAME, 'Priority');
});
