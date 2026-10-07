import { Box, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { HandoffProgress, SidekickEvent } from "./sidekick-runtime.js";

export interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export function duration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function markdownText(markdown: string): Component {
  return new Markdown(markdown, 0, 0, getMarkdownTheme());
}

export function sidekickWorkingHeader(theme: ThemeLike, progress: Pick<HandoffProgress, "toolCalls" | "startedAt">, label = "sidekick"): string {
  return `${theme.fg("accent", theme.bold(`◆ ${label} working`))} ${theme.fg("dim", `· ${String(progress.toolCalls)} tool calls · ${duration(Date.now() - progress.startedAt)} · /unipi:sidekick view / message`)}`;
}

class FittedComponent implements Component {
  private cache: { width: number; source: string[]; lines: string[] } | undefined;
  constructor(private readonly inner: Component) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const source = this.inner.render(width);
    if (this.cache?.width === width && this.cache.source === source) return this.cache.lines;
    const lines = source.map((line) => truncateToWidth(line, width, ""));
    this.cache = { width, source, lines };
    return lines;
  }

  invalidate(): void { this.cache = undefined; this.inner.invalidate?.(); }
  handleInput(data: string): void { this.inner.handleInput?.(data); }
}

export function fitTranscript(content: Component): Component {
  return new FittedComponent(content);
}

export class RailComponent implements Component {
  private cache: { width: number; source: string[]; lines: string[] } | undefined;
  constructor(private readonly inner: Component, private readonly rail: string) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const prefix = truncateToWidth(`${this.rail} `, width, "");
    const remaining = width - visibleWidth(prefix);
    const source = this.inner.render(Math.max(1, remaining));
    if (this.cache?.width === width && this.cache.source === source) return this.cache.lines;
    const lines = source.map((line) => prefix + (remaining > 0 ? truncateToWidth(line, remaining, "") : ""));
    this.cache = { width, source, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }
}

export function frameSidekick(theme: ThemeLike & { bg: (color: string, text: string) => string }, status: "working" | "completed" | "error", content: Component): Component {
  const railColor = status === "working" ? "accent" : status === "completed" ? "success" : "error";
  const rail = theme.fg(railColor, "▍");
  const boxed = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  boxed.addChild(new RailComponent(content, rail));
  return new FittedComponent(boxed);
}

export interface TranscriptOptions {
  events: readonly SidekickEvent[];
  droppedEvents?: number;
  header: string;
  expanded: boolean;
  isPartial: boolean;
  report?: { text: string };
  renderText: (markdown: string) => Component;
}

/** Main-surface previews are bounded independently of RPC/session retention. */
export const TRANSCRIPT_WINDOW = 8;
export const EXPANDED_TRANSCRIPT_WINDOW = 40;
export const TRANSCRIPT_MAX_CHARS = 32 * 1024;
export const TRANSCRIPT_MAX_LINES = 400;
export const TRANSCRIPT_REPORT_CHARS = 8 * 1024;

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function primaryArg(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const value = name === "bash"
    ? args.command
    : name === "read" || name === "edit" || name === "write"
      ? args.path ?? args.file_path ?? args.filePath
      : name === "sidekick"
        ? args.message
        : Object.values(args).find((entry) => typeof entry === "string");
  return typeof value === "string" ? truncate(firstLine(value), 100) : "";
}

function toolComponent(theme: ThemeLike, event: Extract<SidekickEvent, { kind: "tool" }>, expanded: boolean): Text {
  const title = `${event.isError ? theme.fg("error", "✗ ") : ""}${theme.fg("toolTitle", theme.bold(event.name))}`;
  const argument = primaryArg(event.name, event.args);
  const lines = [`${title}${argument.length > 0 ? ` ${theme.fg("accent", argument)}` : ""}`];
  if (!event.done) {
    lines[0] += theme.fg("warning", " ⋯ running");
  } else if (typeof event.output === "string" && event.output.length > 0) {
    const output = event.output.split("\n");
    const visible = expanded ? output.slice(-40) : output.slice(-3);
    lines.push(...visible.map((line) => theme.fg("toolOutput", truncate(line, 160))));
  }
  return new Text(lines.join("\n"), 0, 0);
}

