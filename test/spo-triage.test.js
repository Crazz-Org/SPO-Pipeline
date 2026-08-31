'use strict';
// Unit tests for bin/spo's cmdIntake/cmdReports/cmdTriage wiring, via the same deps.reportIntake/
// deps.autoTriage test-only override convention test/intake.test.js already uses for deps.intake
// (cmdAsk/cmdPull) -- drives the REAL commands/parseArgs against fake modules, never the real
// orchestrator/*.js, so no account pool / spawnSync fixture is needed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const spo = require('../bin/spo');
const { mkTmp } = require('./helpers');

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
  withExitCodeReset(async () => {
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
);

test(
  'spo intake: nothing queued',
  withExitCodeReset(async () => {
    const fakeReportIntake = {
      DEFAULT_AUTO_INTAKE_LIMIT: 3,
      runReportIntake: async () => ({ ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs([]);
      await spo.cmdIntake(opts, { reportIntake: fakeReportIntake });
    } finally {
      console_.restore();
    }

    assert.ok(console_.logs.some((l) => l.includes('no queued reports')));
  })
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
