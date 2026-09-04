/**
 * Status footer extension for Pi 0.84.4.
 *
 * The former right-sidebar implementation depended on private TUI patches.
 * Pi 0.84.4 does not expose that layout API, so this extension keeps the
 * portable part of the feature in the regular footer instead.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface Todo {
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface Stats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const fmt = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let branch: string | null = null;
	let statuses: [string, string][] = [];
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;
	let stats: Stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let contextUsage: { contextWindow: number; percent: number | null } | null = null;
	let tuiRef: { requestRender(): void } | null = null;

	const rebuildTodos = (ctx: ExtensionContext): void => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "todo") continue;
			const details = message.details as { todos?: Todo[] } | undefined;
			if (details?.todos) todos = details.todos;
		}
	};

	const rebuildStats = (ctx: ExtensionContext): void => {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const usage =
				message.role === "assistant"
					? (message as AssistantMessage).usage
					: (message as { usage?: AssistantMessage["usage"] }).usage;
			if (!usage) continue;
			input += usage.input ?? 0;
			output += usage.output ?? 0;
			cacheRead += usage.cacheRead ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
			cost += usage.cost?.total ?? 0;
		}
		stats = { input, output, cacheRead, cacheWrite, cost };
	};

	const refresh = (ctx: ExtensionContext): void => {
		rebuildTodos(ctx);
		rebuildStats(ctx);
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
		const usage = ctx.getContextUsage();
		contextUsage = usage
			? { contextWindow: usage.contextWindow, percent: usage.percent }
			: ctx.model?.contextWindow && ctx.model.contextWindow > 0
				? { contextWindow: ctx.model.contextWindow, percent: 0 }
				: null;
		tuiRef?.requestRender();
	};

	const setup = (ctx: ExtensionContext): void => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const syncExternal = (): void => {
				branch = footerData.getGitBranch();
				statuses = [...footerData.getExtensionStatuses().entries()];
			};
			const unsubscribeBranch = footerData.onBranchChange(syncExternal);
			return {
				dispose(): void {
					unsubscribeBranch();
				},
				invalidate(): void {},
				render(width: number): string[] {
					syncExternal();
					const totalInput = stats.input + stats.cacheRead + stats.cacheWrite;
					const parts = [
						theme.fg("dim", `↑${fmt(totalInput)} ↓${fmt(stats.output)}`),
						theme.fg("dim", `$${stats.cost.toFixed(3)}`),
					];
					if (contextUsage) {
						const percent = contextUsage.percent;
						const context = `${percent !== null ? `${percent.toFixed(1)}%` : "?"}/${fmt(contextUsage.contextWindow)}`;
						parts.push(
							(percent ?? 0) > 90
								? theme.fg("error", context)
								: (percent ?? 0) > 70
									? theme.fg("warning", context)
									: theme.fg("text", context),
						);
					}
					if (todos.length > 0) {
						const completed = todos.filter((todo) => todo.status === "completed").length;
						parts.push(theme.fg("dim", `todo ${completed}/${todos.length}`));
					}
					const left = parts.join(" ");
					const branchText = branch ? ` (${branch})` : "";
					const statusText = statuses.map(([key, value]) => `${key}:${value}`).join(" ");
					const right = theme.fg(
						"dim",
						`${modelId ?? "no-model"}${thinkingLevel ? ` ${thinkingLevel}` : ""}${branchText}${statusText ? ` ${statusText}` : ""}`,
					);
					const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + padding + right, width)];
				},
			};
		});
	};

	let setupDone = false;
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!setupDone) {
			setupDone = true;
			setup(ctx);
		}
		refresh(ctx);
	});

	const onRefreshEvent = async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.hasUI) refresh(ctx);
	};
	pi.on("session_tree", onRefreshEvent);
	pi.on("turn_end", onRefreshEvent);
	pi.on("tool_execution_end", async (event, ctx) => {
		if (ctx.hasUI && (event as { toolName?: string }).toolName === "todo") refresh(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
		tuiRef?.requestRender();
	});
	pi.on("thinking_level_select", async (event, ctx) => {
		if (!ctx.hasUI) return;
		thinkingLevel = (event as { level?: string }).level ?? ctx.thinkingLevel;
		tuiRef?.requestRender();
	});
}
