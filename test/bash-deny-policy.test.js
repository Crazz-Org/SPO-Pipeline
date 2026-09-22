'use strict';
// bash-deny-policy.test.js -- card #240. Pins the per-policy `Bash` deny lists
// (orchestrator/bash-policy.js) against the corpus measurement that chose them, and pins the two
// things the card is not allowed to change: CITATION_VERIFIER's contract, and intake's `gh`/`curl`
// traffic.
//
// The MUST-ALLOW samples below are not invented. Every one is a verbatim `Bash` command from a
// real pool-account transcript (`~/.claude-accounts/pool{1,2}/projects/**/*.jsonl`, 13001 calls
// over 1379 step-classified sessions, 2026-08-29..2026-09-22), attributed to the policy whose
// prompt launched that session. A rule that starts denying one of them is a measured regression,
// not a style question.

require('./no-real-spawn'); // before the first orchestrator require -- see that file's header

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  BASH_DENY_HOST_CONTROL,
  BASH_DENY_TREE_WRITES,
  BASH_DENY_REMOTE_WRITES,
  READ_ONLY_STEP_BASH_DENY,
  WRITE_STEP_BASH_DENY,
  INTAKE_BASH_DENY,
} = require('../orchestrator/bash-policy');
const { STEP_CONTRACTS, resolveStepContract } = require('../orchestrator/step-contracts');
const { buildArgv } = require('../orchestrator/steps/llm');

const REPO_ROOT = path.join(__dirname, '..');

// ---- a matcher that mirrors what the CLI documents and what the corpus proved ---------------
//
// Two properties, both established before these lists were written (see bash-policy.js's header
// for the evidence):
//   - a `Bash(<prefix>*)` rule is a prefix pattern over a command, `*` matching anything;
//   - the check runs against the SUBCOMMANDS of a compound command, not the raw string, and any
//     denied subcommand denies the whole call. Three real IMPLEMENT calls in the corpus were
//     refused that way, one with the denied part in the middle of an `&&` chain, while bare `Bash`
//     was granted.
// This local matcher is deliberately independent of the CLI: it exists so the LISTS can be
// regression-tested offline, not to reimplement the CLI's parser.

