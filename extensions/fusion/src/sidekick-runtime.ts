import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { BackgroundJobTracker } from "./background-jobs.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getPiSpawnCommand } from "./vendor/subagents/pi-spawn.js";
import type { EffortLevel, ModelKey } from "./preset.js";

export interface SidekickSpawnConfig {
  cwd: string;
  model: ModelKey;
  thinking: EffortLevel;
  sessionFile: string;
  systemPrompt: string;
  spawn?: typeof defaultSpawn;
  command?: { command: string; args: string[] };
  onProgress?: () => void;
  settleGraceMs?: number;
  reportTimeoutMs?: number;
  abortTimeoutMs?: number;
  /** ACK and inactivity deadlines. Busy/queued native state extends inactivity. */
  promptTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export interface SidekickUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type SidekickEvent =
  | { kind: "text"; text: string; open: boolean; truncated?: boolean }
  | { kind: "tool"; toolCallId: string; name: string; args: Record<string, unknown> | undefined; output: string; isError: boolean; done: boolean; startedAt: number; endedAt?: number };

export const MAX_EVENTS = 300;
export const MAX_TOOL_OUTPUT = 4000;
export const MAX_TEXT_EVENT_BYTES = 8 * 1024;
export const MAX_RPC_RECORD_BYTES = 10 * 1024 * 1024;
export const MAX_REPORT_TEXT_BYTES = 64 * 1024;
export const MAX_REPORTS = 20;
const DISPLAY_TRUNCATION = "[Display text truncated; full text is available in the final report.]\n";

export type SidekickMessage = AgentSession["messages"][number];
export type SidekickSessionEvent = Record<string, unknown>;

export interface HandoffProgress {
  /** Monotonic display revision, including non-tail tool completions. */
  revision?: number;
  toolCalls: number;
  recentTools: string[];
  textTail: string;
  startedAt: number;
  events: SidekickEvent[];
  droppedEvents: number;
}

export interface HandoffReport {
  id: string;
  status: "completed" | "aborted" | "error" | "interrupted";
  text: string;
  usage: SidekickUsage;
  toolCalls: number;
  durationMs: number;
  events: SidekickEvent[];
  error?: string;
  fullTextPath?: string;
  /** Recovered assistant/retry errors remain diagnostic, not terminal errors. */
  transientErrors?: string[];
}

type PromptRequest = { message: string; retried: boolean; generation: number };
interface PendingHandoff {
  id: string;
  startedAt: number;
  usage: SidekickUsage;
  progress: HandoffProgress;
  bg: BackgroundJobTracker;
  generation: number;
  brief: string;
  accepted: boolean;
  active: boolean;
  settled: boolean;
  settleTimer?: NodeJS.Timeout;
  promptRequests: Map<string, PromptRequest>;
  promptTimer?: NodeJS.Timeout;
  stateRequestId?: string;
  stateTimer?: NodeJS.Timeout;
  reportRequestId?: string;
  reportTimer?: NodeJS.Timeout;
  abortRequestId?: string;
  abortTimer?: NodeJS.Timeout;
  abortRequested: boolean;
  error?: string;
  transientErrors: string[];
  resolve: (report: HandoffReport) => void;
}

const emptyUsage = (): SidekickUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const normalizeBrief = (text: string): string => text.normalize("NFC").replace(/\s+/gu, " ").trim();
/** Slice by UTF-8 bytes without manufacturing replacement characters. */
function utf8Slice(text: string, bytes: number, tail = false): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  if (tail) {
    let start = buffer.length - bytes;
    while ((buffer[start]! & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  }
  let end = bytes;
  while ((buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
function userText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

export class SidekickRuntime {
  private readonly cfg: SidekickSpawnConfig;
  private child: ChildProcess | undefined;
  private promptPath: string | undefined;
  private pending: PendingHandoff | undefined;
  private latestHandoff: { id: string; done: Promise<HandoffReport>; report?: HandoffReport } | undefined;
  private stderrTail = "";
  private inputBuffer = "";
  private inputBytes = 0;
  private completedHandoffs = 0;
  private toolCalls = 0;
  readonly reports = new Map<string, HandoffReport>();
  readonly usage = emptyUsage();
  private readonly listeners = new Set<(event: SidekickSessionEvent) => void>();
  private streamingMessage: SidekickMessage | undefined;
  private lastMessage: SidekickMessage | undefined;

  constructor(cfg: SidekickSpawnConfig) { this.cfg = cfg; }

  isAlive(): boolean {
    const child = this.child;
    return child !== undefined && child.exitCode == null && child.signalCode == null && !child.killed && child.stdin?.writable === true;
  }
  isBusy(): boolean { return this.pending !== undefined; }
  totalToolCalls(): number { return this.toolCalls; }
  totalHandoffs(): number { return this.completedHandoffs; }
  get sessionFile(): string { return this.cfg.sessionFile; }
  currentMessage(): SidekickMessage | undefined { return this.streamingMessage; }
  lastCompletedMessage(): SidekickMessage | undefined { return this.lastMessage; }
  subscribe(listener: (event: SidekickSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emitSessionEvent(event: SidekickSessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* an inspector must never stop the child */ }
    }
  }

  private notifyProgress(): void {
    if (this.pending) this.pending.progress.revision = (this.pending.progress.revision ?? 0) + 1;
    try { this.cfg.onProgress?.(); } catch { /* display must not affect work */ }
    this.emitSessionEvent({ type: "runtime_update" });
  }
  private appendEvent(event: SidekickEvent): void {
    const progress = this.pending?.progress;
    if (!progress) return;
    progress.events.push(event);
    if (progress.events.length > MAX_EVENTS) {
      progress.events.shift();
      progress.droppedEvents += 1;
    }
  }
  private closeOpenText(): void {
    const last = this.pending?.progress.events.at(-1);
    if (last?.kind === "text" && last.open) last.open = false;
  }
  private toolOutput(result: unknown): string {
    if (typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)) {
      return ((result as { content: unknown[] }).content)
        .map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : typeof part === "string" ? part : "")
        .filter(Boolean).join("\n").slice(-MAX_TOOL_OUTPUT);
    }
    return String(result ?? "").slice(-MAX_TOOL_OUTPUT);
  }

  private send(value: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error("Sidekick process is not writable");
    const pending = this.pending;
    const generation = pending?.generation;
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      // Async EPIPE belongs to this child/request, not a replacement handoff.
      if (error && this.child === child && this.pending === pending && pending?.generation === generation) this.failChild(child, errorText(error));
    });
  }
  private cleanupPrompt(): void {
    if (!this.promptPath) return;
    try { unlinkSync(this.promptPath); } catch { /* already removed */ }
    this.promptPath = undefined;
  }
  /** Stop only a child we spawned. EOF lets Pi run extension shutdown hooks. */
  private stopChild(child: ChildProcess): void {
    let closed = child.exitCode != null || child.signalCode != null;
    let timer: NodeJS.Timeout | undefined;
    child.once("close", () => { closed = true; clearTimeout(timer); });
    try { child.stdin?.end(); } catch { /* SIGTERM still runs */ }
    if (closed) return;
    try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
    if (closed) return;
    timer = setTimeout(() => {
      if (!closed && child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      }
    }, this.cfg.shutdownGraceMs ?? 7000);
    timer.unref();
  }
  private failChild(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.cleanupPrompt();
    this.inputBuffer = "";
    this.inputBytes = 0;
    this.finish("error", undefined, error);
    this.stopChild(child);
  }
  private spawn(): void {
    // A signalled child can have exitCode=null; never reuse it.
    const oldChild = this.child;
    if (oldChild) { this.child = undefined; this.cleanupPrompt(); this.stopChild(oldChild); }
    mkdirSync(dirname(this.cfg.sessionFile), { recursive: true });
    this.promptPath = join(tmpdir(), `unipi-fusion-${randomUUID()}.txt`);
    writeFileSync(this.promptPath, this.cfg.systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const command = this.cfg.command ?? getPiSpawnCommand([
      "--mode", "rpc", "--session", this.cfg.sessionFile, "--model", this.cfg.model,
      "--thinking", this.cfg.thinking, "--append-system-prompt", this.promptPath, "--no-skills",
    ]);
    const spawn = this.cfg.spawn ?? defaultSpawn;
    const child = spawn(command.command, command.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, UNIPI_FUSION_CHILD: "1", UNIPI_SUBAGENT_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.inputBuffer = "";
    this.inputBytes = 0;
    this.stderrTail = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (data: Buffer | string) => {
      if (this.child === child) this.readStdout(typeof data === "string" ? data : stdoutDecoder.write(data), child);
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      if (this.child === child) this.stderrTail = utf8Slice(`${this.stderrTail}${typeof data === "string" ? data : stderrDecoder.write(data)}`, 2048, true);
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", (error) => this.failChild(child, `Sidekick stream error: ${errorText(error)}`));
    }
    child.on("close", (_code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.cleanupPrompt();
      this.inputBuffer = "";
      this.inputBytes = 0;
      this.finish("error", undefined, this.stderrTail || `Sidekick process exited${signal ? ` (${String(signal)})` : ""}`);
    });
    child.on("error", (error) => this.failChild(child, errorText(error)));
  }

  private readStdout(data: string, child: ChildProcess): void {
    // Bound each record, including records that never terminate with a newline.
    let offset = 0;
    while (offset < data.length && this.child === child) {
      const newline = data.indexOf("\n", offset);
      const part = data.slice(offset, newline === -1 ? data.length : newline);
      this.inputBytes += Buffer.byteLength(part);
      if (this.inputBytes > MAX_RPC_RECORD_BYTES) {
        this.failChild(child, "Sidekick RPC record exceeded 10MiB");
        return;
      }
      this.inputBuffer += part;
      if (newline === -1) return;
      const line = this.inputBuffer.endsWith("\r") ? this.inputBuffer.slice(0, -1) : this.inputBuffer;
      this.inputBuffer = "";
      this.inputBytes = 0;
      offset = newline + 1;
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      // Parsing noise is tolerated; handler failures must not vanish as noise.
      try {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid sidekick RPC object");
        this.handleMessage(parsed as Record<string, unknown>);
        const event = parsed as SidekickSessionEvent;
        const message = event.message as SidekickMessage | undefined;
        if (message && typeof message.role === "string") {
          if (event.type === "message_start" || event.type === "message_update") this.streamingMessage = message;
          else if (event.type === "message_end") { this.streamingMessage = undefined; this.lastMessage = message; }
        }
        this.emitSessionEvent(event);
      } catch (error) {
        this.failChild(child, `Sidekick RPC handler failed: ${errorText(error)}`);
      }
    }
  }

  private clearPromptTimers(current: PendingHandoff): void {
    clearTimeout(current.promptTimer);
    clearTimeout(current.stateTimer);
    current.promptTimer = undefined;
    current.stateTimer = undefined;
    current.stateRequestId = undefined;
  }
  private armPromptDeadline(current: PendingHandoff): void {
    clearTimeout(current.promptTimer);
    if (this.pending !== current || current.abortRequested || current.settled) return;
    const generation = current.generation;
    const timeoutMs = this.cfg.promptTimeoutMs ?? 30_000;
    current.promptTimer = setTimeout(() => {
      if (this.pending !== current || current.generation !== generation) return;
      current.promptTimer = undefined;
      if (!current.accepted) {
        this.finish("error", undefined, `Sidekick prompt ACK not received within ${String(timeoutMs)}ms`);
        return;
      }
      // Long tools and queued steer can be silent. Confirm native state once
      // per inactivity window, rather than mistaking silence for consumption.
      this.requestState(current);
    }, timeoutMs);
    current.promptTimer.unref();
  }
  private requestState(current: PendingHandoff): void {
    if (current.stateRequestId || current.abortRequested) return;
    const id = randomUUID();
    current.stateRequestId = id;
    const timeoutMs = this.cfg.promptTimeoutMs ?? 30_000;
    current.stateTimer = setTimeout(() => {
      if (this.pending === current && current.stateRequestId === id) this.finish("error", undefined, `Sidekick inactivity state query timed out after ${String(timeoutMs)}ms`);
    }, timeoutMs);
    current.stateTimer.unref();
    try { this.send({ id, type: "get_state" }); } catch (error) { this.finish("error", undefined, errorText(error)); }
  }
  private invalidateReport(): void {
    const current = this.pending;
    if (!current) return;
    clearTimeout(current.reportTimer);
    current.reportTimer = undefined;
    current.reportRequestId = undefined;
  }
  private resetSettleState(): void {
    const current = this.pending;
    if (!current) return;
    clearTimeout(current.settleTimer);
    current.settleTimer = undefined;
    this.invalidateReport();
    current.settled = false;
  }
  private requestLastAssistantText(): void {
    const current = this.pending;
    if (!current || current.reportRequestId || current.abortRequestId) return;
    if (!current.abortRequested && (!current.accepted || !current.active || !current.settled)) return;
    clearTimeout(current.settleTimer);
    current.settleTimer = undefined;
    this.clearPromptTimers(current);
    const id = randomUUID();
    current.reportRequestId = id;
    const timeoutMs = this.cfg.reportTimeoutMs ?? 10_000;
    current.reportTimer = setTimeout(() => {
      if (this.pending === current && current.reportRequestId === id) this.finish("error", undefined, `Sidekick did not return a final report within ${String(timeoutMs)}ms`);
    }, timeoutMs);
    current.reportTimer.unref();
    try { this.send({ id, type: "get_last_assistant_text" }); } catch (error) { this.finish("error", undefined, errorText(error)); }
  }
  private scheduleSettledReport(): void {
    const current = this.pending;
    if (!current || !current.accepted || !current.active || !current.settled || current.bg.pendingCount > 0 || current.abortRequested || current.reportRequestId || current.settleTimer) return;
    current.settleTimer = setTimeout(() => {
      current.settleTimer = undefined;
      if (this.pending === current && current.settled && current.bg.pendingCount === 0) this.requestLastAssistantText();
    }, this.cfg.settleGraceMs ?? 3000);
    current.settleTimer.unref();
  }
  private recordTransientError(current: PendingHandoff, text: string): void {
    if (current.transientErrors.at(-1) !== text) current.transientErrors.push(utf8Slice(text, MAX_TEXT_EVENT_BYTES));
    if (current.transientErrors.length > 20) current.transientErrors.shift();
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === "response") { this.handleResponse(message); return; }
    if (message.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(String(message.method))) this.send({ type: "extension_ui_response", id: message.id, cancelled: true });
      return;
    }
    const current = this.pending;
    if (!current) return;
    const msg = message.message as Record<string, unknown> | undefined;
    if ((message.type === "message_start" || message.type === "message_end") && msg?.role === "user" && current.accepted && !current.abortRequested) {
      // Preflight ACK is not proof of an agent run (commands/input handlers can
      // consume it). A matching user message is also required for this generation.
      const received = normalizeBrief(userText(msg));
      if (received === current.brief && !current.active) {
        current.active = true;
        this.resetSettleState();
      }
    }
    if (current.accepted && !current.settled && !current.abortRequested) {
      // Real new activity supersedes an inactivity snapshot still in flight.
      // A stale idle response must not terminate a now-active generation.
      if (current.active) this.clearPromptTimers(current);
      if (!current.stateRequestId) this.armPromptDeadline(current);
    }
    if (message.type === "tool_execution_start") {
      this.closeOpenText();
      current.progress.toolCalls += 1;
      this.toolCalls += 1;
      const args = message.args !== undefined && typeof message.args === "object" && message.args !== null ? message.args as Record<string, unknown> : undefined;
      current.bg.onToolStart(String(message.toolName ?? "tool"), String(message.toolCallId ?? ""), args);
      const encodedArgs = args === undefined ? "" : JSON.stringify(args);
      const argsText = encodedArgs.replace(/\s+/gu, " ");
      current.progress.recentTools = [...current.progress.recentTools, `${String(message.toolName ?? "tool")}(${argsText})`.slice(0, 40)].slice(-6);
      const displayArgs = Buffer.byteLength(encodedArgs) > MAX_TEXT_EVENT_BYTES
        ? { truncated: true, preview: utf8Slice(argsText, MAX_TEXT_EVENT_BYTES / 2 - 160), note: "Display arguments truncated; background tracking used the complete RPC arguments." }
        : args;
      this.appendEvent({ kind: "tool", toolCallId: String(message.toolCallId ?? ""), name: String(message.toolName ?? "tool"), args: displayArgs, output: "", isError: false, done: false, startedAt: Date.now() });
      this.notifyProgress();
    } else if (message.type === "tool_execution_end") {
      const toolCallId = String(message.toolCallId ?? "");
      const event = [...current.progress.events].reverse().find((entry): entry is Extract<SidekickEvent, { kind: "tool" }> => entry.kind === "tool" && entry.toolCallId === toolCallId && !entry.done);
      if (event) {
        event.done = true;
        event.endedAt = Date.now();
        event.isError = message.isError === true;
        event.output = this.toolOutput(message.result);
      }
      const before = current.bg.pendingCount;
      current.bg.onToolEnd(String(message.toolName ?? ""), toolCallId, message.result, message.isError === true);
      if (before > 0 && current.bg.pendingCount === 0) this.scheduleSettledReport();
      this.notifyProgress();
    } else if (message.type === "message_update") {
      const streamEvent = (message.assistantMessageEvent ?? message) as Record<string, unknown>;
      if (streamEvent.type === "text_delta") {
        const delta = typeof streamEvent.delta === "string" ? streamEvent.delta : typeof streamEvent.text === "string" ? streamEvent.text : "";
        current.progress.textTail = utf8Slice(`${current.progress.textTail}${delta}`, 400, true);
        let last = current.progress.events.at(-1);
        if (last?.kind !== "text" || !last.open) {
          last = { kind: "text", text: "", open: true };
          this.appendEvent(last);
        }
        const text = last.truncated ? `${last.text.slice(DISPLAY_TRUNCATION.length)}${delta}` : `${last.text}${delta}`;
        if (last.truncated || Buffer.byteLength(text) > MAX_TEXT_EVENT_BYTES) {
          last.text = DISPLAY_TRUNCATION + utf8Slice(text, MAX_TEXT_EVENT_BYTES - Buffer.byteLength(DISPLAY_TRUNCATION), true);
          last.truncated = true;
        } else last.text = text;
        this.notifyProgress();
      }
    } else if (message.type === "message_end") {
      if (msg?.role === "custom") {
        if (current.bg.onNotification({ customType: msg.customType, details: msg.details, content: msg.content })) this.scheduleSettledReport();
        this.notifyProgress();
      } else if (msg?.role === "assistant") {
        this.closeOpenText();
        if (current.active && !current.abortRequested) {
          if (msg.stopReason === "error") {
            current.error = String(msg.errorMessage ?? "Sidekick assistant failed");
            this.recordTransientError(current, current.error);
          } else if (msg.stopReason === "stop" || msg.stopReason === "toolUse" || msg.stopReason === "length") current.error = undefined;
        }
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          const cost = usage.cost as Record<string, unknown> | undefined;
          this.addUsage(current.usage, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: cost?.total });
        }
        this.notifyProgress();
      }
    } else if (message.type === "auto_retry_start") {
      if (typeof message.errorMessage === "string") this.recordTransientError(current, message.errorMessage);
      this.resetSettleState();
      if (current.accepted) this.armPromptDeadline(current);
    } else if (message.type === "auto_retry_end" && message.success === true) {
      if (current.active) current.error = undefined;
    } else if (message.type === "agent_start") {
      if (!current.abortRequested) {
        this.resetSettleState();
        if (current.accepted) this.armPromptDeadline(current);
      }
      this.notifyProgress();
    } else if (message.type === "agent_settled") {
      // Never save a stale settle for replay after ACK/new-user activation.
      if (current.abortRequested || !current.accepted || !current.active) return;
      current.settled = true;
      this.clearPromptTimers(current);
      if (current.bg.pendingCount > 0) this.notifyProgress();
      else this.requestLastAssistantText();
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const current = this.pending;
    if (!current || typeof message.id !== "string") return;
    const id = message.id;
    if (message.command === "prompt") {
      const request = current.promptRequests.get(id);
      if (!request || request.generation !== current.generation) return;
      if (message.success === false) {
        const text = String(message.error ?? "Sidekick prompt rejected");
        if (!/already processing/i.test(text) || request.retried) { this.finish("error", undefined, text); return; }
        request.retried = true;
        try { this.send({ id, type: "prompt", message: request.message, streamingBehavior: "followUp" }); } catch (error) { this.finish("error", undefined, errorText(error)); }
      } else if (message.success === true) {
        current.promptRequests.delete(id);
        current.accepted = true;
        this.resetSettleState();
        this.armPromptDeadline(current);
      }
    } else if (message.command === "get_state" && current.stateRequestId === id) {
      clearTimeout(current.stateTimer);
      current.stateTimer = undefined;
      current.stateRequestId = undefined;
      const data = message.data as Record<string, unknown> | undefined;
      if (message.success !== true || !data) { this.finish("error", undefined, String(message.error ?? "Sidekick state query failed")); return; }
      if (data.isStreaming === true || data.isCompacting === true || (typeof data.pendingMessageCount === "number" && data.pendingMessageCount > 0)) {
        this.armPromptDeadline(current);
      } else {
        this.finish("error", undefined, current.active ? "Sidekick became idle without a final agent_settled event" : "Sidekick prompt was acknowledged but no matching user activity occurred (input handler or command may have consumed it)");
      }
    } else if (message.command === "get_last_assistant_text" && current.reportRequestId === id) {
      this.invalidateReport();
      if (message.success !== true) { this.finish("error", undefined, String(message.error ?? "Sidekick report query failed")); return; }
      const data = message.data as Record<string, unknown> | undefined;
      const text = typeof data?.text === "string" ? data.text : current.progress.textTail;
      this.finish(current.abortRequested ? "aborted" : current.error === undefined ? "completed" : "error", text, current.error);
    } else if (message.command === "abort" && current.abortRequestId === id) {
      clearTimeout(current.abortTimer);
      current.abortTimer = undefined;
      current.abortRequestId = undefined;
      if (message.success !== true) { this.finish("error", undefined, String(message.error ?? "Sidekick abort rejected")); return; }
      this.requestLastAssistantText();
    }
  }