type CachedEvent = { signature: string; component: Component };

/** Reused across SDK progress snapshots. Only changed events rebuild Markdown. */
export class SidekickTranscript implements Component {
  private entries = new Map<string, CachedEvent>();
  private cache: { width: number; lines: string[] } | undefined;
  private report: CachedEvent | undefined;

  constructor(private readonly theme: ThemeLike, private opts: TranscriptOptions) {}

  update(opts: TranscriptOptions): void {
    this.opts = opts;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
    this.entries.clear();
    this.report = undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cache?.width === width) return this.cache.lines;
    const opts = this.opts;
    const dropped = opts.droppedEvents ?? 0;
    let start = Math.max(0, opts.events.length - (opts.expanded ? EXPANDED_TRANSCRIPT_WINDOW : TRANSCRIPT_WINDOW));
    // Budget from the newest event backwards so live work stays visible.
    let chars = 0;
    for (let i = opts.events.length - 1; i >= start; i--) {
      const event = opts.events[i]!;
      const size = event.kind === "text" ? event.text?.length ?? 0 : (event.output?.length ?? 0) + 160;
      if (chars + size > TRANSCRIPT_MAX_CHARS && i < opts.events.length - 1) { start = i + 1; break; }
      chars += size;
    }
    const lines = new Text(opts.header, 0, 0).render(width).slice(0, 4);
    let omittedLines = false;
    if (start + dropped > 0) lines.push(...new Text(this.theme.fg("dim", `… ${String(start + dropped)} earlier steps · /unipi:sidekick for history`), 0, 0).render(width).slice(0, 4));
    const next = new Map<string, CachedEvent>();
    for (let i = start; i < opts.events.length; i++) {
      const event = opts.events[i]!;
      const key = `${dropped + i}:${event.kind}`;
      const text = event.kind === "text" ? (event.text ?? "").slice(-TRANSCRIPT_MAX_CHARS).trim() : "";
      const signature = event.kind === "text" ? text : JSON.stringify([event.name, primaryArg(event.name, event.args), event.done, event.isError, event.output, opts.expanded]);
      let cached = this.entries.get(key);
      if (!cached || cached.signature !== signature) cached = { signature, component: event.kind === "tool" ? toolComponent(this.theme, event, opts.expanded) : opts.renderText(text) };
      next.set(key, cached);
      lines.push(...cached.component.render(width));
      // Bound accumulation too: pathological narrow widths must not retain
      // tens of thousands of lines before the final slice.
      if (lines.length > TRANSCRIPT_MAX_LINES) {
        omittedLines = true;
        lines.splice(4, lines.length - TRANSCRIPT_MAX_LINES);
      }
    }
    this.entries = next;
    if (!opts.isPartial && opts.report?.text) {
      const last = opts.events.at(-1);
      if (!(last?.kind === "text" && last.text?.trim() === opts.report.text.trim())) {
        const text = opts.report.text.slice(0, TRANSCRIPT_REPORT_CHARS);
        if (this.report?.signature !== text) this.report = { signature: text, component: opts.renderText(text) };
        lines.push(...new Text(this.theme.fg("dim", "── report ──"), 0, 0).render(width), ...this.report.component.render(width));
        if (text.length < opts.report.text.length) lines.push(...new Text(this.theme.fg("dim", "… report preview truncated; full report is in the saved session."), 0, 0).render(width));
      }
    }
    if (omittedLines || lines.length > TRANSCRIPT_MAX_LINES) {
      lines.splice(4, Math.max(0, lines.length - TRANSCRIPT_MAX_LINES + 1));
      lines.splice(4, 0, truncateToWidth(this.theme.fg("dim", "… display lines omitted · /unipi:sidekick for history"), width, ""));
    }
    this.cache = { width, lines: lines.map(line => truncateToWidth(line, width, "")) };
    return this.cache.lines;
  }
}

export function renderSidekickTranscript(theme: ThemeLike, opts: TranscriptOptions): SidekickTranscript {
  return new SidekickTranscript(theme, opts);
}
