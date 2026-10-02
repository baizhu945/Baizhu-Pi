/**
 * Background job holds for one sidekick handoff.
 *
 * A handoff stays open until background completion has been delivered, or an
 * explicit cancellation removes the notification obligation. Otherwise the
 * lead gets a truncated transcript. Pi has two completion protocols for that
 * work; both need to be recognized:
 *
 * - `background-command-result` — the local `background-commands` extension
 *   batches finished jobs and carries `details.jobs[]`, each with its own id.
 * - `background-task-notification` — the legacy UniPi notification, a single
 *   job id in `details.id` (or no id at all).
 *
 * Counting one release per notification (the old bare counter) leaves a permanent
 * residue: four jobs delivered in one batch decrement once. Each call-id hold
 * binds to the job id that `bg_run` printed; a notification releases exactly
 * the jobs it names — batched, deduplicated, and never a neighbour's.
 *
 * Only the handoff's own state lives here; the tracker never talks to pi.
 */

export interface BackgroundNotification {
  customType?: unknown;
  details?: unknown;
  content?: unknown;
}

/** `ddabca17 running 0s pid=4711 npm test` — the first line bg_run/bg_status print. */
const JOB_LINE = /^([0-9a-f]{8}) (running|stopping|exited|failed|stopped|killed|aborted|canceled|cancelled)\b/;
/** A job we stopped ourselves delivers no automatic completion. */
const STOPPED_LINE = /^([0-9a-f]{8}) (stopped|killed|aborted|canceled|cancelled)\b/;

type Launch = { jobId?: string };
type ActiveCall = { name: string; launch?: Launch; requestedId?: string };
export const MAX_RECENT_BACKGROUND_IDS = 300;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Full tool output text — the job id sits in the first line, before any tail truncation. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const details = record(result);
  if (details === undefined) return "";
  const content = details.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const entry = record(part);
      return text(entry?.text) ?? (typeof part === "string" ? part : undefined) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

/** `details.task.id` (legacy UniPi) or `details.id` / `jobId` / `taskId`. */
function jobIdFromDetails(details: unknown): string | undefined {
  const outer = record(details);
  if (outer === undefined) return undefined;
  return text(record(outer.task)?.id) ?? text(outer.id) ?? text(outer.jobId) ?? text(outer.taskId);
}

function jobIdFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  return text(args.id) ?? text(args.taskId) ?? text(args.jobId);
}

function jobIdFromResult(result: unknown): string | undefined {
  const details = record(result);
  const structured = jobIdFromDetails(details?.details);
  if (structured !== undefined) return structured;
  const line = firstLine(resultText(result));
  return JOB_LINE.exec(line)?.[1];
}

