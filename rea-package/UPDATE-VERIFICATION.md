# REA 6.4.0 update verification — 2026-10-13

Traditional `home-manager build -f home.nix` and `home-manager switch -f home.nix`
completed; generation **2155**:
`/nix/store/b2wgak02yc7qa8mry8n16x06k17m18nc-home-manager-generation`.
GitHub HEAD checked at update start:
`a2d8b94dd50dab8d966239dd63ab84718aa8b4b4`, package6.4.0.

## Independent deployment / patch audit

Pi remains in consolidated `../rea.nix`; independent DSH recipe/config/helper
files do not import Pi. Existing user's Pi1.1.0 MCP source-hardening patch and
all unrelated defaults/models/permissions/AGENTS/skills are preserved.

The old REA schema patch is retired from both recipes: upstream fixes NUL,
ObjC bracket syntax, reserved environment names and normalized relative roots.
Old patch files are historical, not applied. Live full-schema regressions now
check187 canonical tools/effects,1346 schema patterns and105 unique patterns
withJS/Rust, plusAJV/Zod Unicode/NUL/newline boundaries and local-ref siblings.
Invalid/noncanonical startup values now fail closed; 30min/31min/8G private
analysis budgets remain unchanged.

Updated source/npm fixed hashes, compile+runtime bundle+generated skills build,
all bridge/dist workers/package imports/licenses/notices/scripts. Only unused
foreign musl CSS libc is exempted during native prebuild; selected GNU/production
binaries resolve. REA child wrapper privately supplies procps ps for current
owned-process verification. Nix prlimit is explicit for JS/EVM/firmware/TShark/
sigrok; no global agent PATH or optional provider installation.

## Final packages / identities

- Pi: `/nix/store/y5c6wvcdyk61rkrv8ykm75csixkgi22y-rea-agents-6.4.0`.
- DSH: `/nix/store/by9bpkq4ww2h02qpm37glhrlc7ainmq4-rea-agents-6.4.0`.
- Actual stdio doctor187 tools/6 prompts, healthy, exact name/catalog identity.
- Catalog digest:45b24a429e7b822cc4a3d48f9a75b6e9c4e73d343189b30cfcc55e1fd67d7a6b.
- Node24.21.0 SQLite native worker checks DatabaseSync.limits; a bounded selected-
  column readonly sample preserves sourceSHA and creates no source sidecars.

## Actual client / analysis tests

Final deployed Pi1.1.0 full loadout206 tools (19ordinary+187REA) accepted by real
openai-codex/gpt-6.1-sol. Guard allows one target-free binary_session read only;
model invokes it and repliesREA_READY. Credentials are used internally, not
printed. Initial staging network fetch failed transiently; retry and final
model tests pass. No target/runtime experiment was allowed by this model test.

Actual Pi SDK/native MCP pipeline: complete static JS graph, Ghidra12.1.2/JDK21
native function/CFG/call recovery and decompilation, EVMole inference, new
retained-Evidence summary then exact bytecode-page retrieval all pass. OFF
restores the previous tools/prompt and rejects subsequent direct/indirect calls;
original executableSHA and owned resource cleanup pass.

Pi14-extension/default19-tool complete first-request/schema/prompt neutrality,
15/15 child-exclusion regressions and nativeMCP8/8 lifecycle checks pass.
All28 existing all-plugin checks also passed during build.

DSH actual CLI/TUI SDK and Desktop peer graph both pass full suites: every
nonREA preset standard/ptc/minimal/cordis/codex full prompt/tools/schema/TS+Python
SDK/first requests equal, no cold MCP spawn; root parallel/child/default/preset
lock/failure/malformed/initialize+list cancellation/physical teardown/approval
and permissions preserved. Real JS, Ghidra, EVMole and retained-Evidence paging
pass. Codex74 source/runtime hashes equal the preupdate snapshot; instructions
retain b4826d27f737d141a5ca95f67e749dabbcfd0e068694888f7ea98e55c43bfd88.

## Boundaries / usage

187-operation catalog is not a187-operation or all-platform execution claim.
Optional Frida driver/Python/Hopper/IDA/ADB/etc. were not installed/activated;
no host device, arbitrary target or network/RPC endpoint was exercised.
Desktop hostSDK was tested, not a full Electron GUI click-through. Ordinary
headless stays unchanged. Old historical Evidence is not fabricated/upconverted.

Restart Pi (or `/reload`, then human `/rea on`) and restart DSH/selectREA in a new
session to replace old connections. DefaultOFF/preset and session history remain.

## Logs

- `/tmp/rea64-pi-package-build.log`, `/tmp/rea64-dsh-package-build.log`
- `/tmp/rea64-home-manager-build.log`, `/tmp/rea64-home-manager-switch.log`
- `/tmp/rea64-codex-deployed.log`, `/tmp/rea64-pi-deployed-functional.log`
- `/tmp/rea64-dsh-deployed-functional.log`, `/tmp/rea64-dsh-desktop-functional.log`
- `/tmp/rea64-pi-native-mcp-regressions.log`

Older local real-provider harness `../tests/rea-live.mjs` targets pre6.4 result
representations; it is not this version's integration gate or evidence claim.
Use current installed-active/schema/SQLite/retained-view tests instead.
