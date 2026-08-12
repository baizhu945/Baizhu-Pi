/**
 * Subagent Viewer — 从主 agent 界面「进入」subagent 会话
 *
 * 背景：subagent 工具每次调用都会以独立 pi 进程运行（`pi --mode json -p --no-session`），
 * 不落盘为可切换的会话文件；其完整会话（任务、思考、工具调用、输出）被捕获后保存在
 * 主会话的 toolResult `details.results[].messages` 里。本查看器从当前会话中提取所有
 * subagent 运行记录，以全屏覆盖层呈现，并与主 agent 界面做强视觉区分。
 *
 * 入口：
 *   - 快捷键 `alt+s`（未占用的键，可改 SUBAGENT_CYCLE_KEY 常量）
 *   - 命令 `/subagents`
 *
 * 按键行为：
 *   alt+s           有多个 subagent 时进入下一个；已是最后一个则退出查看器
 *   esc / q / ctrl+c 随时退出
 *   ↑↓ / PgUp PgDn / Home End  滚动会话内容
 *
 * 视觉区分（与主 agent 界面差异大、一眼可辨）：
 *   - 全屏覆盖层盖住主界面
 *   - 顶部/底部反色（inverse）状态条 + borderAccent 分隔线 + │ 会话槽线
 *   - agent 名 / TASK 标签用 warning 色，主界面不使用反色条，风格迥异
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Markdown, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

/** 循环/进入/退出 subagent 会话的快捷键（当前未被 pi 与用户 keybindings.json 占用） */
export const SUBAGENT_CYCLE_KEY = "alt+s";

/** 一条 subagent 运行记录（来自 subagent 工具结果的 details.results[i]） */
interface SubagentRun {
	agent: string;
	agentSource: string;
	task: string;
	messages: Message[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: { input: number; output: number; cost: number; turns: number };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatUsage(u: { input: number; output: number; cost: number; turns: number }): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${fmtTokens(u.input)}`);
	if (u.output) parts.push(`↓${fmtTokens(u.output)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

function previewArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	const s = JSON.stringify(args);
	if (!s) return "";
	return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** 取 toolResult 内容的第一行文本（截断） */
function firstResultLine(msg: { content?: unknown }, maxLen: number): string {
	const content = msg.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		for (const p of content) {
			if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
				const t = (p as { text?: unknown }).text;
				if (typeof t === "string") {
					text = t;
					break;
				}
			}
		}
	}
	return truncateToWidth(text.split("\n")[0] ?? "", maxLen);
}

/** 截断 + 空格补齐到指定宽度（ANSI 安全） */
function padLine(s: string, w: number): string {
	const t = truncateToWidth(s, w, "");
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

/* ------------------------------------------------------------------ */
/* 数据提取：从当前会话中收集所有 subagent 运行记录（按时间正序）       */
/* ------------------------------------------------------------------ */

function collectSubagentRuns(ctx: ExtensionContext): SubagentRun[] {
	const runs: SubagentRun[] = [];
	const sorted = [...ctx.sessionManager.getBranch()].sort((a, b) =>
		a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
	);

	for (const entry of sorted) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
		const details = msg.details as { results?: unknown[] } | undefined;
		if (!details || !Array.isArray(details.results)) continue;

		for (const r of details.results) {
			if (!r || typeof r !== "object") continue;
			const rr = r as Record<string, unknown>;
			const usage = (rr.usage ?? {}) as Record<string, unknown>;
			runs.push({
				agent: String(rr.agent ?? "?"),
				agentSource: String(rr.agentSource ?? "unknown"),
				task: String(rr.task ?? ""),
				messages: Array.isArray(rr.messages) ? (rr.messages as Message[]) : [],
				model: typeof rr.model === "string" ? rr.model : undefined,
				stopReason: typeof rr.stopReason === "string" ? rr.stopReason : undefined,
				errorMessage: typeof rr.errorMessage === "string" ? rr.errorMessage : undefined,
				usage: {
					input: Number(usage.input ?? 0),
					output: Number(usage.output ?? 0),
					cost: Number(usage.cost ?? 0),
					turns: Number(usage.turns ?? 0),
				},
			});
		}
	}
	return runs;
}

/* ------------------------------------------------------------------ */
/* 全屏查看器组件                                                      */
/* ------------------------------------------------------------------ */

class SubagentViewer {
	private index = 0;
	private scroll = 0;
	private cached?: { width: number; lines: string[] };

	constructor(
		private tui: TUI,
		private theme: Theme,
		private runs: SubagentRun[],
		private done: () => void,
	) {}

	private contentHeight(rows: number): number {
		// 顶栏 + 上分隔线 + 内容区 + 下分隔线 + 信息行 + 底栏 = 5 行固定开销
		return Math.max(1, rows - 5);
	}

