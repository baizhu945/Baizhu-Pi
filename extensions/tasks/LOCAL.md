# Local Pi Tasks

Source: https://github.com/tintinweb/pi-tasks
Upstream revision: `29180d72498bdd77d5601dc77a9093d25da42102` (0.9.0).

This fork is deployed by `../tasks.nix` to `~/.pi/agent/extensions/pi-tasks/`.
The package entry is the root `index.ts` wrapper, matching the local Fusion and
subagents layout, so Pi's startup extension label is `pi-tasks`.
Edit this source and run `home-manager build` followed by `home-manager switch`.
No npm installation is required. The upstream media and GitHub workflows are
omitted; source, tests, license, documentation and lockfile are retained.

Pi 0.99.2 supplies the SDK, TUI and TypeBox. All three are declared as `"*"`
peer dependencies. TypeBox is only a development dependency; no runtime
`node_modules` is deployed. This prevents a second copy of host modules and
fixes the host-provided extension package warning.

Nix fetches the locked Vitest and Biome dependencies and runs lint, type checking
and the full upstream test suite against the exact installed Pi SDK, rather
than the upstream development pin. An installation check loads the resulting
package through Pi's real loader, checks that it has no warnings, and exercises
task creation, listing and completion without contacting a model.

The activation removes the legacy npm package. Task data and settings are
preserved.
