import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

const APPROVAL_OPTIONS = ["Allow", "Deny", "Always Allow"];
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const WEB_ACCESS_TOOL_NAMES = new Set([
  "web_access",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);
const DENIED_REASON = "The user denied this tool call; it was not executed.";

interface ToolCallSnapshot {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolBatch {
  calls: ToolCallSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectToolCalls(message: unknown): ToolCallSnapshot[] {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block): ToolCallSnapshot[] => {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" ||
      typeof block.name !== "string" || !isRecord(block.arguments)) return [];
    return [{ id: block.id, name: block.name, arguments: block.arguments }];
  });
}

function isReadOnlyTool(toolName: string, tool: ToolInfo | undefined): boolean {
  if (tool?.annotations?.readOnlyHint === true) return true;

  const normalizedName = toolName.toLowerCase().replaceAll("-", "_");
  if (READ_ONLY_TOOL_NAMES.has(normalizedName) || WEB_ACCESS_TOOL_NAMES.has(normalizedName)) return true;
  if (normalizedName.startsWith("web_access_") || normalizedName.startsWith("mcp__web_access__")) return true;

  const namespaceNames = [tool?.namespace?.name, ...(tool?.namespace?.aliases ?? [])]
    .filter((name): name is string => name !== undefined)
    .map((name) => name.toLowerCase().replaceAll("-", "_"));
  if (namespaceNames.includes("web_access")) return true;

  // pi-web-access can configure custom tool names, so recognize tools registered
  // by that local extension as read-only even when their names have been changed.
  return /(?:^|[/\\])pi-web-access(?:[/\\]|$)/i.test(tool?.sourceInfo.path ?? "");
}

