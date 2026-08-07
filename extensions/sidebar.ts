/**
 * Sidebar Extension - right-side status panel (opencode-style)
 *
 * Layout modeled after opencode's TUI sidebar (packages/tui/src/routes/session/sidebar.tsx):
 *   - fixed panel width 42, shown when terminal width > 120 (same thresholds as opencode)
 *   - `┃` vertical divider between chat and panel (opencode SplitBorder)
 *   - bold section titles, muted labels, `─` section dividers
 *   - todo items styled like opencode's TodoItem: `[✓]` completed (muted),
 *     `[•]` in_progress (warning yellow), `[ ]` pending (muted)
 *   - bottom status badge `• Pi <version>` (success dot + bold + muted version)
 *
 * Content: footer info (model, token usage, cost in CNY, git branch, extension
 * statuses) + todo list. Todo state is rebuilt from session entries
 * (toolResult details of the `todo` tool), staying decoupled from todo.ts.
 *
 * Responsive: wide terminal -> sidebar visible, bottom footer collapses to a
 * hint line. Narrow terminal -> sidebar hidden (chat not narrowed), bottom
 * footer renders the full info (default-like). Todo list only exists in the
 * sidebar. Chat viewport mode (enabled by the pi patch) keeps the sidebar
 * fixed on screen while browsing history via scroll wheel / alt+pageUp+Down.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Terminal width threshold (same as opencode's `wide` memo: width > 120). */
const MIN_WIDTH = 120;
/** Sidebar panel width (same as opencode: 42). */
const PANEL_WIDTH = 42;
/** Max todo items rendered in the panel (rest summarized). */
const MAX_TODOS = 8;

interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

const fmt = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

