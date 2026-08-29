'use strict';
// scripted.js -- the "spawn a command, return {exit, stdoutTail}" step interface.
//
// Shadow mode (ctx.shadowMode === true): never spawns anything. Reads the next value for
// `fixtureKey` from the task's shadow fixture (see fixture.js) as the exit code, optionally
// preceded by an artificial delay read from `delays.<fixtureKey>` (ms) -- used by the step-
// deadline test to simulate a slow step without a real subprocess.
//
// Real mode: opts.command / opts.args, if given, are spawned synchronously and the exit code
// and a tail of stdout (falling back to stderr) are returned. Nothing in this build ever
// passes opts.command from the state machine -- every scripted step in orchestrator/state-
// machine.js only supplies a fixtureKey, so real mode is reachable but unexercised: the wiring
// of the actual `npm run gate` / `gh pr merge` / etc. commands is future work, done when this
// orchestrator leaves shadow mode.

const { spawnSync } = require('child_process');

function lastLines(text, n = 20) {
  if (!text) return '';
  return text.split('\n').slice(-n).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScripted(ctx, fixtureKey, opts = {}) {
  const { defaultExit = 0, command = null, args = [] } = opts;

  if (ctx.shadowMode) {
    const exit = ctx.fixture(fixtureKey, defaultExit);
    const delay = ctx.fixture(`delays.${fixtureKey}`, 0);
    if (delay > 0) await sleep(delay);
    return { exit, stdoutTail: `[shadow] ${fixtureKey} -> exit ${exit}` };
  }

  if (!command) {
    throw new Error(
      `scripted.js: no real command configured for "${fixtureKey}" -- non-shadow execution ` +
        `is not implemented in this skeleton (shadow mode only for now).`
    );
  }
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const exit = result.status === null || result.status === undefined ? 1 : result.status;
  return { exit, stdoutTail: lastLines(result.stdout || result.stderr || '') };
}

module.exports = { runScripted, sleep, lastLines };
