import { randomUUID } from "node:crypto";
import { isEffortLevel, type ActiveSelection } from "./preset.js";

/** Custom session entries are durable state, not model-context messages. */
export const FUSION_SESSION_STATE = "fusion-session-state";
export const FUSION_WORK_SCOPE = "fusion-work-scope";

export interface FusionSessionManager {
  getSessionId(): string;
  getBranch(): readonly unknown[];
}

export interface FusionSessionState {
  schema: 1;
  sessionId: string;
  selection: ActiveSelection;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function selection(value: unknown): ActiveSelection | undefined {
  const data = record(value);
  if (!data) return undefined;
  if (data.kind === "single" && typeof data.model === "string" && data.model.trim()) {
    return { kind: "single", model: data.model };
  }
  if (data.kind !== "fusion" || typeof data.lead !== "string" || !data.lead.trim() ||
      typeof data.sidekick !== "string" || !data.sidekick.trim()) return undefined;
  if (data.leadEffort !== undefined && !isEffortLevel(data.leadEffort)) return undefined;
  if (data.sidekickEffort !== undefined && !isEffortLevel(data.sidekickEffort)) return undefined;
  return {
    kind: "fusion", lead: data.lead, sidekick: data.sidekick,
    ...(isEffortLevel(data.leadEffort) ? { leadEffort: data.leadEffort } : {}),
    ...(isEffortLevel(data.sidekickEffort) ? { sidekickEffort: data.sidekickEffort } : {}),
  };
}

export function sessionIdOf(manager: Partial<FusionSessionManager> | undefined): string | undefined {
  try {
    const id = manager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Never restore authorization from the global/project preset or another session. */
export function readSessionSelection(manager: Partial<FusionSessionManager> | undefined): ActiveSelection | undefined {
  const id = sessionIdOf(manager);
  if (!id) return undefined;
  try {
    const branch = manager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = record(branch[i]);
      if (entry?.type !== "custom") continue;
      if (entry.customType === FUSION_WORK_SCOPE) {
        const boundary = record(entry.data);
        if (!boundary || typeof boundary.sessionId !== "string" || !boundary.sessionId.trim() || boundary.sessionId === id) return undefined;
        continue;
      }
      if (entry.customType !== FUSION_SESSION_STATE) continue;
      const data = record(entry.data);
      // An unscoped/corrupt marker cannot be assumed to belong to somebody
      // else: fail closed instead of reviving an earlier enabled marker.
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) return undefined;
      // Forks may copy the parent's entries; those do not authorize the fork.
      if (data.sessionId !== id) continue;
      // Fail closed on a malformed/latest marker, rather than reviving an old on.
      if (data.schema !== 1) return undefined;
      const restored = selection(data.selection);
      if (restored?.kind === "fusion") {
        // A native model switch while the extension was unloaded also revokes
        // the earlier pair. Even switching back later is not a new opt-in.
        for (const later of branch.slice(i + 1)) {
          const change = record(later);
          if (change?.type === "model_change" && `${change.provider}/${change.modelId}` !== restored.lead) return undefined;
        }
      }
      return restored;
    }
  } catch {
    // A disposed/missing session context cannot grant Fusion authorization.
  }
  return undefined;
}

export function createSessionState(
  manager: Partial<FusionSessionManager> | undefined,
  value: ActiveSelection,
): FusionSessionState {
  const sessionId = sessionIdOf(manager);
  const normalized = selection(value);
  if (!sessionId || !normalized || typeof manager?.getBranch !== "function") {
    throw new Error("Fusion requires a valid current session to record the user's selection.");
  }
  return { schema: 1, sessionId, selection: normalized };
}

/** A fresh child conversation after tree navigation cannot inherit abandoned work. */
export function createWorkScope(manager: Partial<FusionSessionManager> | undefined): { schema: 1; sessionId: string; scopeId: string } {
  const sessionId = sessionIdOf(manager);
  if (!sessionId) throw new Error("Fusion requires a current session for work isolation.");
  return { schema: 1, sessionId, scopeId: randomUUID() };
}

export function readWorkScope(manager: Partial<FusionSessionManager> | undefined): string | undefined {
  const id = sessionIdOf(manager);
  if (!id) return undefined;
  try {
    const branch = manager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = record(branch[i]);
      if (entry?.type !== "custom" || entry.customType !== FUSION_WORK_SCOPE) continue;
      const data = record(entry.data);
      if (!data || typeof data.sessionId !== "string") return undefined;
      if (data.sessionId !== id) continue;
      return data.schema === 1 && typeof data.scopeId === "string" && /^[0-9a-f-]{36}$/u.test(data.scopeId)
        ? data.scopeId : undefined;
    }
  } catch { /* disposed contexts are not usable storage */ }
  return undefined;
}