export default function (pi: ExtensionAPI) {
	// ---- shared state (rebuilt from session events) ----
	let todos: Todo[] = [];
	let branch: string | null = null;
	let statuses: [string, string][] = [];
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;
	let stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;

	// ---- data rebuild ----
	const rebuildTodos = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as { todos?: Todo[] } | undefined;
			if (details?.todos) todos = details.todos;
		}
	};

	const rebuildStats = (ctx: ExtensionContext) => {
		let input = 0,
			output = 0,
			cacheRead = 0,
			cacheWrite = 0,
			cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const m = entry.message;
			if (m.role === "assistant") {
				const usage = (m as AssistantMessage).usage;
				if (usage) {
					input += usage.input ?? 0;
					output += usage.output ?? 0;
					cacheRead += usage.cacheRead ?? 0;
					cacheWrite += usage.cacheWrite ?? 0;
					cost += usage.cost?.total ?? 0;
				}
			} else if (m.role === "toolResult" && (m as { usage?: AssistantMessage["usage"] }).usage) {
				const usage = (m as { usage: AssistantMessage["usage"] }).usage;
				input += usage.input ?? 0;
				output += usage.output ?? 0;
				cacheRead += usage.cacheRead ?? 0;
				cacheWrite += usage.cacheWrite ?? 0;
				cost += usage.cost?.total ?? 0;
			}
		}
		stats = { input, output, cacheRead, cacheWrite, cost };
	};

	const refresh = (ctx: ExtensionContext) => {
		rebuildTodos(ctx);
		rebuildStats(ctx);
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
		// context usage: prefer session estimate; fall back to model window (default-footer behavior)
		const cu = ctx.getContextUsage();
		if (cu) {
			contextUsage = cu;
		} else if (ctx.model?.contextWindow && ctx.model.contextWindow > 0) {
			contextUsage = { tokens: 0, contextWindow: ctx.model.contextWindow, percent: 0 };
		} else {
			contextUsage = null;
		}
		panel?.invalidate();
		tuiRef?.requestRender();
	};

	// ---- sidebar panel component (opencode-style) ----
	let panel: SidebarPanel | null = null;
	let tuiRef: { requestRender(): void } | null = null;

	class SidebarPanel {
		private theme: Theme;
		private cachedWidth = 0;
		private cachedLines: string[] = [];

		constructor(theme: Theme) {
			this.theme = theme;
		}

		render(width: number, viewportH?: number): string[] {
			if (this.cachedLines.length && this.cachedWidth === width) return this.cachedLines;
			const th = this.theme;
			// opencode: vertical divider `┃` between chat and sidebar
			const vline = th.fg("borderMuted", "┃");
			const contentW = Math.max(8, width - 2);
			const pad = " ".repeat(contentW - 2);
			const divider = th.fg("muted", "─".repeat(contentW - 2));
			const lines: string[] = [];

			const push = (content: string) => {
				lines.push(vline + " " + truncateToWidth(content, width - 2));
			};

			// top padding (opencode paddingTop: 1)
			lines.push(vline);

			// --- Status ---
			push(th.fg("text", th.bold("Status")));
			push(divider);
			if (modelId) push(th.fg("muted", "model  ") + th.fg("text", modelId));
			// thinking level (e.g. high / max), between model and tokens
			if (thinkingLevel && thinkingLevel !== "off") {
				const levelColor = (["low", "medium", "high", "xhigh", "max"] as const).includes(
					thinkingLevel as never,
				)
					? (`thinking${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)}` as "thinkingHigh")
					: "text";
				push(th.fg("muted", "think  ") + th.fg(levelColor, thinkingLevel));
			}
			// input / output tokens on separate lines. Input is the TOTAL input
			// token count (cache hits + misses combined); the cache hit rate is
			// shown on its own line below.
			const totalInput = stats.input + stats.cacheRead + stats.cacheWrite;
			const hitRate = totalInput > 0 ? (stats.cacheRead / totalInput) * 100 : 0;
			push(
				th.fg("muted", "tokens ") + th.fg("text", `in  ↑${fmt(totalInput)}`),
			);
			push(
				th.fg("muted", "tokens ") + th.fg("text", `out ↓${fmt(stats.output)}`),
			);
			push(
				th.fg("muted", "hit    ") +
					th.fg(stats.cacheRead > 0 ? "success" : "dim", `${hitRate.toFixed(2)}%`),
			);
			const usdCnyRate = Number(process.env.PI_USD_CNY_RATE) || 7.2;
			push(th.fg("muted", "cost   ") + th.fg("text", `¥${(stats.cost * usdCnyRate).toFixed(3)}`));
			push(th.fg("muted", "branch ") + th.fg("text", branch ?? "(none)"));
			// context usage (same logic as the default footer: >90 error, >70 warning)
			if (contextUsage) {
				const cw = contextUsage.contextWindow ?? 0;
				const pct = contextUsage.percent;
				const pctStr = pct !== null ? `${pct.toFixed(1)}%` : "?";
				const ctxStr = `${pctStr}/${fmt(cw)}`;
				const colored =
					(pct ?? 0) > 90
						? th.fg("error", ctxStr)
						: (pct ?? 0) > 70
							? th.fg("warning", ctxStr)
							: th.fg("text", ctxStr);
				push(th.fg("muted", "ctx     ") + colored);
			}
			for (const [key, text] of statuses) {
				push(th.fg("muted", `${key}    `) + th.fg("text", truncateToWidth(text, contentW - 4)));
			}

			lines.push(vline);

			// --- Todos ---
			push(th.fg("text", th.bold("Todos")));
			push(divider);
			if (todos.length === 0) {
				push(th.fg("muted", "no todos"));
			} else {
				const done = todos.filter((t) => t.status === "completed").length;
				push(th.fg("muted", `${done}/${todos.length} completed`));
				for (const t of todos.slice(0, MAX_TODOS)) {
					// opencode TodoItem: in_progress -> warning, else muted
					const color = t.status === "in_progress" ? "warning" : "muted";
					const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "•" : " ";
					// Wrap long todo text onto continuation lines instead of truncating.
					const wrapped = wrapTextWithAnsi(t.text, Math.max(4, contentW - 6));
					wrapped.forEach((wl, idx) => {
						if (idx === 0) {
							push(th.fg(color, `[${mark}] `) + th.fg(color, wl));
						} else {
							// align continuation lines with the todo text (after "[x] ")
							push(th.fg(color, "    ") + th.fg(color, wl));
						}
					});
				}
				if (todos.length > MAX_TODOS) {
					push(th.fg("muted", `... ${todos.length - MAX_TODOS} more`));
				}
			}

			lines.push(vline);

			// opencode-style badge `• Pi <version>`, right-aligned at the very bottom
			const badge =
				" " + th.fg("success", "•") + " " + th.fg("text", th.bold("Pi")) + th.fg("muted", ` ${VERSION}`);
			const badgeW = visibleWidth(badge);
			const lead = Math.max(0, contentW - 2 - badgeW);

			if (viewportH !== undefined && viewportH > 0) {
				// Fill the rest of the right column so the panel spans the full
				// terminal height; the badge stays pinned to the very bottom row.
				while (lines.length < viewportH - 1) {
					lines.push(vline + pad);
				}
				lines.push(vline + " " + " ".repeat(lead) + badge);
			} else {
				// bottom padding (fallback without a viewport height)
				lines.push(vline + " " + " ".repeat(lead) + badge);
				lines.push(vline);
				lines.push(vline + pad);
			}

			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		invalidate(): void {
			this.cachedWidth = 0;
			this.cachedLines = [];
		}
	}

	// ---- setup: layout sidebar + custom footer ----
	let setupDone = false;

	const setup = (ctx: ExtensionContext) => {
		if (setupDone) return;
		setupDone = true;

		const theme = ctx.ui.theme;

		// Layout-level right sidebar (chat viewport mode is enabled by the pi
		// patch): the chat column is narrowed and the sidebar is composited onto
		// the visible window rows, so it never covers text and stays fixed on
		// screen while browsing history via internal scrolling.
		ctx.ui.setExtensionSidebar((tui, th) => {
			tuiRef = tui;
			panel = new SidebarPanel(th);
			return panel;
		});

		// Custom footer: wide -> minimal hint (info lives in the sidebar);
		// narrow -> full footer info (model, tokens, CNY cost, branch, statuses).
		ctx.ui.setFooter((tui, th, footerData) => {
			const syncExternal = () => {
				branch = footerData.getGitBranch();
				statuses = [...footerData.getExtensionStatuses().entries()];
			};
			const unsubBranch = footerData.onBranchChange(syncExternal);
			return {
				dispose() {
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					syncExternal();
					// 宽度判断用终端全宽（宽屏时 footer 的 render width 已减窄）
					const wide = (tui.terminal?.columns ?? width) >= MIN_WIDTH;
					if (wide) {
						return [th.fg("dim", "┃ status & todos → right panel")];
					}
					// Full footer (≈ default footer content)
					const usdCnyRate = Number(process.env.PI_USD_CNY_RATE) || 7.2;
					const parts = [
						th.fg("dim", `↑${fmt(stats.input)} ↓${fmt(stats.output)}`),
						th.fg("dim", `¥${(stats.cost * usdCnyRate).toFixed(3)}`),
					];
					if (contextUsage) {
						const cw = contextUsage.contextWindow ?? 0;
						const pct = contextUsage.percent;
						const pctStr = pct !== null ? `${pct.toFixed(1)}%` : "?";
						const ctxStr = `${pctStr}/${fmt(cw)}`;
						parts.push(
							(pct ?? 0) > 90
								? th.fg("error", ctxStr)
								: (pct ?? 0) > 70
									? th.fg("warning", ctxStr)
									: th.fg("text", ctxStr),
						);
					}
					const left = parts.join(" ");
					const branchStr = branch ? ` (${branch})` : "";
					const statusParts = statuses.map(([k, v]) => `${k}:${v}`).join(" ");
					const right = th.fg("dim", `${modelId ?? "no-model"}${branchStr}${statusParts ? ` ${statusParts}` : ""}`);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	};

	// ---- events ----
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setup(ctx);
		refresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		refresh(ctx);
	});

	const onRefreshEvent = async (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		refresh(ctx);
	};

	pi.on("turn_end", onRefreshEvent);
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const toolName = (event as { toolName?: string }).toolName;
		if (toolName !== "todo") return;
		refresh(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
		panel?.invalidate();
		tuiRef?.requestRender();
	});
	pi.on("thinking_level_select", async (event, ctx) => {
		if (!ctx.hasUI) return;
		thinkingLevel = (event as { level?: string }).level ?? ctx.thinkingLevel;
		panel?.invalidate();
		tuiRef?.requestRender();
	});}
