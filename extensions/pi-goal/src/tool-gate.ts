import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_BLOCKED_TOOL, GOAL_COMPLETE_TOOL, GOAL_TOOL_NAMES } from "./tool-policy.js";

export interface GoalToolGate {
  readonly registered: boolean;
  enable(names?: readonly string[]): void;
  disable(): void;
}

/** Register on explicit activation; remove only this extension's own tools. */
export function createGoalToolGate(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
  register: () => void,
): GoalToolGate {
  let registered = false;
  const owned = new Map<string, string | undefined>();
  const infos = () => new Map(pi.getAllTools().map(tool => [tool.name, tool]));
  const pathOf = (tool: ReturnType<ExtensionAPI["getAllTools"]>[number] | undefined) => tool?.sourceInfo?.path;
  const owns = (name: string, tools: ReturnType<typeof infos>) =>
    owned.has(name) && (!tools.has(name) || pathOf(tools.get(name)) === owned.get(name));
  const disable = () => {
    if (!owned.size) return;
    const tools = infos();
    const active = pi.getActiveTools();
    const filtered = active.filter(name => !owns(name, tools));
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
  };
  const assertNoCollisions = () => {
    const tools = infos();
    const collisions = GOAL_TOOL_NAMES.filter(name => tools.has(name) && !owns(name, tools));
    if (collisions.length) throw new Error(`Goal tool names already belong to another extension: ${collisions.join(", ")}.`);
  };

  return {
    get registered() { return registered; },
    enable(names = GOAL_TOOL_NAMES) {
      assertNoCollisions();
      if (!registered) {
        const before = infos();
        try {
          register();
          const after = infos();
          for (const name of GOAL_TOOL_NAMES) owned.set(name, pathOf(after.get(name)));
          registered = true;
        } catch (error) {
          const after = infos();
          for (const name of GOAL_TOOL_NAMES) {
            if (!before.has(name) && after.has(name)) owned.set(name, pathOf(after.get(name)));
          }
          disable();
          throw error;
        }
      }
      assertNoCollisions();
      const tools = infos();
      // goal_wait is optional in upstream's tool policy; preserve restrictive
      // Pi selections instead of requiring or reintroducing excluded tools.
      const required = names === GOAL_TOOL_NAMES ? [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] : names;
      const missing = required.filter(name => !tools.has(name));
      if (missing.length) {
        disable();
        throw new Error(`Goal tools excluded by the Pi tool selection: ${missing.join(", ")}.`);
      }
      const active = pi.getActiveTools();
      const selected = active.filter(name => !owns(name, tools) || names.includes(name));
      const added = names.filter(name => tools.has(name) && owns(name, tools) && !selected.includes(name));
      if (added.length || selected.length !== active.length) pi.setActiveTools([...selected, ...added]);
    },
    disable,
  };
}
