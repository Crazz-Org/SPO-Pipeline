'use strict';
// nightly-proof.js -- `spo nightly` and `spo nightly reprove`: the maintainer's view of the nightly
// proof of SPO-WebClient's `main`, and the human-only entry point for asking the bench worker for a
// fresh one. Design, the WebClient companion spec and the open DECISION: doc/manual-nightly-proof.md.
//
// ---- this module is NOT a pipeline step, and must never become one -----------------------------
//
// "No new card is claimed while main is red" (SPO-WebClient doc/kanban-workflow.md § While `main`
// is red) is only a rule if an automated session cannot grant itself a fresh nightly to get past
// it. So:
//   - bin/spo is the ONLY requirer of this file. test/nightly-proof.test.js fails if any module the
//     daemon can load (orchestrator/**, console/**) requires it, or if prompts/ names the command.
//   - `reprove` refuses inside a Claude Code session (CLAUDECODE, which Claude Code exports to every
//     shell it spawns) and without a terminal on both stdin and stdout. Neither is a security
//     boundary against a same-uid process that sets out to evade it -- see the doc's § The human
//     gate for what IS bounded and why -- but both make "a session ran it by accident or by
//     initiative" a refusal rather than a queued live drive.
//   - The authoritative copy of that gate belongs to WebClient's `request-nightly` (the doc's § B4),
//     because a product session can reach that CLI without going through `spo` at all. This copy is
//     the courtesy that refuses before a process is spawned.
//
// ---- what this module never does -----------------------------------------------------------------
//
// It never writes under the bench directory. The request marker's format and its only writer live
// in SPO-WebClient (src/e2e/bench/cli.ts, spec § B4): two writers of one file in two repos is the
// drift classifyNightly's own header already paid for once. And it never re-derives "is main red":
// `status` calls steps/scripted.js's classifyNightly on the same file the guards read.

const fs = require('fs');
const path = require('path');

const WEBCLIENT_CLI = path.join('dist', 'e2e', 'bench', 'cli.js');
const WEBCLIENT_SUBCOMMAND = 'request-nightly';

// `spo nightly` mirrors SPO-WebClient scripts/nightly-check.sh's exit codes on purpose: one table,
// three answers, whichever repo a human happens to be standing in.
const STATUS_EXIT = { green: 0, red: 1, unknown: 2 };

// `spo nightly reprove`'s own refusals. 0-4 are passed through from WebClient's CLI unchanged (its
// header: 0 ok, 1 usage/unknown command, 2 refused, 3 worker down); these two never reach it.
const REPROVE_EXIT = { notHuman: 5, companionMissing: 6 };

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Everything the bench publishes about the nightly, read-only. `manualRequest` and `manualRecords`
// only exist once the WebClient companion lands (spec § B2); until then they read as absent, which
// is also their correct reading.
function readNightlyState(benchDir) {
  const nightlyDir = path.join(benchDir, 'nightly');
  let manualRecords = [];
  try {
    manualRecords = fs
      .readdirSync(path.join(nightlyDir, 'manual'))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => readJson(path.join(nightlyDir, 'manual', n)))
      .filter((r) => r && typeof r === 'object');
  } catch {
    /* no manual/ directory: no manual run ever recorded */
  }
  return {
    latest: readJson(path.join(nightlyDir, 'latest.json')),
    manualRequest: readJson(path.join(nightlyDir, 'manual-request.json')),
    manualRecords,
  };
}

// origin/main's tip as GitHub has it now. `ls-remote` rather than `rev-parse origin/main`: the
// product repo's remote-tracking ref is only as fresh as its last fetch, and a stale tip would
// classify a FAIL on the real tip as "unknown". The local ref is the labelled fallback, never a
// silent one.
function resolveOriginMainTip(productRepo, execFileSync) {
  try {
    const out = execFileSync('git', ['-C', productRepo, 'ls-remote', 'origin', 'refs/heads/main'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const sha = String(out).split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, source: 'ls-remote' };
  } catch {
    /* fall through to the local ref */
  }
  try {
    const sha = String(
      execFileSync('git', ['-C', productRepo, 'rev-parse', 'origin/main'], { encoding: 'utf8', timeout: 10000 })
    ).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, source: 'local origin/main (ls-remote failed -- may be stale)' };
  } catch {
    /* nothing to fall back to */
  }
  return { sha: null, source: 'unresolved' };
}

// Cards the red nightly parked and that are still waiting. Both of the nightly-red park reasons
// that can leave a card sitting in PARKED are counted, not just one -- card #226 added
// `nightly-red-holding-intake` (handleIntake's pre-gate) beside the existing `nightly-main-red`
// (realWorktree's check), and a listing that knew only the older name would silently under-report
// exactly what this screen exists to show.
//
// Both are, AT THIS POINT, equally stuck. `nightly-main-red` is terminal outright
// (TERMINAL_PARK_REASONS). `nightly-red-holding-intake` is transient
// (TRANSIENT_RETRY_REASONS) and self-resumes -- but a task only reaches PARKED under it once
// finalizePark's bounded retry budget is spent, so a card that appears in THIS list has already
// used its automatic resumes and needs a `retry` like the other. A green nightly releases
// neither. Listed so that consequence is on screen at the moment a human is deciding whether to
// ask for a proof.
const NIGHTLY_RED_PARK_REASONS = new Set(['nightly-main-red', 'nightly-red-holding-intake']);

function listNightlyRedParks(journalRoot) {
  let names = [];
  try {
    names = fs.readdirSync(journalRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const id of names) {
    const state = readJson(path.join(journalRoot, id, 'state.json'));
    if (state && state.state === 'PARKED' && NIGHTLY_RED_PARK_REASONS.has(state.reason) && !state.externallyResolved) {
      rows.push({ id, title: state.title || '' });
    }
  }
  return rows;
}

function short(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, 8) : '(no sha)';
}

