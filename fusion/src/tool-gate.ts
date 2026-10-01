import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FUSION_TOOL_NAMES = ["sidekick", "read_subagent"] as const;

/**
 * Pi cannot unregister a tool. Do not register optional tools until Fusion is
 * enabled, then remove only our own tools from the active set when disabled.
 * No prompt snippets/guidelines are registered, so inactive definitions do not
 * contribute to the system prompt either. Unrelated tools retain their order.
 */
export function createFusionToolGate(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
  register: () => void,
): { assertCanEnable(): void; enable(): void; disable(): void } {
  let registered = false;

  function assertCanEnable(): void {
    if (registered) return;
    const names = new Set(pi.getAllTools().map((tool) => tool.name));
    const collisions = FUSION_TOOL_NAMES.filter((name) => names.has(name));
    if (collisions.length > 0) {
      throw new Error(`Fusion tool names already belong to another extension: ${collisions.join(", ")}.`);
    }
  }

  function disable(): void {
    if (!registered) return;
    const active = pi.getActiveTools();
    const filtered = active.filter((name) => !FUSION_TOOL_NAMES.some((owned) => owned === name));
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
  }

  return {
    assertCanEnable,
    enable() {
      assertCanEnable();
      if (!registered) {
        register();
        registered = true;
      }
      const names = new Set(pi.getAllTools().map((tool) => tool.name));
      const missing = FUSION_TOOL_NAMES.filter((name) => !names.has(name));
      if (missing.length > 0) {
        disable();
        throw new Error(`Fusion tools excluded by the Pi tool selection: ${missing.join(", ")}.`);
      }
      const active = pi.getActiveTools();
      const added = FUSION_TOOL_NAMES.filter((name) => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...active, ...added]);
    },
    disable,
  };
}
