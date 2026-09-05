'use strict';

/**
 * scripts/git-hooks/post-merge -- the deploy.
 *
 * This hook *is* the deployment mechanism for the daemon and the dashboard: `git pull`
 * fires it, and it restarts the units so they pick up the merged code. Nothing else does.
 *
 * The defect it carries a test for now: the hook gated on `systemctl is-enabled`, which
 * answers "does this unit start at boot" -- not "is a process running this repo's code".
 * A unit can be active and disabled at once, and on 2026-09-03
 * `spo-pipeline-daemon.service` was exactly that. Every pull printed nothing about it,
 * looked like a deploy, and left the daemon on pre-merge code for a working day. The
 * failure mode is the worst available: silent, and indistinguishable from success.
 *
 * Hermetic -- a fake `systemctl` on PATH. Nothing here touches the real units.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Overridable so the suite can be pointed at an older copy of the hook and made to fail
// on purpose -- a test that has never been seen failing proves nothing about the fix.
const HOOK =
  process.env.SPO_POST_MERGE_HOOK ||
  path.join(__dirname, '..', 'scripts', 'git-hooks', 'post-merge');

const DAEMON = 'spo-pipeline-daemon.service';
const DASHBOARD = 'spo-pipeline-dashboard.service';

/**
 * Run the hook against a fake systemd.
 *
 * `installed`, `active` and `enabled` are unit-name lists; they are independent on purpose,
 * because in the real world they are -- that independence is the whole bug.
 */
function runHook({ installed = [], active = [], enabled = [], restartFails = [], states = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-post-merge-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');

  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
# Drops the leading flags, then dispatches on the verb. --no-block is dropped here the same
# way --user is, and RECORDED separately below: the hook must pass it on a restart (a daemon
# stop drains in-flight cards, up to 45 min, and without it that wait lands on the
# maintainer's terminal in the middle of a git pull), so a test that merely tolerated it
# would let the flag be dropped again in silence.
args=()
noblock=no
for a in "$@"; do
  case "$a" in
    --user) ;;
    --no-block) noblock=yes ;;
    *) args+=("$a") ;;
  esac
done
verb="\${args[0]:-}"
unit="\${args[1]:-}"
echo "$verb $unit noblock=$noblock" >> ${JSON.stringify(log)}
contains() { case " $1 " in *" $2 "*) return 0;; esac; return 1; }
case "$verb" in
  list-unit-files) contains ${JSON.stringify(installed.join(' '))} "$unit" ;;
  is-active)       if contains ${JSON.stringify(active.join(' '))} "$unit"; then echo active; exit 0; fi
                   for pair in ${JSON.stringify(Object.entries(states).map(([u, st]) => `${u}:${st}`).join(' '))}; do
                     if [ "\${pair%%:*}" = "$unit" ]; then echo "\${pair#*:}"; exit 3; fi
                   done
                   echo inactive; exit 3 ;;
  is-enabled)      contains ${JSON.stringify(enabled.join(' '))} "$unit" ;;
  restart)         contains ${JSON.stringify(restartFails.join(' '))} "$unit" && exit 1; exit 0 ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );

  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('bash', [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = String(err.stdout ?? '');
  }

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const restartCalls = calls.filter(l => l.startsWith('restart '));
  const restarted = restartCalls.map(l => l.split(' ')[1]);
  const restartedBlocking = restartCalls.filter(l => l.endsWith('noblock=no')).map(l => l.split(' ')[1]);
  return { restarted, restartedBlocking, calls, stdout, status };
}

test('restarts a unit that is running but disabled -- the 2026-09-03 deploy hole', () => {
  // Precisely the state measured on the box: active=active, enabled=disabled. Under the
  // old `is-enabled` gate this restarted nothing at all, and said nothing about it.
  const r = runHook({ installed: [DAEMON], active: [DAEMON], enabled: [] });
  assert.deepStrictEqual(r.restarted, [DAEMON]);
  assert.strictEqual(r.status, 0);
});

test('says which unit it restarted and why, so a pull that deploys looks different from one that does not', () => {
  const r = runHook({ installed: [DAEMON], active: [DAEMON], enabled: [] });
  assert.match(r.stdout, new RegExp(`restarting ${DAEMON.replace('.', '\\.')}`));
  assert.match(r.stdout, /running/);
});

test('still restarts an enabled unit that is not running -- restart starts it', () => {
  const r = runHook({ installed: [DAEMON], active: [], enabled: [DAEMON] });
  assert.deepStrictEqual(r.restarted, [DAEMON]);
  assert.match(r.stdout, /enabled/);
});

test('restarts an active and enabled unit exactly once', () => {
  const r = runHook({ installed: [DAEMON], active: [DAEMON], enabled: [DAEMON] });
  assert.deepStrictEqual(r.restarted, [DAEMON]);
});

test('leaves a unit that is installed but neither running nor enabled alone', () => {
  // Nothing is executing stale code, and starting it here would deploy a service nobody
  // asked for. Doing nothing is the correct deploy.
  const r = runHook({ installed: [DAEMON], active: [], enabled: [] });
  assert.deepStrictEqual(r.restarted, []);
  assert.strictEqual(r.status, 0);
});