function ruleToRegExp(rule) {
  assert.ok(rule.startsWith('Bash(') && rule.endsWith(')'), `not a Bash rule: ${rule}`);
  const pattern = rule.slice('Bash('.length, -1);
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${source}$`);
}

// Top-level segments of a shell command: split on newline, `;`, `&&`, `||` and `|`, never inside
// a quoted string (a `&&` inside `--body "a && b"` is text, not an operator).
function segmentsOf(command) {
  const out = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  // A leading `!`, `cd x &&` already split off above, and env assignments are left alone on
  // purpose: the CLI strips them itself, and none of these rules key on them.
  return out.map((s) => s.trim().replace(/^!\s*/, '')).filter(Boolean);
}

function deniedBy(list, command) {
  const regexps = list.map(ruleToRegExp);
  for (const segment of segmentsOf(command)) {
    for (let i = 0; i < regexps.length; i += 1) {
      if (regexps[i].test(segment)) return list[i];
    }
  }
  return null;
}

// ---- the measured corpus samples ------------------------------------------------------------

// Verbatim commands from the measured window that MUST keep working.
const MUST_ALLOW = {
  PLAN: [
    'npx jest src/client/store/mail-store.test.ts src/client/components/mail/MailPanel.test.tsx > /tmp/issue509-jest.log 2>&1',
    'npm run typecheck >/tmp/tc-521.log 2>&1',
    "gh api repos/Crazz-Org/SPO-WebClient/pulls/380 --jq '{state,merged,title,head:.head.ref}' 2>&1",
    'ls doc/ && echo "---" && git log --oneline -3',
    'cd /home/crazz/.spo-worktrees/issue-530; ! grep -rn "1=quality" src/server/session/politics-handler.ts',
    'gh issue view 518 --json title,body -R Crazz-Org/SPO-WebClient 2>/dev/null',
    'git merge-base HEAD origin/main',
    'git branch -a --contains a8c62b05',
    'timeout 300 npx jest src/server/session/newspaper-handler.test.ts',
  ],
  DIAGNOSE: [
    'gh api --method GET repos/Crazz-Org/SPO-WebClient/actions/jobs/100853224571/logs 2>&1',
    'gh run view 33273333753 --repo Crazz-Org/SPO-WebClient --log-failed 2>&1',
    'systemctl --user list-units --all 2>/dev/null',
    'journalctl --user -u spo-pipeline-daemon.service --no-pager 2>/dev/null',
    'git stash list',
    'git branch -vv',
    'git merge-base --is-ancestor 4f2eb09e b254625a',
    'cd /home/crazz/.spo-state/journal/issue-518 && tail -c 2500 logs/CHECK.log | cat -A | tail -20',
    'npm audit',
  ],
  VALIDATE: [
    'git merge-tree --write-tree --name-only main HEAD',
    'git branch --show-current',
    'gh issue view 613 --repo Crazz-Org/SPO-WebClient --json title,body 2>/dev/null',
    'gh pr list --repo Crazz-Org/SPO-WebClient --search "888" --state all --json number,title',
    'cd /home/crazz/.spo-worktrees/issue-553 && git show --stat HEAD | head -20 && git diff 204f6206 HEAD --stat',
    'ln=$(grep -n "function TRegMultiString.GetValue" file.pas | cut -d: -f1)',
  ],
  IMPLEMENT: [
    'git status --porcelain',
    'npm run typecheck 2>&1 | tail -30; echo "TYPECHECK_RC=$?"',
    'rm src/server/__debug_parse.test.ts',
    'cp /tmp/parse.test.ts src/server/__debug_parse.test.ts',
    'git add -A',
    'git commit -q -m "wip: banks parsing (temporary)"',
    'git stash push -u -m "issue-607-precheck-tmp"',
    'git reset --soft HEAD~1',
    'mkdir -p /tmp/debugtest',
    'chmod +x /home/crazz/SPO-Deploy/deploy.sh',
    'gh pr create --repo Crazz-Org/SPO-Deploy --title "feat: populate deploy.sh" --body "body && more"',
    'ssh-keygen -t ed25519 -C "spo-bench@host" -f ~/.ssh/spo-bench -N ""',
    'npx jest src/server/session/mail-handler.test.ts -t "system mail page" 2>&1',
  ],
  INTAKE: [
    'gh issue list --repo Crazz-Org/SPO-WebClient --state open --limit 100 --json number,title,labels',
    'gh issue list --repo Crazz-Org/SPO-WebClient --state all --search "anchorKey: a072c0f3 in:body" --json number',
    'gh issue view 874 --repo Crazz-Org/SPO-WebClient --json title,body',
    "gh api repos/Crazz-Org/SPO-WebClient/pulls/447 --jq '{state,merged,merged_at,closed_at,title}'",
    'gh pr view 444 --repo Crazz-Org/SPO-Pipeline --json title,state 2>&1',
    'gh project item-list 1 --owner Crazz-Org --limit 200 --format json 2>/dev/null',
    'gh search issues --repo Crazz-Org/SPO-WebClient "be887c3c" --json number,title,state',
    'gh label list --repo Crazz-Org/SPO-WebClient',
    'curl -s --connect-timeout 5 --max-time 20 "http://158.69.153.134/logs/FIVEMODELSERVER/Survival.log" -o /tmp/s.log',
    'git branch -a --contains d4612ef2 2>/dev/null',
    'git -C /home/crazz/SPO-WebClient log --oneline -15 -- src/client/layouts/LoginScreen.module.css',
    'grep -rn "topbar-height" --include=*.css --include=*.ts src/ | head -40',
    "sed -n '150,165p' ~/SPO-Pipeline/orchestrator/steps/scripted.js 2>&1",
    'git show origin/main:CLAUDE.md | sed -n \'10,18p\' | cat -n',
  ],
};

const LIST_FOR = {
  PLAN: READ_ONLY_STEP_BASH_DENY,
  DIAGNOSE: READ_ONLY_STEP_BASH_DENY,
  VALIDATE: READ_ONLY_STEP_BASH_DENY,
  IMPLEMENT: WRITE_STEP_BASH_DENY,
  INTAKE: INTAKE_BASH_DENY,
};

test('every deny list leaves the measured, verbatim traffic of its own policies alone', () => {
  const offenders = [];
  for (const [policy, commands] of Object.entries(MUST_ALLOW)) {
    for (const command of commands) {
      const rule = deniedBy(LIST_FOR[policy], command);
      if (rule) offenders.push(`${policy}: ${rule} would deny a real measured call -- ${command}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A deny rule now blocks traffic the corpus shows the policy actually makes. Either the rule is ' +
      'wrong, or the measurement that justified it has to be redone and recorded first.'
  );
});

