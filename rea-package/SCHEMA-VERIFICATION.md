# Pi REA schema verification

## Current pin: REA 6.8.0

GitHub release revision: `160d821ac9a0310afcb8d1fc427862dd6508add5`.
The Pi child process sets `REA_MCP_INPUT_SCHEMA_PROFILE=full`; compact defaults
would omit nested parameter constraints. Its Nix install check audits the live
MCP 229-tool input/output schemas against canonical Zod, JavaScript, Rust and
AJV, including Unicode/newline boundaries.

REA 6.8 adds one request-path lookahead that JavaScript accepts but Rust's
standard regex engine rejects. `schema-portability-6.8.patch` changes only that
pattern to an equivalent Rust-compatible expression; Nix requires `--fuzz=0`.
The earlier `schema-portability.patch` and its ObjC/projection repairs are
historical only and are not applied to 6.8. The Nix install check also runs the
Ghidra budget/cancellation and SQLite read-only smoke tests. A passing schema
check does not prove every third-party model client's schema admission.

The 6.8 Pi package build has not yet been recorded in this file. Real model,
provider, target-analysis and Home Manager activation checks remain separate.

## Historical 6.1.0 verification — 2026-10-09

The prior 6.1 Pi deployment used generation 2151:
`/nix/store/mawrvf5amvjl1ayyqbbh6mymkw4h7w8d-home-manager-generation`.
That release required ObjC bracket escaping and several schema projections;
those fixes were later adopted or superseded upstream. Its 138-tool counts,
store paths and Codex smoke results are historical and are not acceptance
criteria for 6.8.0.