function formatArguments(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

function safePreviewText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function splitLines(text: string): string[] {
  return safePreviewText(text).split(/\r\n|\n|\r/);
}

interface FilePreview {
  heading: string;
  diff: string;
}

function formatFilePreview(toolName: string, input: Record<string, unknown>): FilePreview | undefined {
  if (typeof input.path !== "string") return undefined;
  const path = safePreviewText(input.path);
  if (toolName === "write" && typeof input.content === "string") {
    const added = splitLines(input.content).map((line, index) => `+${index + 1} ${line}`);
    return { heading: `write ${path}`, diff: added.join("\n") };
  }
  const edits = input.edits;
  if (toolName === "edit" && Array.isArray(edits) && edits.every((edit) =>
    isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string")) {
    const blocks = edits.map((edit, index) => {
      const lines = [
        ...splitLines(edit.oldText as string).map((line, lineIndex) => `-${lineIndex + 1} ${line}`),
        ...splitLines(edit.newText as string).map((line, lineIndex) => `+${lineIndex + 1} ${line}`),
      ];
      return edits.length > 1 ? [`Edit ${index + 1}`, ...lines].join("\n") : lines.join("\n");
    });
    return { heading: `edit ${path}`, diff: blocks.join("\n\n") };
  }
  return undefined;
}

async function renderFilePreview(preview: FilePreview, mode: ExtensionContext["mode"]): Promise<string> {
  if (mode !== "tui") return `${preview.heading}\n${preview.diff}`;
  const { renderDiff } = await import("@earendil-works/pi-coding-agent");
  return `${preview.heading}\n${renderDiff(preview.diff, { filePath: preview.heading })}`;
}

async function formatReview(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  batch: ToolBatch | undefined,
  mode: ExtensionContext["mode"],
): Promise<{ heading: string; details: string }> {
  const calls = batch?.calls ?? [{ id: toolCallId, name: toolName, arguments: input }];
  const currentIndex = Math.max(0, calls.findIndex((call) => call.id === toolCallId));
  const heading = `Tool call approval · ${toolName} · ${currentIndex + 1}/${calls.length}`;
  const displayedCalls = await Promise.all(calls.map(async (call, index) => {
    const isCurrent = call.id === toolCallId;
    const args = isCurrent ? input : call.arguments;
    const prefix = `${index + 1}/${calls.length}${isCurrent ? " [approval required]" : ""}`;
    const preview = formatFilePreview(call.name, args);
    if (preview) return `${prefix}\n${await renderFilePreview(preview, mode)}`;
    return `${prefix} ${call.name} ${formatArguments(args)}`;
  }));
  const details = [`Batch of ${calls.length}; approving call ${currentIndex + 1} only.`, ...displayedCalls].join("\n");
  return { heading, details };
}

export default function permissionExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let alwaysAllowThisSession = false;
  const batchByCallId = new Map<string, ToolBatch>();

  const disable = () => {
    enabled = false;
    alwaysAllowThisSession = false;
  };

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  pi.registerCommand("permission", {
    description: "Toggle tool-call approval: /permission [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        const state = !enabled ? "off" : alwaysAllowThisSession ? "on (always allow this session)" : "on";
        notify(ctx, `Tool-call approval is ${state}.`);
        return;
      }

      if (action === "off" || (action === "" && enabled)) {
        disable();
        notify(ctx, "Tool-call approval is off; tool calls will not be reviewed.");
        return;
      }

      if (action === "on" || (action === "" && !enabled)) {
        if (!ctx.hasUI) {
          notify(ctx, "Tool-call approval needs an interactive or RPC UI and remains off.", "warning");
          return;
        }
        if (!enabled) {
          enabled = true;
          alwaysAllowThisSession = false;
        }
        notify(ctx, "Tool-call approval is on.");
        return;
      }

      notify(ctx, "Usage: /permission [on|off|status] (without an argument toggles it).", "warning");
    },
  });

  // Remember every call in the finalized assistant batch before the first
  // tool_call preflight, so each approval screen can show the complete request.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    batchByCallId.clear();
    const calls = collectToolCalls(event.message);
    const batch = { calls };
    for (const call of calls) batchByCallId.set(call.id, batch);
  });
  pi.on("tool_execution_end", (event) => {
    batchByCallId.delete(event.toolCallId);
  });

  // Permission choices are deliberately process-local and start disabled for
  // every newly started, resumed, forked, or reloaded session.
  const resetSession = () => {
    disable();
    batchByCallId.clear();
  };
  pi.on("session_start", resetSession);
  pi.on("session_before_switch", resetSession);
  pi.on("session_before_fork", resetSession);
  pi.on("session_shutdown", resetSession);

  // Serialize prompts defensively for nested parallel calls. The review itself
  // includes the full sibling batch, so no call is hidden behind the last one.
  let approvalQueue: Promise<void> = Promise.resolve();

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    if (alwaysAllowThisSession) return;

    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (isReadOnlyTool(event.toolName, tool)) return;

    let release!: () => void;
    const previous = approvalQueue;
    approvalQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      // A previous decision may have switched off the gate or selected
      // session-wide approval while this call was waiting in the queue.
      if (!enabled || alwaysAllowThisSession) return;
      if (!ctx.hasUI) {
        return { block: true, reason: "User approval is unavailable; this tool call was not executed." };
      }

      const { heading, details } = await formatReview(
        event.toolName,
        event.toolCallId,
        event.input,
        batchByCallId.get(event.toolCallId),
        ctx.mode,
      );
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(`${heading}\n\n${details}`, APPROVAL_OPTIONS, {
          signal: ctx.signal,
          timeout: APPROVAL_TIMEOUT_MS,
        });
      } catch {
        return { block: true, reason: "The approval prompt failed; this tool call was not executed." };
      }

      if (choice === "Allow") return;
      if (choice === "Always Allow") {
        alwaysAllowThisSession = true;
        notify(ctx, "Always Allow enabled for this session; all tool calls will be approved.");
        return;
      }
      if (choice === "Deny") return { block: true, reason: DENIED_REASON };
      return { block: true, reason: "The approval prompt was cancelled or timed out; this tool call was not executed." };
    } finally {
      release();
    }
  });
}