test('the read-only steps are denied the writes the corpus caught them making', () => {
  // PLAN made both of these from inside permissionMode 'plan', which blocks Edit/Write but not a
  // write made through the shell -- the finding that chose this list. Verbatim from the corpus.
  for (const command of [
    'cp /tmp/te-probe.test.tsx src/client/report/__te_probe.test.tsx',
    'rm -rf "$TMPD/bench" "$TMPD/paths.js"',
  ]) {
    assert.ok(deniedBy(READ_ONLY_STEP_BASH_DENY, command), `not denied for a read-only step: ${command}`);
    assert.equal(
      deniedBy(WRITE_STEP_BASH_DENY, command),
      null,
      `IMPLEMENT must stay free to do this -- it is the one policy whose contract is to write: ${command}`
    );
  }
});

test('a deny fires on a subcommand in the middle of a compound command', () => {
  // The exact corpus command whose refusal proved deny beats the bare `Bash` allow AND runs per
  // subcommand ("Permission to use Bash with command ... has been denied"), except keyed on a
  // rule from THIS card's lists rather than settings.json's.
  const command = 'git status --porcelain && git reset --hard 3fa2a115 && git log --oneline -5 && git status --porcelain';
  assert.equal(deniedBy(READ_ONLY_STEP_BASH_DENY, command), 'Bash(git reset*)');
  // ... and it is not the first segment that matched.
  assert.equal(deniedBy(READ_ONLY_STEP_BASH_DENY, 'git status --porcelain'), null);
});

test('quoted operators are text, not subcommands -- a denied verb inside a --body string does not deny the call', () => {
  const command = 'gh pr create --repo Crazz-Org/SPO-Deploy --title "x" --body "run: sudo rm -rf /tmp/x"';
  assert.equal(deniedBy(WRITE_STEP_BASH_DENY, command), null);
  // The real thing, unquoted, is denied for every policy.
  assert.ok(deniedBy(WRITE_STEP_BASH_DENY, 'sudo rm -rf /tmp/x'));
});

test('intake is denied the write surface of the live product checkout it runs in', () => {
  const mustDeny = [
    'gh issue create --repo Crazz-Org/SPO-WebClient --title "x" --body "y"',
    'gh issue edit 874 --repo Crazz-Org/SPO-WebClient --add-label bug',
    'gh issue comment 874 --body "triaged"',
    'gh pr merge 425 --repo Crazz-Org/SPO-WebClient --squash',
    'gh project item-edit --id X --field-id Y --project-id Z',
    'gh api repos/Crazz-Org/SPO-WebClient/issues/874 -X PATCH -f state=closed',
    "gh api graphql -f query='mutation { updateProjectV2ItemFieldValue }'",
    'git commit -am "intake fix"',
    'git checkout -b intake-tmp',
    'git push origin main',
    'rm -rf /home/crazz/SPO-WebClient/src',
    'cd /home/crazz/SPO-WebClient && git reset --hard origin/main',
    'npm install some-package',
    'npx jest',
    'bin/spo ask "file this"',
    'sudo systemctl --user stop spo-pipeline-daemon',
  ];
  const missed = mustDeny.filter((c) => !deniedBy(INTAKE_BASH_DENY, c));
  assert.deepEqual(missed, [], 'intake deny list no longer covers these');
});

test('the host/daemon control surface is denied for every policy that holds Bash, IMPLEMENT included', () => {
  for (const command of [
    'sudo rm -rf /',
    'bin/spo park 123 --reason x',
    './bin/spo ask "hello"',
    'spo status',
    'crontab -e',
    'ssh user@host "rm -rf /"',
    'shutdown -h now',
  ]) {
    for (const [policy, list] of Object.entries(LIST_FOR)) {
      assert.ok(deniedBy(list, command), `${policy} does not deny: ${command}`);
    }
  }
});

// ---- the two things this card may not change ------------------------------------------------

test("CITATION_VERIFIER's contract is untouched: no Bash, and no --disallowedTools in its argv", () => {
  assert.deepEqual(STEP_CONTRACTS.CITATION_VERIFIER.allowedTools, ['Read', 'Grep']);
  assert.equal(STEP_CONTRACTS.CITATION_VERIFIER.disallowedTools, undefined);

  const contract = resolveStepContract('CITATION_VERIFIER', {});
  assert.equal(contract.disallowedTools, undefined);
  const argv = buildArgv({
    promptText: 'x',
    model: contract.model,
    effort: contract.effort,
    allowedTools: contract.allowedTools,
    disallowedTools: contract.disallowedTools,
    permissionMode: contract.permissionMode,
  });
  assert.equal(argv.includes('--disallowedTools'), false);
  assert.deepEqual(argv, [
    '-p',
    '--model',
    contract.model,
    '--effort',
    contract.effort,
    '--output-format',
    'json',
    '--allowedTools',
    'Read Grep',
    '--permission-mode',
    'default',
  ]);
});

