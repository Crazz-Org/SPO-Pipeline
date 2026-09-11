'use strict';
// Tests for the systemd units scripts/daemon-install.sh and scripts/dashboard-install.sh write.
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
// in [Service] since the unit was written. scripts/dashboard-install.sh's unit had the identical
// bug (card #194) -- fixed the same way, and pinned below by the same assertions run against
// EVERY discovered installer, not a second copy of this file.
//
// The consequence is not cosmetic. `Restart=always` with `RestartSec=5` restarts a crash-looping
// service every ~5 seconds, so at most ~2 restarts ever land inside a 10-second window and the
// burst of 5 is never reached: the rate limiter the script's own comment promises ("five tries in
// five minutes then stop, instead of looping on a config error forever") did not exist, and a
// genuine config error looped forever. Since C6 that matters more than it did for the daemon: each
// restart can park up to workerCrashLimit (3) cards before its circuit breaker trips, so an
// unbounded restart loop is an unbounded PARK loop against live cards.
//
// Hermetic on purpose: it parses the unit template out of the shell script rather than shelling
// out to `systemd-analyze verify`, so it runs identically on a box with no systemd. The A/B
// against the real tool was done once, by hand, and agrees -- systemd warns on the pre-fix unit
// and is silent on this one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const DAEMON_INSTALL_SH = path.join(SCRIPTS_DIR, 'daemon-install.sh');

// Recursively list every file under `dir`, any extension -- discovery below must not assume a
// unit writer stays flat in scripts/, stays a *.sh file, or stays a shell script at all.
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

// A `[Service]` section-header LINE (whitespace either side allowed, nothing else on the line) --
// the same test systemd itself applies once it has sectionised a unit file.
const SERVICE_HEADER_LINE = /^[ \t]*\[Service\][ \t]*$/m;

// A checked-in *.service file: the unit IS the file, not a heredoc inside it. `.timer`/`.socket`/
// `.path` units have no [Service] section of their own (they reference a paired *.service instead),
// so they never trigger discovery and are deliberately not listed here.
const UNIT_FILE_RE = /\.service$/;

