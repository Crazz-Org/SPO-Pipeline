'use strict';
// Unit tests for bin/spo's cmdIntake/cmdReports/cmdTriage wiring, via the same deps.reportIntake/
// deps.autoTriage test-only override convention test/intake.test.js already uses for deps.intake
// (cmdAsk/cmdPull) -- drives the REAL commands/parseArgs against fake modules, never the real
// orchestrator/*.js, so no account pool / spawnSync fixture is needed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// `../bin/spo` transitively requires 28 orchestrator modules, `command-timeout.js` among them,
// so it destructures the real spawnSync at require time exactly like a direct orchestrator
// require would -- the killswitch has to be installed before this line, not after. See
// test/no-real-spawn.js's header for the incident that makes this non-negotiable.
require('./no-real-spawn');

const spo = require('../bin/spo');
const { mkTmp } = require('./helpers');
const { lockPath } = require('../orchestrator/lock');
const { stateJournalRoot } = require('../orchestrator/state-root');

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function withExitCodeReset(fn) {
  return async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await fn();
    } finally {
      process.exitCode = before;
    }
  };
}

// Card #100 post-verification fix (F1): `refuseIfDaemonLockHeld` (bin/spo) ALWAYS checks the REAL
// default journal root -- `stateJournalRoot(resolveStateRoot())` -- in addition to whatever
// `--journal` a command's own opts resolve to (its own ANTI-EVASION note explains why: nothing on
// THIS process's argv can move where a live daemon's lock actually is). That means isolating a
// cmdIntake test via `--journal` ALONE no longer isolates it -- the guard still probes this
// machine's true `~/.spo-state/journal`, which measurably DOES hold a live daemon lock on this box
// (verification's own F1 probe proved it). `SPO_STATE_DIR` is the only thing that actually
// redirects `resolveStateRoot()` (orchestrator/state-root.js) -- so it is what isolates the REAL
// default, not a flag or a `deps` override. See test/intake.test.js's identical helper for the
// cmdPull side of the same fix.
function withIsolatedStateDir(fn) {
  return async () => {
    const stateDir = mkTmp('spo-cmd-state-');
    const saved = process.env.SPO_STATE_DIR;
    process.env.SPO_STATE_DIR = stateDir;
    try {
      await fn(stateDir);
    } finally {
      if (saved === undefined) delete process.env.SPO_STATE_DIR;
      else process.env.SPO_STATE_DIR = saved;
    }
  };
}

// ---- cmdTriage ----------------------------------------------------------------------------

test(
  'spo triage: defaults to dry -- passes {dry: true} through to runAutoTriage',
  withExitCodeReset(async () => {
    let seenDry = null;
    let seenLimit = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (journalRoot, config, deps, opts) => {
        seenDry = opts.dry;
        seenLimit = config.autoTriageLimit;
        return { ok: true, processed: 0, filed: 0, duplicates: 0, held: 0, errors: [], results: [] };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs([]);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.equal(seenDry, true);
    assert.equal(seenLimit, 3);
    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('no confirmed reports')));
  })
);