test('bare `Bash` is still what the other seven policies grant -- this card denied, it did not rescope', () => {
  // Recorded deliberately: rescoping `allowedTools` was measured and rejected (only 42.6% of the
  // 13001 measured calls have every subcommand covered by settings.json's 92 rules). If a future
  // change drops bare `Bash` from a contract, that measurement has to be redone first.
  for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']) {
    assert.ok(STEP_CONTRACTS[step].allowedTools.includes('Bash'), `${step} no longer grants Bash`);
    assert.ok(
      Array.isArray(STEP_CONTRACTS[step].disallowedTools) && STEP_CONTRACTS[step].disallowedTools.length > 0,
      `${step} carries no disallowedTools`
    );
  }
});

test('all three intake policies carry INTAKE_BASH_DENY, alongside their unchanged bare `Bash`', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator', 'intake.js'), 'utf8');
  // One per call site: draftCard, reviewCard, triageBugReport.
  const grants = src.match(/allowedTools:\s*\['Read', 'Grep', 'Glob', 'Bash'\]/g) || [];
  assert.equal(grants.length, 3, 'expected exactly three intake allowedTools grants');
  const denies = src.match(/\bdisallowedTools:\s*INTAKE_BASH_DENY\b/g) || [];
  assert.equal(denies.length, 3, 'every intake call site must pass INTAKE_BASH_DENY');
});

// ---- argv plumbing ---------------------------------------------------------------------------

test('buildArgv: --disallowedTools is space-joined and sits between --allowedTools and --permission-mode', () => {
  const argv = buildArgv({
    promptText: 'x',
    model: 'sonnet',
    effort: 'medium',
    allowedTools: ['Read', 'Bash'],
    disallowedTools: ['Bash(git reset*)', 'Bash(sudo *)'],
    permissionMode: 'default',
  });
  assert.deepEqual(argv, [
    '-p',
    '--model',
    'sonnet',
    '--effort',
    'medium',
    '--output-format',
    'json',
    '--allowedTools',
    'Read Bash',
    '--disallowedTools',
    'Bash(git reset*) Bash(sudo *)',
    '--permission-mode',
    'default',
  ]);
});

test('buildArgv: an absent or empty disallowedTools omits the flag entirely', () => {
  for (const value of [undefined, [], '']) {
    const argv = buildArgv({ promptText: 'x', model: 'sonnet', effort: 'medium', disallowedTools: value });
    assert.equal(argv.includes('--disallowedTools'), false, `flag emitted for ${JSON.stringify(value)}`);
  }
});

// ---- list composition -------------------------------------------------------------------------

test('the three composed lists are exactly their stated parts, and every entry is a Bash rule', () => {
  assert.deepEqual(READ_ONLY_STEP_BASH_DENY, [...BASH_DENY_HOST_CONTROL, ...BASH_DENY_TREE_WRITES]);
  assert.deepEqual(WRITE_STEP_BASH_DENY, [...BASH_DENY_HOST_CONTROL]);
  assert.deepEqual(INTAKE_BASH_DENY, [
    ...BASH_DENY_HOST_CONTROL,
    ...BASH_DENY_TREE_WRITES,
    ...BASH_DENY_REMOTE_WRITES,
  ]);
  for (const list of [READ_ONLY_STEP_BASH_DENY, WRITE_STEP_BASH_DENY, INTAKE_BASH_DENY]) {
    assert.ok(Object.isFrozen(list));
    for (const rule of list) {
      assert.match(rule, /^Bash\([^)]+\)$/, `not a well-formed Bash rule: ${rule}`);
    }
    assert.equal(new Set(list).size, list.length, 'duplicate rule in a composed list');
  }
});

test('the 14 rules .claude/settings.json already denies are NOT duplicated here -- it stays the single source', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const shared = settings.permissions.deny.filter((r) => r.startsWith('Bash('));
  const mine = new Set(INTAKE_BASH_DENY);
  const duplicated = shared.filter((r) => mine.has(r));
  assert.deepEqual(
    duplicated,
    [],
    'These rules already reach every pool account through `spo account sync-settings` ' +
      '(doc/permissions.md § The account layer). Repeating them here forks the policy.'
  );
});
