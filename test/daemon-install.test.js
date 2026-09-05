'use strict';
// Tests for the systemd unit scripts/daemon-install.sh writes.
//
// WHY THIS FILE EXISTS: a systemd directive in the wrong SECTION is not an error, it is a
// WARNING on a line nobody reads, and the unit then runs with the default in place of the value
// the script thought it set. C6 verification caught exactly that, and the box's own journal is
// the evidence:
//
//   systemd[243]: /home/crazz/.config/systemd/user/spo-pipeline-daemon.service:14:
//                 Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
//
// with `systemctl --user show spo-pipeline-daemon.service` reporting
// `StartLimitIntervalUSec=10s` -- systemd's DEFAULT, not the 300s the file specified.
// StartLimitIntervalSec/StartLimitBurst are [Unit] directives (systemd 229+); they had been sitting
// in [Service] since the unit was written.
//
// The consequence is not cosmetic. `Restart=always` with `RestartSec=5` restarts a crash-looping
// daemon every ~5 seconds, so at most ~2 restarts ever land inside a 10-second window and the
// burst of 5 is never reached: the rate limiter the script's own comment promises ("five tries in
// five minutes then stop, instead of looping on a config error forever") did not exist, and a
// genuine config error looped forever. Since C6 that matters more than it did: each restart can
// park up to workerCrashLimit (3) cards before its circuit breaker trips, so an unbounded restart
// loop is an unbounded PARK loop against live cards.
//
// Hermetic on purpose: it parses the unit template out of the shell script rather than shelling
// out to `systemd-analyze verify`, so it runs identically on a box with no systemd. The A/B
// against the real tool was done once, by hand, and agrees -- systemd warns on the pre-fix unit
// and is silent on this one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SH = path.join(__dirname, '..', 'scripts', 'daemon-install.sh');

// The unit template is the body of the `cat > "$UNIT" <<UNITEOF ... UNITEOF` heredoc.
function unitTemplate() {
  const src = fs.readFileSync(INSTALL_SH, 'utf8');
  const start = src.indexOf('<<UNITEOF\n');
  assert.ok(start !== -1, 'daemon-install.sh no longer writes a UNITEOF heredoc -- this test is reading the wrong thing');
  const body = src.slice(start + '<<UNITEOF\n'.length);
  const end = body.indexOf('\nUNITEOF\n');
  assert.ok(end !== -1, 'unterminated UNITEOF heredoc');
  return body.slice(0, end);
}

// Minimal systemd INI sectioniser: {SectionName: [directive lines]}. Comments and blanks dropped,
// which is what systemd itself does before it decides a key is unknown for its section.
function sections(text) {
  const out = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1];
      out[current] = out[current] || [];
      continue;
    }
    if (current) out[current].push(line);
  }
  return out;
}

function keysOf(lines) {
  return lines.map((l) => l.split('=')[0]);
}

test('daemon-install.sh: the restart rate limit is in [Unit], where systemd actually reads it', () => {
  const parsed = sections(unitTemplate());
  assert.ok(parsed.Unit, 'no [Unit] section');
  assert.ok(parsed.Service, 'no [Service] section');

  const unitKeys = keysOf(parsed.Unit);
  const serviceKeys = keysOf(parsed.Service);

  for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
    assert.ok(
      unitKeys.includes(key),
      `${key} must be in [Unit] -- in [Service] systemd logs "Unknown key name ... ignoring" and silently uses its own default`
    );
    assert.ok(
      !serviceKeys.includes(key),
      `${key} is in [Service], where systemd ignores it: the unit then runs with the DEFAULT 10s window, not the value written here`
    );
  }
});

