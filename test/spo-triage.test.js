'use strict';
// Unit tests for bin/spo's cmdTriage wiring around orchestrator/auto-triage.js's runAutoTriage,
// via the same deps.autoTriage test-only override convention test/intake.test.js already uses
// for deps.intake (cmdAsk/cmdPull) -- drives the REAL cmdTriage/parseArgs against a fake
// auto-triage module, never the real orchestrator/auto-triage.js, so no account pool / spawnSync
// fixture is needed here.

const test = require('node:test');
const assert = require('node:assert/strict');

const spo = require('../bin/spo');

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

test(
  'spo triage: defaults to dry -- passes {dry: true} through to runAutoTriage',
  withExitCodeReset(async () => {
    let seenDry = null;
    let seenLimit = null;
    let seenReportsDir = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (reportsDir, journalRoot, config, deps, opts) => {
        seenDry = opts.dry;
        seenLimit = config.autoTriageLimit;
        seenReportsDir = reportsDir;
        return {
          ok: true,
          processed: 0,
          filed: 0,
          duplicates: 0,
          notReproduced: 0,
          insufficient: 0,
          schemaVersion: 0,
          doNotFile: 0,
          errors: [],
          results: [],
        };
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
    assert.ok(seenReportsDir);
    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('no queued reports')));
  })
);

test(
  'spo triage --file: passes {dry: false}',
  withExitCodeReset(async () => {
    let seenDry = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (reportsDir, journalRoot, config, deps, opts) => {
        seenDry = opts.dry;
        return {
          ok: true,
          processed: 0,
          filed: 0,
          duplicates: 0,
          notReproduced: 0,
          insufficient: 0,
          schemaVersion: 0,
          doNotFile: 0,
          errors: [],
          results: [],
        };
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
  'spo triage --limit 2 --reports-dir <dir>: flags reach runAutoTriage',
  withExitCodeReset(async () => {
    let seenLimit = null;
    let seenReportsDir = null;
    const fakeAutoTriage = {
      DEFAULT_AUTO_TRIAGE_LIMIT: 3,
      runAutoTriage: async (reportsDir, journalRoot, config) => {
        seenLimit = config.autoTriageLimit;
        seenReportsDir = reportsDir;
        return {
          ok: true,
          processed: 0,
          filed: 0,
          duplicates: 0,
          notReproduced: 0,
          insufficient: 0,
          schemaVersion: 0,
          doNotFile: 0,
          errors: [],
          results: [],
        };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--limit', '2', '--reports-dir', '/tmp/fake-reports']);
      await spo.cmdTriage(opts, { autoTriage: fakeAutoTriage });
    } finally {
      console_.restore();
    }

    assert.equal(seenLimit, 2);
    assert.equal(seenReportsDir, '/tmp/fake-reports');
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
        notReproduced: 0,
        insufficient: 0,
        schemaVersion: 0,
        doNotFile: 0,
        errors: [{ file: 'b.json', error: 'boom' }],
        results: [
          { file: 'a.json', outcome: 'filed', issueNumber: 42, url: 'https://x/42' },
          { file: 'b.json', outcome: 'error', error: 'boom' },
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

    assert.ok(console_.logs.some((l) => l.includes('a.json: filed #42')));
    assert.ok(console_.logs.some((l) => l.includes('b.json: error -- boom')));
    assert.ok(console_.logs.some((l) => l.includes('filed: 1')));
    assert.equal(process.exitCode, 1);
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
