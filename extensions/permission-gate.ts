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
 *   - Always allow -> 本对话内放行所有此类调用（/new、/resume、/reload 时重置）
 *
 * 非交互模式（无 UI）下无法询问用户，一律拦截。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "ls", "find"]);
// 安全工具（调度/状态类）：自身不直接改动文件或执行命令，副作用受到二次把关：
// - subagent 工具 spawn 的 explore 子代理只有只读工具；general 子代理的
//   write/edit/bash 在无 UI 时同样会被这里拦截。
// - todo 工具只维护会话内任务列表（session entries），不碰文件系统。
const SAFE_TOOLS = new Set(["subagent", "todo"]);
// 网络只读工具（pi-web-access 包）：web 搜索 / URL 抓取 / 搜索结果取内容，
// 不改动本地文件（GitHub 克隆仅写入包自身缓存目录）；抓取自带 SSRF DNS 预检
// （拦截 localhost/私有 IP），且不执行任意本地命令。
// ask_user（@d3ara1n/pi-ask-user）：纯交互面板，只展示选项等待用户选择，无副作用。
const NETWORK_READ_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check", "ask_user"]);

export default function (pi: ExtensionAPI) {
  // "Always allow" 状态：仅对当前对话生效
  let alwaysAllow = false;

  // 会话切换（/new、/resume、/fork 等）时重置，确保只影响同一个对话
  pi.on("session_start", () => {
    alwaysAllow = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    // 全自动模式（由 cc-connect 通过环境变量 CC_PERMISSION_MODE=yolo 注入）：
    // 直接放行所有工具，不再弹出权限确认卡片。
    if (process.env.CC_PERMISSION_MODE === "yolo") {
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

    // 已选择 Always allow：本次对话内直接放行
    if (alwaysAllow) {
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
      alwaysAllow = true;
      return undefined;
    }
    if (choice !== "Yes") {
      // 选择 No 或按 Esc 取消都视为拒绝
      return { block: true, reason: "Rejected by user" };
    }

    return undefined;
  });
}