test('daemon-install.sh: the rate limit is the one that actually bounds Restart=always', () => {
  const parsed = sections(unitTemplate());
  const kv = (lines, key) => {
    const hit = lines.find((l) => l.startsWith(`${key}=`));
    return hit ? hit.slice(key.length + 1) : null;
  };

  // Restart=always is what makes the limit load-bearing at all: without a working limit, a
  // refuse-to-start (empty account pool, held lock) loops forever.
  assert.equal(kv(parsed.Service, 'Restart'), 'always');

  const restartSec = Number(kv(parsed.Service, 'RestartSec'));
  const windowSec = Number(kv(parsed.Unit, 'StartLimitIntervalSec'));
  const burst = Number(kv(parsed.Unit, 'StartLimitBurst'));
  assert.ok(Number.isFinite(restartSec) && restartSec > 0, 'RestartSec must be a positive number of seconds');
  assert.ok(Number.isFinite(windowSec) && windowSec > 0);
  assert.ok(Number.isFinite(burst) && burst > 0);

  // The relationship that has to hold for the limit to ever TRIP: the window must be long enough
  // to actually contain `burst` restarts spaced RestartSec apart. This is precisely what the
  // ignored-directive default broke -- a 10s window against RestartSec=5 fits ~2 restarts, so a
  // burst of 5 was unreachable and the daemon looped forever on a permanent config error.
  assert.ok(
    windowSec >= burst * restartSec,
    `a ${windowSec}s window cannot contain ${burst} restarts spaced ${restartSec}s apart -- ` +
      'the burst is unreachable and Restart=always never stops'
  );
});

// ---- the unit must not reach into the tree a human edits ------------------------------------

test('nothing in the generated unit points into the source checkout -- only the release symlink', () => {
  const body = unitTemplate();
  // `$REPO` is the DEV checkout: edited, pulled, and mutated under the running service. Any path
  // the unit derives from it is a live code path still coupled to that tree, which is the one
  // thing the immutable-release layout exists to remove -- and it is easy to reintroduce, because
  // every line here used to read that way. SPO_PARK_ALERT_CMD did, and was missed until a deploy
  // was already half-run: the daemon would have spawned a park-alert script out of a tree anyone
  // could edit while it ran.
  const offenders = body
    .split('\n')
    // A comment that MENTIONS $REPO is prose explaining why the directives below do not use it --
    // systemd ignores those lines entirely, and flagging them is the same false positive the
    // heredoc/backtick guard first produced.
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => l.includes('$REPO'))
    .map((l) => l.trim());
  assert.deepEqual(
    offenders,
    [],
    'unit line(s) derived from the source checkout rather than $CURRENT_LINK:\n  ' + offenders.join('\n  ')
  );

  // And the two that matter positively, so this cannot pass by the unit becoming empty.
  const parsed = sections(body);
  assert.ok(parsed.Service.some((l) => l.startsWith('WorkingDirectory=') && l.includes('CURRENT_LINK')));
  assert.ok(parsed.Service.some((l) => l.startsWith('ExecStart=') && l.includes('CURRENT_LINK')));
});

// ---- the drain's two systemd halves -------------------------------------------------------------

test('daemon-install.sh: a deliberate stop is not a failure -- SuccessExitStatus covers 143 and 130', () => {
  const parsed = sections(unitTemplate());
  const hit = parsed.Service.find((l) => l.startsWith('SuccessExitStatus='));
  assert.ok(hit, 'no SuccessExitStatus -- every deliberate stop leaves this unit `failed`');
  const codes = hit.slice('SuccessExitStatus='.length).trim().split(/\s+/);
  // daemon.js's handlers exit 143 on SIGTERM and 130 on SIGINT once a drain's bound expires or a
  // second signal arrives. Without these, `systemctl stop` leaves ActiveState=failed -- measured
  // on this box on 2026-09-05 (ExecMainStatus=143, Result=exit-code, UnitFileState=disabled) --
  // and scripts/git-hooks/post-merge, which gates on `is-active OR is-enabled`, then skips the
  // unit on the next pull. Silently, before the same change taught it to say so.
  assert.ok(codes.includes('143'), 'SIGTERM (143) is not declared a success exit');
  assert.ok(codes.includes('130'), 'SIGINT (130) is not declared a success exit');
});

