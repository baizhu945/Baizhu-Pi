/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for research and implementation.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Read-only agent for file, symbol, and codebase searches.",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      // No model pin: Explore inherits the parent session's model.
      systemPrompt: `Search and analyze the codebase without changing files or system state, including temporary files. Use find/grep/read for searches and reading; bash only for read-only inspection. Return concise findings with absolute file paths. Adapt search depth to the task.`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
  [
    "Plan",
    {
      name: "Plan",
      displayName: "Plan",
      description: "Read-only architect that produces implementation plans, critical files, and trade-offs.",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      systemPrompt: `Explore the codebase and produce an implementation plan with steps, dependencies, trade-offs, and critical file paths. Do not change files or system state, including temporary files. Use find/grep/read for inspection; bash only for read-only commands.`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
]);
