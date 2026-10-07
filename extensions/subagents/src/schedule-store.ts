/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { safePathId } from "./path-id.js";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function acquireLock(lockPath: string): string {
  const token = `${process.pid}:${randomUUID()}`;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx", mode: 0o600 });
      return token;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          const validPid = Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
          if (validPid ? !isProcessRunning(pid) : i >= 2) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore — try again */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

function releaseLock(lockPath: string, token: string): void {
  try { if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${safePathId(sessionId)}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Load from disk into the in-memory cache. Silent on parse errors. */
  private load(strict = false): void {
    if (!existsSync(this.filePath)) { this.jobs.clear(); return; }
    try {
      const data: Partial<ScheduleStoreData> = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.jobs)) {
        throw new Error("Invalid schedule store");
      }
      const loaded = new Map<string, ScheduledSubagent>();
      for (const job of data.jobs) {
        if (!job || typeof job !== "object" || typeof job.id !== "string"
          || typeof job.name !== "string" || typeof job.description !== "string"
          || typeof job.prompt !== "string" || typeof job.subagent_type !== "string"
          || typeof job.schedule !== "string" || typeof job.enabled !== "boolean"
          || !["interval", "once", "cron"].includes(job.scheduleType)) {
          if (strict) throw new Error("Invalid schedule record");
          continue;
        }
        if (strict && loaded.has(job.id)) throw new Error("Duplicate schedule ID");
        loaded.set(job.id, { ...job, runCount: Number.isSafeInteger(job.runCount) && job.runCount >= 0 ? job.runCount : 0 });
      }
      this.jobs = loaded;
    } catch {
      if (strict) throw new Error(`Refusing to overwrite unreadable or malformed schedule store: ${this.filePath}`);
    }
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(tmp, this.filePath);
    } finally { try { unlinkSync(tmp); } catch { /* renamed or never created */ } }
  }

  /** Acquire lock → reload → mutate → save → release. */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    const token = acquireLock(this.lockPath);
    try {
      this.load(true);
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    this.load();
    return structuredClone([...this.jobs.values()]);
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    this.load();
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    this.load();
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      if ([...this.jobs.values()].some(existing => existing.name === job.name && existing.id !== job.id)) {
        throw new Error(`A scheduled job named "${job.name}" already exists.`);
      }
      this.jobs.set(job.id, structuredClone(job));
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.get(id)) return undefined;
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      if (patch.id !== undefined && patch.id !== id) throw new Error("Schedule ID cannot be changed");
      const updated = { ...existing, ...patch, id };
      this.jobs.set(id, updated);
      return structuredClone(updated);
    });
  }

  remove(id: string): boolean {
    // No-op fast path — see update().
    if (!this.get(id)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (!existsSync(this.filePath)) return;
    const token = acquireLock(this.lockPath);
    try {
      this.load(true);
      if (this.jobs.size === 0) unlinkSync(this.filePath);
    } finally { releaseLock(this.lockPath, token); }
  }
}
