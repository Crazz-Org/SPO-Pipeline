# `vendor/claude-agent-sdk/` -- provenance

This directory holds a **vendored copy** of `@anthropic-ai/claude-agent-sdk`, version `0.3.273`
(paired with Claude Code `2.1.273`), for card #239's chantier ("Drive LLM steps through the
Claude Agent SDK instead of spawning `claude -p`"). It was copied in, not installed by `npm`,
into a repo that has no `package.json` and no `node_modules` by design -- see
`orchestrator/sdk.js`'s own header and `CLAUDE.md` § Git for why that property matters here.
`orchestrator/sdk.js` is the only file that reaches into this directory at runtime; nothing else
should `require()` or `import()` these files directly.

This file is different from the other three in this directory: `sdk.mjs`, `package.json` and
`LICENSE.md` are third-party code this repo did not write, excluded from
`doc/remediation-plan-2026-08.md`'s sibling-grep scope (execution rule 6) and named in
`doc/accepted-gaps.md` §1's "Vendored or generated files" bucket. This README is this repo's OWN
prose -- it is named in rule 6's scope list (`vendor/**/README.md`) like any other doc, and a
future correction to a claim it makes (a byte count, an md5, a version pair) is sibling-grepped
the same as a correction anywhere else.

## What is here, and how it got here

Ran once, on 2026-09-17, in a throwaway directory **outside** this repo (never inside it, to keep
this repo's own tree free of any `node_modules`):

```
npm install @anthropic-ai/claude-agent-sdk --omit=optional --legacy-peer-deps
```

Result: 1 package, 5.0 MB, zero peer dependencies installed (`--legacy-peer-deps` skips the
`@anthropic-ai/sdk` / `@modelcontextprotocol/sdk` / `zod` peers listed in the package's own
`peerDependencies`; `--omit=optional` skips the eight platform-binary `optionalDependencies`,
219 MB apiece).

Three files were then copied from that throwaway `node_modules/@anthropic-ai/claude-agent-sdk/`
into this directory and committed here, verbatim:

| file | bytes | note |
|---|---|---|
| `sdk.mjs` | 1,556,674 | md5 `29c5937f279eed1487b4c86ca98b2da9` -- minified but not degenerate: 225 lines, 14 comment lines, 150 of the 225 under 200 characters (`wc -l`, `grep -c '^\s*//'`, `awk '{if(length($0)<200)c++}END{print c}'`) |
| `package.json` | -- | the package's own manifest; kept as the provenance record for `version` / `claudeCodeVersion`, read back by `test/sdk-loader.test.js` as the pin source, never `require()`d at runtime |
| `LICENSE.md` | -- | `© Anthropic PBC. All rights reserved.` |

## What is deliberately NOT here

- `manifest.json`, `manifest.zst.json`, and the three peer packages (`zod`,
  `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`). Measured: `sdk.mjs` alone, in a bare
  directory with no `node_modules` at all, loads via `import()` and drives a full `query()` call
  against a fake executable -- none of the above is on that path.
- The platform binary package (`@anthropic-ai/claude-agent-sdk-linux-x64`, 219 MB, and its seven
  OS/arch siblings). Measured (2026-09-17, `node -e` against the real vendored `sdk.mjs`):
  `query({prompt, options:{}})` throws synchronously, before any process is spawned -- "Native CLI
  binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional,
  or set options.pathToClaudeCodeExecutable." -- and throws the identical way even with a real,
  working `claude` binary on PATH. The SDK's only fallback is the platform npm package this repo
  did not install; it never reads PATH by itself. So this bullet is not "unnecessary because the
  SDK finds `claude` on PATH" -- it never will, on its own. Every future `query()` call site (A3,
  A5) must resolve and pass `options.pathToClaudeCodeExecutable` explicitly;
  `orchestrator/sdk.js`'s `resolveClaudeCodeExecutable` is the one place that does that PATH walk,
  pointed at the same `claude` binary `orchestrator/steps/llm.js` spawns today.

If a future change needs either class of file, that is a new vendor entry with its own
measurement, not a silent addition -- update this table and `doc/accepted-gaps.md` §1's "Vendored
or generated files" bucket in the same change.

## License

Proprietary. `LICENSE.md`'s full text is `© Anthropic PBC. All rights reserved. Use is subject to
the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.` This
repo (SPO-Pipeline) is **private**, and this copy exists solely for this pipeline's own internal
use under that license -- it is not redistributed.

## Updating this vendor drop

1. In a throwaway directory **outside** this repo: re-run the `npm install` command above with
   the new version pinned (`npm install @anthropic-ai/claude-agent-sdk@<version> --omit=optional
   --legacy-peer-deps`).
2. Re-measure the two "deliberately NOT here" points above against the new `sdk.mjs` -- an SDK
   minor/major bump can change what it touches on the load-and-`query()` path.
3. Copy the same three files (`sdk.mjs`, `package.json`, `LICENSE.md`) over the ones in this
   directory, and update the byte count / md5 in the table above (`wc -c sdk.mjs`, `md5sum
   sdk.mjs`).
4. Update `VENDORED_SDK_VERSION` and `VENDORED_CLAUDE_CODE_VERSION` in `orchestrator/sdk.js` to
   match the new `package.json`'s `version` / `claudeCodeVersion` -- in the SAME change, never a
   follow-up, or `test/sdk-loader.test.js`'s version-pin check fails.
5. Re-run `node --test test/*.test.js` (never bare) from the repo root.
