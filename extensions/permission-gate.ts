/**
 * Permission Gate Extension for Pi
 *
 * 默认权限策略（/permission ask）：
 *   - read、网络读取和任务读取工具 -> allow
 *   - 任务创建/更新/停止、子代理编排和 goal 工具 -> allow
 *   - ls/grep/find、写入、命令执行、交互以及任何未知工具 -> ask
 *   - 不存在静态 deny；deny 只作为 /permission deny 的运行时模式
 *
 * /permission 支持三种运行时模式：
 *   - allow -> 放行所有工具
 *   - ask   -> 遵循上面的细分策略
 *   - deny  -> 拒绝所有工具
 *
 * ask 模式的确认框提供三个选择：
 *   - Yes          -> 仅放行这一次调用
 *   - No (Esc)     -> 拦截这次调用
 *   - Always allow -> 本对话内放行同一种工具（会话切换时重置）
 *
 * 非交互模式（无 UI）下无法询问用户，因此 ask 模式中未列入 allow 白名单的
 * 工具会被拦截。子代理 launcher 传入的显式工具白名单仍作为子代理自身的
 * capability profile 保留；/permission allow 和 deny 会覆盖该 profile。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PermissionMode = "allow" | "ask" | "deny";

const PERMISSION_MODES: readonly PermissionMode[] = ["allow", "ask", "deny"];

// 当前策略中自动放行的读取工具。ls、grep、find 按用户要求保留为 ask。
const READ_ONLY_TOOLS = new Set([
  "read",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
  // pi-tasks：读取任务/任务输出，不修改任务或启动进程。
  "TaskList",
  "TaskGet",
  "TaskOutput",
]);

// 明确要求自动放行的调度/任务/goal 工具。
const SAFE_TOOLS = new Set([
  // 兼容旧版/其它 subagent 扩展的名称。
  "subagent",
  "todo",
  // @tintinweb/pi-subagents。
  "Agent",
  "SubagentWorkflow",
  "get_subagent_result",
  "steer_subagent",
  "StructuredOutput",
  // @tintinweb/pi-tasks：创建任务，以及启动任务对应的子代理。
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "TaskExecute",
  // @narumitw/pi-goal。
  "goal_blocked",
  "goal_complete",
  "goal_wait",
]);

function getInitialPermissionMode(): PermissionMode {
  const inheritedMode = process.env.PI_PERMISSION_MODE?.toLowerCase();
  if (PERMISSION_MODES.includes(inheritedMode as PermissionMode)) {
    return inheritedMode as PermissionMode;
  }

  // cc-connect 的显式自动任务入口保持原有语义；用户随后可用
  // `/permission ask` 或 `/permission deny` 覆盖本次 Pi 进程的初始模式。
  return process.env.CC_PERMISSION_MODE === "yolo" ? "allow" : "ask";
}

function getSubagentToolAllowlist(): Set<string> {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return new Set();
  return new Set(
    (process.env.PI_SUBAGENT_ALLOWED_TOOLS ?? "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
}

function parsePermissionMode(args: string): PermissionMode | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return undefined;
  const mode = tokens[0].toLowerCase();
  return PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : undefined;
}

function formatPermissionMode(mode: PermissionMode): string {
  return `permission: ${mode}`;
}

function blockedResult(reason: string) {
  return { block: true, reason };
}

export default function (pi: ExtensionAPI) {
  // 使用对象而不是普通局部字符串，方便 command handler 与 tool_call handler
  // 共享同一份可变的运行时模式。
  const permissionState: { mode: PermissionMode } = { mode: getInitialPermissionMode() };

  // “Always allow” 只对 ask 模式有效，并且只持续到会话边界。
  const alwaysAllowTools = new Set<string>();

  // JSON 子代理没有 UI，不能等待 permission prompt。只有 launcher 根据 agent
  // 的显式 tools 字段传入的工具才可免确认；未列出的工具仍不可用。
  const subagentToolAllowlist = getSubagentToolAllowlist();

  const updateStatus = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
    ctx.ui.setStatus("permission-gate", formatPermissionMode(permissionState.mode));
  };

  pi.registerCommand("permission", {
    description: "Show or set the tool permission mode: allow, ask, or deny",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      return PERMISSION_MODES
        .filter((mode) => mode.startsWith(normalizedPrefix))
        .map((mode) => ({
          value: mode,
          label: mode,
          description:
            mode === "allow"
              ? "Allow every tool"
              : mode === "ask"
                ? "Allow reads/tasks; ask for writes, commands, and other tools"
                : "Block every tool",
        }));
    },
    handler: async (args, ctx) => {
      let selectedMode = parsePermissionMode(args);

      if (!args.trim()) {
        if (!ctx.hasUI) {
          updateStatus(ctx);
          ctx.ui.notify(`Current permission mode: ${permissionState.mode}`, "info");
          return;
        }

        selectedMode = (await ctx.ui.select(
          `Permission mode (current: ${permissionState.mode})`,
          [...PERMISSION_MODES],
        )) as PermissionMode | undefined;
      }

      if (!selectedMode) {
        ctx.ui.notify("Usage: /permission allow|ask|deny", "warning");
        return;
      }

      permissionState.mode = selectedMode;
      // 让之后启动的子 Pi 进程继承同一档模式；每个子进程仍会独立加载本扩展。
      process.env.PI_PERMISSION_MODE = selectedMode;
      // 切换模式后不保留 ask 模式中用户临时授予的工具。
      alwaysAllowTools.clear();
      updateStatus(ctx);
      ctx.ui.notify(`Permission mode: ${permissionState.mode}`, "info");
    },
  });

  // 会话切换时只重置 ask 模式的临时 Always allow 授权；/permission 选择的
  // 模式属于当前 Pi 进程，切换 /new、/resume、/fork 不应意外改变它。
  pi.on("session_start", (_event, ctx) => {
    alwaysAllowTools.clear();
    updateStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    if (permissionState.mode === "allow") {
      return undefined;
    }

    if (permissionState.mode === "deny") {
      return blockedResult(`Permission mode is deny; ${toolName} is blocked`);
    }

    if (READ_ONLY_TOOLS.has(toolName) || SAFE_TOOLS.has(toolName)) {
      return undefined;
    }

    // OpenCode 风格的子代理 capability profile：它只在子代理无 UI 时使用，
    // 让显式配置的 general agent 仍可执行其声明的工具。主会话的 /permission
    // 模式不会被该分支绕过：allow/deny 已在上面优先处理。
    if (subagentToolAllowlist.has(toolName)) {
      return undefined;
    }

    // 已选择 Always allow：仅在 ask 模式下生效。
    if (alwaysAllowTools.has(toolName)) {
      return undefined;
    }

    // 无 UI（非交互模式）时无法征询用户，一律拦截 ask 工具。
    if (!ctx.hasUI) {
      return blockedResult(`${toolName} requires user approval (no UI available)`);
    }

    const input = (event.input ?? {}) as Record<string, unknown>;
    const detail =
      toolName === "bash" || toolName === "powershell"
        ? `Command: ${typeof input.command === "string" ? input.command : JSON.stringify(input)}`
        : toolName === "write" || toolName === "edit"
          ? `Path: ${typeof input.path === "string" ? input.path : JSON.stringify(input)}`
          : `Input: ${JSON.stringify(input).slice(0, 200)}`;

    const choice = await ctx.ui.select(
      `Allow ${toolName}?\n${detail}`,
      ["Yes", "No", "Always allow"],
    );

    if (choice === "Always allow") {
      alwaysAllowTools.add(toolName);
      return undefined;
    }
    if (choice !== "Yes") {
      // 选择 No 或按 Esc 取消都视为拒绝。
      return blockedResult("Rejected by user");
    }

    return undefined;
  });
}
