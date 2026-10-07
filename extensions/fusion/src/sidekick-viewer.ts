import { readFileSync } from "node:fs";
import { buildSessionContext, parseSessionEntries, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, stripTerminalSequences, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { SidekickMessage, SidekickRuntime, SidekickSessionEvent } from "./sidekick-runtime.js";
import { frameOverlay } from "./vendor/core/tui-overlay.js";
import { adaptiveInnerWidth } from "./vendor/core/tui-width.js";
import { duration } from "./transcript.js";

export const SIDEKICK_VIEWPORT_PERCENT = 70;
export const VIEWER_MAX_MESSAGES = 300;
export const VIEWER_MAX_MESSAGE_CHARS = 16_000;
export const VIEWER_MAX_MESSAGE_LINES = 1000;
export const VIEWER_REFRESH_MS = 200;

/** Pure SDK projection: viewing an old/empty session must never rewrite it. */
export function readSidekickHistory(file: string): SidekickMessage[] {
  let content: string;
  try { content = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!content.trim()) return [];
  const entries = parseSessionEntries(content);
  if (entries[0]?.type !== "session") throw new Error("Sidekick history is not a valid Pi session.");
  return buildSessionContext(entries.filter(entry => entry.type !== "session")).messages;
}

function literal(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}
function messageText(message: SidekickMessage, tail = false): string {
  const msg = message as unknown as Record<string, unknown>;
  const content = msg.content;
  const preview = (text: string, count: number) => tail ? text.slice(-count) : text.slice(0, count);
  if (typeof content === "string") return preview(content, VIEWER_MAX_MESSAGE_CHARS + 1);
  if (!Array.isArray(content)) return typeof msg.output === "string" ? preview(msg.output, VIEWER_MAX_MESSAGE_CHARS + 1) : "";
  // Bound before ANSI scanning/formatting, including large write-tool args.
  let remaining = VIEWER_MAX_MESSAGE_CHARS + 1;
  const parts: string[] = [];
  for (const part of content as Record<string, unknown>[]) {
    if (remaining <= 0) break;
    let text = "";
    if (part.type === "text") text = preview(String(part.text ?? ""), remaining);
    else if (part.type === "thinking") text = `[thinking]\n${String(part.thinking ?? "").slice(0, remaining)}`;
    else if (part.type === "toolCall") {
      let nodes = 0;
      text = `[tool: ${String(part.name ?? "tool")}]\n${JSON.stringify(part.arguments ?? {}, (_key, value: unknown) => {
        if (++nodes > 1000) return "[display omitted]";
        if (typeof value === "string") return value.slice(0, VIEWER_MAX_MESSAGE_CHARS);
        if (Array.isArray(value)) return value.slice(0, 100);
        return value;
      }, 2)}`;
    }
    else if (part.type === "image") text = "[image]";
    if (text) { parts.push(text.slice(0, remaining)); remaining -= text.length + 2; }
  }
  return parts.join("\n\n");
}

export interface SidekickViewerOptions {
  runtime: SidekickRuntime;
  name: string;
  thinking: string;
  tui: Pick<TUI, "requestRender" | "terminal">;
  theme: Theme;
  keybindings?: Pick<KeybindingsManager, "matches">;
  done: (result: undefined) => void;
  onSend: (message: string) => void;
  onStop: () => void;
}

/** An inspector over the existing RPC child, never another session writer. */
export class SidekickViewer implements Component {
  private messages: SidekickMessage[] = [];
  private streaming: SidekickMessage | undefined;
  private runningTools = new Map<string, { name: string; output: string }>();
  private dropped = 0;
  private scroll = 0;
  private follow = true;
  private viewport = 8;
  private width = 78;
  private composer: Input | undefined;
  private notice = "";
  private stopArmed = false;
  private closed = false;
  private revision = 0;
  private cache: { width: number; revision: number; lines: string[] } | undefined;
  private messageCache = new WeakMap<object, { width: number; liveLabel: string; lines: string[] }>();
  private unsubscribe: () => void;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly opts: SidekickViewerOptions) {
    this.unsubscribe = opts.runtime.subscribe(event => this.onEvent(event));
    this.loadHistory();
    this.streaming = opts.runtime.currentMessage();
    for (const event of opts.runtime.progress()?.events ?? []) {
      if (event.kind === "tool" && !event.done) this.runningTools.set(event.toolCallId, { name: event.name, output: event.output });
    }
    this.heartbeat = setInterval(() => { if (opts.runtime.isBusy()) this.requestRefresh(); }, 1000);
    this.heartbeat.unref();
  }

  private loadHistory(): void {
    try {
      const messages = readSidekickHistory(this.opts.runtime.sessionFile);
      // A just-emitted message can precede the SDK's journal append.
      const last = this.opts.runtime.lastCompletedMessage();
      if (last && JSON.stringify(messages.at(-1)) !== JSON.stringify(last)) messages.push(last);
      this.dropped = Math.max(0, messages.length - VIEWER_MAX_MESSAGES);
      this.messages = messages.slice(-VIEWER_MAX_MESSAGES);
    } catch (error) { this.notice = `History unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    this.revision++;
  }

  private onEvent(event: SidekickSessionEvent): void {
    if (this.closed) return;
    const message = event.message as SidekickMessage | undefined;
    if (message && (event.type === "message_start" || event.type === "message_update")) {
      if (event.type === "message_start" && message.role === "user") this.runningTools.clear();
      this.streaming = message;
      this.revision++;
    } else if (message && event.type === "message_end") {
      this.streaming = undefined;
      this.messages.push(message);
      if (this.messages.length > VIEWER_MAX_MESSAGES) { this.messages.shift(); this.dropped++; }
      this.revision++;
    } else if (event.type === "auto_compaction_end") {
      this.loadHistory();
    } else if (event.type === "tool_execution_start") {
      this.runningTools.set(String(event.toolCallId ?? ""), { name: String(event.toolName ?? "tool"), output: "" });
      this.revision++;
    } else if (event.type === "tool_execution_update") {
      const tool = this.runningTools.get(String(event.toolCallId ?? ""));
      if (tool) {
        tool.output = messageText((event.partialResult ?? event.result ?? {}) as SidekickMessage, true).slice(-VIEWER_MAX_MESSAGE_CHARS);
        this.revision++;
      }
    } else if (event.type === "tool_execution_end") {
      this.runningTools.delete(String(event.toolCallId ?? ""));
      this.revision++;
    } else if (event.type === "runtime_closed") {
      this.close();
      return;
    } else if (event.type === "runtime_update" && !this.opts.runtime.isBusy()) {
      // A transport failure can end a handoff without message/tool end events.
      // Preserve its partial evidence, but stop presenting it as live work.
      this.revision++;
    }
    this.requestRefresh();
  }

  private requestRefresh(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.closed) this.opts.tui.requestRender();
    }, VIEWER_REFRESH_MS);
    this.refreshTimer.unref();
  }

  private contentLines(width: number): string[] {
    if (this.cache?.width === width && this.cache.revision === this.revision) return this.cache.lines;
    const theme = this.opts.theme;
    const lines: string[] = [];
    if (this.dropped) lines.push(...wrapTextWithAnsi(theme.fg("dim", `… ${this.dropped} earlier messages omitted; saved session: ${this.opts.runtime.sessionFile}`), width));
    const messages = [...this.messages, ...(this.streaming ? [this.streaming] : [])];
    for (const message of messages) {
      const liveLabel = message === this.streaming ? this.opts.runtime.isBusy() ? "streaming" : "partial" : "";
      const cached = this.messageCache.get(message);
      if (cached?.width === width && cached.liveLabel === liveLabel) { lines.push(...cached.lines); continue; }
      const rendered: string[] = [];
      const msg = message as unknown as Record<string, unknown>;
      const role = message.role;
      const label = role === "toolResult" ? `tool result: ${String(msg.toolName ?? "tool")}` : role === "custom" ? `notification: ${String(msg.customType ?? "custom")}` : role;
      const color = msg.isError === true || msg.stopReason === "error" ? "error" : role === "assistant" ? "accent" : "muted";
      rendered.push(...wrapTextWithAnsi(theme.fg(color, theme.bold(literal(`── ${label}${liveLabel ? ` · ${liveLabel}` : ""} ──`))), width));
      const text = messageText(message);
      rendered.push(...wrapTextWithAnsi(literal(text.slice(0, VIEWER_MAX_MESSAGE_CHARS)), width));
      if (text.length > VIEWER_MAX_MESSAGE_CHARS) rendered.push(...wrapTextWithAnsi(theme.fg("dim", "… display truncated; complete output is in the saved session."), width));
      if (typeof msg.errorMessage === "string") rendered.push(...wrapTextWithAnsi(theme.fg("error", literal(msg.errorMessage.slice(0, VIEWER_MAX_MESSAGE_CHARS))), width));
      if (rendered.length > VIEWER_MAX_MESSAGE_LINES) {
        rendered.length = VIEWER_MAX_MESSAGE_LINES - 1;
        rendered.push(...wrapTextWithAnsi(theme.fg("dim", "… display lines truncated; complete output is in the saved session."), width).slice(0, 1));
      }
      rendered.push("");
      this.messageCache.set(message, { width, liveLabel, lines: rendered });
      lines.push(...rendered);
    }
    for (const tool of this.runningTools.values()) {
      lines.push(...wrapTextWithAnsi(theme.fg("warning", literal(`── tool ${this.opts.runtime.isBusy() ? "running" : "interrupted"}: ${tool.name} ──`)), width));
      if (tool.output) lines.push(...wrapTextWithAnsi(literal(tool.output), width));
    }
    if (!messages.length && !this.runningTools.size) lines.push(...wrapTextWithAnsi("No sidekick messages yet. Enter sends a brief to this sidekick.", width));
    this.cache = { width, revision: this.revision, lines };
    return lines;
  }

  render(width: number): string[] {
    const inner = adaptiveInnerWidth(width);
    this.width = inner;
    const terminalRows = this.opts.tui.terminal.rows || 24;
    const maxRows = Math.max(1, Math.floor(terminalRows * SIDEKICK_VIEWPORT_PERCENT / 100));
    const composerLines = this.composer?.render(inner) ?? [];
    // Frame, status, path, footer and optional composer all count toward maxHeight.
    this.viewport = Math.max(1, maxRows - 6 - composerLines.length - (this.notice ? 1 : 0));
    const content = this.contentLines(inner);
    const maxScroll = Math.max(0, content.length - this.viewport);
    this.scroll = this.follow ? maxScroll : Math.min(this.scroll, maxScroll);
    const runtime = this.opts.runtime;
    const progress = runtime.progress();
    const report = runtime.latest()?.report;
    const state = runtime.isBusy() ? `working · ${progress?.toolCalls ?? 0} tools · ${duration(Date.now() - (progress?.startedAt ?? Date.now()))}` : report?.status ?? "idle";
    const statusNote = report?.error && !runtime.isBusy() ? report.error : this.notice;
    const body = [
      this.opts.theme.fg("accent", literal(`${this.opts.name} · ${this.opts.thinking} · ${state}`)),
      this.opts.theme.fg("dim", literal(`Session: ${runtime.sessionFile}`)),
      ...content.slice(this.scroll, this.scroll + this.viewport),
    ];
    while (body.length < this.viewport + 2) body.push("");
    if (statusNote) body.push(this.opts.theme.fg(report?.error && !runtime.isBusy() ? "error" : "warning", literal(statusNote)));
    if (this.composer) body.push(...composerLines);
    const footer = this.composer ? "Enter send · Esc cancel" : this.stopArmed ? "x again to stop · any other key cancels" : `↑↓ / PgUp PgDn scroll · End follow · Enter message${runtime.isBusy() ? " · x stop" : ""} · Esc close`;
    body.push(this.opts.theme.fg("dim", footer));
    return frameOverlay(body, width, { title: this.composer ? "Sidekick · message" : "Sidekick · live conversation", borderFg: text => this.opts.theme.fg("borderMuted", text) });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.composer) { this.composer.handleInput(data); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.close(); return; }
    if (matchesKey(data, "enter")) { this.stopArmed = false; this.openComposer(); return; }
    if (matchesKey(data, "x") && this.opts.runtime.isBusy()) {
      if (this.stopArmed) {
        this.stopArmed = false;
        try { this.opts.onStop(); this.notice = "Stop requested."; }
        catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
      } else this.stopArmed = true;
      this.opts.tui.requestRender();
      return;
    }
    this.stopArmed = false;
    const keys = this.opts.keybindings;
    if ((keys?.matches(data, "tui.select.up") ?? matchesKey(data, "up")) || matchesKey(data, "k")) { this.follow = false; this.scroll = Math.max(0, this.scroll - 1); }
    else if ((keys?.matches(data, "tui.select.down") ?? matchesKey(data, "down")) || matchesKey(data, "j")) { this.follow = false; this.scroll++; }
    else if ((keys?.matches(data, "tui.select.pageUp") ?? matchesKey(data, "pageUp")) || matchesKey(data, "shift+up")) { this.follow = false; this.scroll = Math.max(0, this.scroll - this.viewport); }
    else if ((keys?.matches(data, "tui.select.pageDown") ?? matchesKey(data, "pageDown")) || matchesKey(data, "shift+down")) { this.follow = false; this.scroll += this.viewport; }
    else if (matchesKey(data, "home")) { this.follow = false; this.scroll = 0; }
    else if (matchesKey(data, "end")) this.follow = true;
    this.scroll = Math.min(this.scroll, Math.max(0, this.contentLines(this.width).length - this.viewport));
    this.opts.tui.requestRender();
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onEscape = () => { this.composer = undefined; this.opts.tui.requestRender(); };
    input.onSubmit = value => {
      const message = value.trim();
      if (!message) return;
      try {
        this.opts.onSend(message);
        this.composer = undefined;
        this.follow = true;
        this.notice = "Message sent to sidekick; it will be processed at its next boundary.";
      } catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
      this.opts.tui.requestRender();
    };
    this.composer = input;
    this.opts.tui.requestRender();
  }

  invalidate(): void { this.cache = undefined; this.messageCache = new WeakMap(); this.composer?.invalidate(); }
  close(): void {
    if (this.closed) return;
    this.dispose();
    this.opts.done(undefined);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    clearTimeout(this.refreshTimer);
    clearInterval(this.heartbeat);
    this.composer = undefined;
  }
}
