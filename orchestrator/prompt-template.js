'use strict';
// prompt-template.js -- loads one file from prompts/ and fills its declared {{placeholders}}.
//
// Every prompt file starts with an HTML-comment header (prompts/README.md: "Every file starts
// with an HTML-comment header naming its {{placeholders}} and the exact JSON shape expected on
// stdout -- read that before the body. The body is written directly to the model ..."). That
// last clause matters here: the header is meta-documentation for whoever is wiring the prompt
// up (this module, a human skimming prompts/), not part of what a `claude -p` call should ever
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

// An array value is joined ", " (invariant_ids, check_commands, citations, ...); anything else
// is coerced to its own string form. undefined/null are never reached here -- they are caught
// as "missing" before any substitution runs.
function stringifyValue(value) {
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
    filled = filled.split(`{{${name}}}`).join(stringifyValue(values[name]));
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
