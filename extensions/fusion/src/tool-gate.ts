import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FUSION_TOOL_NAMES = ["sidekick", "read_subagent"] as const;

/** Optional tools are registered lazily and only our own active names removed. */
export function createFusionToolGate(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
  register: () => void,
): { assertCanEnable(): void; enable(): void; disable(): void } {
  let registered = false;
  const owned = new Map<string, string | undefined>();
  const infos = () => new Map(pi.getAllTools().map(tool => [tool.name, tool]));
  const pathOf = (tool: ReturnType<ExtensionAPI["getAllTools"]>[number] | undefined) => tool?.sourceInfo?.path;
  const owns = (name: string, tools: ReturnType<typeof infos>) =>
    owned.has(name) && (!tools.has(name) || pathOf(tools.get(name)) === owned.get(name));

  function assertCanEnable(): void {
    const tools = infos();
    const collisions = FUSION_TOOL_NAMES.filter(name => tools.has(name) && !owns(name, tools));
    if (collisions.length > 0) {
      throw new Error(`Fusion tool names already belong to another extension: ${collisions.join(", ")}.`);
    }
  }

  function disable(): void {
    if (!owned.size) return;
    const tools = infos();
    const active = pi.getActiveTools();
    const filtered = active.filter(name => !owns(name, tools));
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
  }

  return {
    assertCanEnable,
    enable() {
      assertCanEnable();
      if (!registered) {
        const before = infos();
        try {
          register();
          const after = infos();
          for (const name of FUSION_TOOL_NAMES) owned.set(name, pathOf(after.get(name)));
          registered = true;
        } catch (error) {
          // A registrar can throw after installing its first tool. Capture only
          // newly added, preflight-absent names so rollback cannot leak that tool
          // or remove an unrelated pre-existing registration.
          const after = infos();
          for (const name of FUSION_TOOL_NAMES) {
            if (!before.has(name) && after.has(name)) owned.set(name, pathOf(after.get(name)));
          }
          disable();
          throw error;
        }
      }
      const tools = infos();
      const missing = FUSION_TOOL_NAMES.filter(name => !tools.has(name));
      if (missing.length > 0) {
        disable();
        throw new Error(`Fusion tools excluded by the Pi tool selection: ${missing.join(", ")}.`);
      }
      assertCanEnable();
      const active = pi.getActiveTools();
      const added = FUSION_TOOL_NAMES.filter(name => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...active, ...added]);
    },
    disable,
  };
}
