# REA Codex regex schema fix — 2026-10-09

Deployed by traditional `home-manager build` then `home-manager switch`:
**generation2151**,
`/nix/store/mawrvf5amvjl1ayyqbbh6mymkw4h7w8d-home-manager-generation`.
REA remains6.1.0, pinned4fb2f3e; Pi declarations remain consolidated in `../rea.nix`.

## Cause / exact reproduction

Session `2026-10-09T05-54-00-352Z_01a11f39-be1f-7491-8824-56fd1e6c2a28.jsonl`,
line8: openai-codex/gpt-6.1-sol rejected observe_native_calls at schema validation,
before inference/tool execution. Original ObjC-name regex `^[^\s[\]]+$` is valid
JavaScript but has an unescaped nested bracket for stricter regex parsers.
Rust regex reproduces an unclosed character class. A real restricted Codex smoke
reproduced the user's exact error: `/tmp/rea-schema-codex-before.log`.

DSH also forwards this upstream input schema unchanged, so it has the same risk.
Its package owns a separate local patch and gate; no Pi file/config import.

## Fix without weakening arguments

- Equivalent canonical ObjC bracket escaping `^[^\s\[\]]+$`.
- Pure schema-only input/output projection for known NUL spellings: `\0` ->
  `\x00`. Runtime canonical Zod constraints remain intact.
- Known negative lookaheads translated to equivalent JSON Schema not/allOf:
  exact reserved REA_PROCESS_RUN_ID remains forbidden in process captures;
  forbidden relative root paths remain forbidden.
- Preserve examples/defaults/descriptions as data, existing constraints,
  patternProperties collision intersections and metadata/memoization.
- Do not hide observe_native_calls or reduce the138-tool catalog.

Actual production MCP tools/list install gates cover all input/output schema
positions:1171 pattern occurrences,91 unique patterns compile in JavaScript
and Rust. CanonicalZod versusAJV fixtures, Unicode/NUL/newline boundary cases,
short-string exhaustive comparisons, immutability/idempotence checks pass.
Rust compilation alone is not treated as proof of Codex acceptance.

## Real model and provider validation

After switch, the real deployed full Pi loadout (19 ordinary +138REA =157tools)
is accepted by **openai-codex/gpt-6.1-sol**. It actually calls binary_session once
and replies REA_READY. All other calls blocked, ephemeral test session;
credentials not printed. `/tmp/rea-regex-codex-deployed.log`.

Real Pi pipeline JS, Ghidra12.1.2/JDK21 decompilation/CFG/calls and offline EVMole
inspection pass, then OFF restores tools/prompt and owned resource cleanup.
14-extension/default full first-request neutrality and child15/15 gates pass.
Existing native MCP lifecycle/cancellation regressions8/8 remain passing.

DSH CLI/TUI and Desktop Host SDK peer graph suites pass: every discovered
nonREA preset standard/ptc/minimal/cordis/codex retains complete tools/schema/
prompt/PTC SDK/first requests; parallel roots, children, failure rollback,
initialize/tools-list cancellation, approval and physical teardown pass.
Actual JS/Ghidra/EVMole calls pass. No full Electron GUI click-through claim.
Codex source/runtime hashes are checked separately; native preset not modified.

## Current packages / logs

- Pi: `/nix/store/6pc12fgbdxvggigpk4cr24g5bd6mlz1q-rea-agents-6.1.0`.
- DSH: `/nix/store/2dqf5yz2nwc7sqm5jw1vzq5mn7bvc6r8-rea-agents-6.1.0`.
- Catalog digest: `b9885d4ed3d65793bc483c7b80a04a8cbc71dae2a68d286e36eb472eb972f108`.
- `/tmp/rea-regex-home-manager-build.log`, `/tmp/rea-regex-home-manager-switch.log`
- `/tmp/rea-regex-pi-functional.log`, `/tmp/rea-regex-dsh-functional.log`
- `/tmp/rea-regex-desktop-functional.log`, `/tmp/rea-regex-native-mcp-regressions.log`

Restart Pi or `/reload`, then explicitly `/rea on` again: an already-running
extension/MCP connection does not replace itself when Home Manager switches.
Restart DSH and select REA in a new session. Existing session history is kept.
Optional LLDB/macOS operation execution is not claimed on this Linux host;
its valid schema stays advertised rather than breaking unrelated REA use.