function jobIdsFromCommandResult(details: unknown): string[] {
  const outer = record(details);
  if (outer === undefined) return [];
  const jobs = outer.jobs;
  if (!Array.isArray(jobs)) {
    const id = jobIdFromDetails(outer);
    return id === undefined ? [] : [id];
  }
  const ids = new Set<string>();
  for (const job of jobs) {
    const id = text(record(job)?.id);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

function stoppedJobIds(result: unknown, requestedId?: string): string[] {
  const ids = new Set<string>();
  const details = record(record(result)?.details);
  const addStopped = (value: Record<string, unknown> | undefined, fallbackId?: string): void => {
    if (value === undefined || !["stopped", "killed", "aborted", "canceled", "cancelled"].includes(String(value.state ?? value.status))) return;
    const id = jobIdFromDetails(value) ?? fallbackId;
    if (id !== undefined) ids.add(id);
  };
  addStopped(details, requestedId);
  addStopped(record(details?.task), jobIdFromDetails(details) ?? requestedId);
  const jobs = details?.jobs;
  if (Array.isArray(jobs)) {
    for (const job of jobs) addStopped(record(job));
  }
  for (const line of resultText(result).split("\n")) {
    const match = STOPPED_LINE.exec(line.trim());
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
}

export class BackgroundJobTracker {
  /** Holds outlive tool calls; reusing a completed call id creates a fresh launch. */
  private readonly launches = new Set<Launch>();
  private readonly activeCalls = new Map<string, ActiveCall>();
  /** Only early IDs awaiting launch binding; completed/irrelevant IDs are discarded. */
  private readonly releasedJobs = new Set<string>();

  get pendingCount(): number {
    return this.launches.size;
  }

  onToolStart(name: string, callId: string, args: Record<string, unknown> | undefined): void {
    if (this.activeCalls.has(callId)) return;
    if (name === "bg_run") {
      const launch = args?.notifyOnCompletion === false || args?.triggerOnCompletion === false ? undefined : {};
      if (launch) this.launches.add(launch);
      this.activeCalls.set(callId, { name, launch });
    } else if (name === "bg_kill" || name === "bg_status") {
      this.activeCalls.set(callId, { name, requestedId: jobIdFromArgs(args) });
    }
  }

  onToolEnd(name: string, callId: string, result: unknown, isError: boolean): void {
    // Native end events may omit toolName. Only dispatch a currently active
    // call; old completed bg_run IDs must never turn a bash end into a launch.
    const call = this.activeCalls.get(callId);
    if (!call || (name !== "" && name !== call.name)) return;
    this.activeCalls.delete(callId);
    const failed = isError || record(result)?.isError === true;
    if (call.name === "bg_run") {
      const launch = call.launch;
      if (!launch || !this.launches.has(launch)) { this.pruneReleasedJobs(); return; }
      const details = record(record(result)?.details);
      const task = record(details?.task);
      if (failed || details?.notifyOnCompletion === false || details?.triggerOnCompletion === false || task?.notifyOnCompletion === false || task?.triggerOnCompletion === false) {
        this.launches.delete(launch);
        this.pruneReleasedJobs();
        return;
      }
      const jobId = jobIdFromResult(result);
      launch.jobId = jobId;
      if ((jobId !== undefined && this.releasedJobs.has(jobId)) || stoppedJobIds(result, jobId).length > 0) this.launches.delete(launch);
    } else if (call.name === "bg_kill") {
      // Accepted cancellation, even `stopping`, removes the delivery obligation.
      if (call.requestedId !== undefined && !failed) this.releaseJob(call.requestedId);
    } else if (call.name === "bg_status" && !failed) {
      const stopped = stoppedJobIds(result, call.requestedId);
      if (call.requestedId !== undefined) {
        if (stopped.includes(call.requestedId)) this.releaseJob(call.requestedId);
      } else {
        for (const id of stopped) this.releaseJob(id);
      }
    }
    this.pruneReleasedJobs();
  }

  onNotification(message: BackgroundNotification): boolean {
    const before = this.pendingCount;
    const customType = message.customType;
    if (customType === "background-command-result") {
      const ids = jobIdsFromCommandResult(message.details);
      for (const id of ids) this.releaseJob(id);
      return this.pendingCount < before;
    } else if (customType === "background-task-notification") {
      const id = jobIdFromDetails(message.details);
      if (id !== undefined) {
        this.releaseJob(id);
        return this.pendingCount < before;
      }
    } else {
      return false;
    }
    // Legacy id-less notification: at most one still-unbound launch, never a
    // job we already know by name.
    this.releaseUnboundLaunch();
    return this.pendingCount < before;
  }

  private hasUnboundCall(): boolean {
    return [...this.activeCalls.values()].some((call) => call.launch !== undefined && this.launches.has(call.launch) && call.launch.jobId === undefined);
  }

  private pruneReleasedJobs(): void {
    if (!this.hasUnboundCall()) this.releasedJobs.clear();
  }

  private releaseJob(id: string): void {
    for (const launch of this.launches) {
      if (launch.jobId === id) this.launches.delete(launch);
    }
    if (!this.hasUnboundCall()) { this.releasedJobs.clear(); return; }
    // Until tool end binds IDs, an unrelated notice is indistinguishable from
    // an early completion. Never silently evict evidence needed for that race:
    // fail explicitly on pathological overflow rather than hang a lost hold.
    if (!this.releasedJobs.has(id) && this.releasedJobs.size >= MAX_RECENT_BACKGROUND_IDS) throw new Error("Background early-notification cache exceeded 300 IDs before launch binding");
    this.releasedJobs.add(id);
  }

  private releaseUnboundLaunch(): void {
    // Only the old single-job, id-less fixture is unambiguous. In particular,
    // an anonymous notice must not guess between several active launches.
    if (this.pendingCount !== 1) return;
    for (const launch of this.launches) {
      if (launch.jobId !== undefined) continue;
      this.launches.delete(launch);
      this.pruneReleasedJobs();
      return;
    }
  }
}