import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The capability profile for one in-process child session.
 *
 * It is captured by child extensions while they are loaded. Environment
 * variables cannot represent this safely because multiple subagents may load
 * concurrently in the same Pi process; AsyncLocalStorage keeps each profile
 * attached to the right loader without mutating process-global state.
 */
export interface ChildSessionPolicy {
  /** Built-in and injected custom tools explicitly admitted to this child. */
  allowedTools: readonly string[];
  /** Whether tools from the child's selected extensions are admitted. */
  allowExtensionTools?: boolean;
}

/**
 * Keep the store discoverable by sibling extensions without importing this
 * fork through a Home Manager store path. Home Manager links each extension
 * source file to a different Nix store path, so a relative import from
 * permission-gate.ts would not reliably resolve to this module. The symbol is
 * process-local and AsyncLocalStorage still provides isolation for concurrent
 * child loads.
 */
const CHILD_SESSION_POLICY_KEY = Symbol.for("pi-subagents:child-session-policy");
const globalState = globalThis as typeof globalThis & {
  [CHILD_SESSION_POLICY_KEY]?: AsyncLocalStorage<ChildSessionPolicy>;
};
const childSessionContext =
  globalState[CHILD_SESSION_POLICY_KEY] ?? new AsyncLocalStorage<ChildSessionPolicy>();
globalState[CHILD_SESSION_POLICY_KEY] = childSessionContext;

/** Marks resource loading/session construction performed for a subagent. */

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() !== undefined;
}

export function getChildSessionPolicy(): ChildSessionPolicy | undefined {
  return childSessionContext.getStore();
}

export function runInChildSessionContext<T>(
  fn: () => Promise<T>,
  policy: ChildSessionPolicy = { allowedTools: [] },
): Promise<T> {
  return childSessionContext.run(policy, fn);
}