test('skips a unit that was never installed, without an error on every pull', () => {
  const r = runHook({ installed: [], active: [], enabled: [] });
  assert.deepStrictEqual(r.restarted, []);
  assert.strictEqual(r.status, 0);
  assert.ok(
    !r.calls.some(l => l.startsWith('is-active') || l.startsWith('is-enabled')),
    'a unit that does not exist is not interrogated further',
  );
});

test('handles the two units independently -- one being absent does not skip the other', () => {
  const r = runHook({ installed: [DASHBOARD], active: [DASHBOARD], enabled: [] });
  assert.deepStrictEqual(r.restarted, [DASHBOARD]);
});

test('restarts both when both are running, whatever their enabled state', () => {
  const r = runHook({
    installed: [DAEMON, DASHBOARD],
    active: [DAEMON, DASHBOARD],
    enabled: [DASHBOARD],
  });
  assert.deepStrictEqual(r.restarted.sort(), [DAEMON, DASHBOARD].sort());
});

test('a failed restart does not abort the hook, so the second unit still deploys', () => {
  // `set -e` is on; the `|| echo` is what keeps one bad unit from silently cancelling the
  // rest of the deploy.
  const r = runHook({
    installed: [DAEMON, DASHBOARD],
    active: [DAEMON, DASHBOARD],
    enabled: [],
    restartFails: [DAEMON],
  });
  assert.deepStrictEqual(r.restarted.sort(), [DAEMON, DASHBOARD].sort());
  assert.strictEqual(r.status, 0);
});

test('covers both pipeline units -- adding a third service must not be silently undeployed', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  const listed = /for unit in ([^;]+);/.exec(source);
  assert.ok(listed, 'the hook still iterates an explicit unit list');
  assert.deepStrictEqual(listed[1].trim().split(/\s+/).sort(), [DAEMON, DASHBOARD].sort());
});

test('never gates on is-enabled alone -- that is the defect, and it must not come back', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  const guard = source.split('\n').filter(l => l.includes('systemctl') && l.includes('is-'));
  assert.ok(
    guard.some(l => l.includes('is-active')),
    'the hook asks whether the unit is running, not only whether it starts at boot',
  );
});

test('a restart is --no-block, so a draining daemon does not hold up the pull', () => {
  // Since the drain landed, `systemctl restart` waits for the stop, and a stop legitimately
  // takes as long as the in-flight cards do -- up to config.js's drainTimeoutMs (45 min).
  // Without --no-block that wait happens inside `git pull`. The deploy is asynchronous either
  // way; this only decides whether the maintainer's terminal is held hostage by it.
  const r = runHook({ installed: [DAEMON, DASHBOARD], active: [DAEMON, DASHBOARD], enabled: [] });
  assert.deepStrictEqual(r.restarted, [DAEMON, DASHBOARD]);
  assert.deepStrictEqual(r.restartedBlocking, [], 'a restart was issued without --no-block');
});

test('an installed-but-stopped unit is skipped OUT LOUD, not in silence', () => {
  // The state the daemon was in on 2026-09-05: stopped on purpose (and, before the
  // SuccessExitStatus fix, `failed` on every deliberate stop). Skipping it is correct --
  // nothing is running stale code. Saying nothing about it is not: the pull then printed a
  // dashboard restart and looked exactly like a deploy that had covered both units.
  const r = runHook({ installed: [DAEMON, DASHBOARD], active: [DASHBOARD], enabled: [DASHBOARD] });
  assert.deepStrictEqual(r.restarted, [DASHBOARD]);
  assert.match(r.stdout, new RegExp(`SKIPPING ${DAEMON.replace('.', '\\.')}`));
  assert.strictEqual(r.status, 0);
});

test('a unit still DRAINING is reported as already in flight, not skipped', () => {
  // Since the drain landed, a stop legitimately takes up to TimeoutStopSec=2820 and the unit sits
  // in `deactivating` for the whole of it. `is-active` exits non-zero for that state, so the old
  // gate read it as "neither active nor enabled" and skipped -- during a window that used to be
  // 90s and is now the better part of an hour. It is not a skip: a restart is already queued
  // behind the stop, and its start execs from WorkingDirectory, so it picks up this merge too.
  const r = runHook({ installed: [DAEMON], active: [], enabled: [], states: { [DAEMON]: 'deactivating' } });
  assert.deepStrictEqual(r.restarted, []);
  assert.match(r.stdout, /deactivating -- a restart is already in flight/);
  assert.doesNotMatch(r.stdout, /SKIPPING/);
  assert.strictEqual(r.status, 0);
});

test('an inactive unit is still skipped out loud -- deactivating is the only new case', () => {
  const r = runHook({ installed: [DAEMON], active: [], enabled: [], states: { [DAEMON]: 'inactive' } });
  assert.deepStrictEqual(r.restarted, []);
  assert.match(r.stdout, new RegExp(`SKIPPING ${DAEMON.replace('.', '\\.')}`));
});
