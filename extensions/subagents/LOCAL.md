# Local Pi Subagents

This source is deployed by `../subagents.nix` as the local pi-subagents fork.

The 0.19.0-local.2 revision adds linked Alt+W folding for tasks, above-editor
agents and the below-editor fleet. It preserves running work and uses a single
shortcut regardless of load order. Late-loaded widgets inherit the current
state; disposed widgets cannot recreate timers.

New/resumed/forked sessions stop the outgoing session's agents and workflows,
clear queued notifications and usage, and ignore late completion callbacks.
Already-cancelled starts/resumes do not contact a model. Queued resumes remain
interruptible. Worktree cleanup failures preserve the directory and explain its
path; completion is reported after verification/cleanup, and worktree gates
still run against the child's actual checkout. Nested children execute the
definition resolved in their branch, including its prompt and tool restrictions.

Schedule storage protects concurrent writers and damaged files. Far-future
one-shots wait in bounded timer chunks, and cron validation leaves no timer.
Unsafe filesystem IDs and agent filenames cannot traverse storage roots.
Agent file toggles and scalar serialization preserve valid YAML. Project agent
discovery and UI saves use the session's workspace. Public RPC spawns cannot
forge internal queue/config capabilities, and model objects resolve through the
registered model definition rather than payload URLs or headers.

Workflow globals, promises and errors now stay inside the VM realm, closing the
worker Function-constructor bypass. Global Date aliases cannot read the current
clock. The VM remains an execution/determinism boundary, not an OS permission
sandbox; authorized agent tools still have their configured filesystem access.

Nix runs plugin-integrity.mjs plus actual Pi failure-recovery and notification
tests on the installed package. Tests use temporary fixtures and fake providers,
without external services or production credentials.

The 0.19.0-local.1 revision addresses failures seen in the 2026-10-04 session:
OpenRouter `stealth/space-bunny-alpha` repeatedly returned `Upstream idle timeout
exceeded` while children prepared large reports. The parent received the children’s
progress text in `task_error`, hiding the actual provider error. Resuming those
children with smaller file writes recovered their reports.

- Failed notifications now put the real error in `task_error` and preserve any
  progress or partial answer separately in `partial_output`. Collapsed rows also
  show the error, including for older saved notifications that kept it in details.
- Ordinary child prompts recommend small, verified writes for large artifacts.
  On the first idle-timeout retry of each spawn/resume invocation, the runner
  queues a continuation hint through Pi’s public steering API. It preserves the
  task context and asks for chunked writes without blindly replaying file edits.
  The existing retry settings remain authoritative; no extra retry loop or model
  fallback is introduced. Persistent provider failures are still reported as errors.
- A failed provider response does not trigger the separate structured-output
  format retry. Successful prose/schema mismatch responses still get that retry.

`tests/subagent-failure-recovery.mjs` runs actual Pi parent/child sessions using a
deterministic in-memory provider. It covers transient and persistent timeouts,
concurrent children, retries disabled, authentication errors, ordinary service
retries, resume, cancellation during backoff and structured output. Nix checks
the built package with those tests and the notification renderer regressions.
The existing completion-batching suite additionally covers inference/tool-call
boundaries, idle parent wake-up, group/workflow delivery and RPC consumption.

Further local audit: project settings use private UUID temporary files and atomic rename; malformed existing settings are preserved and save failure is surfaced by the existing UI.
