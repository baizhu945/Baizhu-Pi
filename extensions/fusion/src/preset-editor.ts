/**
 * @pi-unipi/fusion — `/unipi:fusion-preset` curation component
 *
 * Two-column checklist over every available model:
 *
 *   Search: glm
 *   ─────────────────────────────────────────────────────
 *     L   S    model
 *   › [x][ ]  anthropic/claude-opus-4-6
 *     [ ][x]  omniroute/zai/glm-5.3-flash      ◆ active sidekick
 *     [ ][ ]  omniroute/deepseek/v4-flash
 *
 *   ↑/↓ select · ←/→ column · space toggle lead · Enter save · esc cancel · type to filter
 *
 * Keys follow our overlay conventions (task-manager dock, pi's own model
 * selector): arrows navigate, `Enter` is the primary action (save), `esc`
 * cancels, `tab`/`←→` switch the L/S column, `space` toggles membership with
 * an empty query. While filtering, `space` extends the query; `ctrl+space`
 * always toggles the highlighted model without changing the query.
 * Defaults are not edited here — confirming a Fusion pair in /unipi:model
 * records it as the default.
 */

import { Key, matchesKey, parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "./vendor/core/index.js";
import { adaptiveInnerWidth, normalizeWidth } from "./vendor/core/tui-width.js";
import type { ActiveSelection, FusionPreset, ModelKey } from "./preset.js";

export interface PresetEditorModel {
  key: ModelKey;
  name: string;
}

export type PresetEditorResult =
  | {
      type: "saved";
      target: "global" | "project";
      curation: Pick<FusionPreset, "lead" | "sidekick" | "default">;
    }
  | { type: "cancelled" };

export interface PresetEditorOptions {
  models: readonly PresetEditorModel[];
  initial: Pick<FusionPreset, "lead" | "sidekick" | "default">;
  /** Current selection — its pair becomes the default when still curated. */
  active: ActiveSelection | undefined;
  initialTarget: "global" | "project";
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
  onDone: (result: PresetEditorResult) => void;
  onRenderRequest?: (() => void) | undefined;
  visibleRows?: number | undefined;
}

function printable(data: string): string | undefined {
  const pasted = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
  let text = pasted ? data.slice(6, -6) : data;
  if (!pasted && data.startsWith("\x1b")) {
    const key = parseKey(data);
    if (key === undefined || Array.from(key).length !== 1) return undefined;
    text = key;
  }
  return text.length > 0 && !/[\u0000-\u001f\u007f-\u009f\p{Surrogate}]/u.test(text) ? text : undefined;
}

export class PresetEditor {
  private readonly opts: PresetEditorOptions;
  private lead: Set<ModelKey>;
  private sidekick: Set<ModelKey>;
  private target: "global" | "project";
  private search = "";
  private selected = 0;
  private column: "lead" | "sidekick" = "lead";
  private done = false;

  constructor(opts: PresetEditorOptions) {
    this.opts = opts;
    this.lead = new Set(opts.initial.lead);
    this.sidekick = new Set(opts.initial.sidekick);
    this.target = opts.initialTarget;
  }

  private filtered(): PresetEditorModel[] {
    const q = this.search.toLowerCase();
    const all = this.opts.models;
    const list = q.length === 0 ? [...all] : all.filter((m) => `${m.key} ${m.name}`.toLowerCase().includes(q));
    // Selected models float to the top so the curated set is visible at a glance.
    list.sort((a, b) => {
      const sa = this.lead.has(a.key) || this.sidekick.has(a.key) ? 0 : 1;
      const sb = this.lead.has(b.key) || this.sidekick.has(b.key) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.key.localeCompare(b.key);
    });
    return list;
  }

  private defaultFor(set: Set<ModelKey>, active: ModelKey | undefined, previous: ModelKey | undefined): ModelKey | undefined {
    const available = new Set(this.opts.models.map((m) => m.key));
    // Keep offline membership, but never select an invisible executable default.
    return [active, previous, ...set].find((key) => key !== undefined && set.has(key) && available.has(key));
  }

  handleInput(data: string): void {
    if (this.done) return;
    const list = this.filtered();
    this.selected = Math.min(this.selected, Math.max(0, list.length - 1));
    const cur = list[this.selected];
    if (matchesKey(data, Key.escape)) {
      this.done = true;
      this.opts.onDone({ type: "cancelled" });
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      // Enter = save & close, the primary action in every other overlay.
      this.done = true;
      const lead = [...this.lead];
      const sidekick = [...this.sidekick];
      const def: FusionPreset["default"] = {};
      const active = this.opts.active;
      const dl = this.defaultFor(this.lead, active?.kind === "fusion" ? active.lead : undefined, this.opts.initial.default.lead);
      const ds = this.defaultFor(this.sidekick, active?.kind === "fusion" ? active.sidekick : undefined, this.opts.initial.default.sidekick);
      if (dl !== undefined) def.lead = dl;
      if (ds !== undefined) def.sidekick = ds;
      this.opts.onDone({ type: "saved", target: this.target, curation: { lead, sidekick, default: def } });
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) this.column = "lead";
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.column = "sidekick";
    else if (matchesKey(data, Key.ctrl("space")) || (matchesKey(data, Key.space) && this.search.length === 0)) {
      if (cur) this.toggle(this.column === "lead" ? this.lead : this.sidekick, cur.key);
    } else if (matchesKey(data, Key.space)) {
      this.search += " ";
      this.selected = 0;
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.search = Array.from(this.search).slice(0, -1).join("");
      this.selected = 0;
    } else {
      const ch = printable(data);
      if (ch === undefined) return;
      this.search += ch;
      this.selected = 0;
    }
    this.opts.onRenderRequest?.();
  }

  private toggle(set: Set<ModelKey>, key: ModelKey): void {
    if (set.has(key)) set.delete(key);
    else set.add(key);
    this.selected = Math.max(0, this.filtered().findIndex((model) => model.key === key));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const w = normalizeWidth(width);
    return frameOverlay(this.renderBody(adaptiveInnerWidth(w)), w, { title: "Fusion preset" });
  }

  private renderBody(width: number): string[] {
    const t = this.opts.theme;
    const list = this.filtered();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
    const active = this.opts.active;
    const lines: string[] = [];
    lines.push(`${t.fg("accent", t.bold("Fusion preset"))} ${t.fg("dim", `· ${String(this.lead.size)} lead · ${String(this.sidekick.size)} sidekick · writes to ${this.target}`)}`);
    lines.push(`${t.fg("dim", "Search:")} ${this.search.length > 0 ? t.fg("text", this.search) : t.fg("dim", "(type to filter)")}`);
    lines.push(t.fg("dim", "─".repeat(Math.max(1, width - 2))));
    const colHead = (label: string, col: "lead" | "sidekick") =>
      this.column === col ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
    lines.push(`    ${colHead("L", "lead")}   ${colHead("S", "sidekick")}    ${t.fg("dim", "model")}`);
    const win = normalizeWidth(this.opts.visibleRows ?? 14);
    const start = Math.max(0, Math.min(this.selected - Math.floor(win / 2), list.length - win));
    const end = Math.min(list.length, start + win);
    if (list.length === 0) lines.push(t.fg("warning", "  No models match."));
    for (let i = start; i < end; i++) {
      const m = list[i];
      if (!m) continue;
      const hl = i === this.selected;
      const ptr = hl ? t.fg("accent", "›") : " ";
      const box = (on: boolean, col: "lead" | "sidekick") => {
        const focused = hl && this.column === col;
        const glyph = on ? "[x]" : "[ ]";
        return focused ? t.fg("accent", t.bold(glyph)) : on ? t.fg("success", glyph) : t.fg("dim", glyph);
      };
      const l = box(this.lead.has(m.key), "lead");
      const s = box(this.sidekick.has(m.key), "sidekick");
      const name = hl ? t.fg("accent", m.key) : t.fg("text", m.key);
      const tags: string[] = [];
      if (m.key === this.opts.initial.default.lead) tags.push("default lead");
      if (m.key === this.opts.initial.default.sidekick) tags.push("default sidekick");
      if (active?.kind === "fusion") {
        if (m.key === active.lead) tags.push("active lead");
        if (m.key === active.sidekick) tags.push("active sidekick");
      }
      const tag = tags.length > 0 ? ` ${t.fg("dim", `(${tags.join(", ")})`)}` : "";
      lines.push(truncateToWidth(` ${ptr} ${l} ${s}  ${name}${tag}`, width, "…"));
    }
    if (list.length > win) lines.push(t.fg("dim", `  ${String(start + 1)}-${String(end)} of ${String(list.length)}`));
    lines.push("");
    const spaceHint = this.search.length > 0 ? `space filter · ctrl-space toggle ${this.column}` : `space/ctrl-space toggle ${this.column}`;
    lines.push(t.fg("dim", `↑/↓ select · ←/→ column · ${spaceHint} · Enter save · esc cancel · type to filter`));
    return lines;
  }
}