	handleInput(data: string): void {
		if (matchesKey(data, SUBAGENT_CYCLE_KEY)) {
			if (this.index < this.runs.length - 1) {
				this.index++;
				this.scroll = 0;
			} else {
				this.done(); // 最后一个 subagent 上按 alt+s = 退出
				return;
			}
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done();
			return;
		} else if (matchesKey(data, "up")) {
			this.scroll = Math.max(0, this.scroll - 1);
		} else if (matchesKey(data, "down")) {
			this.scroll++;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scroll = Math.max(0, this.scroll - Math.max(1, (this.contentHeight(this.tui.terminal.rows) / 2) | 0));
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
			this.scroll += Math.max(1, (this.contentHeight(this.tui.terminal.rows) / 2) | 0);
		} else if (matchesKey(data, "home")) {
			this.scroll = 0;
		} else if (matchesKey(data, "end")) {
			this.scroll = Number.MAX_SAFE_INTEGER; // render 时 clamp
		} else {
			return;
		}
		this.cached = undefined;
		this.tui.requestRender();
	}

	private buildConversation(run: SubagentRun, w: number): string[] {
		const { theme } = this;
		const mdTheme = getMarkdownTheme();
		const lines: string[] = [];

		// 任务块
		lines.push(theme.fg("warning", theme.bold("▸ TASK ")) + theme.fg("dim", truncateToWidth(run.task, w - 8)));

		for (const msg of run.messages) {
			if (!msg || typeof msg !== "object") continue;
			if (msg.role === "user") continue; // 任务已在顶部展示，避免重复
			if (msg.role === "assistant") {
				for (const part of msg.content ?? []) {
					if (!part || typeof part !== "object") continue;
					if (part.type === "text") {
						const md = new Markdown(part.text ?? "", 0, 0, mdTheme);
						for (const l of md.render(w)) lines.push(l);
					} else if (part.type === "thinking") {
						const think = (part.thinking ?? "").trim();
						if (think) {
							for (const l of think.split("\n")) lines.push(theme.fg("dim", theme.italic(l)));
						}
					} else if (part.type === "toolCall") {
						lines.push(
							theme.fg("muted", "→ ") +
								theme.fg("accent", part.name ?? "?") +
								theme.fg("dim", ` ${previewArgs(part.arguments)}`),
						);
					}
				}
				lines.push("");
			} else if (msg.role === "toolResult") {
				const toolName = (msg as { toolName?: unknown }).toolName ?? "tool";
				lines.push(theme.fg("dim", `⏎ ${toolName} — ${firstResultLine(msg, w - 12)}`));
				lines.push("");
			}
		}
		return lines;
	}

	private buildInfoLine(run: SubagentRun): string {
		const { theme } = this;
		const parts: string[] = [];
		const u = formatUsage(run.usage);
		if (run.model) parts.push(`model: ${run.model}`);
		if (u) parts.push(`usage: ${u}`);
		if (run.stopReason) parts.push(`stop: ${run.stopReason}`);
		if (run.errorMessage) parts.push(theme.fg("error", `✗ ${truncateToWidth(run.errorMessage, 60)}`));
		return parts.length > 0 ? ` ${parts.join(" · ")} ` : " ";
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;

		const { theme } = this;
		const rows = Math.max(8, this.tui.terminal.rows);
		const innerW = Math.max(8, width - 2); // │ 槽线 + 空格
		const run = this.runs[this.index];
		const conv = this.buildConversation(run, innerW);
		const contentH = this.contentHeight(rows);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, conv.length - contentH)));

		const lines: string[] = [];

		// 顶栏：反色状态条
		const failed = run.stopReason === "error" || run.stopReason === "aborted" || !!run.errorMessage;
		const title = ` SUBAGENT VIEWER [${this.index + 1}/${this.runs.length}] ${failed ? "✗" : "✓"} ${run.agent} (${run.agentSource}) `;
		lines.push(theme.inverse(theme.bold(padLine(title, width))));

		// 上分隔线
		lines.push(theme.fg("borderAccent", "─".repeat(width)));

		// 会话内容（可滚动）
		const gutter = theme.fg("borderAccent", "│");
		for (let i = 0; i < contentH; i++) {
			const idx = this.scroll + i;
			const line = idx < conv.length ? conv[idx] : "";
			lines.push(gutter + " " + padLine(line, innerW));
		}

		// 下分隔线 + 信息行 + 底栏
		lines.push(theme.fg("borderAccent", "─".repeat(width)));
		lines.push(theme.fg("dim", padLine(this.buildInfoLine(run), width)));
		lines.push(
			theme.inverse(
				theme.bold(
					padLine(
						` ${SUBAGENT_CYCLE_KEY} 下一个 / 退出 · ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 退出 `,
						width,
					),
				),
			),
		);

		this.cached = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

/* ------------------------------------------------------------------ */
/* 注册                                                               */
/* ------------------------------------------------------------------ */

async function openViewer(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("subagent 查看器仅在交互式 TUI 中可用", "warning");
		return;
	}
	const runs = collectSubagentRuns(ctx);
	if (runs.length === 0) {
		ctx.ui.notify("当前会话还没有 subagent 运行记录", "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new SubagentViewer(tui, theme, runs, () => done()),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}

export function registerSubagentViewer(pi: ExtensionAPI): void {
	pi.registerShortcut(SUBAGENT_CYCLE_KEY, {
		description: "进入 subagent 会话查看器（再次按下进入下一个，最后一个按下退出）",
		handler: (ctx) => void openViewer(ctx),
	});

	pi.registerCommand("subagents", {
		description: "进入 subagent 会话查看器：查看 subagent 完整会话（alt+s 切换 / 退出）",
		handler: (_args, ctx) => openViewer(ctx),
	});
}
