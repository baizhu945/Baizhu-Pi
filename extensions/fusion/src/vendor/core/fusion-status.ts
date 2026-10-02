/**
 * @pi-unipi/core — shared Fusion display status
 *
 * The fusion package owns the active lead/sidekick selection; the footer
 * package owns the input-box frame that should display it. Same pattern as
 * background-tasks' shared registry: a Symbol.for global published at
 * extension init / session start and cleared on shutdown.
 */

export interface SharedFusionStatus {
  /** Display name of the lead (the session model). */
  leadName: string;
  /** Lead thinking level, e.g. "medium". */
  leadEffort: string;
  /** Display name of the sidekick. */
  sidekickName: string;
  /** Sidekick thinking level. */
  sidekickEffort: string;
  /** Estimated savings compared with pricing all sidekick usage at lead rates. */
  savedUsd?: number;
  /** A handoff is running on the sidekick right now. */
  busy?: boolean;
  /** Tool calls made directly by the lead in this session while Fusion was active. */
  leadToolCalls?: number;
  /** Tool calls made by the sidekick across all handoffs (completed + in flight). */
  sidekickToolCalls?: number;
}

const KEY = Symbol.for("unipi.fusion.status");

type Holder = { status?: Readonly<SharedFusionStatus> | undefined; owner?: symbol | undefined };

function holder(): Holder {
  const g = globalThis as { [KEY]?: Holder };
  g[KEY] ??= {};
  return g[KEY] as Holder;
}

/**
 * Publish a detached snapshot. Optional factory-owned tokens protect cleanup:
 * a clear only succeeds for the current owner (legacy unowned calls still work).
 */
export function setSharedFusionStatus(status: SharedFusionStatus | undefined, owner?: symbol): void {
  const current = holder();
  if (status === undefined) {
    if (current.owner !== owner) return;
    delete current.status;
    delete current.owner;
    return;
  }
  current.status = Object.freeze({ ...status });
  current.owner = owner;
}

/** A frozen, detached copy; callers cannot mutate another extension's status. */
export function getSharedFusionStatus(): Readonly<SharedFusionStatus> | undefined {
  const status = holder().status;
  return status === undefined ? undefined : Object.freeze({ ...status });
}
