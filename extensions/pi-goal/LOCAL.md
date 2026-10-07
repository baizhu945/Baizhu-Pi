# Local Pi Goal

Based on `@narumitw/pi-goal` 0.54.8. Home Manager deploys `index.ts` and `src/`
with the same pinned runtime dependencies. Pi's TypeScript loader loads the
source directly; the original generated `dist/` is no longer deployed.

An unused Goal extension registers its `/goal` command and lifecycle hooks but
no model tools. Starting or resuming a goal registers and enables `goal_complete`,
`goal_blocked`, and `goal_wait`. Pausing, clearing, completing, or restoring an
inactive goal removes this extension's tools from the model's active selection.
Other extensions' tool selections and conflicting names are preserved.

Inactive mode does not append a Goal contract or modify the system prompt.
Obsolete `goal-contract` messages are omitted from subsequent model requests;
ordinary user/assistant messages and actual past tool results remain in history.
An explicitly active saved Goal session still restores its tools and contract.

`test/neutrality.mjs` uses the installed Pi loader, session runtime and a fake
provider stream. It compares the full request context for absent and loaded-but-
unused extensions, exercises mode transitions and checks tool collisions and
denylist behavior. It makes no model or network calls and runs during the Nix
installation check.

Local revision 0.54.8-local.2 adds locked/private atomic settings and legacy cleanup, preserves malformed state, releases workflow listeners on unbind, re-arms long wait deadlines and preserves apostrophes in natural objectives.
