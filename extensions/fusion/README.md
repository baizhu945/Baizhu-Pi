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
- Global/project picker preferences never grant authorization. A new session,
  a fork/clone, or any resumed session without its own explicit opt-in remains
  disabled, even if `preset.active.kind` says `fusion`.
- Neither model nor thinking level is changed automatically in an unauthorized
  session.
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

Global picker preferences: `~/.unipi/config/fusion/preset.json`.
Project preference override: `<cwd>/.unipi/fusion-preset.json`.
Sidekick session: `~/.unipi/state/fusion/sidekick/<lead-session-id>--<scope>.jsonl`.
These mutable runtime files are not Nix-managed, because the picker writes them.
Session identifiers are sanitized before use, so a hostile session id cannot
write outside that directory.

Activation is separate from those preferences. Explicit confirmation in
`/unipi:model` writes a non-context `fusion-session-state` custom session entry
with schema, exact session ID and selection. Only that consenting session's
active branch may restore it. Forks/clones cannot inherit the parent's opt-in;
choosing a single model revokes it. A native model change while the extension
was unloaded also revokes an older opt-in, even when switching back later.
Malformed/latest state fails closed. Old global `active.kind = "fusion"` values
are deliberately not migrated into authorization; explicitly choose the pair
once in each session that should use Fusion. Opening/cancelling the picker
never activates it. Authorization entries are not sent to the model.

Navigating the session tree (`/tree`) ends Fusion for that conversation: the
pair is revoked and the next confirmation starts a new sidekick session file, so
work never crosses between abandoned and resumed branches.

The picker overlays need an interactive terminal. In RPC mode they report that
requirement instead of throwing, and they never change the model, tool set or
session state.

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
child processes, not a real sidekick model. An additional integration test uses
the actual local background-commands extension and real SDK events with fake
model streams, runs only two harmless local printf commands, and verifies that
a batched completion reaches the parent once with the final follow-up report.

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

Local revision `2.20.5-local.3` fixes background completion and session consent:

- Track each bg_run call/job ID, recognize both `background-command-result`
  batches and legacy `background-task-notification`, deduplicate results, and
  handle early notifications, failed launches and accepted cancellation.
- A busy redirect uses RPC prompt with steering behavior: it can wake an idle
  child instead of merely enqueueing a message that never runs.
- Correlate prompt/report/abort/state responses by request ID, retrieve a report
  on abort acknowledgement, and bound final-report queries, prompt acceptance
  and abort acknowledgement by timeouts.
- Global pair memory no longer auto-enables unrelated sessions (see above).

Local revision `2.20.5-local.4` hardens the paths found by a full review:

- RPC: stdin/stdout/stderr errors and async write failures end one error report
  instead of crashing pi; UTF-8 is decoded across chunk boundaries; a settled
  child can be respawned after a signal exit; a settled run can no longer be
  completed by another brief's stale `agent_settled`; SDK retry success clears a
  stale assistant error; handler failures are no longer hidden as bad JSON;
  oversized RPC records, display text and report history are bounded, and a
  report above 64 KiB is archived with its path instead of being truncated
  silently.
- Delivery: each waiter owns its own token, so a parallel non-blocking call can
  no longer both consume a report and drop its completion, and a waiter that
  detaches and reattaches can no longer lose the only delivery attempt. Wait
  loops subscribe once, clear their timers, and recheck abort/pending state.
  Failures throw as the host expects instead of relying on a returned
  `isError`, so real tool errors are recorded once and details stay available.
- Storage: preference writes take an exclusive lock and merge into the newest
  file (no cross-session lost updates), malformed or unreadable existing files
  are never silently replaced, temporary files are unpredictable and
  `0600`, and estimates are `unknown` rather than `NaN`/`Infinity`. A busy lock
  reports how to verify and remove an abandoned one; it is never removed
  automatically.
- Controls: `/unipi:model` and `/unipi:fusion-preset` refuse non-interactive
  modes, results from a replaced session are discarded, and a failed consent
  write leaves Fusion off. Tree navigation revokes the pair and starts a fresh
  sidekick conversation.
- UI: terminal-width correctness for CJK/emoji/ANSI (including the wake line
  and overlay frames), `Shift+Tab` focus cycling, an editable sidekick effort,
  stable selection after preset toggles, `Space`/`Ctrl+Space` handling, and
  no `$NaN` prices.

There is also an optional no-terminal integration test for the actual installed
pi-open-tui editor (no extension startup, credentials or model calls):

```sh
node tests/open-tui-completion.mjs /path/to/pi-package /path/to/subagents /path/to/pi-open-tui
```
