/**
 * @pi-unipi/fusion — fusion preset store
 *
 * The preset is the user-curated, finite model list the `/unipi:model` picker
 * shows (pi's full catalogue can be 400+ entries). It also remembers the
 * per-model effort (thinking level), the default lead/sidekick pair, the
 * currently active selection, and the MRU list.
 *
 * Layers (deep-merged, project on top; arrays replace, objects merge):
 *   global  ~/.unipi/config/fusion/preset.json
 *   project <cwd>/.unipi/fusion-preset.json
 *
 * Writes go to the layer the user chose (default global). The active
 * selection + recent list are runtime state and always persist globally.
 */

import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PRESET_SCHEMA_VERSION = 1;

/** pi thinking levels in ascending effort order (used by ←/→ in the picker). */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type FusionBadge = "new" | "promotion" | "beta";

export const RECENT_LIMIT = 5;

/** `provider/modelId` */
export type ModelKey = string;

export interface FusionPair {
  lead: ModelKey;
  sidekick: ModelKey;
}

export type ActiveSelection =
  | { kind: "single"; model: ModelKey }
  | {
      kind: "fusion";
      lead: ModelKey;
      sidekick: ModelKey;
      /** Fusion-row efforts are independent of per-model memory. */
      leadEffort?: EffortLevel | undefined;
      sidekickEffort?: EffortLevel | undefined;
    };

export interface FusionPreset {
  schema_version: number;
  /** Models offered as lead (also shown as plain single-model rows). */
  lead: ModelKey[];
  /** Models offered as sidekick. */
  sidekick: ModelKey[];
  /** Default pair used when the Fusion row is confirmed without editing. */
  default: Partial<FusionPair>;
  /** Remembered per-model effort. */
  effort: Record<ModelKey, EffortLevel>;
  /** MRU single models / leads, newest first, max RECENT_LIMIT. */
  recent: ModelKey[];
  /** Optional hand-curated model badge metadata. */
  badges: Record<ModelKey, FusionBadge>;
  /** Manual pricing overrides for providers that report no pricing. */
  prices: Record<ModelKey, { input: number; cachedInput: number; output: number; cacheWrite?: number }>;
  /** What the user last confirmed in the picker. */
  active?: ActiveSelection | undefined;
}

export function emptyPreset(): FusionPreset {
  return {
    schema_version: PRESET_SCHEMA_VERSION,
    lead: [],
    sidekick: [],
    default: {},
    effort: {},
    recent: [],
    badges: {},
    prices: {},
  };
}

export function globalPresetPath(home = homedir()): string {
  return join(home, ".unipi", "config", "fusion", "preset.json");
}

export function projectPresetPath(cwd: string): string {
  return join(cwd, ".unipi", "fusion-preset.json");
}

export function modelKey(model: { provider: string; id: string }): ModelKey {
  return `${model.provider}/${model.id}`;
}