function describeTrigger(record) {
  if (!record || !record.trigger || record.trigger === 'scheduled') {
    // A record without `trigger` predates the companion change: every such record was scheduled.
    return record && record.trigger ? 'scheduled' : 'scheduled (no trigger field)';
  }
  if (record.trigger === 'manual') {
    const by = record.requestedBy || {};
    return `manual, requested by ${by.user || '?'}${by.reason ? ` -- "${by.reason}"` : ''}`;
  }
  return `unrecognised trigger ${JSON.stringify(record.trigger)}`;
}

// Pure: the whole `spo nightly` report, from already-read inputs.
function formatNightlyStatus({ latest, manualRequest, manualRecords, tip, classification, parks }) {
  const lines = [];
  const word = { green: 'GREEN', red: 'RED', unknown: 'UNKNOWN' }[classification.status];
  lines.push(`MAIN: ${word} -- ${classification.reason}`);
  lines.push(`  origin/main  ${tip.sha || '(unresolved)'}  [${tip.source}]`);
  if (latest) {
    lines.push(`  nightly      ${latest.verdict || '?'} at ${short(latest.sha)}, finished ${latest.finishedAt || '?'}`);
    lines.push(`  trigger      ${describeTrigger(latest)}`);
    if (latest.detail) lines.push(`  detail       ${latest.detail}`);
    if (latest.logFile) lines.push(`  log          ${latest.logFile}`);
    if (latest.supersedes) {
      const s = latest.supersedes;
      lines.push(`  supersedes   ${s.verdict || '?'} at ${short(s.sha)} (${s.trigger || 'scheduled'}, ${s.finishedAt || '?'})`);
    }
  } else {
    lines.push('  nightly      (no nightly/latest.json on file)');
  }
  if (manualRequest) {
    const by = manualRequest.requestedBy || {};
    lines.push(
      `  pending      manual proof of ${short(manualRequest.sha)} requested by ${by.user || '?'} at ${by.requestedAt || '?'} -- served when the bench queue is next idle`
    );
  }
  const forTip = tip.sha ? manualRecords.filter((r) => r.requestedSha === tip.sha || r.sha === tip.sha) : [];
  for (const r of forTip) {
    lines.push(`  manual run   ${r.verdict || r.outcome || '?'} ${r.finishedAt || ''}${r.attested === false ? ' (did not replace latest.json)' : ''}`);
  }
  if (parks.length) {
    lines.push(`  parked       ${parks.length} card(s) on nightly-main-red / nightly-red-holding-intake -- a green nightly releases none of them; each needs a \`retry\``);
    for (const p of parks) lines.push(`               ${p.id}  ${p.title}`);
  }
  if (classification.status === 'red') {
    lines.push('');
    lines.push('If you believe this red is not the code (read the log first): spo nightly reprove --reason "<why>"');
  }
  return lines;
}

// The courtesy copy of the human gate (see this file's header). Pure over its inputs.
function humanGate({ env, stdinIsTTY, stdoutIsTTY }) {
  if (env.CLAUDECODE) {
    return {
      ok: false,
      why:
        'refused: this is running inside a Claude Code session (CLAUDECODE is set). A manual nightly proof ' +
        'is a maintainer action -- an automated session asking for one is asking past "no new card while main is red".',
    };
  }
  if (!stdinIsTTY || !stdoutIsTTY) {
    return { ok: false, why: 'refused: a manual nightly proof needs a terminal on stdin and stdout (it asks you to confirm the sha).' };
  }
  return { ok: true };
}

// `spo nightly reprove`. Returns the exit code; never throws for an expected refusal.
function reprove({ reason, productRepo, env, stdinIsTTY, stdoutIsTTY, err }, { spawnSync, existsSync = fs.existsSync }) {
  const gate = humanGate({ env, stdinIsTTY, stdoutIsTTY });
  if (!gate.ok) {
    err(gate.why);
    return REPROVE_EXIT.notHuman;
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    err('usage: spo nightly reprove --reason "<why you believe the red is not the code>"');
    return 1;
  }
  const cli = path.join(productRepo, WEBCLIENT_CLI);
  if (!existsSync(cli)) {
    err(`refused: ${cli} does not exist -- the bench CLI is not built in ${productRepo}.`);
    return REPROVE_EXIT.companionMissing;
  }
  // stdio inherited: WebClient's CLI prints the record and reads the typed sha confirmation from
  // THIS terminal. `--via=spo` only labels requestedBy; it grants nothing.
  const res = spawnSync(process.execPath, [cli, WEBCLIENT_SUBCOMMAND, '--via=spo', `--reason=${reason.trim()}`], {
    cwd: productRepo,
    stdio: 'inherit',
  });
  if (res.error) {
    err(`could not run ${cli}: ${res.error.message}`);
    return 1;
  }
  const code = typeof res.status === 'number' ? res.status : 1;
  if (code === 1) {
    err(
      `(exit 1. If the line above reads 'unknown command "${WEBCLIENT_SUBCOMMAND}"', the WebClient companion ` +
        '-- doc/manual-nightly-proof.md § B -- is not deployed on this host yet.)'
    );
  }
  return code;
}

module.exports = {
  WEBCLIENT_CLI,
  WEBCLIENT_SUBCOMMAND,
  STATUS_EXIT,
  REPROVE_EXIT,
  readNightlyState,
  resolveOriginMainTip,
  listNightlyRedParks,
  formatNightlyStatus,
  humanGate,
  reprove,
};