test(
  'spo triage --file: passes {dry: false}',
  withExitCodeReset(async () => {
    let seenDry = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (journalRoot, config, deps, opts) => {
        seenDry = opts.dry;
        return { ok: true, processed: 0, filed: 0, duplicates: 0, held: 0, errors: [], results: [] };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--file']);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.equal(seenDry, false);
  })
);

test(
  'spo triage --limit 2: flag reaches runAutoTriage config',
  withExitCodeReset(async () => {
    let seenLimit = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (journalRoot, config) => {
        seenLimit = config.autoTriageLimit;
        return { ok: true, processed: 0, filed: 0, duplicates: 0, held: 0, errors: [], results: [] };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--limit', '2']);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.equal(seenLimit, 2);
  })
);

test(
  'spo triage: prints one line per result and the summary counts, exits non-zero when there are errors',
  withExitCodeReset(async () => {
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async () => ({
        ok: true,
        processed: 2,
        filed: 1,
        duplicates: 0,
        held: 1,
        errors: [{ issue: 43, error: 'boom' }],
        results: [
          { issue: 42, outcome: 'filed', url: 'https://x/42' },
          { issue: 43, outcome: 'error', error: 'boom' },
        ],
      }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--file']);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.ok(console_.logs.some((l) => l.includes('#42: filed')));
    assert.ok(console_.logs.some((l) => l.includes('#43: error -- boom')));
    assert.ok(console_.logs.some((l) => l.includes('filed: 1')));
    assert.equal(process.exitCode, 1);
  })
);

// action 2.6: a report another runner already claimed prints its own line and counts separately
// from "held" -- it was never actually judged by THIS run, so lumping it into "held" would
// misreport what happened.
test(
  'spo triage: an already-claimed outcome (action 2.6) prints its own line and its own summary count',
  withExitCodeReset(async () => {
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async () => ({
        ok: true,
        processed: 1,
        filed: 0,
        duplicates: 0,
        held: 0,
        alreadyClaimed: 1,
        errors: [],
        results: [{ issue: 44, outcome: 'already-claimed' }],
      }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--file']);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.ok(console_.logs.some((l) => l.includes('#44: already claimed by another runner -- skipped')));
    assert.ok(console_.logs.some((l) => l.includes('already-claimed: 1')));
    assert.equal(process.exitCode, undefined);
  })
);

test(
  'spo triage: a mechanical runAutoTriage failure -> clear error, exit non-zero',
  withExitCodeReset(async () => {
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async () => ({ ok: false, error: 'boom: something spawned wrong' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs([]);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('boom')));
  })
);

// ---- spo triage --retry <issue> (action 3.4) ------------------------------------------------
// Exercises bin/spo's cmdTriage/--retry wiring directly against a fake deps.autoTriage module
// (the same test-only override convention this file already uses for the rest of cmdTriage)
// rather than through runSpo's real subprocess: `--file` would otherwise reach the real
// `gh`/`claude` binaries through orchestrator/auto-triage.js's retryHeldReport, which no test in
// this file should ever do. The mechanism itself (retryHeldReport's preconditions, journalling,
// dry preview) is covered in test/auto-triage.test.js -- these tests only pin bin/spo's own
// argument parsing/validation and wiring.

test(
  'spo triage --retry 449 --file calls retryHeldReport with the right issue and dry:false, exits 0',
  withExitCodeReset(async () => {
    let seen = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async (journalRoot, issue, config, deps, opts) => {
        seen = { issue, dry: opts.dry };
        return {
          ok: true,
          outcome: 'retried',
          issue,
          pendingPath: '/fake/p.json',
          kind: undefined,
          retriedFrom: 'report-held-mechanical',
          commentPosted: true,
        };
      },
    };
    const opts = spo.parseArgs(['--retry', '449', '--file', '--journal', '/fake/journal']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.deepEqual(seen, { issue: 449, dry: false });
    assert.equal(process.exitCode, undefined, 'success must not set a non-zero exit code');
    assert.match(console_.logs.join('\n'), /#449: re-injected \(was report-held-mechanical\)/);
  })
);

test(
  'spo triage --retry #449 accepts the #-prefixed issue a maintainer would paste from GitHub',
  withExitCodeReset(async () => {
    let seenIssue = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async (journalRoot, issue) => {
        seenIssue = issue;
        return { ok: true, outcome: 'would-retry', dry: true, issue, retriedFrom: 'report-held' };
      },
    };
    const opts = spo.parseArgs(['--retry', '#449', '--journal', '/fake/journal']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.equal(seenIssue, 449, 'the leading # must be stripped before parsing as a number');
    assert.equal(process.exitCode, undefined);
  })
);

test(
  'spo triage --retry <issue> without --file previews only -- dry:true is passed through, nothing claims to have acted',
  withExitCodeReset(async () => {
    let seenOpts = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async (journalRoot, issue, config, deps, opts) => {
        seenOpts = opts;
        return { ok: true, outcome: 'would-retry', dry: true, issue, retriedFrom: 'report-held' };
      },
    };
    const opts = spo.parseArgs(['--retry', '449', '--journal', '/fake/journal']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.equal(seenOpts.dry, true, '--file was not given -- --retry must default to dry like every other spo triage invocation');
    assert.match(console_.logs.join('\n'), /would re-inject/);
    assert.match(console_.logs.join('\n'), /pass --file to actually act/);
    assert.equal(process.exitCode, undefined);
  })
);

test(
  'spo triage --retry <non-numeric issue> exits non-zero and never calls retryHeldReport',
  withExitCodeReset(async () => {
    let called = false;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async () => {
        called = true;
        return { ok: true };
      },
    };
    const opts = spo.parseArgs(['--retry', 'abc', '--journal', '/fake/journal']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.equal(called, false, 'an invalid issue must be rejected before the mechanism is ever reached');
    assert.equal(process.exitCode, 1);
    assert.match(console_.errors.join('\n'), /not a valid issue number/);
  })
);

test(
  'spo triage --retry with no value exits non-zero and never calls retryHeldReport',
  withExitCodeReset(async () => {
    let called = false;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async () => {
        called = true;
        return { ok: true };
      },
    };
    // --retry deliberately placed LAST so argv[++i] has nothing to consume -- the "missing value"
    // shape, distinct from "--retry abc" above (a present but invalid value).
    const opts = spo.parseArgs(['--journal', '/fake/journal', '--retry']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.equal(called, false);
    assert.equal(process.exitCode, 1);
    assert.match(console_.errors.join('\n'), /usage: spo triage --retry/);
  })
);

test(
  'spo triage --retry <issue> --file exits non-zero when retryHeldReport refuses, and prints the refusal',
  withExitCodeReset(async () => {
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      retryHeldReport: async () => ({
        ok: false,
        error: 'retryHeldReport: issue #449 has no report-confirmed event on record -- nothing to re-confirm',
      }),
    };
    const opts = spo.parseArgs(['--retry', '449', '--file', '--journal', '/fake/journal']);
    const console_ = captureConsole();
    try {
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }
    assert.equal(process.exitCode, 1);
    assert.match(console_.errors.join('\n'), /has no report-confirmed event on record/);
  })
);

// ---- cmdPullReports ---------------------------------------------------------------------------

test(
  'spo pull-reports: not configured -> a clear message, exit 0',
  withExitCodeReset(async () => {
    const fakeRemoteReportPull = {
      runRemoteReportPull: async () => ({ ok: true, skipped: 'no-url' }),
    };
    const console_ = captureConsole();
    try {
      await spo.cmdPullReports(spo.parseArgs([]), { remoteReportPull: fakeRemoteReportPull });
    } finally {
      console_.restore();
    }
    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('SPO_REMOTE_REPORT_URL')));
  })
);

test(
  'spo pull-reports: prints the summary counts, exits non-zero when there are errors',
  withExitCodeReset(async () => {
    const fakeRemoteReportPull = {
      runRemoteReportPull: async () => ({
        ok: true,
        listed: 2,
        pulled: 1,
        acked: 1,
        rejected: 0,
        errors: [{ file: 'x.json', error: 'ack failed: boom' }],
      }),
    };
    const console_ = captureConsole();
    try {
      await spo.cmdPullReports(spo.parseArgs([]), { remoteReportPull: fakeRemoteReportPull });
    } finally {
      console_.restore();
    }
    assert.ok(console_.logs.some((l) => l.includes('pulled: 1')));
    assert.ok(console_.errors.some((l) => l.includes('x.json')));
    assert.equal(process.exitCode, 1);
  })
);

test(
  'spo pull-reports: a mechanical failure -> clear error, exit non-zero',
  withExitCodeReset(async () => {
    const fakeRemoteReportPull = { runRemoteReportPull: async () => ({ ok: false, error: 'boom' }) };
    const console_ = captureConsole();
    try {
      await spo.cmdPullReports(spo.parseArgs([]), { remoteReportPull: fakeRemoteReportPull });
    } finally {
      console_.restore();
    }
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('boom')));
  })
);

