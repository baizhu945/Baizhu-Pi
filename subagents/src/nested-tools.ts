import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildAgentRegistry,
  getAgentConfigIn,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import {
  createOutputFilePath,
  getOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "./output-file.js";
import type {
  AgentConfig,
  AgentInvocation,
  AgentRecord,
  IsolationMode,
  ThinkingLevel,
} from "./types.js";
import { addUsage } from "./usage.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/**
 * Hard ceiling on nesting for every branch: main session = 0, its subagents = 1,
 * their children = 2. `0`/`1` disables nesting entirely. Set from
 * `subagents.json` (`maxSubagentDepth`). Read when a subagent session is built,
 * so a change applies to sessions started after it.
 */
let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void {
  if (!Number.isSafeInteger(n)) return;
  maxSubagentDepth = Math.max(0, n);
}

const NESTED_TOOL_NAMES = ["Agent", "steer_subagent"] as const;

interface NestedSpawnOptions {
  description: string;
  model?: Model<any>;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onSessionCreated?: (session: AgentSession) => void;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd?: string;
  rootSessionId?: string;
}

export interface NestedAgentManager {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: NestedSpawnOptions,
  ): string;
  /** Resolves once the spawned agent is running; rejects on a startup failure. */
  awaitStartup(id: string): Promise<void>;
  getRecord(id: string): AgentRecord | undefined;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** "all" = any enabled agent; string[] = only those types. Never empty. */
  allowedSubagents: "all" | string[];
  /** Root used for agent/config discovery; may differ from the agent's working directory. */
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  // Agents resolve from a registry built for THIS branch's config root (under
  // worktree isolation, the copy). Never via registerAgents — that is
  // process-global state shared with the main session and every other agent.
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent.", minLength: 1 }),
      description: Type.String({ description: "Short 3-5 word task description.", minLength: 1 }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.`, minLength: 1 }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Reloaded per call so new agent files are picked up without a restart.
      const registry = loadRegistry();
      const rawType = params.subagent_type;
      // Strict resolve, never the fallback policy: a project-level
      // `fallbackSubagent` must not hand a nested caller an agent its allowlist
      // never named. The list stays allowlist-filtered so a typo can't enumerate
      // agents this parent may not reach.
      const resolvedType = resolveEnabledTypeIn(registry, rawType);
      if (resolvedType === undefined) {
        return textResult(
          `Unknown or disabled nested agent type: "${rawType}". Allowed: ${availableIn(registry).join(", ") || "none"}.`,
          true,
        );
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.`,
          true,
        );
      }

      const config = getAgentConfigIn(registry, resolvedType);
      // Nested children are detached as well in this fork. Their completion is
      // sent directly into the owning parent session by the manager callback.
      const invocation = {
        ...resolveAgentInvocationConfig(config, params, {
          worktreeAllowed: isWorktreeIsolationEnabled(),
          defaultRunInBackground: true,
        }),
        runInBackground: true,
      };
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (invocation.modelFromParams) return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }

      // Same scopeModels policy as the top-level Agent tool — a nested spawn
      // must not escape the allowlist. A "warn" verdict proceeds silently:
      // child sessions have no UI surface to toast to.
      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: invocation.modelFromParams,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      // The whole branch shares the root session's transcript directory; read it
      // off the owning parent rather than this child session's own id.
      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId;
      const childDepth = context.depth + 1;
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        // Nested children are hidden from every reporting surface, so their spend
        // would otherwise be unattributable. Fold it into every ancestor's record:
        // the top-level one appears in lifecycle events, completion notifications,
        // and `/agents`, and those all read `lifetimeUsage`. The whole chain is
        // walked, not just the immediate parent — a spawn callback only fires for
        // that child's OWN turns, so stopping at one level would hide a
        // great-grandchild from the only record anyone can see. (The live
        // widget/fleet counters read their own per-agent activity tracker, which
        // still sees only the top-level agent's own turns.)
        onAssistantUsage: (usage) => {
          for (let id: string | undefined = context.parentAgentId; id !== undefined; ) {
            const ancestor = context.manager.getRecord(id);
            if (!ancestor) break;
            addUsage(ancestor.lifetimeUsage, usage);
            id = ancestor.parentAgentId;
          }
        },
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
      };

      // Transcript wiring, same gate as the top-level path: the child's
      // `output_transcript` frontmatter wins, else the project default. Without
      // it a nested run leaves no artifact but the string it returned — the
      // parent's own transcript records the call and the answer, never the tool
      // calls in between, which is exactly what a misbehaving child needs to
      // explain itself. Filed under the ROOT session and this branch's config
      // root, so a nested transcript lands in the same `tasks/` directory as its
      // ancestors' rather than in a directory of its own.
      const transcriptSessionId =
        rootSessionId !== undefined && (config?.outputTranscript ?? getOutputTranscriptDefault())
          ? rootSessionId
          : undefined;
      let childId: string | undefined;
      const attachTranscript = (id: string): void => {
        childId = id;
        if (transcriptSessionId === undefined) return;
        const rec = context.manager.getRecord(id);
        if (!rec) return;
        try {
          rec.outputFile = createOutputFilePath(context.configCwd, id, transcriptSessionId);
          writeInitialEntry(rec.outputFile, id, params.prompt, ctx.cwd);
        } catch {
          // Transcript output is optional diagnostics; do not fail a nested
          // delegation after the child has already been accepted.
          rec.outputFile = undefined;
        }
      };
      options.onSessionCreated = (session) => {
        const rec = childId === undefined ? undefined : context.manager.getRecord(childId);
        if (rec?.outputFile && childId !== undefined) {
          rec.outputCleanup = streamToOutputFile(session, rec.outputFile, childId, ctx.cwd);
        }
      };

      // `ctx` is forwarded to the manager unmodified, never captured at tool-build
      // time: each AgentSession builds its own ExtensionRunner from that session's
      // cwd/sessionManager/modelRegistry, so this is the CHILD's context. Capturing
      // one earlier would silently give a grandchild the wrong worktree base, the
      // wrong conversation under inherit_context, and the wrong inherited model.
      //
      // spawn() throws on strict worktree-isolation failure and cwd validation —
      // report it as a tool error, like the top-level Agent tool does, instead of
      // letting it escape into the child's turn.
      try {
        const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
          ...options,
          isBackground: true,
        });
        // Synchronous, before the event loop yields — onSessionCreated fires
        // asynchronously inside runAgent, so the file is attached in time.
        attachTranscript(id);
        // Worktree isolation starts the agent asynchronously; surface its
        // failure as a tool error, like the synchronous throw used to.
        await context.manager.awaitStartup(id);
        return textResult(`Nested agent started in background. Agent ID: ${id}`);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Session not ready yet — queue the steer. The manager flushes pending
      // steers when the session is created (same contract as the top-level tool).
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  return [agentTool, steerTool];
}
