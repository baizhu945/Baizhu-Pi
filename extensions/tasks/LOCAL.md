# Local Pi Tasks

Source: https://github.com/tintinweb/pi-tasks
Upstream revision: `29180d72498bdd77d5601dc77a9093d25da42102` (0.9.0).

This fork is deployed by `../tasks.nix` to `~/.pi/agent/extensions/pi-tasks/`.
The package entry is the root `index.ts` wrapper, matching the local Fusion and
subagents layout, so Pi's startup extension label is `pi-tasks`.
Edit this source and run `home-manager build` followed by `home-manager switch`.
No npm installation is required. The upstream media and GitHub workflows are
omitted; source, tests, license, documentation and lockfile are retained.

Pi's Nix package supplies the SDK, TUI and TypeBox. All three are declared as `"*"`
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

The local.2 revision registers only TaskCreate, TaskList, TaskGet and TaskUpdate.
It tracks requirements, statuses, owners, dependencies and arbitrary metadata;
execution is performed by the main agent or another extension. Subagent RPC,
background output/stop tools, auto-cascade and the unused process tracker have
been removed. TaskCreate no longer has an agentType parameter. Task data is
preserved, including any older metadata, but no longer drives subagent execution.
Nix checks the remaining test suite and verifies all four deployed tool schemas
and prompts through Pi's real extension loader.

The local.3 revision coordinates Alt+W with pi-subagents: one shortcut folds or
expands the task widget, agent widget and fleet list. Collapsed widgets show a
summary; execution and task data are unchanged. Either plugin can run alone.
The event bus payloads are narrowed from the current SDK's unknown type.

Task forks copy nested metadata independently. Memory lists and widget metrics
reset at session boundaries. Shared-file seeding and empty cleanup recheck the
file under its lock; malformed persisted data cannot be overwritten by a
mutation. Atomic writes use private, unique temporary files. Metadata keys do
not alter prototypes, and unsafe session IDs cannot escape the task directory.
The startup sweep respects autoClearCompleted: never. Widget limits and terminal
control characters are handled without changing the underlying task text.

Further local audit: project settings now use private atomic writes and refuse to replace malformed existing JSON. Full Biome/type/Vitest checks include these cases.