// ---- cmdIntake ------------------------------------------------------------------------------

test(
  'spo intake: reports filed/duplicate/schema-version/error lines and the summary',
  withExitCodeReset(
    withIsolatedStateDir(async () => {
      let seenLimit = null;
      let seenReportsDir = null;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async (journalRoot, config) => {
          seenLimit = config.autoIntakeLimit;
          seenReportsDir = config.spoReportsDir;
          return {
            ok: true,
            processed: 3,
            filed: 1,
            duplicates: 1,
            schemaVersion: 1,
            errors: [],
            results: [
              { file: 'a.json', outcome: 'filed', issueNumber: 501 },
              { file: 'b.json', outcome: 'duplicate', issueNumber: 42 },
              { file: 'c.json', outcome: 'schema-version', found: 2, expected: 1 },
            ],
          };
        },
      };

      // Card #100: no --journal here on purpose -- see withIsolatedStateDir's own header for why
      // SPO_STATE_DIR, not a flag, is what isolates the real default the guard always also checks.
      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--limit', '5', '--reports-dir', '/tmp/fake-reports']);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake });
      } finally {
        console_.restore();
      }

      assert.equal(seenLimit, 5);
      assert.equal(seenReportsDir, '/tmp/fake-reports');
      assert.ok(console_.logs.some((l) => l.includes('a.json: filed #501')));
      assert.ok(console_.logs.some((l) => l.includes('b.json: duplicate of #42')));
      assert.ok(console_.logs.some((l) => l.includes('c.json: schema version mismatch')));
      assert.ok(console_.logs.some((l) => l.includes('filed: 1')));
      assert.equal(process.exitCode, undefined);
    })
  )
);

