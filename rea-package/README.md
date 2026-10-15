# Private Pi REA package

Traditional Home Manager: `../rea.nix` contains REA, the existing patched Pi
runtime and all mode/composition checks. No separate package Nix module, flake,
global PATH installation, `rea setup` or automatic activation. DSH owns its
independent recipe and helper files; neither configuration imports the other.

## Current pin

REA **6.4.0**, GitHub checkpoint `a2d8b94dd50dab8d966239dd63ab84718aa8b4b4`.
Source: `sha256-z9Hgl8LiXkgVmO8zyGOkXlLXPZM+jxFmeNDmHUfTJnw=`.
Locked npm cache: `sha256-NNK1RLvEDF7Cj4BebTbEx5MNCEHZc2KQTmaoKmpAMYw=`.
Node24 private absolute executable; upstream lockfile unchanged.

## Patch review

Ghidra startup and all previously patched schema patterns are now fixed upstream.
The old `schema-portability.patch` is retained as historical review material but
**not applied**. Do not rebase its obsolete outbound-projection repair onto6.4.
Portable NUL/ObjC patterns, normalized relative-root validation and reserved
process-run key restrictions belong to upstream canonical validators now.
Live official MCP JS/Rust/AJV and Unicode/newline boundary checks remain mandatory.

Timeout parsing now accepts only canonical positive decimal milliseconds up to
Node's2147483647ms timer bound; unset Ghidra default330000ms, invalid input fails
closed. Authorized private configuration preserves1800000ms/1860s/8G.
The user's Pi1.1.0 native MCP source-hardening patch stays separate and unchanged;
it is not superseded by REA's own provider changes.

## Build and assets

Locked offline npm cache and lifecycle scripts ignored. autoPatchelf selects GNU
natives; only the unused optional musl LightningCSS libc is exempt during the
prebuild pass. Build uses `compile` (tsc plus original-location-preserving runtime
bundles) then `artifacts:skills`, not removed `build:unlocked` or Turbo workflows.
Ship all original/bundled dist workers, bridge adapters, generated skills,
third_party/licenses, disclaimers/notices and package imports/metadata/helper
scripts. Keep test-only generatedMcpToolCatalog.js out of production.

REA6.4 owned subprocesses require a procps-compatible ps. The private executable
prepends Nix procps for that child only. JavaScript/EVM/firmware/TShark/sigrok
limiter settings use explicit Nix util-linux prlimit; no host /usr/bin assumption.
No optional ADB/Frida driver/IDA/Hopper/Python/tshark/sigrok engine is installed
or activated just because its operation appears in the187-tool catalog.

## Verification

Both independent packages check real stdio **187 tools /6 prompts**, canonical
name/effects equality, strict startup parsing/client forwarding/cancellation,
all full-profile input/output patterns with JS and Rust, and canonical/AJV
Unicode/NUL/newline fixtures. SQLite smoke uses Node24.15+ DatabaseSync.limits,
a selected-column readonly sample, unchanged input SHA and no source sidecars.
Other public/API/native-pipeline tests are in `../tests/` and the deployment report.

```sh
pkg=$(nix-build --no-out-link -E '
  let module = import /home/baizhu945/.config/home-manager/agent/pi/rea.nix {
    pkgs = import <nixpkgs> {}; config = {};
  }; in module.home.file.".pi/agent/extensions/rea-mode".source.rea')
scratch=$(mktemp -d /tmp/rea-runtime-verification.XXXXXX)
node rea-package/verify-runtime.mjs "$pkg" "$scratch"
```

MCP6.4 analysis delivers Evidence directly (`normalized_result`, `provider`,
identity/provenance), while session status remains in `result` and groups tool
availability. Summary is opt-in; retained-Evidence paging is tested, not a reason
to fabricate old Evidence metadata. Catalog coverage is not all187 operations or
all-platform execution coverage. Models/defaults/skills/permissions remain intact.
