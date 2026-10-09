# Independent Pi REA Nix package

Traditional Home Manager module, no flake: `../rea.nix` now contains the
private REA package, patched Pi runtime and mode/composition checks together.
It is imported by `../pi.nix`. This directory retains only helper scripts and
documentation; the former standalone Nix recipes have been merged.

No global PATH, `rea setup`, `rea update`, installers, credentials or other
client configuration. DSH owns a separate recipe and tests; neither package
imports the other's files.

## Current upstream pin

- Version **6.1.0**; commit `4fb2f3e6ed0233505eada3cddeeff0ea0bfc6fe5`.
- Source hash: `sha256-NClYysftKb9mGjYFlLUWE8lyUC4eBFK1t4tI17e9hi8=`.
- Locked npm cache: `sha256-abg9mFUM4NvNZ97Ik92YYGGAY03ujhwomsvWq3q1ioQ=`.
- Node 24 is an absolute private executable. Upstream lockfile is unmodified.

## Patch review before upgrading

The local `ghidra-startup-budget.patch` was **removed**, not rebased:
upstream #974 now parses `REA_GHIDRA_STARTUP_TIMEOUT_MS`, forwards it to the
actual Ghidra client and preserves abort/cleanup. Invalid/unset values default
to 330000ms; valid positive safe integers are bounded by Node's 2147483647ms
maximum timer. This differs from our older decimal-only rejection/cap.
The adapted compiled regression verifies upstream behavior, real-client
pre-aborted cancellation and the 1800000ms setting, without launching a target.

Pi's **host-native MCP lifecycle source patch** is separate: it changes Pi
connection ownership, not REA. REA's provider fixes do not supersede it. It stays
in the `piRuntime` binding of `../rea.nix` with its compiled regression lane. The dist patch is
only a diagnostic companion, not an additional production patch.

## Build / contents

- Nix fixed npm cache; ignore dependency lifecycle rebuild and installer scripts.
- autoPatchelf native TypeScript/formatting tools and production PTY.
- Full `build:unlocked`: TypeScript, test catalog, generated skills, product
  catalog and completion ledger. Skills are generated from `skill-src/`.
- **No second tsc** and no compiled `generatedMcpToolCatalog.js`: upstream now
  intentionally excludes that test-only source from the production package.
- Prune dev dependencies offline, copy dist/bridge/skills/third_party/node_modules
  and packaged runtime helpers. Notices for EVMole/pwntools/pwndbg are retained.
- Compiled budget regression plus real production MCP doctor in scratch HOME
  with `PATH=/nonexistent`: **138 tools / 6 prompts** and version identity.

6.1 adds inspect_binary_layout, inspect_recorded_crash, inspect_evm_interface,
observe_native_calls and trace_dylib_resolution; removes set_current_document.
MCP host filesystem inputs are absolute; CLI operator-relative paths still work.
Artifact-internal selectors are not blanket-converted to host paths.

## Engines / verification limits

Ghidra/JDK/Chromium and EVM's util-linux prlimit are supplied explicitly only to
an authorized REA subprocess. GUI/default session environments remain unchanged.
No optional Python pwntools/pwndbg, Hopper, IDA or LLDB provider is installed by
this package. Catalog membership alone is not execution/provider coverage.

Build and runtime validation:

```sh
pkg=$(nix-build --no-out-link -E '
  let
    module = import /home/baizhu945/.config/home-manager/agent/pi/rea.nix {
      pkgs = import <nixpkgs> {};
      config = {};
    };
  in module.home.file.".pi/agent/extensions/rea-mode".source.rea')
scratch=$(mktemp -d /tmp/rea-runtime-verification.XXXXXX)
node rea-package/verify-runtime.mjs "$pkg" "$scratch"
```

`verify-runtime.mjs` checks actual stdio inventory, target-free call, negative
provider boundary, required packaged assets and real native PTY child creation.
See `../REA-VERIFICATION.md` for deployed native Pi pipeline and isolation tests.
The former 5.0.0 installation is historical, not the current package.