test(
  'spo intake: nothing queued',
  withExitCodeReset(
    withIsolatedStateDir(async () => {
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => ({ ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] }),
      };

      // Card #100: see the note on the previous cmdIntake test above.
      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake });
      } finally {
        console_.restore();
      }

      assert.ok(console_.logs.some((l) => l.includes('no queued reports')));
    })
  )
);

// ---- cmdIntake: daemon-lock guard (card #100, consolidates 79.2) ---------------------------
//
// `cmdIntake` used to call resolveDirs(opts) and go straight to `runReportIntake` -- no lock
// read, no refusal, no `--force`. Now it reads orchestrator/lock.js's daemon.lock at that SAME
// resolveDirs(opts).journalRoot *and* -- unconditionally -- at the real default
// `stateJournalRoot(resolveStateRoot())` before doing anything else. Modeled on
// test/recette.test.js:328 (refusal), :346 (--force overrides), :361 (dead pid is not a refusal)
// -- `deps.isAlive` is the identical injection point liveDaemonHolder uses.
//
// Every test below isolates the REAL default via SPO_STATE_DIR (withIsolatedStateDir) -- see that
// helper's own header for why --journal alone can no longer isolate a test from this machine's
// real daemon lock (that is the whole point of the anti-evasion fix these tests exist to lock in).

test(
  'spo intake: a live daemon lock refuses -- runReportIntake is never called, exit 1',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      let runReportIntakeCalled = false;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => {
          runReportIntakeCalled = true;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake, isAlive: (pid) => pid === 999999 });
      } finally {
        console_.restore();
      }

      assert.equal(runReportIntakeCalled, false, 'refusal must happen before any downstream call');
      assert.equal(process.exitCode, 1);
      assert.ok(console_.errors.some((l) => l.includes('999999') && l.includes('daemon.lock')));
    })
  )
);

test(
  'spo intake --force: overrides the daemon-lock refusal -- runReportIntake IS called despite a live lock',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      let runReportIntakeCalled = false;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => {
          runReportIntakeCalled = true;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--force']);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake, isAlive: () => true });
      } finally {
        console_.restore();
      }

      assert.equal(runReportIntakeCalled, true, '--force must let intake actually run');
    })
  )
);

