import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SidekickRuntime, HandoffProgress, HandoffReport } from "./sidekick-runtime.js";
import { LEAD_ROLE_BOUNDARY } from "./prompts.js";
import { duration, fitTranscript, frameSidekick, markdownText, renderSidekickTranscript, sidekickWorkingHeader, type SidekickTranscript, type TranscriptOptions } from "./transcript.js";

const SidekickParams = Type.Object({
  message: Type.String({ description: "Self-contained execution brief for any task: objective, context, scope, constraints, acceptance criteria, checks, deliverables and existing authorization. Delegate investigation as well as implementation; the lead does not execute task work." }),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)" })),
});
const ReadSubagentParams = Type.Object({
  agent_id: Type.Optional(Type.String({ description: "Handoff id; omit to use the latest handoff" })),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default false: snapshot)" })),
  timeout: Type.Optional(Type.Number({ minimum: 0, description: "Maximum wait in seconds" })),
});

export interface FusionToolDeps {
  getRuntime: (ctx: ExtensionContext) => SidekickRuntime | undefined;
  /** Do not wake a disabled Fusion mode or a replaced lead/sidekick session. */
  isReportCurrent?: (report: HandoffReport) => boolean;
  onReport?: (ctx: ExtensionContext, report: HandoffReport) => void;
  onHandoffStart?: (ctx: ExtensionContext) => void;
  onAttach?: (ctx: ExtensionContext) => void;
  onDetach?: (ctx: ExtensionContext) => void;
}

export interface FusionControls {
  /** Use the same handoff, waiter ownership and completion delivery as model tools. */
  sendToSidekick(ctx: ExtensionContext, message: string): string;
}

type CompletionOutcome = { report: HandoffReport } | { error: string };
type WaitToken = symbol;

/** One done subscription per handoff; only the owner of a wait token can release it. */
export function createCompletionDelivery(
  send: (report: HandoffReport) => void | boolean,
  options: {
    onFailure?: (id: string, error: string) => void | boolean;
    onDiagnostic?: (id: string, error: string) => void;
  } = {},
) {
  type State = {
    waiting: Set<WaitToken>;
    subscribed: boolean;
    consumed: boolean;
    delivered: boolean;
    queued: boolean;
    outcome?: CompletionOutcome;
    done: Promise<CompletionOutcome>;
    resolve: (outcome: CompletionOutcome) => void;
  };
  const states = new Map<string, State>();
  const stateFor = (id: string): State => {
    let state = states.get(id);
    if (!state) {
      let resolve!: State["resolve"];
      const done = new Promise<CompletionOutcome>((res) => { resolve = res; });
      state = { waiting: new Set(), subscribed: false, consumed: false, delivered: false, queued: false, done, resolve };
      states.set(id, state);
    }
    return state;
  };
  const deliver = (id: string, state: State): void => {
    if (state.queued || state.consumed || state.delivered) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      if (!state.outcome || state.waiting.size > 0 || state.consumed || state.delivered) return;
      try {
        const sent = "report" in state.outcome ? send(state.outcome.report) : options.onFailure?.(id, state.outcome.error);
        if (sent !== false) state.delivered = true;
      } catch (error) {
        // A later explicit detach/read can retry. Never spin on a broken sender.
        try { options.onDiagnostic?.(id, errorText(error)); } catch { /* diagnostics cannot break delivery */ }
      }
    });
  };
  const observe = (id: string, done: Promise<HandoffReport>): Promise<CompletionOutcome> => {
    const state = stateFor(id);
    if (!state.subscribed) {
      state.subscribed = true;
      const settle = (outcome: CompletionOutcome): void => {
        state.outcome = outcome;
        state.resolve(outcome);
        deliver(id, state);
      };
      void done.then((report) => settle({ report }), (error) => settle({ error: errorText(error) }));
    }
    return state.done;
  };
  return {
    observe,
    attach(id: string): WaitToken {
      const token = Symbol(id);
      stateFor(id).waiting.add(token);
      return token;
    },
    detach(id: string, done: Promise<HandoffReport>, token?: WaitToken): void {
      const state = stateFor(id);
      if (token !== undefined) state.waiting.delete(token);
      observe(id, done);
      deliver(id, state);
    },
    consume(id: string): void {
      stateFor(id).consumed = true;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

function progressText(runtime: SidekickRuntime, id: string, progress = runtime.progress(id)): string {
  if (!progress) return "No active handoff progress.";
  const elapsed = duration(Date.now() - progress.startedAt);
  const recent = progress.recentTools ?? [];
  const tools = recent.length > 0 ? `\n${recent.map((tool) => `  ${tool}`).join("\n")}` : "";
  const tail = progress.textTail ? `\n  ${progress.textTail}` : "";
  return `◆ sidekick working · ${String(progress.toolCalls)} tool calls · ${elapsed}${tools}${tail}`;
}

function progressKey(progress: HandoffProgress | undefined): string {
  if (!progress) return "";
  if (progress.revision !== undefined) return String(progress.revision);
  const events = progress.events ?? [];
  const last = events.at(-1);
  return `${String(progress.toolCalls)}|${(progress.recentTools ?? []).join("|")}|${progress.textTail ?? ""}|${String(events.length)}|${last?.kind === "tool" ? `${String(last.output?.length ?? 0)}|${String(last.done)}` : last?.kind === "text" ? `${String(last.text?.length ?? 0)}|${String(last.open)}` : ""}`;
}

export const MODEL_CONTENT_MAX_BYTES = 32 * 1024;
const fullTextPaths = new WeakMap<HandoffReport, string>();

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let end = Math.max(0, Math.min(maxBytes, bytes.length));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function modelText(text: string, fullTextPath?: string): string {
  if (Buffer.byteLength(text) <= MODEL_CONTENT_MAX_BYTES) return text;
  const suffix = `\n\n[Output truncated to 32 KiB.${fullTextPath ? ` Full report: ${fullTextPath}` : ""}]`;
  return utf8Prefix(text, MODEL_CONTENT_MAX_BYTES - Buffer.byteLength(suffix)) + suffix;
}

function reportPath(report: HandoffReport, required = false): string | undefined {
  if (report.fullTextPath) return report.fullTextPath;
  const cached = fullTextPaths.get(report);
  if (cached) return cached;
  // Runtime artifacts start at 64 KiB; preserve the 32–64 KiB gap here too.
  if (!required) return undefined;
  const path = join(mkdtempSync(join(tmpdir(), "fusion-report-")), "report.txt");
  writeFileSync(path, report.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fullTextPaths.set(report, path);
  return path;
}

function reportText(report: HandoffReport): string {
  const usage = report.usage ? ` · in ${String(report.usage.input)} / out ${String(report.usage.output)} tokens` : "";
  const text = `${report.text}\n\n--- sidekick ${report.id} · ${report.status} · ${String(report.toolCalls)} tool calls · ${duration(report.durationMs)}${usage}`;
  return modelText(text, reportPath(report, Buffer.byteLength(text) > MODEL_CONTENT_MAX_BYTES));
}

function result(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: modelText(text) }], details: details ?? {} };
}

