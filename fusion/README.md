# Local Fusion — model-neutral when disabled

Vendored from UniPi `@pi-unipi/fusion` 2.20.5, commit
`6d696efed65f7638fd2a23020b119dc7a32aad49`:
https://github.com/Neuron-Mr-White/UniPi/tree/6d696efed65f7638fd2a23020b119dc7a32aad49/packages/fusion

The Fusion source and required core/pi-spawn helpers live in this directory.
They are not fetched or patched during deployment. Upstream's MIT license is
retained in `LICENSE`. The only external runtime dependency is TypeBox 1.3.7,
whose npm tarball and fixed hash are declared in `../fusion.nix`. Pi supplies
its SDK/TUI modules. The implementation is checked against the Pi package in
Nixpkgs on every build (currently Pi 0.87.1).

## Declarative deployment

`../pi.nix` imports `../fusion.nix`, which packages `src = ./fusion` and deploys
it with recursive `home.file` to `~/.pi/agent/extensions/pi-fusion/`, following
the local `pi-subagents` layout. There is no npm package-manager installation,
GitHub fetch, flake, or imperative edit of Pi's settings/resources.

After a Home Manager switch, restart Pi or run `/reload`.
Do not load the original UniPi Fusion extension alongside this local copy.

## Commands and behavior

- `/unipi:fusion-preset`: select lead/sidekick candidates.
- `/unipi:model`: select a Fusion pair or an ordinary single model.
- `/unipi:fusion-stats`: view sidekick token usage and savings estimates.

When Fusion is enabled, the upstream picker, pair/thinking-level persistence,
lead and sidekick policies, edit/bash nudges, RPC sidekick, blocking/background
handoffs, steering, live transcript rendering and savings calculations remain.
The sidekick is lazy-spawned only when a handoff is sent. It has an independent
persistent session and uses the same machine/worktree. The upstream child
flags, including `--no-skills`, are unchanged.

When Fusion is disabled:

- A fresh extension load registers **no model tools**. There are no resource
  discovery hooks, skills, prompt templates, prompt snippets or guidelines.
- `before_agent_start` returns nothing, and `tool_result` does not alter results.
- Neither model nor thinking level is changed automatically for a single/empty
  active selection.
- Enabling registers `sidekick` and `read_subagent` lazily. Disabling removes
  only those owned names from the active tools, preserving all unrelated tools
  and their order (including changes made by other extensions while enabled).
- Existing tools with the same names are never overwritten or hidden; Fusion
  refuses activation in that case. Tool allowlists excluding a Fusion tool
  cannot leave the mode half-enabled.
- A completed/aborted old handoff cannot inject a follow-up or wake the lead
  after disabling Fusion or replacing its runtime.

Pi has no public tool-unregister API. After the first activation the tool
registrations remain in Pi's internal registry, **inactive and not sent to the
model**. A fresh disabled load does not register them at all. UI commands and
`/model` autocomplete still exist; these are not model tools or prompt text.

To turn Fusion off even when retaining the same lead model, select that model
as an ordinary single row in `/unipi:model`. The upstream behavior is preserved:
Pi's native `/model` only exits Fusion when selecting a different model.

## Runtime state and guarantee boundary

Global preset/state: `~/.unipi/config/fusion/preset.json`.
Project override: `<cwd>/.unipi/fusion-preset.json`.
Sidekick session: `~/.unipi/state/fusion/sidekick/<lead-session-id>.jsonl`.
These mutable runtime files are not Nix-managed, because the picker writes them.

A persisted `active.kind = "fusion"` restores enabled mode at startup, just
like upstream. Lists or a default pair alone do not enable it.

"Model-neutral" means that with equivalent session/configuration, a disabled
extension contributes no tools/schemas, skills, prompt text or context messages.
Tests compare the actual cold-start LLM request context, not just a tool count.
This does not promise deterministic LLM outputs or undo the effects of earlier
Fusion usage: existing conversation/tool results and filesystem changes remain.
Disabling changes the current tool/prompt loadout; it does not erase history.

## Tests

No model API calls, user credentials, production state or network are required.
The integration test uses the actual Pi extension loader, session runtime,
prompt builder and a local fake stream. Other upstream runtime tests use stub
child processes, not a real sidekick model.

```sh
node tests/run.mjs /path/to/pi-package
```

The Pi package directory contains `dist/index.js` and `node_modules/`.
`fusion.nix` runs the upstream/local regression suite in `checkPhase`, then
checks the installed extension again in `installCheckPhase`. The autocomplete
regression suite uses Pi's real `CombinedAutocompleteProvider`, the local
subagents mention wrapper in both composition orders, and `Editor.handleInput`
with Tab/Enter. It checks prototype methods, private `this` state, optional
file-completion behavior and trigger getters, not only suggestions.

Local revision `2.20.5-local.2` fixes an upstream UI bug: spreading a class
provider with `{ ...current }` drops its prototype `applyCompletion()` and
`shouldTriggerFileCompletion()`. The wrapper now delegates these methods to
the original instance. This prevents every slash-command completion from
crashing when the subagents wrapper sits outside Fusion.

There is also an optional no-terminal integration test for the actual installed
pi-open-tui editor (no extension startup, credentials or model calls):

```sh
node tests/open-tui-completion.mjs /path/to/pi-package /path/to/subagents /path/to/pi-open-tui
```
