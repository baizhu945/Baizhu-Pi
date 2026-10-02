/** Small, process-local background shell jobs for Pi. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_JOBS = 32;
const OUTPUT_BYTES = 64 * 1024;
const DEFAULT_VIEW_CHARS = 4000;
const MAX_WIDGET_JOBS = 6;
const WIDGET_KEY = "background-commands";
const COMPLETION_BATCH_MS = 250;

type State = "running" | "stopping" | "exited" | "failed" | "stopped";
type Job = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  state: State;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  outputBytes: number;
  output: Buffer;
  autoDeliver: boolean;
  killTimer?: NodeJS.Timeout;
};
type CompletionRow = {
  id: string;
  command: string;
  state: State;
  exitCode?: number | null;
  signal?: string | null;
  durationMs: number;
};
type CompletionDetails = { jobs: CompletionRow[] };

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  const pendingCompletions = new Map<string, Job>();
  let shuttingDown = false;
  let agentRunning = false;
  let completionTimer: NodeJS.Timeout | undefined;
  let widgetUi: ExtensionContext["ui"] | undefined;
  let widgetTui: { terminal: { columns: number }; requestRender(): void } | undefined;
  let widgetRegistered = false;
  let widgetTimer: NodeJS.Timeout | undefined;

  const activeJobs = () => [...jobs.values()].filter((job) => job.state === "running" || job.state === "stopping");

  function renderWidget(theme: { fg(color: "accent" | "dim", text: string): string }): string[] {
    const active = activeJobs();
    if (!active.length || !widgetTui) return [];
    const width = Math.max(1, widgetTui.terminal.columns);
    const lines = [truncateToWidth(theme.fg("accent", "Background"), width)];
    const shown = active.slice(-MAX_WIDGET_JOBS);
    for (const job of shown) {
      const prefix = `  ${job.id}  `;
      const seconds = Math.floor((Date.now() - job.startedAt) / 1000);
      const suffix = `  ${seconds}s`;
      const command = stripTerminalSequences(job.command).replace(/\s+/g, " ").trim();
      const space = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      lines.push(truncateToWidth(prefix + truncateToWidth(command, space) + theme.fg("dim", suffix), width));
    }
    return lines;
  }

  function updateWidget(): void {
    if (!widgetUi) return;
    if (!activeJobs().length) {
      if (widgetRegistered) widgetUi.setWidget(WIDGET_KEY, undefined);
      widgetRegistered = false;
      widgetTui = undefined;
      if (widgetTimer) clearInterval(widgetTimer);
      widgetTimer = undefined;
      return;
    }
    if (!widgetRegistered) {
      widgetUi.setWidget(WIDGET_KEY, (tui, theme) => {
        widgetTui = tui;
        return { render: () => renderWidget(theme), invalidate() {} };
      }, { placement: "aboveEditor" });
      widgetRegistered = true;
    } else {
      widgetTui?.requestRender();
    }
    if (!widgetTimer) widgetTimer = setInterval(() => widgetTui?.requestRender(), 1000);
  }

  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    agentRunning = false;
    if (ctx.mode !== "tui") return;
    if (widgetRegistered) widgetUi?.setWidget(WIDGET_KEY, undefined);
    widgetUi = ctx.ui;
    widgetRegistered = false;
    widgetTui = undefined;
    updateWidget();
  });

  pi.registerMessageRenderer<CompletionDetails>("background-command-result", (message, { expanded }, theme) => {
    const details = message.details as CompletionDetails | (Partial<CompletionRow> & { id?: string }) | undefined;
    let rows: CompletionRow[] = [];
    if (details && "jobs" in details && Array.isArray(details.jobs)) {
      rows = details.jobs;
    } else if (details && "id" in details && typeof details.id === "string") {
      rows = [{ id: details.id, command: "", state: details.state ?? "exited", exitCode: details.exitCode, signal: details.signal, durationMs: 0 }];
    }
    if (!rows.length) return undefined;

    const failed = rows.some((row) => row.state !== "exited");
    const lines = [theme.bold(`Background · ${rows.length} job${rows.length === 1 ? "" : "s"} finished`)];
    for (const row of rows) {
      const icon = row.state === "exited" ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const command = truncateToWidth(stripTerminalSequences(row.command).replace(/\s+/g, " ").trim(), 60);
      const outcome = row.exitCode === null || row.exitCode === undefined
        ? (row.signal ?? row.state)
        : `exit ${row.exitCode}`;
      const elapsed = row.durationMs > 0 ? ` · ${Math.round(row.durationMs / 1000)}s` : "";
      lines.push(`${icon} ${row.id}${command ? `  ${command}` : ""}  ${theme.fg("dim", `${outcome}${elapsed}`)}`);
    }
    if (expanded) {
      const payload = typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      lines.push("", ...payload.split("\n").map((line) => theme.fg("toolOutput", `  ${line}`)));
    } else {
      lines.push(theme.fg("dim", "  Ctrl+O to expand output"));
    }
    const box = new Box(1, 0, (text) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  function clearCompletionTimer(): void {
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = undefined;
  }

  function flushCompletions(): void {
    clearCompletionTimer();
    if (shuttingDown || pendingCompletions.size === 0) return;
    const completed = [...pendingCompletions.values()];
    pendingCompletions.clear();
    const sections = completed.map((job) => `Background command ${job.id} finished.\n${statusForJob(job, OUTPUT_BYTES)}`);
    const content = `Background command result${completed.length === 1 ? "" : "s"} (${completed.length}). Use these results to continue the user's task; no bg_status call is needed for final output.\n\n${sections.join("\n\n---\n\n")}`;
    const details: CompletionDetails = {
      jobs: completed.map((job) => ({
        id: job.id, command: job.command, state: job.state, exitCode: job.exitCode,
        signal: job.signal, durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      })),
    };
    try {
      pi.sendMessage({ customType: "background-command-result", content, display: true, details },
        { deliverAs: "steer", triggerTurn: true });
    } catch (error) {
      const ids = completed.map((job) => job.id).join(", ");
      const message = `Could not deliver background results ${ids}: ${String(error)}. Use bg_status to inspect them.`;
      if (widgetUi) widgetUi.notify(message, "error");
      else console.error(message);
    }
  }

  function queueCompletion(job: Job): void {
    pendingCompletions.set(job.id, job);
    if (agentRunning || completionTimer) return;
    completionTimer = setTimeout(() => {
      completionTimer = undefined;
      if (!agentRunning) flushCompletions();
    }, COMPLETION_BATCH_MS);
  }

  // Keep results here throughout inference AND the entire tool batch. Sending
  // during inference puts separate messages in Pi's one-at-a-time steer queue,
  // even when all those results are waiting before the next tool returns.
  pi.on("agent_start", () => {
    agentRunning = true;
    clearCompletionTimer();
  });
  pi.on("turn_end", () => flushCompletions());
  pi.on("agent_end", () => {
    agentRunning = false;
    flushCompletions();
  });

  function append(job: Job, chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    job.outputBytes += bytes.length;
    job.output = Buffer.concat([job.output, bytes]).subarray(-OUTPUT_BYTES);
  }

  function signalGroup(job: Job, signal: NodeJS.Signals): void {
    try {
      if (job.child.pid) process.kill(-job.child.pid, signal);
      else job.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  function stop(job: Job): void {
    if (job.state !== "running") return;
    job.state = "stopping";
    updateWidget();
    signalGroup(job, "SIGTERM");
    job.killTimer = setTimeout(() => {
      if (job.state === "stopping") signalGroup(job, "SIGKILL");
    }, 2000);
  }

  function start(command: string, name: string | undefined, cwd: string, autoDeliver = false): Job {
    if (!command.trim()) throw new Error("Command cannot be empty");
    if (jobs.size >= MAX_JOBS) {
      for (const [id, job] of jobs) {
        if (job.state !== "running" && job.state !== "stopping") jobs.delete(id);
        if (jobs.size < MAX_JOBS) break;
      }
      if (jobs.size >= MAX_JOBS) throw new Error(`At most ${MAX_JOBS} active jobs`);
    }

    let id: string;
    do id = randomBytes(4).toString("hex"); while (jobs.has(id));
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job: Job = {
      id, name: name?.trim() || command.slice(0, 80), command, cwd, child,
      state: "running", startedAt: Date.now(), outputBytes: 0, output: Buffer.alloc(0), autoDeliver,
    };
    jobs.set(id, job);
    child.stdout?.on("data", (chunk: Buffer) => append(job, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(job, chunk));
    child.once("error", (error) => { job.error = error.message; });
    child.once("close", (code, signal) => {
      if (job.killTimer) clearTimeout(job.killTimer);
      const wasStopping = job.state === "stopping";
      job.state = wasStopping ? "stopped" : job.error || code !== 0 ? "failed" : "exited";
      job.exitCode = code;
      job.signal = signal;
      job.endedAt = Date.now();
      updateWidget();
      if (job.autoDeliver && job.state !== "stopped" && !shuttingDown) {
        queueCompletion(job);
      }
    });
    updateWidget();
    return job;
  }

  function summary(job: Job): string {
    const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
    const result = job.state === "running" || job.state === "stopping"
      ? `pid=${job.child.pid ?? "?"}`
      : `exit=${job.exitCode ?? "-"}${job.signal ? ` signal=${job.signal}` : ""}`;
    return `${job.id} ${job.state} ${seconds}s ${result} ${job.name}`;
  }

  function description(job: Job): string {
    return `${summary(job)}\ncommand: ${job.command}\ncwd: ${job.cwd}`;
  }

  function statusForJob(job: Job, maxChars = DEFAULT_VIEW_CHARS): string {
    const output = job.output.toString("utf8").slice(-maxChars);
    const omitted = job.outputBytes > Buffer.byteLength(output);
    return [
      description(job),
      ...(job.error ? [`error: ${job.error}`] : []),
      `output (${job.outputBytes} bytes${omitted ? ", showing tail" : ""}):`,
      output || "(none yet)",
    ].join("\n");
  }

  function status(id?: string, maxChars = DEFAULT_VIEW_CHARS): string {
    if (!id) return jobs.size ? [...jobs.values()].map(description).join("\n\n") : "No background jobs";
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown background job: ${id}`);
    return statusForJob(job, maxChars);
  }

  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

  pi.registerTool({
    name: "bg_run",
    label: "Background command",
    description: "Start a background command in the current directory. Returns a job ID; completion automatically delivers exit status and output.",
    promptGuidelines: [
      "Use bg_run for independent work or persistent processes; use bash if the next step needs the result. Completion is automatic; avoid polling.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to start in the current working directory" }),
      name: Type.Optional(Type.String({ description: "Optional short label shown in job listings" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const job = start(params.command, params.name, ctx.cwd, true);
      return result(`${description(job)}\nContinue independent work; the final result will arrive automatically. Do not poll for completion.`);
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", "bg_run")}\n${theme.fg("dim", "$ ")}${args.command}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background status",
    description: "Read a job status and bounded output tail, or omit id to list jobs. Completion is automatic; query interim status only when useful.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job ID returned by bg_run; omit to list all tracked jobs" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192, description: "Maximum recent output characters to show for one job (default 4000)" })),
    }),
    async execute(_id, params) { return result(status(params.id, params.maxChars)); },
    renderCall(args, theme) {
      const job = args.id ? jobs.get(args.id) : undefined;
      const command = job ? `\n${theme.fg("dim", "$ ")}${job.command}` : "";
      return new Text(`${theme.fg("toolTitle", "bg_status")} ${args.id ?? "all jobs"}${command}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Stop background command",
    description: "Stop a background process group (SIGTERM, then SIGKILL after 2 seconds if needed). Use bg_status to confirm a stopping job has exited.",
    parameters: Type.Object({ id: Type.String({ description: "Job ID returned by bg_run or listed by bg_status" }) }),
    async execute(_id, params) {
      const job = jobs.get(params.id);
      if (!job) throw new Error(`Unknown background job: ${params.id}`);
      stop(job);
      return result(description(job));
    },
    renderCall(args, theme) {
      const job = jobs.get(args.id);
      const command = job ? `\n${theme.fg("dim", "$ ")}${job.command}` : "";
      return new Text(`${theme.fg("toolTitle", "bg_kill")} ${args.id}${command}`, 0, 0);
    },
  });

  pi.registerCommand("bg", {
    description: "Run a background shell command: /bg <command>",
    handler: async (args, ctx) => {
      try { ctx.ui.notify(description(start(args, undefined, ctx.cwd)), "info"); }
      catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
  pi.registerCommand("jobs", {
    description: "List jobs or show output: /jobs [id]",
    handler: async (args, ctx) => {
      try { ctx.ui.notify(status(args.trim() || undefined), "info"); }
      catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
  pi.registerCommand("kill", {
    description: "Stop a background job: /kill <id>",
    handler: async (args, ctx) => {
      const job = jobs.get(args.trim());
      if (!job) { ctx.ui.notify(`Unknown background job: ${args.trim()}`, "error"); return; }
      stop(job);
      ctx.ui.notify(description(job), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearCompletionTimer();
    pendingCompletions.clear();
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    if (widgetRegistered) widgetUi?.setWidget(WIDGET_KEY, undefined);
    widgetUi = undefined;
    widgetTui = undefined;
    widgetRegistered = false;
    const active = [...jobs.values()].filter((job) => job.state === "running" || job.state === "stopping");
    const settled = active.map((job) => new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        job.child.removeListener("close", onClose);
        resolve();
      }, 5000);
      const onClose = () => { clearTimeout(timeout); resolve(); };
      job.child.once("close", onClose);
    }));
    for (const job of active) stop(job);
    await Promise.all(settled);
  });
}
