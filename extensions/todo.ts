/**
 * Todo Extension - structured task list for the current session
 *
 * Merges the official pi todo example (session-entry persistence, /todos
 * command, TUI rendering) with OpenCode's todo semantics:
 *   - 4 states: pending / in_progress / completed / cancelled
 *   - exactly ONE in_progress at a time (tool-enforced invariant)
 *   - promptSnippet so the main agent proactively plans with todos
 *
 * State is stored in tool result details (session entries), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: string;
	todos: Todo[];
	nextId: number;
	error?: string;
}

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
const STATUS_LABEL: Record<TodoStatus, string> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	cancelled: "cancelled",
};

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "set_status", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add / update)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update / set_status / remove)" })),
	status: Type.Optional(StringEnum(STATUSES, { description: "New status (for set_status)" })),
});

function formatList(todos: Todo[]): string {
	if (todos.length === 0) return "No todos";
	const mark: Record<TodoStatus, string> = {
		pending: "[ ]",
		in_progress: "[>]",
		completed: "[x]",
		cancelled: "[-]",
	};
	return todos
		.map((t) => `${mark[t.status]} #${t.id} [${STATUS_LABEL[t.status]}] ${t.text}`)
		.join("\n");
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const mark = (() => {
					switch (todo.status) {
						case "completed":
							return th.fg("success", "✓");
						case "in_progress":
							return th.fg("warning", "▶");
						case "cancelled":
							return th.fg("dim", "✗");
						default:
							return th.fg("dim", "○");
					}
				})();
				const id = th.fg("accent", `#${todo.id}`);
				const statusTag = th.fg("muted", `[${STATUS_LABEL[todo.status]}]`);
				const text =
					todo.status === "completed" || todo.status === "cancelled"
						? th.fg("dim", todo.text)
						: th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${mark} ${id} ${statusTag} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a structured task list for this session. Actions: list, add (text), update (id + text), set_status (id + status: pending|in_progress|completed|cancelled), remove (id), clear. Exactly one item may be in_progress at a time.",
		promptSnippet: "Maintain a todo list for multi-step work (3+ distinct steps) and update item statuses in real time",
		promptGuidelines: [
			"Use the todo tool proactively when a task requires 3+ distinct steps or the user provides multiple tasks.",
			"Mark the item you are working on as in_progress (exactly one at a time), then completed only after the work is actually done and verified.",
			"If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatList(todos) }],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "update": {
					if (params.id === undefined || !params.text) {
						return {
							content: [{ type: "text", text: "Error: id and text required for update" }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: "id and text required",
							} as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.text = params.text;
					return {
						content: [{ type: "text", text: `Updated todo #${todo.id}` }],
						details: { action: "update", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "set_status": {
					if (params.id === undefined || !params.status) {
						return {
							content: [{ type: "text", text: "Error: id and status required for set_status" }],
							details: {
								action: "set_status",
								todos: [...todos],
								nextId,
								error: "id and status required",
							} as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "set_status",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const newStatus = params.status as TodoStatus;
					const moved = todo.status !== newStatus && newStatus === "in_progress";
					todo.status = newStatus;
					// Enforce the "exactly one in_progress" invariant: demote others
					if (moved) {
						for (const t of todos) {
							if (t.id !== todo.id && t.status === "in_progress") t.status = "pending";
						}
					}
					return {
						content: [
							{
								type: "text",
								text: `Todo #${todo.id} -> ${STATUS_LABEL[todo.status]}${moved ? " (others demoted to pending)" : ""}`,
							},
						],
						details: { action: "set_status", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for remove" }],
							details: {
								action: "remove",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "remove",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const [removed] = todos.splice(idx, 1);
					return {
						content: [{ type: "text", text: `Removed todo #${removed.id}: ${removed.text}` }],
						details: { action: "remove", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const mark = (() => {
							switch (t.status) {
								case "completed":
									return theme.fg("success", "✓");
								case "in_progress":
									return theme.fg("warning", "▶");
								case "cancelled":
									return theme.fg("dim", "✗");
								default:
									return theme.fg("dim", "○");
							}
						})();
						const statusTag = theme.fg("muted", `[${STATUS_LABEL[t.status]}]`);
						const itemText = t.status === "completed" || t.status === "cancelled" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${mark} ${theme.fg("accent", `#${t.id}`)} ${statusTag} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "set_status": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
