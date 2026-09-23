'use strict';
// prompt-template.js -- loads one file from prompts/ and fills its declared {{placeholders}}.
//
// Every prompt file starts with an HTML-comment header (prompts/README.md: "Every file starts
// with an HTML-comment header naming its {{placeholders}} and the exact JSON shape expected on
// stdout -- read that before the body. The body is written directly to the model ..."). That
// last clause matters here: the header is meta-documentation for whoever is wiring the prompt
// up (this module, a human skimming prompts/), not part of what an LLM call should ever
// see -- so the header is stripped before filling, never sent to the model. Filling the whole
// file (header included) would also self-destruct: the header's own "Placeholders: {{a}} {{b}}
// ..." line contains every placeholder token too, and substituting it in place would replace
// that declaration with the actual call's values instead of leaving it as a declaration.
//
// The placeholder *set* a file declares is still read from the header alone -- not by scanning
// the body -- because a `{{name}}` token can legitimately appear inside the header's own
// JSON-shape example too (e.g. plan.md's `"plan_path": "<absolute path, under
// {{scratch_dir}}>"`), so extraction scans the entire header block rather than parsing only the
// "Placeholders:" line by itself; the two produce the same set for every file in prompts/ today.
//
// Fill is all-or-nothing ("No partial fills" -- see the task brief this module was built for):
// any declared placeholder with no value in the caller's `values` object throws
// MissingPlaceholderError before a single substitution happens, and so does any `{{...}}` token
// still present in the body after every declared placeholder has been substituted (a body
// reference to a name the header never declared, most likely a typo) -- both cases are the same
// typed error, so the caller has one thing to catch.

const fs = require('fs');

const HEADER_RE = /^<!--([\s\S]*?)-->/;
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

class MissingPlaceholderError extends Error {
  constructor(promptFile, placeholder, allMissing) {
    super(`prompt-template.js: ${promptFile} declares {{${placeholder}}} but no value was supplied`);
    this.name = 'MissingPlaceholderError';
    this.promptFile = promptFile;
    this.placeholder = placeholder;
    this.missing = allMissing || [placeholder];
  }
}

// Splits `text` into its header comment (the inside of `<!-- ... -->`, empty string if the file
// has none) and everything after it -- the part actually sent to the model. Leading blank lines
// left by the split are trimmed so the body starts at its own first heading.
function splitHeaderAndBody(text) {
  const m = text.match(HEADER_RE);
  if (!m) return { header: '', body: text };
  return { header: m[1], body: text.slice(m[0].length).replace(/^\s*\n/, '') };
}

// The declared placeholder set for one prompt file's text, in first-seen order, deduplicated.
function extractPlaceholders(text) {
  const { header } = splitHeaderAndBody(text);
  const seen = new Set();
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(header))) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

function loadPromptSpec(promptFile) {
  const text = fs.readFileSync(promptFile, 'utf8');
  const { header, body } = splitHeaderAndBody(text);
  const seen = new Set();
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(header))) {
    seen.add(match[1]);
  }
  return { text, header, body, placeholders: Array.from(seen) };
}

