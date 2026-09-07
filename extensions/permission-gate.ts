/**
 * Permission Gate Extension for Pi
 *
 * 权限策略：白名单工具直接放行，其余所有工具一律询问用户：
 *   - read/grep/ls/find                     -> 总是放行（本地只读）
 *   - subagent/todo                         -> 总是放行（调度/状态，副作用受二次把关）
 *   - web_search/fetch_content/.../ask_user -> 总是放行（网络只读 / 交互面板）
 *   - 其他所有工具（bash、write、edit 及任何未知或新增工具）-> 询问用户
 *
 * 询问对话框提供三个选择：
 *   - Yes          -> 仅放行这一次调用
 *   - No (Esc)     -> 拦截这次调用
 *   - Always allow -> 本对话内放行同一种工具（/new、/resume、/reload 时重置）
 *
 * 非交互模式（无 UI）下无法询问用户，一律拦截；但 subagent launcher
 * 会把 agent markdown 中显式声明的 tools 白名单传给子进程。子进程只对
 * 该白名单内的工具放行，这对应 OpenCode 的 per-agent permission 配置。
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "ls", "find"]);
// 安全工具（调度/状态类）：自身不直接改动文件或执行命令，副作用受到二次把关：
// - subagent 工具 spawn 的 explore 子代理只有只读工具；general 子代理的
//   write/edit/bash 只有在 general 的显式 tools 白名单中才会放行。
// - todo 工具只维护会话内任务列表（session entries），不碰文件系统。
const SAFE_TOOLS = new Set(["subagent", "todo"]);
// 网络只读工具（pi-web-access 包）：web 搜索 / URL 抓取 / 搜索结果取内容，
// 不改动本地文件（GitHub 克隆仅写入包自身缓存目录）；抓取自带 SSRF DNS 预检
// （拦截 localhost/私有 IP），且不执行任意本地命令。
// ask_user（@d3ara1n/pi-ask-user）：纯交互面板，只展示选项等待用户选择，无副作用。
const NETWORK_READ_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check", "ask_user"]);

function getSubagentToolAllowlist(): Set<string> {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return new Set();
  return new Set(
    (process.env.PI_SUBAGENT_ALLOWED_TOOLS ?? "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
}

function inputString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function isSensitiveRequest(toolName: string, input: Record<string, unknown>, cwd: string, isChild: boolean): boolean {
  const inputKeys = ["path", "file_path", "glob", "pattern"];
  if (toolName === "bash") inputKeys.push("command");
  const rawValues = inputKeys.map((key) => inputString(input, key)).filter(Boolean);
  const raw = rawValues.join("\n").toLowerCase();
  if (!raw) return false;

  const paths = rawValues.map((value) => path.resolve(cwd, value).split(path.sep).join("/").toLowerCase());
  for (const candidate of paths) {
    const basename = candidate.split("/").pop() ?? "";
    if (/^\.env(?:\.[^/]+)?$/.test(basename) && basename !== ".env.example") return true;
    if (/^(?:auth|credentials|secret|token|private-key)(?:\.[^/]*)?$/.test(basename)) return true;
    if (/(?:^|\/)\.(?:ssh|gnupg|aws)(?:\/|$)/.test(candidate)) return true;
    if (/(?:\/google-chrome|\/chromium|\/mozilla\/firefox)(?:\/|$)/.test(candidate) &&
      /(?:cookies|login data|local state|key4\.db)$/i.test(basename)) return true;
    if (/^\/proc\/[^/]+\/(?:environ|mem)(?:\/|$)/.test(candidate)) return true;
  }

  // Pattern-based scans can expose the same data even when the sensitive
  // filename is not part of the path argument.
  if ((toolName === "find" || toolName === "grep") && /(?:^|\/)proc(?:\/|$)/.test(raw) &&
    /environ|mem|\/fd(?:\/|$)/.test(raw)) return true;

  // This is deliberately narrow: it catches obvious credential dumps, not a
  // general shell language. Pi's extension gate is not an OS sandbox.
  if (isChild && toolName === "bash" &&
    (/(?:^|[;&|()\s])(?:env|printenv)(?:$|[;&|()\s])/.test(raw) ||
      /(?:auth\.json|(?:^|[\/\s])\.env(?:[\/\s]|$)|\/proc\/[^\s/]+\/environ)/.test(raw))) return true;

  return false;
}

export default function (pi: ExtensionAPI) {
  // "Always allow" 状态：按工具分别记录，仅对当前对话生效。
  // 允许 write 后不应顺便让 bash/未知工具也失去确认。
  const alwaysAllowTools = new Set<string>();
  // JSON 子代理没有 UI，不能等待 permission prompt。只有 launcher 根据
  // agent 的显式 tools 字段传入的工具才可免确认；未列出的工具仍不可用，
  // 即使某个其它扩展注册了它。
  const subagentToolAllowlist = getSubagentToolAllowlist();

  // 会话切换（/new、/resume、/fork 等）时重置，确保只影响同一个对话
  pi.on("session_start", () => {
    alwaysAllowTools.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    // 全自动模式（由 cc-connect 通过环境变量 CC_PERMISSION_MODE=yolo 注入）：
    // 直接放行所有工具，不再弹出权限确认卡片。
    if (process.env.CC_PERMISSION_MODE === "yolo") {
      return undefined;
    }

    const isChild = process.env.PI_SUBAGENT_CHILD === "1";
    if (isSensitiveRequest(toolName, event.input as Record<string, unknown>, ctx.cwd, isChild)) {
      if (isChild || !ctx.hasUI) {
        return {
          block: true,
          reason: `${toolName} blocked: sensitive credential or process-environment path`,
        };
      }

      const choice = await ctx.ui.select(
        `Allow sensitive ${toolName}?\nThis may expose credentials or process environment data.`,
        ["Yes", "No"],
      );
      if (choice !== "Yes") return { block: true, reason: "Sensitive access rejected by user" };
      return undefined;
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return undefined;
    }

    // 安全工具放行（subagent 调度、todo 状态管理等），副作用仍受本 gate 约束
    if (SAFE_TOOLS.has(toolName)) {
      return undefined;
    }

    // 网络只读工具放行（web 搜索/抓取、ask_user 交互面板）
    if (NETWORK_READ_TOOLS.has(toolName)) {
      return undefined;
    }

    // OpenCode 的 general agent 可以在自己的权限规则中允许 edit/bash。
    // Pi 子代理使用 JSON 模式没有 UI，因此这里采用等价的显式 agent 工具
    // 白名单：general 声明了 write/edit/bash 时放行它们，explore 没声明
    // 时既不会出现在工具列表，也不会绕过本 gate。
    if (subagentToolAllowlist.has(toolName)) {
      return undefined;
    }

    // 已选择 Always allow：本次对话内直接放行
    if (alwaysAllowTools.has(toolName)) {
      return undefined;
    }

    // 无 UI（非交互模式）时无法征询用户，一律拦截
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${toolName} requires user approval (no UI available)`,
      };
    }

    // 其余所有工具（bash / write / edit 及任何未知、新增工具）都询问用户
    const detail =
      toolName === "bash"
        ? `Command: ${(event.input as { command?: string }).command ?? ""}`
        : toolName === "write" || toolName === "edit"
          ? `Path: ${(event.input as { path?: string }).path ?? ""}`
          : `Input: ${JSON.stringify(event.input ?? {}).slice(0, 200)}`;

    const choice = await ctx.ui.select(
      detail ? `Allow ${toolName}?\n${detail}` : `Allow ${toolName}?`,
      ["Yes", "No", "Always allow"],
    );

    if (choice === "Always allow") {
      alwaysAllowTools.add(toolName);
      return undefined;
    }
    if (choice !== "Yes") {
      // 选择 No 或按 Esc 取消都视为拒绝
      return { block: true, reason: "Rejected by user" };
    }

    return undefined;
  });
}
