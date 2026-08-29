'use strict';
// llm.js -- the "claude -p" step interface (PLAN, IMPLEMENT, DIAGNOSE, VALIDATE's two
// verifiers). state-machine-spec.md § Step contracts.
//
// Shadow mode (ctx.shadowMode === true): never touches the `claude` CLI. Returns the canned
// JSON payload from the task's shadow.llm.<stepName> fixture (see fixture.js for the array/
// scalar cursor convention), optionally preceded by an artificial delay read from
// `delays.<stepName>` (ms), same mechanism as steps/scripted.js.
//
// Real mode is a DOCUMENTED STUB, not an implementation. When this orchestrator leaves shadow
// mode, this branch becomes: spawn `claude -p` with the pinned model/effort/tool-set/
// --output-format json/--json-schema/--max-budget-usd/--allowedTools/--permission-mode for
// `stepName`, under the account's CLAUDE_CONFIG_DIR chosen by the scheduler (account pool,
// state-machine-spec.md § Account pool), and parse the JSON result (recording session_id,
// cost_usd, duration_s into the journal per state-machine-spec.md § Observability). None of
// that is implemented here on purpose: this build must never invoke the `claude` CLI, so the
// real branch only throws, loudly, if it is ever reached.

const { sleep } = require('./scripted');

async function runLlm(ctx, stepName, fixtureKey) {
  if (ctx.shadowMode) {
    const payload = ctx.fixture(fixtureKey, null);
    const delay = ctx.fixture(`delays.${stepName}`, 0);
    if (delay > 0) await sleep(delay);
    return payload;
  }

  throw new Error(
    `llm.js: real (non-shadow) execution is not implemented in this skeleton -- step ` +
      `"${stepName}" would spawn \`claude -p\` per state-machine-spec.md § Step contracts. ` +
      `Shadow mode only for now.`
  );
}

module.exports = { runLlm };