  private addUsage(target: SidekickUsage, raw: Record<string, unknown>): void {
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    target.input += number(raw.input);
    target.output += number(raw.output);
    target.cacheRead += number(raw.cacheRead);
    target.cacheWrite += number(raw.cacheWrite);
    target.cost += number(raw.cost);
    if (target !== this.usage) this.addUsage(this.usage, raw);
  }
  private finish(status: HandoffReport["status"], text?: string, error?: string): void {
    const current = this.pending;
    if (!current) return;
    clearTimeout(current.settleTimer);
    clearTimeout(current.reportTimer);
    clearTimeout(current.abortTimer);
    this.clearPromptTimers(current);
    current.promptRequests.clear();
    this.pending = undefined;
    let reportText = text ?? current.progress.textTail;
    let fullTextPath: string | undefined;
    if (Buffer.byteLength(reportText) > MAX_REPORT_TEXT_BYTES) {
      try {
        const directory = join(dirname(this.cfg.sessionFile), "reports");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Report directory is not a real directory");
        chmodSync(directory, 0o700);
        fullTextPath = join(directory, `handoff-${current.id}.md`);
        writeFileSync(fullTextPath, reportText, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const notice = `\n\n[Report truncated at 64KiB; full evidence: ${fullTextPath}]`;
        reportText = utf8Slice(reportText, MAX_REPORT_TEXT_BYTES - Buffer.byteLength(notice)) + notice;
      } catch (cause) {
        fullTextPath = undefined;
        status = "error";
        error = `${error ? `${error}; ` : ""}Could not preserve full sidekick report: ${errorText(cause)}`;
        const notice = `\n\n[Report truncated; full evidence could not be saved: ${errorText(cause)}]`;
        reportText = utf8Slice(reportText, MAX_REPORT_TEXT_BYTES - Buffer.byteLength(notice)) + notice;
      }
    }
    const report: HandoffReport = {
      id: current.id, status, text: reportText, usage: { ...current.usage }, toolCalls: current.progress.toolCalls,
      durationMs: Date.now() - current.startedAt, events: current.progress.events.map((event) => ({ ...event })),
      ...(error === undefined ? {} : { error }), ...(fullTextPath ? { fullTextPath } : {}),
      ...(current.transientErrors.length ? { transientErrors: [...current.transientErrors] } : {}),
    };
    this.completedHandoffs += 1;
    this.reports.set(report.id, report);
    while (this.reports.size > MAX_REPORTS) this.reports.delete(this.reports.keys().next().value!);
    if (this.latestHandoff?.id === report.id) this.latestHandoff.report = report;
    current.resolve(report);
    this.notifyProgress();
  }

  handoff(message: string): { id: string; done: Promise<HandoffReport> } {
    const current = this.pending;
    if (current) {
      const done = this.latestHandoff!.done;
      this.resetSettleState();
      this.clearPromptTimers(current);
      clearTimeout(current.abortTimer);
      current.abortTimer = undefined;
      current.promptRequests.clear();
      current.abortRequestId = undefined;
      current.abortRequested = false;
      current.error = undefined;
      current.generation += 1;
      current.brief = normalizeBrief(message);
      current.accepted = false;
      current.active = false;
      const id = randomUUID();
      current.promptRequests.set(id, { message, retried: false, generation: current.generation });
      this.armPromptDeadline(current);
      try { this.send({ id, type: "prompt", message, streamingBehavior: "steer" }); } catch (error) { this.finish("error", undefined, errorText(error)); }
      return { id: current.id, done };
    }
    const id = randomUUID();
    const startedAt = Date.now();
    let resolve!: (report: HandoffReport) => void;
    const done = new Promise<HandoffReport>((res) => { resolve = res; });
    this.pending = {
      id, startedAt, usage: emptyUsage(),
      progress: { revision: 0, toolCalls: 0, recentTools: [], textTail: "", startedAt, events: [], droppedEvents: 0 },
      bg: new BackgroundJobTracker(), generation: 1, brief: normalizeBrief(message), accepted: false, active: false,
      settled: false, promptRequests: new Map([[id, { message, retried: false, generation: 1 }]]),
      abortRequested: false, transientErrors: [], resolve,
    };
    this.latestHandoff = { id, done };
    this.armPromptDeadline(this.pending);
    try {
      if (!this.isAlive()) this.spawn();
      this.send({ id, type: "prompt", message });
    } catch (error) {
      this.cleanupPrompt();
      this.finish("error", undefined, errorText(error));
    }
    return { id, done };
  }
  progress(id?: string): HandoffProgress | undefined {
    if (this.pending && (id === undefined || id === this.pending.id)) return { ...this.pending.progress, recentTools: [...this.pending.progress.recentTools], events: this.pending.progress.events.map((event) => ({ ...event })) };
    return undefined;
  }
  latest(): { id: string; done: Promise<HandoffReport>; report?: HandoffReport } | undefined { return this.latestHandoff; }
  async abort(): Promise<void> {
    const current = this.pending;
    if (!current || current.abortRequested) return;
    current.abortRequested = true;
    this.resetSettleState();
    this.clearPromptTimers(current);
    current.promptRequests.clear();
    const id = randomUUID();
    current.abortRequestId = id;
    const timeoutMs = this.cfg.abortTimeoutMs ?? 10_000;
    current.abortTimer = setTimeout(() => {
      if (this.pending === current && current.abortRequestId === id) this.finish("error", undefined, `Sidekick abort ACK not received within ${String(timeoutMs)}ms`);
    }, timeoutMs);
    current.abortTimer.unref();
    try { this.send({ id, type: "abort" }); } catch (error) { this.finish("error", undefined, errorText(error)); }
  }
  kill(): void {
    const child = this.child;
    this.child = undefined;
    this.cleanupPrompt();
    this.inputBuffer = "";
    this.inputBytes = 0;
    this.finish("error", undefined, "Sidekick process stopped");
    this.streamingMessage = undefined;
    this.emitSessionEvent({ type: "runtime_closed" });
    if (child) this.stopChild(child);
  }
}