test(
  'spo intake: a lock file whose pid is dead is not a refusal -- runReportIntake IS called',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 123456, mode: 'real', startedAt: new Date().toISOString() })
      );
      let runReportIntakeCalled = false;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => {
          runReportIntakeCalled = true;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake, isAlive: () => false });
      } finally {
        console_.restore();
      }

      assert.equal(runReportIntakeCalled, true);
      assert.equal(process.exitCode, undefined);
    })
  )
);

test(
  'spo intake: no lock file at all is not a refusal -- runReportIntake IS called, with the resolved journalRoot forwarded',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      let seenJournalRoot = null;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async (journalRoot) => {
          seenJournalRoot = journalRoot;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake });
      } finally {
        console_.restore();
      }

      assert.equal(seenJournalRoot, stateJournalRoot(stateDir), 'runReportIntake must receive the SAME journalRoot the guard checked');
      assert.equal(process.exitCode, undefined);
    })
  )
);

// ---- cmdIntake: anti-evasion regressions (post-verification fix, F1) ------------------------
//
// F1 (verification, 2026-09-06): `spo intake --journal <empty-tmp>` walked straight past a REAL
// live daemon lock because the guard checked only the resolved --journal path. Reproduced with a
// real `acquireLock` + a real decoy `--journal` before the fix; reproduced here as a permanent
// regression.

test(
  'spo intake: a --journal decoy cannot evade a live lock at the REAL default journal root',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      const decoyJournal = mkTmp('spo-intake-decoy-journal-'); // no lock here at all
      let runReportIntakeCalled = false;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => {
          runReportIntakeCalled = true;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--journal', decoyJournal]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake, isAlive: (pid) => pid === 999999 });
      } finally {
        console_.restore();
      }

      assert.equal(runReportIntakeCalled, false, 'a --journal decoy must not evade the real default lock check');
      assert.equal(process.exitCode, 1);
    })
  )
);

test(
  'spo intake: an explicit --journal pointed at a SECOND live daemon is also refused (belt-and-braces)',
  withExitCodeReset(
    withIsolatedStateDir(async () => {
      // The real default has NO lock here -- only the explicit --journal target does, simulating
      // a maintainer who really did start a second daemon with --journal <secondDaemonJournal>.
      const secondDaemonJournal = mkTmp('spo-intake-second-daemon-journal-');
      fs.writeFileSync(
        lockPath(secondDaemonJournal),
        JSON.stringify({ host: os.hostname(), pid: 888888, mode: 'real', startedAt: new Date().toISOString() })
      );
      let runReportIntakeCalled = false;
      const fakeReportIntake = {
        DEFAULT_AUTO_INTAKE_LIMIT: 3,
        runReportIntake: async () => {
          runReportIntakeCalled = true;
          return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--journal', secondDaemonJournal]);
        await spo.cmdIntake(opts, { reportIntake: fakeReportIntake, isAlive: (pid) => pid === 888888 });
      } finally {
        console_.restore();
      }

      assert.equal(runReportIntakeCalled, false, 'an explicit --journal naming a live second daemon must still refuse');
      assert.equal(process.exitCode, 1);
      assert.ok(console_.errors.some((l) => l.includes('888888')));
    })
  )
);

// ---- cmdReports -----------------------------------------------------------------------------

test('spo reports: lists pending files, or says nothing pending', () => {
  const reportsDir = mkTmp('spo-reports-cmd-');
  const pendingDir = path.join(reportsDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, '2026-08-30T00-00-00-000Z_desktop_aaa.json'), '{}');

  const console_ = captureConsole();
  try {
    spo.cmdReports(spo.parseArgs(['--reports-dir', reportsDir]));
  } finally {
    console_.restore();
  }
  assert.ok(console_.logs.some((l) => l.includes('2026-08-30T00-00-00-000Z_desktop_aaa.json')));

  const empty = mkTmp('spo-reports-cmd-empty-');
  fs.mkdirSync(path.join(empty, 'pending'), { recursive: true });
  const console2 = captureConsole();
  try {
    spo.cmdReports(spo.parseArgs(['--reports-dir', empty]));
  } finally {
    console2.restore();
  }
  assert.ok(console2.logs.some((l) => l.includes('nothing pending')));
});