// Every heredoc body in `src`, for any opener spelling: `<<MARKER`, `<< MARKER`, `<<'MARKER'`,
// `<<"MARKER"`, `<<-MARKER` (tab-stripped closing line). Returns ALL of them, not just the first --
// a script with an unrelated heredoc ABOVE its unit one, or two units in two heredocs, must not
// have the one that matters go silently unread. An opener sitting on a `#` COMMENT line (e.g. a
// shell comment that happens to mention `<<UNITEOF` in prose, above the real code) is skipped
// entirely -- otherwise its "body" spans from the comment down to the real heredoc's terminator,
// swallowing real code as if it were unit text and misreading the section it lands in.
function heredocBodies(src) {
  const bodies = [];
  const open = /<<(-?)[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n/g;
  let m;
  while ((m = open.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index - 1) + 1;
    const line = src.slice(lineStart, m.index + m[0].length).replace(/\n$/, '');
    if (/^[ \t]*#/.test(line)) continue; // opener is inside a comment, not real code
    const [, dash, , marker] = m;
    const rest = src.slice(m.index + m[0].length);
    const term = new RegExp(`^${dash ? '\\t*' : ''}${marker}$`, 'm').exec(rest);
    if (!term) continue;
    bodies.push(rest.slice(0, term.index).replace(/\n$/, ''));
    open.lastIndex = m.index + m[0].length + term.index + term[0].length;
  }
  return bodies;
}

// Every heredoc body in `src` that itself carries a [Service] header -- the candidate unit bodies
// inside one file, before that file is decided to be a writer or not, or a checked-in unit file's
// own text if it IS one (see UNIT_FILE_RE).
function unitBodiesIn(src, file) {
  if (UNIT_FILE_RE.test(file)) return [src];
  return heredocBodies(src).filter((b) => SERVICE_HEADER_LINE.test(b));
}

// The unit template for a SPECIFIC installer script: the (single) body it writes that carries a
// [Service] header -- not "the first heredoc in the file", which would read an unrelated heredoc
// if one were ever added ahead of the unit's.
function unitTemplate(installSh) {
  const src = fs.readFileSync(installSh, 'utf8');
  const bodies = unitBodiesIn(src, installSh);
  assert.ok(
    bodies.length > 0,
    `${path.basename(installSh)}: no heredoc body (or checked-in unit file) carrying a [Service] header -- this test is reading the wrong thing`
  );
  assert.equal(
    bodies.length,
    1,
    `${path.basename(installSh)}: expected exactly one [Service]-bearing unit body, found ${bodies.length} -- this helper cannot pick one for you`
  );
  return bodies[0];
}

// Discover every unit writer under scripts/ (recursive, any extension) BY CONSTRUCTION, and fail
// CLOSED rather than open: a file is a unit writer the instant any of its NON-COMMENT lines
// mentions `[Service]` -- this catches a `printf`/`echo`-built unit too, not only a heredoc one.
// From there:
//   - a `*.service` file IS a unit body (checked-in, not generated);
//   - anything else has EVERY heredoc body extracted (any marker, any opener spelling, a `<<-`
//     tab-stripped close honoured), keeping the ones that carry a `[Service]` header line;
//   - a file that triggered (mentions `[Service]`) but yields NO such body is `unrecognized`:
//     reported as a failure rather than silently dropped, so a writer this rule cannot parse
//     (e.g. one that builds the unit with `printf`) cannot pass by vanishing from the set.
// Four ways a weaker discovery rule (first-heredoc, *.sh-only, flat scripts/, no-space `<<MARKER`
// only) can go silently green on a fake unit writer it cannot see: a second heredoc, an
// `<< UNITEOF` opener with a space, an installer under scripts/units/, and a checked-in .service
// file copied by `cp`. This rule closes all four.
function discoverUnitInstallers() {
  const found = [];
  const unrecognized = [];
  for (const file of walk(SCRIPTS_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const triggers = src.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes('[Service]'));
    if (!triggers) continue;
    const name = path.relative(SCRIPTS_DIR, file);
    const bodies = unitBodiesIn(src, file);
    if (bodies.length === 0) {
      unrecognized.push(name);
      continue;
    }
    bodies.forEach((body, i) => {
      found.push({ name: bodies.length > 1 ? `${name}#${i + 1}` : name, file, body });
    });
  }
  return { found, unrecognized };
}

// The two StartLimit directives fail differently when misplaced, and the assertion messages must
// say so truthfully (systemd 255, systemd-analyze --user verify: `StartLimitBurst=abc` in
// [Service] gives "Failed to parse unsigned value, ignoring: abc"; `StartLimitIntervalSec=abc`
// gives "Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring."):
// StartLimitIntervalSec in [Service] is a genuinely UNKNOWN key there and is dropped with a
// logged warning. StartLimitBurst in [Service] is NOT unknown -- it is still parsed as a pre-229
// compat alias, silently, with no warning at all -- so StartLimitBurst in [Service] does take
// effect. The 10s-default failure needs StartLimitIntervalSec outside [Unit] (in [Service],
// where it is dropped, or missing altogether), and both cases are reported by the
// StartLimitIntervalSec assertions, which run first; the StartLimitBurst assertion is placement
// hygiene that keeps the pair together.
const KEY_MESSAGES = {
  StartLimitIntervalSec: {
    mustBeInUnit: (name) =>
      `${name}: StartLimitIntervalSec must be in [Unit] -- in [Service] systemd logs "Unknown key name ... ignoring" and silently uses its own 10s default`,
    mustNotBeInService: (name) =>
      `${name}: StartLimitIntervalSec is in [Service], where systemd logs "Unknown key name ... ignoring" and drops it: the unit then runs with the DEFAULT 10s window, not the value written here`,
  },
  StartLimitBurst: {
    mustBeInUnit: (name) =>
      `${name}: StartLimitBurst must be in [Unit], beside StartLimitIntervalSec -- systemd still parses it in [Service] as a pre-229 compat alias (no warning), but StartLimitIntervalSec has no such alias there; keep the pair together in [Unit], not one move away from the "Unknown key name ... ignoring" 10s-default trap`,
    mustNotBeInService: (name) =>
      `${name}: StartLimitBurst is in [Service] -- systemd accepts it there only as a pre-229 compat alias (no warning); it takes effect, but its partner StartLimitIntervalSec does not, so the pair belongs together in [Unit]`,
  },
};

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

// ---- discovery itself is pinned: a set that silently loses an installer must fail loudly --------

const { found: DISCOVERED_UNITS, unrecognized: UNRECOGNIZED_UNIT_WRITERS } = discoverUnitInstallers();

test('unit-installer discovery finds both known installers', () => {
  const names = DISCOVERED_UNITS.map((i) => i.name);
  assert.ok(
    names.includes('daemon-install.sh'),
    `discovery did not find daemon-install.sh under scripts/ (found: ${names.join(', ') || '(none)'})`
  );
  assert.ok(
    names.includes('dashboard-install.sh'),
    `discovery did not find dashboard-install.sh under scripts/ (found: ${names.join(', ') || '(none)'})`
  );
});

test('every scripts/ file mentioning [Service] yields an extractable unit body', () => {
  assert.deepEqual(
    UNRECOGNIZED_UNIT_WRITERS,
    [],
    UNRECOGNIZED_UNIT_WRITERS.map((u) => `unrecognized unit writer: ${u}`).join('\n  ')
  );
});

// ---- the StartLimit placement pin, run against EVERY discovered unit body -------------------------

for (const installer of DISCOVERED_UNITS) {
  test(`${installer.name}: the restart rate limit is in [Unit], where systemd actually reads it`, () => {
    const parsed = sections(installer.body);
    assert.ok(parsed.Unit, `${installer.name}: no [Unit] section`);
    assert.ok(parsed.Service, `${installer.name}: no [Service] section`);

    const unitKeys = keysOf(parsed.Unit);
    const serviceKeys = keysOf(parsed.Service);

    for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
      assert.ok(unitKeys.includes(key), KEY_MESSAGES[key].mustBeInUnit(installer.name));
      assert.ok(!serviceKeys.includes(key), KEY_MESSAGES[key].mustNotBeInService(installer.name));
    }
  });

  test(`${installer.name}: the rate limit is the one that actually bounds Restart=always`, () => {
    const parsed = sections(installer.body);
    const kv = (lines, key) => {
      const hit = lines.find((l) => l.startsWith(`${key}=`));
      return hit ? hit.slice(key.length + 1) : null;
    };

    // Restart=always is what makes the limit load-bearing at all: without a working limit, a
    // refuse-to-start (empty account pool, held lock; port already bound) loops forever.
    assert.equal(kv(parsed.Service, 'Restart'), 'always', `${installer.name}: Restart must be 'always'`);

    const restartSec = Number(kv(parsed.Service, 'RestartSec'));
    const windowSec = Number(kv(parsed.Unit, 'StartLimitIntervalSec'));
    const burst = Number(kv(parsed.Unit, 'StartLimitBurst'));
    assert.ok(Number.isFinite(restartSec) && restartSec > 0, `${installer.name}: RestartSec must be a positive number of seconds`);
    assert.ok(Number.isFinite(windowSec) && windowSec > 0, `${installer.name}: StartLimitIntervalSec must be a positive number of seconds`);
    assert.ok(Number.isFinite(burst) && burst > 0, `${installer.name}: StartLimitBurst must be a positive number`);

    // The relationship that has to hold for the limit to ever TRIP: the window must be long enough
    // to actually contain `burst` restarts spaced RestartSec apart. This is precisely what the
    // ignored-directive default broke -- a 10s window against RestartSec=5 fits ~2 restarts, so a
    // burst of 5 was unreachable and the service looped forever on a permanent config error.
    assert.ok(
      windowSec >= burst * restartSec,
      `${installer.name}: a ${windowSec}s window cannot contain ${burst} restarts spaced ${restartSec}s apart -- ` +
        'the burst is unreachable and Restart=always never stops'
    );
  });
}

// ---- the unit must not reach into the tree a human edits ------------------------------------

test('nothing in the generated unit points into the source checkout -- only the release symlink', () => {
  const body = unitTemplate(DAEMON_INSTALL_SH);
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

test('daemon-install.sh: KillMode=mixed, or the drain is silently defeated by systemd', () => {
  const parsed = sections(unitTemplate(DAEMON_INSTALL_SH));
  const hit = parsed.Service.find((l) => l.startsWith('KillMode='));
  assert.ok(hit, 'no KillMode -- systemd defaults to control-group and SIGTERMs every worker too');
  assert.equal(hit, 'KillMode=mixed');

  // WHY THIS IS PINNED HERE AND NOT PROVEN BY THE DRAIN TESTS. Under the default
  // (control-group), `systemctl stop` signals EVERY process in the cgroup -- the dispatcher, each
  // worker, and each worker's `claude`/`npm` child. The dispatcher then drains correctly and
  // reports "every in-flight card finished" while those cards were killed by the same signal
  // milliseconds earlier. Measured in production on the first real stop after the drain shipped
  // (2026-09-05 12:19): a clean 357ms drain, and both in-flight cards parked
  // `llm-transport-failed:PLAN` from a `claude` that exited 143.
  //
  // Every test in test/drain.test.js signals the daemon PROCESS -- `daemon.kill('SIGTERM')` --
  // which is mixed-mode semantics, so they were green throughout. The unit file is part of the
  // behaviour; testing the function is not testing the deployment.
});

test('daemon-install.sh: a deliberate stop is not a failure -- SuccessExitStatus covers 143 and 130', () => {
  const parsed = sections(unitTemplate(DAEMON_INSTALL_SH));
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
  const parsed = sections(unitTemplate(DAEMON_INSTALL_SH));
  const hit = parsed.Service.find((l) => l.startsWith('TimeoutStopSec='));
  assert.ok(hit, 'no TimeoutStopSec -- systemd defaults to 90s and SIGKILLs the drain at 1m30s');
  const stopSec = Number(hit.slice('TimeoutStopSec='.length));
  assert.ok(Number.isFinite(stopSec) && stopSec > 0, 'TimeoutStopSec must be a positive number of seconds');

  // The number is read out of config.js's SOURCE TEXT, not required from it: recomputing an
  // expectation from the value under test pins nothing (test/doc-constant-sweep.test.js's own
  // lesson, paid for twice in this repo). If the default is ever expressed differently this
  // assertion fails loudly rather than silently checking a `null`.
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'config.js'), 'utf8');
  const m = /SPO_DRAIN_TIMEOUT_MS[\s\S]{0,160}?[:,]\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)\s*[;)]/.exec(configSrc);
  assert.ok(m, 'config.js no longer states the drain default as `N * N * N` -- update this guard');
  const drainSec = (Number(m[1]) * Number(m[2]) * Number(m[3])) / 1000;
  const g = /SPO_DRAIN_KILL_GRACE_MS[\s\S]{0,160}?[:,]\s*(\d+)\s*\*\s*(\d+)\s*[;)]/.exec(configSrc);
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
  const body = unitTemplate(DAEMON_INSTALL_SH);
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
