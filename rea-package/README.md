# Pi REA private package

Traditional Home Manager integration lives in `../rea.nix`. REA is a private child
of the explicitly enabled Pi mode: no global `rea` PATH entry, `rea setup`, or
changes to normal Pi tools, models, skills, AGENTS, or `mcp.json`. The DSH recipe
is maintained separately; both recipes pin the same upstream release.

## Pin and runtime

- Latest published GitHub release at this update: REA 6.8.0,
  `morluto/rea` revision `160d821ac9a0310afcb8d1fc427862dd6508add5`.
- Source hash: `sha256-2ADn3U3lvUoB4tCEpzO0rMfYE4sis+5uBiEazcp0gpI=`.
- npm dependency hash: `sha256-3WPXD+qm5WVfrTEvepKwX5RZBfbLBcPB0uDmKIx4MR8=`.
- Package build/runtime uses the pinned Node 24.22.1 from `agent/dsh/environment.nix`;
  this supplies `DatabaseSync.limits` for SQLite and matches REA 6.8's engine range.
- The complete 229-tool ordered catalog is checked against compiled contracts and
  effects. The Pi MCP child sets `REA_MCP_INPUT_SCHEMA_PROFILE=full` so it advertises
  the full nested schemas, not the compact default.

The Pi controller still requires a human `/rea on` confirmation in an interactive
parent TUI. Each session starts off; REA tools and evidence guidance are removed on
`/rea off`, and child/subagent sessions do not inherit authorization. Its native
MCP source-hardening patch remains Pi-specific and separate from the REA package.

## Schema portability

REA 6.8 introduces a request-path lookahead unsupported by Rust's default regex
engine. `schema-portability-6.8.patch` changes only that expression to an equivalent
Rust-compatible form; `--fuzz=0` is enforced. The prior schema projection/ObjC
compatibility patches are historical and are not applied. The install check compares
the live full-profile MCP schemas with canonical Zod validation, JavaScript, Rust,
and AJV, including Unicode/newline fixtures.

## Package checks

The Nix install check runs:

- MCP doctor: healthy server identity, catalog digest, 229 tools and 6 prompts;
- Ghidra startup-budget strict parsing and cancellation propagation;
- schema portability over every input/output pattern;
- SQLite MCP bounded readonly inspection, unchanged input hash, and no sidecars.

`verify-runtime.mjs` additionally checks the installed file manifest, CLI/MCP
startup, real `tools/list`, and native PTY child spawn with an isolated HOME/PATH.
These checks do not claim that every catalog operation, optional engine, platform,
or real target has been exercised. `rea-installed-active.mjs` and the real Ghidra/
JavaScript/EVM tests are separate deployment gates; no live provider or user
credentials are used by the package checks.