// An array value is joined ", " (citations, ...) EXCEPT for the two placeholders named in
// JSON_RENDERED_PLACEHOLDERS, which are JSON-stringified instead; anything else is coerced to its
// own string form. undefined/null are never reached here -- they are caught as "missing" before
// any substitution runs.
//
// Why those two keys are special-cased, in the order the history happened (#231, 2026-09-22):
//
// 1. Until #229, `invariant_ids`/`check_commands` never reached this function as arrays at all.
//    Measured across every task dir's journal.jsonl on 2026-09-07 (re-derived Lot 6, 2026-09-08),
//    each arrived from PLAN as a JSON-ENCODED STRING in 158 of 158 successful PLAN `result`
//    payloads and 0 as a real array -- the same wire shape #118 measured for files_to_change.
//    So they fell to String(value) and rendered into prompts/implement.md and
//    prompts/validate-change.md verbatim as ["INV-1","INV-2"], never as INV-1, INV-2.
//
// 2. #153 proposed normalizing that so the model would see INV-1, INV-2 instead. Measured and
//    closed won't-fix, because the measurement said don't: IMPLEMENT already named back every
//    declared invariant id in 100 of 101 answerable runs and collapsed a check_commands list 0
//    times in 104, so there was no behavioural cost to recover -- while 158 of 1,093 declared
//    check commands (14.5%, across 30 of 59 task dirs) contained a comma, making 23 of 157
//    non-empty lists (14.6%) unrecoverable by splitting the joined text back on ", ", where the
//    JSON form's `","` delimiter stays unambiguous.
//
// 3. #229 (merged 2026-09-13T23:49Z) then made PLAN's `--json-schema` declare every contract key
//    in `properties`, and the model started sending both fields as REAL ARRAYS. Nothing here
//    changed; the input shape changed underneath it, so the `Array.isArray` branch began firing
//    on them and silently shipped exactly the join(', ') rendering #153 had measured and
//    rejected -- on every card, live, until #231. Re-measured on the live journal 2026-09-22:
//    125 of 125 post-#229 PLAN `result` records carry both keys as real arrays and 0 as strings
//    (386 of 386 pre-#229 records are strings and 0 arrays), and across the 56 distinct post-#229
//    replies with a non-empty check_commands, 69 of 476 declared commands (14.5%) contain a comma
//    and 29 (6.1%) contain a literal ", " -- which makes 21 of those 56 lists (37.5%)
//    unrecoverable by splitting on ", ".
//
// 4. #231's fix is on the render side only, deliberately: PLAN's wire shape stays whatever #229
//    made it. These two placeholders are JSON-stringified, which puts the same unambiguous
//    ["INV-1","INV-2"] text back into the prompt the pre-#229 JSON string produced, whichever of
//    the two shapes arrives -- an array and a JSON string holding one now render identically.
//
// `citations` (CITATION_VERIFIER) is the array this function's join(', ') branch exists to serve,
// and it keeps it: its list items are scraped catalogue lines, read as prose by the verifier
// prompt, with no split-on-", " consumer to corrupt. It is NOT in JSON_RENDERED_PLACEHOLDERS.
const JSON_RENDERED_PLACEHOLDERS = new Set(['check_commands', 'invariant_ids']);

function stringifyValue(value, name) {
  if (Array.isArray(value) && JSON_RENDERED_PLACEHOLDERS.has(name)) return JSON.stringify(value);
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// Reads prompts/<file>, fills every declared {{placeholder}} from `values` in the BODY only
// (the header is stripped, never sent to the model -- see file header comment), and returns the
// filled body text. Throws MissingPlaceholderError (never returns a partially-filled string)
// when a declared placeholder has no value, or when a `{{...}}` token survives the fill in the
// body (an undeclared/misspelled reference, most likely a typo).
function fillPromptTemplate(promptFile, values = {}) {
  const { body, placeholders } = loadPromptSpec(promptFile);

  const missing = placeholders.filter((name) => values[name] === undefined || values[name] === null);
  if (missing.length > 0) {
    throw new MissingPlaceholderError(promptFile, missing[0], missing);
  }

  let filled = body;
  for (const name of placeholders) {
    filled = filled.split(`{{${name}}}`).join(stringifyValue(values[name], name));
  }

  PLACEHOLDER_RE.lastIndex = 0;
  const stray = PLACEHOLDER_RE.exec(filled);
  if (stray) {
    throw new MissingPlaceholderError(promptFile, stray[1], [stray[1]]);
  }

  return filled;
}

module.exports = {
  fillPromptTemplate,
  extractPlaceholders,
  loadPromptSpec,
  splitHeaderAndBody,
  MissingPlaceholderError,
};
