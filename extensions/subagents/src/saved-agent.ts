import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { open, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { getAgentDir, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { getAgentConfig } from "./agent-types.js";
import type { AgentRecord, AgentTombstone, SavedAgentSession } from "./types.js";

export function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  return resolve(cwd, sessionDir);
}

export function savedAgentSession(record: AgentRecord): SavedAgentSession | undefined {
  const session = record.session?.sessionManager;
  if (!record.sessionFile || !session) return record.savedSession;
  return {
    sessionFile: record.sessionFile,
    sessionId: session.getSessionId(),
    cwd: session.getCwd(),
    configCwd: record.configCwd,
    isolated: record.isolated,
    worktreeBase: record.worktreeBase,
    worktreeRef: record.worktreeResult?.branch
      ? `refs/heads/${record.worktreeResult.branch}`
      : record.worktree?.baseSha ?? record.savedSession?.worktreeRef,
  };
}

export function openSavedAgentSession(ctx: ExtensionContext, saved: SavedAgentSession, cwd: string): SessionManager {
  const stats = statSync(saved.sessionFile, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.size === 0) throw new Error("The saved child session file is missing or empty.");
  const session = SessionManager.open(saved.sessionFile, undefined, cwd);
  if (session.getSessionId() !== saved.sessionId ||
      session.getHeader()?.parentSession !== ctx.sessionManager.getSessionFile()) {
    throw new Error("The saved child session does not belong to this parent session.");
  }
  return session;
}

export function savedAgent(record: AgentRecord, saved: SavedAgentSession, shutdown?: Promise<void>): AgentTombstone {
  return {
    ...saved,
    id: record.id, type: record.type, description: record.description,
    handle: record.handle, alias: record.alias, completedAt: record.completedAt ?? Date.now(),
    shutdown,
  };
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Read only records on this parent session's active branch. */
export async function findSavedAgent(
  ctx: ExtensionContext,
  id: string,
  sessionDirForType: (type: string) => string | undefined,
): Promise<AgentTombstone | undefined> {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}$/.test(id)) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const entry = branch.findLast(e => e.type === "custom" && e.customType === "subagents:record" && fields(e.data).id === id);
  if (entry?.type !== "custom") return undefined;
  const { type, description, completedAt, handle, alias, resume } = fields(entry.data);
  if (typeof type !== "string" || typeof description !== "string") return undefined;
  const identity = {
    id, type, description,
    completedAt: typeof completedAt === "number" ? completedAt : Date.parse(entry.timestamp),
    handle: typeof handle === "string" ? handle : undefined,
    alias: typeof alias === "string" ? alias : undefined,
  };
  if (resume !== undefined) {
    const { sessionFile, sessionId, cwd, configCwd, isolated, worktreeBase, worktreeRef } = fields(resume);
    if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) ||
      typeof sessionId !== "string" || typeof cwd !== "string" || !isAbsolute(cwd) ||
      (configCwd !== undefined && (typeof configCwd !== "string" || !isAbsolute(configCwd))) ||
      (isolated !== undefined && typeof isolated !== "boolean") ||
      (worktreeBase !== undefined && (typeof worktreeBase !== "string" || !isAbsolute(worktreeBase))) ||
      (worktreeRef !== undefined && (typeof worktreeRef !== "string" ||
        !/^(?:[0-9a-f]{40,64}|refs\/heads\/pi-agent-[0-9a-f-]+)$/.test(worktreeRef)))) return undefined;
    return { ...identity, sessionFile, sessionId, cwd, configCwd, isolated, worktreeBase, worktreeRef };
  }

  // Old records have a full agent ID, but the child file carries only its
  // eight-character suffix in the session name. Require a unique direct child.
  const settings = SettingsManager.create(ctx.cwd, getAgentDir());
  const defaultDir = resolveConfiguredSessionDir(process.env.PI_CODING_AGENT_SESSION_DIR ?? settings.getSessionDir?.(), ctx.cwd);
  const standardDir = resolve(getAgentDir(), "sessions", `--${resolve(ctx.cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const dirs = new Set([sessionDirForType(type), defaultDir, dirname(parentFile), standardDir].filter(dir => dir !== undefined).map(dir => resolve(dir)));
  const matches = new Map<string, { path: string; id: string; cwd: string }>();
  for (const dir of dirs) {
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = resolve(dir, file.name);
      const session = await readLegacyChild(path, parentFile, id);
      if (session) matches.set(path, session);
    }
  }
  if (matches.size !== 1) return undefined;
  const [session] = matches.values();

  // Recover the original explicit isolation request from the tool call, when
  // present. The completion record's type is authoritative even after fallback.
  const spawnResult = branch.find(e => e.type === "message" && e.message.role === "toolResult" &&
    e.message.toolName === "Agent" && fields(e.message.details).agentId === id);
  const callId = spawnResult?.type === "message" && spawnResult.message.role === "toolResult"
    ? spawnResult.message.toolCallId : undefined;
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && part.id === callId && part.name === "Agent" && !part.arguments.resume) {
        identity.alias ??= typeof part.arguments.name === "string" ? part.arguments.name : undefined;
        return {
          ...identity, sessionFile: session.path, sessionId: session.id, cwd: session.cwd,
          isolated: resolveAgentInvocationConfig(getAgentConfig(type), part.arguments).isolated,
        };
      }
    }
  }
  return { ...identity, sessionFile: session.path, sessionId: session.id, cwd: session.cwd };
}

// The old runner wrote session_info before prompting the child. Read that
// prefix only, since the project may contain hundreds of large transcripts.
async function readLegacyChild(path: string, parentFile: string, id: string) {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return undefined;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    const header = JSON.parse(lines.shift() ?? "");
    if (header.type !== "session" || header.parentSession !== parentFile ||
        typeof header.id !== "string" || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) return undefined;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === "message") break;
      if (entry.type === "session_info" && entry.name?.endsWith(`#${id.slice(0, 8)}`)) {
        return { path, id: header.id, cwd: header.cwd };
      }
    }
  } catch {
    // Ignore unrelated, concurrently removed, or malformed session files.
  } finally {
    await file.close();
  }
  return undefined;
}