test('daemon-install.sh: TimeoutStopSec leaves room for the whole drain, or the drain is deleted', () => {
  const parsed = sections(unitTemplate());
  const hit = parsed.Service.find((l) => l.startsWith('TimeoutStopSec='));
  assert.ok(hit, 'no TimeoutStopSec -- systemd defaults to 90s and SIGKILLs the drain at 1m30s');
  const stopSec = Number(hit.slice('TimeoutStopSec='.length));
  assert.ok(Number.isFinite(stopSec) && stopSec > 0, 'TimeoutStopSec must be a positive number of seconds');

  // The number is read out of config.js's SOURCE TEXT, not required from it: recomputing an
  // expectation from the value under test pins nothing (test/doc-constant-sweep.test.js's own
  // lesson, paid for twice in this repo). If the default is ever expressed differently this
  // assertion fails loudly rather than silently checking a `null`.
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'config.js'), 'utf8');
  const m = /SPO_DRAIN_TIMEOUT_MS[\s\S]{0,160}?:\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+);/.exec(configSrc);
  assert.ok(m, 'config.js no longer states the drain default as `N * N * N` -- update this guard');
  const drainSec = (Number(m[1]) * Number(m[2]) * Number(m[3])) / 1000;
  const g = /SPO_DRAIN_KILL_GRACE_MS[\s\S]{0,160}?:\s*(\d+)\s*\*\s*(\d+);/.exec(configSrc);
  assert.ok(g, 'config.js no longer states the kill-grace default as `N * N` -- update this guard');
  const graceSec = (Number(g[1]) * Number(g[2])) / 1000;

  // systemd SIGKILLs the whole cgroup when this expires. A SIGKILL is strictly WORSE than the
  // SIGTERM the drain replaced -- no park, no worktree WIP preserved, recovery deferred to the
  // next start's orphanScan -- so a stop timeout below the drain bound does not shorten the
  // drain, it deletes it and replaces a bad outcome with a worse one.
  // `>= drainSec` ALONE IS NOT THE PROPERTY, and pinning only that was a real hole: it passed with
  // TimeoutStopSec exactly equal to the bound, i.e. ZERO time for the daemon to signal its
  // stragglers, let them finish dying, escalate to SIGKILL and exit. That is the half of the drain
  // that keeps the lock released and the parks written, and it would have been deleted silently.
  assert.ok(
    stopSec >= drainSec + graceSec,
    `TimeoutStopSec=${stopSec}s leaves no room for the ${graceSec}s kill grace after the ${drainSec}s bound: ` +
      'systemd would SIGKILL the cgroup while the daemon was still shutting down cleanly'
  );
  // And a named slack on top, so the reap and process exit are not racing the ceiling either.
  assert.ok(
    stopSec >= drainSec + graceSec + 30,
    `TimeoutStopSec=${stopSec}s has under 30s of slack above drain (${drainSec}s) + grace (${graceSec}s)`
  );
});

// ---- the heredoc is UNQUOTED, and that is a live hazard, not a style note ------------------------

test('daemon-install.sh: the unit heredoc contains no command substitution', () => {
  const body = unitTemplate();
  // `cat > "$UNIT" <<UNITEOF` is deliberately unquoted -- it must expand $REPO, $NODE_BIN and
  // $HOME. That also makes every unescaped backtick pair and every $(...) a COMMAND that runs at
  // install time and pastes its output into the generated unit. This is not hypothetical: a
  // comment reading "and `systemctl --user show` reported ..." ran `systemctl --user show` and
  // spliced several hundred lines of manager properties into the [Service] section. It went
  // unnoticed only because the installer had not been re-run since that comment was added.
  const backticks = body.split('\n').filter((l) => /(^|[^\\])`/.test(l));
  assert.deepEqual(backticks, [], 'unescaped backtick(s) in the unit heredoc -- command substitution at install time');
  const dollarParen = body.split('\n').filter((l) => /(^|[^\\])\$\(/.test(l));
  assert.deepEqual(dollarParen, [], 'unescaped $(...) in the unit heredoc -- command substitution at install time');
});