type WaitOutcome = { report?: HandoffReport; interrupted?: string; aborted?: boolean; error?: string };

async function waitForReport(
  runtime: SidekickRuntime,
  id: string,
  done: Promise<CompletionOutcome>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: ((update: unknown) => void) | undefined,
  diagnostic: (message: string) => void,
  timeoutMs = 2700000,
): Promise<WaitOutcome> {
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let abortStarted = false;
  const abort = (): void => {
    if (abortStarted) return;
    abortStarted = true;
    // An old wait must not cancel a newer handoff on the shared runtime.
    if (runtime.latest()?.id !== id) return;
    try {
      void Promise.resolve(runtime.abort()).catch((error) => diagnostic(`Sidekick abort failed: ${errorText(error)}`));
    } catch (error) {
      diagnostic(`Sidekick abort failed: ${errorText(error)}`);
    }
  };
  try {
    const outcome = await new Promise<WaitOutcome>((resolve) => {
      let finished = false;
      let lastProgressKey = "";
      let update = onUpdate;
      const finish = (value: WaitOutcome): void => {
        if (finished) return;
        finished = true;
        resolve(value);
      };
      const interrupted = (): boolean => {
        if (signal?.aborted) { abort(); finish({ aborted: true }); return true; }
        if (ctx.hasPendingMessages?.()) { finish({ interrupted: progressText(runtime, id) }); return true; }
        return false;
      };
      abortListener = () => { abort(); finish({ aborted: true }); };
      signal?.addEventListener("abort", abortListener, { once: true });
      // One reaction, not one new race reaction for every progress tick.
      void done.then((value) => {
        if (!finished && !interrupted()) finish(value);
      });
      if (interrupted()) return;
      deadlineTimer = setTimeout(() => { if (!interrupted()) finish({}); }, Math.min(timeoutMs, 2147483647));
      const tick = (): void => {
        if (finished || interrupted()) return;
        try {
          const progress = runtime.progress(id);
          const key = progressKey(progress);
          if (key !== lastProgressKey) {
            lastProgressKey = key;
            update?.({ content: [{ type: "text", text: modelText(progressText(runtime, id, progress)) }], details: { progress } });
          }
        } catch (error) {
          update = undefined;
          diagnostic(`Sidekick progress display failed: ${errorText(error)}`);
        }
        if (!finished) progressTimer = setTimeout(tick, 500);
      };
      progressTimer = setTimeout(tick, 500);
    });
    // Cancellation/user input can arrive after resolve but before this continuation.
    if (signal?.aborted) { abort(); return { aborted: true }; }
    if (outcome.report && ctx.hasPendingMessages?.()) return { interrupted: progressText(runtime, id) };
    return outcome;
  } finally {
    if (progressTimer !== undefined) clearTimeout(progressTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

function completionMessage(report: HandoffReport) {
  const open = `<subagent_completion_notification agent_id="${report.id}" status="${report.status}">\n`;
  const close = "\n</subagent_completion_notification>";
  const budget = MODEL_CONTENT_MAX_BYTES - Buffer.byteLength(open + close);
  const path = reportPath(report, Buffer.byteLength(report.text) > budget);
  const suffix = `\n\n[Output truncated to 32 KiB.${path ? ` Full report: ${path}` : ""}]`;
  const text = Buffer.byteLength(report.text) > budget ? utf8Prefix(report.text, budget - Buffer.byteLength(suffix)) + suffix : report.text;
  return { customType: "sidekick-completion", content: open + text + close, display: true, details: path ? { ...report, fullTextPath: path } : report };
}

type ThemeLike = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type FramedTheme = ThemeLike & { bg: (color: string, text: string) => string };

function transcriptStatus(partial: boolean, report: Partial<HandoffReport> | undefined): "working" | "completed" | "error" {
  if (partial) return "working";
  return report?.status === "completed" ? "completed" : "error";
}

function frameTranscript(theme: ThemeLike, status: "working" | "completed" | "error", content: Component): Component {
  return frameSidekick(theme as FramedTheme, status, content);
}

// Model-facing ids/protocol must not reach terminal fallback content.
const HANDOFF_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function displayText(text: string): string {
  return text
    .replace(/<\/?subagent_completion_notification[^>]*>/g, "")
    .replace(/use `?read_subagent`?[^.\n]*\.?/gi, "")
    .replace(HANDOFF_ID, "")
    .replace(/agent_id[ =]?"?"?/g, "")
    .replace(/read_subagent\([^)]*\)/g, "read_subagent")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\bHandoff\s*(?=(is|was|failed|aborted|started)\b)/g, "The handoff ")
    .replace(/ for\s*\./g, ".")
    .replace(/ +$/gm, "")
    .trim();
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").filter(Boolean).join("\n");
}

function backgroundComponent(theme: ThemeLike): Component {
  return fitTranscript(new Text(`${theme.fg("accent", theme.bold("◆ sidekick"))} ${theme.fg("dim", "· continuing in background")}`, 0, 0));
}

type ToolDetails = Partial<HandoffReport> & { progress?: HandoffProgress; background?: boolean };
type RenderContext = { state: Record<string, unknown> };
type TranscriptState = { theme: ThemeLike; status: "working" | "completed" | "error"; transcript: SidekickTranscript; framed: Component };

function persistentTranscript(theme: ThemeLike, status: TranscriptState["status"], opts: TranscriptOptions, context?: RenderContext): Component {
  let state = context?.state.fusionTranscript as TranscriptState | undefined;
  if (!state || state.theme !== theme || state.status !== status) {
    const transcript = renderSidekickTranscript(theme, opts);
    state = { theme, status, transcript, framed: frameTranscript(theme, status, transcript) };
    if (context) context.state.fusionTranscript = state;
  } else state.transcript.update(opts);
  return state.framed;
}
function reportHeader(theme: ThemeLike, label: string, report: Partial<HandoffReport> | undefined): string {
  const status = report?.status ?? "done";
  const metrics = report ? `· ${String(report.toolCalls ?? 0)} tool calls · ${duration(report.durationMs ?? 0)}${report.usage ? ` · in ${String(report.usage.input ?? 0)} / out ${String(report.usage.output ?? 0)} tokens` : ""}` : "";
  return `${theme.fg(status === "completed" ? "success" : "error", "◆")} ${theme.fg("accent", theme.bold(`${label} ${status}`))} ${theme.fg("dim", metrics)}`;
}

function renderToolTranscript(toolResult: { content?: unknown; details?: unknown }, options: { expanded?: boolean }, theme: ThemeLike, label: "sidekick" | "read_subagent", context?: RenderContext): Component {
  const details = typeof toolResult.details === "object" && toolResult.details !== null ? toolResult.details as ToolDetails : undefined;
  if (details?.background === true) return backgroundComponent(theme);
  const hasProgress = details !== undefined && "progress" in details;
  const progress = details?.progress;
  if (hasProgress && !progress) return backgroundComponent(theme);
  const report = progress ? undefined : details;
  if (!progress && typeof report?.text !== "string") return fitTranscript(new Text(displayText(contentText(toolResult.content)), 0, 0));
  const events = progress?.events ?? report?.events;
  return persistentTranscript(theme, transcriptStatus(Boolean(progress), report), {
    events: Array.isArray(events) ? events : [],
    droppedEvents: progress?.droppedEvents,
    header: progress ? sidekickWorkingHeader(theme, progress, label) : reportHeader(theme, label, report),
    expanded: options.expanded === true,
    isPartial: Boolean(progress),
    report: typeof report?.text === "string" ? { text: displayText(report.text) } : undefined,
    renderText: (text) => markdownText(displayText(text)),
  }, context);
}

function renderCompletionCard(theme: ThemeLike, report: Partial<HandoffReport> | undefined, expanded: boolean): Component {
  if (!report) return fitTranscript(new Text(`${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold("sidekick done"))}`, 0, 0));
  return frameTranscript(theme, transcriptStatus(false, report), renderSidekickTranscript(theme, {
    events: Array.isArray(report.events) ? report.events : [],
    header: reportHeader(theme, "sidekick", report),
    expanded,
    isPartial: false,
    report: typeof report.text === "string" ? { text: displayText(report.text) } : undefined,
    renderText: (text) => markdownText(displayText(text)),
  }));
}

export function registerFusionTools(pi: ExtensionAPI, deps: FusionToolDeps): FusionControls {
  pi.registerMessageRenderer("sidekick-completion", (message: { details?: HandoffReport }, options, theme) => renderCompletionCard(theme as unknown as ThemeLike, message.details, options.expanded));
  pi.registerMessageRenderer("sidekick-diagnostic", (message) => fitTranscript(new Text(displayText(contentText(message.content)), 0, 0)));
  const diagnostic = (ctx: ExtensionContext | undefined, message: string): void => {
    try {
      if (ctx?.hasUI !== false && ctx?.ui?.notify) ctx.ui.notify(message, "warning");
      else pi.sendMessage({ customType: "sidekick-diagnostic", content: modelText(message), display: true }, { triggerTurn: false });
    } catch (error) {
      console.warn(`${message} (diagnostic delivery failed: ${errorText(error)})`);
    }
  };
  const safeCallback = (ctx: ExtensionContext, label: string, callback: (() => void) | undefined): void => {
    try { callback?.(); } catch (error) { diagnostic(ctx, `${label} failed: ${errorText(error)}`); }
  };
  const origins = new Map<string, { runtime: SidekickRuntime; ctx: ExtensionContext }>();
  const published = new WeakSet<HandoffReport>();
  const current = (report: HandoffReport): boolean => deps.isReportCurrent?.(report) !== false;
  const publish = (ctx: ExtensionContext, report: HandoffReport): void => {
    if (!current(report) || published.has(report)) return;
    published.add(report);
    safeCallback(ctx, "Sidekick status update", () => deps.onReport?.(ctx, report));
  };
  const completion = createCompletionDelivery((report) => {
    if (!current(report)) return false;
    const origin = origins.get(report.id);
    if (origin) publish(origin.ctx, report);
    if (!current(report)) return false;
    pi.sendMessage(completionMessage(report) as never, { deliverAs: "followUp", triggerTurn: true });
  }, {
    onFailure: (id, error) => {
      const origin = origins.get(id);
      // Rejected done has no runtime-owned report to pass to isReportCurrent.
      if (!origin || deps.getRuntime(origin.ctx) !== origin.runtime) return false;
      const failed: HandoffReport = { id, status: "error", text: `Sidekick handoff failed: ${error}`, error, events: [], toolCalls: 0, durationMs: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      pi.sendMessage(completionMessage(failed) as never, { deliverAs: "followUp", triggerTurn: true });
    },
    onDiagnostic: (id, error) => diagnostic(origins.get(id)?.ctx, `Sidekick completion delivery failed: ${error}. The report remains available via read_subagent.`),
  });

  // Pi ignores a returned isError. Preserve report details and mark only our
  // own report results, using an unforgeable per-registration symbol.
  const ownReport = Symbol("fusion report result");
  pi.on("tool_result", (event) => {
    if (event.toolName !== "sidekick" && event.toolName !== "read_subagent") return;
    const details = event.details as (HandoffReport & { [ownReport]?: string }) | undefined;
    if (details?.[ownReport] === event.toolName && details.status !== "completed") return { isError: true };
  });
  const reportResult = (name: "sidekick" | "read_subagent", report: HandoffReport) => {
    if (!current(report)) throw new Error("Sidekick report belongs to an inactive session or branch; it was not returned.");
    const text = reportText(report);
    const path = reportPath(report);
    return result(text, { ...report, ...(path ? { fullTextPath: path } : {}), [ownReport]: name });
  };
  const collect = async (name: "sidekick" | "read_subagent", runtime: SidekickRuntime, id: string, done: Promise<HandoffReport>, signal: AbortSignal | undefined, onUpdate: ((update: never) => void) | undefined, ctx: ExtensionContext, timeoutMs?: number) => {
    const token = completion.attach(id);
    safeCallback(ctx, "Sidekick attach status", () => deps.onAttach?.(ctx));
    let consumed = false;
    try {
      const waited = await waitForReport(runtime, id, completion.observe(id, done), signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined, (message) => diagnostic(ctx, message), timeoutMs);
      // Recheck at the tool boundary too: no stale inline or status publication.
      if (waited.report && !signal?.aborted && !ctx.hasPendingMessages?.()) {
        const output = reportResult(name, waited.report);
        publish(ctx, waited.report);
        if (!current(waited.report)) throw new Error("Sidekick report belongs to an inactive session or branch; it was not returned.");
        if (signal?.aborted) throw new Error(`Handoff ${id} aborted.`);
        if (ctx.hasPendingMessages?.()) return result("A user message arrived. Update the plan and sidekick brief before collecting the report; remain the coordinator and delegate any new task work.");
        completion.consume(id);
        consumed = true;
        return output;
      }
      if (waited.error) { completion.consume(id); throw new Error(`Handoff ${id} failed: ${waited.error}`); }
      if (waited.aborted || signal?.aborted) throw new Error(`Handoff ${id} aborted.`);
      const progress = progressText(runtime, id);
      if (waited.interrupted || ctx.hasPendingMessages?.()) return result(`A user message arrived while the sidekick (agent_id ${id}) was working. The handoff continues in the background. Update the plan and brief as needed, then call read_subagent({agent_id:"${id}", block:true}) to collect the report or sidekick({message}) to redirect it. Remain the coordinator; delegate all new task work.\n${waited.interrupted ?? progress}`, { progress: runtime.progress(id), id });
      return result(`Handoff ${id} is still running.\n${progress}`, { progress: runtime.progress(id), id });
    } finally {
      completion.detach(id, done, token);
      if (!consumed) safeCallback(ctx, "Sidekick detach status", () => deps.onDetach?.(ctx));
    }
  };
  const reportLimits = " Output cap: 32 KiB; fullTextPath contains truncated reports. Ask the sidekick for missing report sections or evidence instead of reading files or running checks yourself. Token counts describe sidekick usage.";
  const begin = (ctx: ExtensionContext, message: string) => {
    const runtime = deps.getRuntime(ctx);
    if (!runtime) throw new Error("Fusion is not active — pick a Fusion pair with /unipi:model.");
    const wasBusy = runtime.isBusy();
    const handoff = runtime.handoff(message);
    origins.set(handoff.id, { runtime, ctx });
    if (!wasBusy) safeCallback(ctx, "Sidekick start status", () => deps.onHandoffStart?.(ctx));
    return { runtime, handoff };
  };

  pi.registerTool({
    name: "sidekick",
    label: "Sidekick",
    description: "Delegate all task execution to the persistent sidekick sharing this filesystem, including research, simple questions, writing, implementation, verification and authorized external actions. The lead only plans, assigns and accepts results. block:true (default) waits; block:false delivers completion automatically. Calls during a handoff steer it, not a second worker. Cancelling a blocking wait requests abort." + reportLimits,
    promptSnippet: "Delegate every substantive task to sidekick; the Fusion lead only plans, assigns, reviews and accepts results.",
    promptGuidelines: [
      LEAD_ROLE_BOUNDARY,
      "Give a self-contained brief with acceptance criteria and existing authorization. Delegate even tiny tasks and investigation you could do yourself.",
      "Sidekick failure, delay or missing evidence requires another brief, clarification or a blocker report; never take over execution.",
    ],
    parameters: SidekickParams,
    renderCall: (args, theme) => fitTranscript(new Text(`${theme.fg("toolTitle", theme.bold("◆ sidekick"))} ${theme.fg("dim", firstLine(String(args.message)).slice(0, 100))}`, 0, 0)),
    renderResult: (toolResult, options, theme, context) => renderToolTranscript(toolResult, options, theme as unknown as ThemeLike, "sidekick", context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { runtime, handoff } = begin(ctx, params.message);
      if (params.block === false) {
        completion.detach(handoff.id, handoff.done);
        safeCallback(ctx, "Sidekick detach status", () => deps.onDetach?.(ctx));
        return result(`Handoff ${handoff.id} started in the background. You will receive a <subagent_completion_notification agent_id="${handoff.id}"> when it finishes; use read_subagent to wait.`, { background: true, id: handoff.id });
      }
      return collect("sidekick", runtime, handoff.id, handoff.done, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "read_subagent",
    label: "Read Sidekick",
    description: "Collect sidekick reports and execution evidence for lead review and acceptance, not for taking over the work. agent_id selects a handoff (omit for the latest). block:true waits for completion (default timeout 2700s when omitted); block:false or omitted returns the current progress snapshot immediately." + reportLimits,
    promptSnippet: "Collect sidekick evidence for acceptance; send corrections or missing checks back to sidekick.",
    promptGuidelines: [
      "Review the report against acceptance criteria; completed status alone is not proof. Request missing evidence, corrections and verification from sidekick.",
      "Use block:true when waiting for a result instead of repeated polling. While waiting, do coordination work only.",
    ],
    parameters: ReadSubagentParams,
    renderCall: (args, theme) => fitTranscript(new Text(`${theme.fg("toolTitle", theme.bold("◆ read_subagent"))} ${theme.fg("dim", args.block === true ? "· waiting" : "· snapshot")}`, 0, 0)),
    renderResult: (toolResult, options, theme, context) => renderToolTranscript(toolResult, options, theme as unknown as ThemeLike, "read_subagent", context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = deps.getRuntime(ctx);
      if (!runtime) throw new Error("Fusion is not active — pick a Fusion pair with /unipi:model.");
      const latest = runtime.latest();
      if (!latest) throw new Error("No sidekick handoff has run yet.");
      const id = params.agent_id ?? latest.id;
      const selected = runtime.reports.get(id);
      if (selected) {
        if (signal?.aborted) throw new Error(`Handoff ${id} aborted.`);
        if (ctx.hasPendingMessages?.()) return result("A user message arrived. Update the plan and sidekick brief before collecting the report; remain the coordinator and delegate any new task work.");
        const output = reportResult("read_subagent", selected);
        publish(ctx, selected);
        if (!current(selected)) throw new Error("Sidekick report belongs to an inactive session or branch; it was not returned.");
        if (signal?.aborted) throw new Error(`Handoff ${id} aborted.`);
        if (ctx.hasPendingMessages?.()) return result("A user message arrived. Update the plan and sidekick brief before collecting the report; remain the coordinator and delegate any new task work.");
        completion.consume(id);
        return output;
      }
      if (id !== latest.id) throw new Error(`No sidekick handoff found for ${id}.`);
      origins.set(id, { runtime, ctx });
      if (params.block !== true) {
        completion.detach(id, latest.done);
        return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`, { progress: runtime.progress(id), id });
      }
      if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout < 0)) throw new Error("timeout must be a finite, non-negative number of seconds.");
      return collect("read_subagent", runtime, id, latest.done, signal, onUpdate, ctx, (params.timeout ?? 2700) * 1000);
    },
  });
  return {
    sendToSidekick(ctx, message) {
      const text = message.trim();
      if (!text) throw new Error("Sidekick message cannot be empty.");
      const { handoff } = begin(ctx, text);
      completion.detach(handoff.id, handoff.done);
      safeCallback(ctx, "Sidekick detach status", () => deps.onDetach?.(ctx));
      return handoff.id;
    },
  };
}

export { reportText, progressText };