export function splitModelKey(key: ModelKey): { provider: string; id: string } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || key.endsWith("/")) return undefined;
  const provider = key.slice(0, slash);
  const id = key.slice(slash + 1);
  if (!provider.trim() || !id.trim() || provider.trim() !== provider || id.trim() !== id) return undefined;
  return { provider, id };
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isModelKey(value: unknown): value is ModelKey {
  return typeof value === "string" && splitModelKey(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (isModelKey(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Validate + normalise an arbitrary JSON value into a partial preset. */
export function parsePreset(raw: unknown): Partial<FusionPreset> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<FusionPreset> = {};
  if ("lead" in r) out.lead = stringArray(r["lead"]);
  if ("sidekick" in r) out.sidekick = stringArray(r["sidekick"]);
  if (typeof r["default"] === "object" && r["default"] !== null) {
    const d = r["default"] as Record<string, unknown>;
    out.default = {};
    if (isModelKey(d["lead"])) out.default.lead = d["lead"];
    if (isModelKey(d["sidekick"])) out.default.sidekick = d["sidekick"];
  }
  if (typeof r["effort"] === "object" && r["effort"] !== null) {
    const effort: Record<string, EffortLevel> = {};
    for (const [k, v] of Object.entries(r["effort"] as Record<string, unknown>)) {
      if (isModelKey(k) && isEffortLevel(v)) effort[k] = v;
    }
    out.effort = effort;
  }
  if ("recent" in r) out.recent = stringArray(r["recent"]).slice(0, RECENT_LIMIT);
  if (typeof r["badges"] === "object" && r["badges"] !== null) {
    const badges: Record<ModelKey, FusionBadge> = {};
    for (const [k, v] of Object.entries(r["badges"] as Record<string, unknown>)) {
      if (isModelKey(k) && (v === "new" || v === "promotion" || v === "beta")) badges[k] = v;
    }
    out.badges = badges;
  }
  if (typeof r["prices"] === "object" && r["prices"] !== null) {
    const prices: FusionPreset["prices"] = {};
    for (const [k, v] of Object.entries(r["prices"] as Record<string, unknown>)) {
      if (!isModelKey(k) || !isRecord(v)) continue;
      const input = v["input"];
      const cachedInput = v["cachedInput"];
      const output = v["output"];
      const cacheWrite = v["cacheWrite"];
      if (validPrice(input) && validPrice(cachedInput) && validPrice(output) &&
          (cacheWrite === undefined || validPrice(cacheWrite))) {
        prices[k] = { input, cachedInput, output, ...(cacheWrite === undefined ? {} : { cacheWrite }) };
      }
    }
    out.prices = prices;
  }
  const active = r["active"];
  if (typeof active === "object" && active !== null) {
    const a = active as Record<string, unknown>;
    if (a["kind"] === "single" && isModelKey(a["model"])) {
      out.active = { kind: "single", model: a["model"] };
    } else if (
      a["kind"] === "fusion" &&
      isModelKey(a["lead"]) &&
      isModelKey(a["sidekick"])
    ) {
      out.active = {
        kind: "fusion",
        lead: a["lead"],
        sidekick: a["sidekick"],
        ...(isEffortLevel(a["leadEffort"]) ? { leadEffort: a["leadEffort"] } : {}),
        ...(isEffortLevel(a["sidekickEffort"]) ? { sidekickEffort: a["sidekickEffort"] } : {}),
      };
    }
  }
  return out;
}

export function mergePresets(base: FusionPreset, over: Partial<FusionPreset>): FusionPreset {
  return {
    schema_version: PRESET_SCHEMA_VERSION,
    lead: over.lead ?? base.lead,
    sidekick: over.sidekick ?? base.sidekick,
    default: { ...base.default, ...(over.default ?? {}) },
    effort: { ...base.effort, ...(over.effort ?? {}) },
    recent: over.recent ?? base.recent,
    badges: { ...base.badges, ...(over.badges ?? {}) },
    prices: { ...base.prices, ...(over.prices ?? {}) },
    active: over.active ?? base.active,
  };
}

interface PresetDocument {
  raw: Record<string, unknown>;
  mode: number;
}

function storeError(action: string, path: string, error: unknown): Error {
  return new Error(`Cannot ${action} Fusion preset ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Missing files are empty; malformed JSON, unsupported schemas and IO errors are not. */
function readDocument(path: string): PresetDocument | undefined {
  let fd: number;
  try {
    // Never follow a preset symlink or block on a FIFO supplied by a project.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw storeError("read", path, error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("expected a regular JSON file");
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!isRecord(raw)) throw new Error("expected a JSON object");
    if ("schema_version" in raw && raw["schema_version"] !== PRESET_SCHEMA_VERSION) {
      throw new Error(`unsupported schema_version ${JSON.stringify(raw["schema_version"])}`);
    }
    return { raw, mode: stat.mode & 0o777 };
  } catch (error) {
    throw storeError("read", path, error);
  } finally {
    closeSync(fd);
  }
}

export interface LoadedPreset {
  preset: FusionPreset;
  globalPath: string;
  projectPath: string;
  hasProjectLayer: boolean;
}

/** Same LoadedPreset shape; throws on malformed/unsupported/unreadable existing layers. */
export function loadPreset(cwd: string, home = homedir()): LoadedPreset {
  const globalPath = globalPresetPath(home);
  const projectPath = projectPresetPath(cwd);
  const globalRaw = readDocument(globalPath)?.raw;
  const projectRaw = readDocument(projectPath)?.raw;
  let preset = mergePresets(emptyPreset(), parsePreset(globalRaw));
  const hasProjectLayer = projectRaw !== undefined;
  if (hasProjectLayer) {
    const project = parsePreset(projectRaw);
    // Picker runtime memory is global-only, never a project override or authorization.
    delete project.active;
    delete project.recent;
    preset = mergePresets(preset, project);
  }
  return { preset, globalPath, projectPath, hasProjectLayer };
}

/**
 * All writers use a cross-process, exclusive lock for the complete read/modify/rename.
 * Fail fast on contention (no event-loop waits). Locks are never auto-reclaimed:
 * after a crash an operator must verify the recorded PID/token and lock inode before
 * removing the abandoned lock. This deliberately cannot delete another live owner.
 */
function withWriteLock(path: string, update: (existing: Record<string, unknown>) => Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Fusion preset write lock exists: ${lockPath}. Writer busy or lock abandoned; retry after the writer finishes. An abandoned lock must be manually verified (PID/token/inode) before removal; it is never automatically removed or followed.`);
    }
    throw storeError("lock", path, error);
  }
  let identity: ReturnType<typeof fstatSync> | undefined;
  try {
    identity = fstatSync(fd);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, dev: identity.dev, ino: identity.ino })}\n`, "utf8");
    fsyncSync(fd);
    const existing = readDocument(path);
    const next = update(existing?.raw ?? {});
    writeJsonAtomic(path, next, existing?.mode);
  } catch (error) {
    throw storeError("save", path, identity === undefined
      ? new Error(`${error instanceof Error ? error.message : String(error)}; lock ownership could not be verified, manually inspect ${lockPath} before removal`)
      : error);
  } finally {
    try {
      if (identity !== undefined) unlinkOwned(lockPath, identity);
    } catch (error) {
      throw storeError("release lock for", path, error);
    } finally {
      closeSync(fd);
    }
  }
}

/** A replacement inode or symlink is not this writer's file. Never follow it. */
function unlinkOwned(path: string, identity: { dev: number | bigint; ino: number | bigint }): void {
  try {
    const current = lstatSync(path);
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeJsonAtomic(path: string, value: unknown, existingMode?: number): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let identity: ReturnType<typeof fstatSync> | undefined;
  let owned = false;
  try {
    fd = openSync(tmp, "wx", 0o600);
    identity = fstatSync(fd);
    owned = true;
    // Preserve restrictions already present, never introduce new group/other access.
    fchmodSync(fd, (existingMode ?? 0o600) & 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    owned = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owned && identity !== undefined) unlinkOwned(tmp, identity);
  }
}

function assertKeys(value: unknown, field: string): asserts value is ModelKey[] {
  if (!Array.isArray(value) || !value.every(isModelKey)) throw new Error(`invalid ${field}: expected qualified provider/modelId keys`);
}

/** Persist curated lists to one layer; keeps unknown fields. Synchronous, busy locks throw. */
export function saveCuration(
  path: string,
  curation: Pick<FusionPreset, "lead" | "sidekick" | "default">,
): void {
  assertKeys(curation.lead, "lead");
  assertKeys(curation.sidekick, "sidekick");
  if (!isRecord(curation.default) || Object.entries(curation.default).some(([key, value]) =>
    (key === "lead" || key === "sidekick") && !isModelKey(value))) throw new Error("invalid default model keys");
  withWriteLock(path, (existing) => {
    const previousDefault = isRecord(existing["default"]) ? { ...existing["default"] } : {};
    delete previousDefault["lead"];
    delete previousDefault["sidekick"];
    return {
      ...existing,
      schema_version: PRESET_SCHEMA_VERSION,
      lead: stringArray(curation.lead),
      sidekick: stringArray(curation.sidekick),
      default: { ...previousDefault, ...curation.default },
    };
  });
}

/**
 * Synchronous global runtime PATCH, not a loaded-preset snapshot:
 * effort contains only dirty keys; recent contains newly touched keys, newest first.
 * Both merge into the latest disk state under the write lock. An omitted active is
 * preserved; an explicitly undefined active clears it. Active is picker preference
 * only (last successful writer), never session authorization. Busy/invalid IO throws.
 */
export function saveRuntimeState(
  globalPath: string,
  state: Pick<FusionPreset, "effort" | "recent"> & { active?: ActiveSelection | undefined },
): void {
  if (!isRecord(state.effort) || Object.entries(state.effort).some(([key, value]) =>
    !isModelKey(key) || !isEffortLevel(value))) throw new Error("invalid effort PATCH");
  assertKeys(state.recent, "recent PATCH");
  const active = parsePreset({ active: state.active }).active;
  if (state.active !== undefined && (active === undefined ||
      (state.active.kind === "fusion" &&
        ((state.active.leadEffort !== undefined && !isEffortLevel(state.active.leadEffort)) ||
         (state.active.sidekickEffort !== undefined && !isEffortLevel(state.active.sidekickEffort)))))) {
    throw new Error("invalid active model selection");
  }
  withWriteLock(globalPath, (existing) => {
    const next: Record<string, unknown> = {
      ...existing,
      schema_version: PRESET_SCHEMA_VERSION,
      effort: { ...(isRecord(existing["effort"]) ? existing["effort"] : {}), ...state.effort },
      recent: stringArray([...state.recent, ...stringArray(existing["recent"])]).slice(0, RECENT_LIMIT),
    };
    if ("active" in state) {
      if (active === undefined) delete next["active"];
      else {
        const previous = isRecord(existing["active"]) ? { ...existing["active"] } : {};
        for (const key of ["kind", "model", "lead", "sidekick", "leadEffort", "sidekickEffort"]) delete previous[key];
        next["active"] = { ...previous, ...active };
      }
    }
    return next;
  });
}

// ── pure helpers used by the picker ────────────────────────────────────────

export function pushRecent(recent: readonly ModelKey[], key: ModelKey): ModelKey[] {
  if (!isModelKey(key)) throw new Error("invalid recent model key");
  return stringArray([key, ...recent]).slice(0, RECENT_LIMIT);
}

export function stepEffort(current: EffortLevel, delta: -1 | 1): EffortLevel {
  const index = EFFORT_LEVELS.indexOf(current);
  const next = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index + delta));
  return EFFORT_LEVELS[next] ?? current;
}

/** Devin-style label: off→None, xhigh→XHigh, max→Max, others capitalised. */
export function effortLabel(level: EffortLevel): string {
  if (level === "off") return "None";
  if (level === "xhigh") return "XHigh";
  if (level === "max") return "Max";
  return level.charAt(0).toUpperCase() + level.slice(1);
}
