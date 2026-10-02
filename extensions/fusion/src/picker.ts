/**
 * @pi-unipi/fusion — Devin-style model picker component
 *
 * Layout (learned from Devin CLI `/model`, not copied):
 *
 *   / type to search
 *   ──────────────────────────────────────────────────────────────
 *   ❭ Fusion              ← ◼◼◼◼◻ → High     Lead Opus… ▾  Sidekick GLM… ▾
 *   · GLM-5.3 Flash ✓       ◼◼◼◼◼     Max
 *   · Claude Opus 5         ◼◼◼       Medium
 *     ↓ more below
 *
 *   Input      Cached input   Output     Sidekick input  Sidekick output
 *   $10 / 1M   $0.25 / 1M     $50 / 1M   $0.2 / 1M       $1.2 / 1M
 *   ↑/↓ select · ←/→ effort · tab lead · Enter confirm · esc cancel
 *
 * Row order: the active selection pinned first, then the always-visible Fusion
 * row (disabled with a setup hint when no pair is configured), then recent
 * (≤5, MRU), then the preset models, then EVERY other available model — the
 * catalogue is never hidden, the preset only controls ordering. Typing filters
 * all rows except the pinned one.
 *
 * ←/→ steps the highlighted row's effort. Per-model effort is remembered for
 * plain model rows; the Fusion row keeps its own lead/sidekick efforts so
 * adjusting one never rewrites a model's standalone level.
 *
 * When a single model is selected, its row lights up with ✓ (plus accent
 * styling). When Fusion is selected, the selection lives on the Fusion row
 * only — plain model rows stay unmarked.
 *
 * On the Fusion row, Tab cycles effort → lead → sidekick (Shift+Tab
 * reverses); the lead/sidekick focus opens an inline dropdown fed by the
 * preset lists. In the sidekick dropdown, ←/→ adjusts its independent effort.
 */

import { Key, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "./vendor/core/index.js";
import { adaptiveInnerWidth, normalizeWidth } from "./vendor/core/tui-width.js";
import {
  effortLabel,
  EFFORT_LEVELS,
  stepEffort,
  type ActiveSelection,
  type EffortLevel,
  type FusionBadge,
  type ModelKey,
} from "./preset.js";
import { blendedPrice, renderSlider, sliderPosition, validPrice } from "./slider.js";

// ── Data contracts ─────────────────────────────────────────────────────────

export interface PickerModel {
  key: ModelKey;
  name: string;
  provider: string;
  badge?: FusionBadge | undefined;
  /** $/1M tokens; undefined when the catalogue has no price. */
  cost?: { input: number; cachedInput: number; output: number; cacheWrite?: number | undefined } | undefined;
  reasoning: boolean;
}

export interface PickerState {
  models: readonly PickerModel[];
  fusionLeads: readonly ModelKey[];
  fusionSidekicks: readonly ModelKey[];
  fusionDefault: { lead?: ModelKey | undefined; sidekick?: ModelKey | undefined };
  recent: readonly ModelKey[];
  active: ActiveSelection | undefined;
  /** The session's current model — its row lights up with ✓. */
  currentModelKey: ModelKey | undefined;
  effort: Readonly<Record<ModelKey, EffortLevel>>;
  /** Effort used for a model with no remembered level. */
  fallbackEffort: EffortLevel;
}

export type PickerResult =
  | {
      type: "single";
      model: ModelKey;
      effort: EffortLevel;
      effortMap: Record<ModelKey, EffortLevel>;
      /** Only standalone model keys the user adjusted (including reverted edits). */
      effortUpdates?: Record<ModelKey, EffortLevel> | undefined;
    }
  | {
      type: "fusion";
      lead: ModelKey;
      sidekick: ModelKey;
      leadEffort: EffortLevel;
      sidekickEffort: EffortLevel;
      effortMap: Record<ModelKey, EffortLevel>;
      effortUpdates?: Record<ModelKey, EffortLevel> | undefined;
    }
  | { type: "cancelled" };

export interface PickerTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export interface PickerOptions {
  state: PickerState;
  theme: PickerTheme;
  onDone: (result: PickerResult) => void;
  onRenderRequest?: (() => void) | undefined;
  /** Rows visible in the list window. */
  visibleRows?: number | undefined;
}

// ── Rows ───────────────────────────────────────────────────────────────────

type Row = { kind: "fusion" } | { kind: "model"; key: ModelKey };
type FusionFocus = "effort" | "lead" | "sidekick";

const DEFAULT_VISIBLE_ROWS = 10;
/** Preferred name width on roomy terminals; never a narrow-screen floor. */
const NAME_COL_MIN = 24;
const MARKER_COL = 2;
const BAR_SEGMENTS = 5;
/** Visible columns outside the name: pointer + marker prefix (4) + effort block (19). */
const FIXED_COLS = 23;

/**
 * A model needs a provider prefix when its display name alone is ambiguous:
 * it contains a "/" (so it reads like a `provider/id` key), or the same name
 * is offered by more than one provider.
 */
function ambiguousNamesOf(models: readonly PickerModel[]): Set<string> {
  const providersByName = new Map<string, Set<string>>();
  for (const m of models) {
    const set = providersByName.get(m.name) ?? new Set<string>();
    set.add(m.provider);
    providersByName.set(m.name, set);
  }
  const out = new Set<string>();
  for (const [name, set] of providersByName) {
    if (set.size > 1) out.add(name);
  }
  return out;
}

function needsProvider(m: PickerModel, ambiguous: ReadonlySet<string>): boolean {
  return m.name.includes("/") || ambiguous.has(m.name);
}

function labelOf(m: PickerModel, ambiguous: ReadonlySet<string>): string {
  return needsProvider(m, ambiguous) ? `${m.provider} \u00b7 ${m.name}` : m.name;
}

function printable(data: string): string | undefined {
  // Terminal paste arrives as one chunk; do not mistake escape/key sequences for text.
  const pasted = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
  let text = pasted ? data.slice(6, -6) : data;
  if (!pasted && data.startsWith("\x1b")) {
    if (matchesKey(data, Key.space)) return " ";
    const key = parseKey(data);
    if (key === undefined || Array.from(key).length !== 1) return undefined;
    text = key;
  }
  return text.length > 0 && !/[\u0000-\u001f\u007f-\u009f\p{Surrogate}]/u.test(text) ? text : undefined;
}

function shortName(name: string, max: number): string {
  return max <= 0 ? "" : truncateToWidth(name, max, "…");
}

function money(perMillion: number): string {
  if (!validPrice(perMillion)) return "—";
  const rounded = perMillion >= 10 ? perMillion.toFixed(0) : perMillion >= 1 ? perMillion.toFixed(1) : perMillion.toFixed(2);
  return `$${rounded.replace(/\.0+$/u, "").replace(/(\.\d)0$/u, "$1")} / 1M`;
}

function hasPricing(cost: PickerModel["cost"]): cost is NonNullable<PickerModel["cost"]> {
  if (cost === undefined) return false;
  const rates = [cost.input, cost.cachedInput, cost.output, ...(cost.cacheWrite === undefined ? [] : [cost.cacheWrite])];
  return rates.every(validPrice) && rates.some((price) => price > 0);
}

function pad(text: string, width: number): string {
  const cut = shortName(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

export class ModelPicker {
  private readonly theme: PickerTheme;
  private readonly onDone: (result: PickerResult) => void;
  private readonly onRenderRequest: (() => void) | undefined;
  private readonly visibleRows: number;
  private readonly modelsByKey: Map<ModelKey, PickerModel>;
  private readonly state: PickerState;
  private readonly priceRange: { min: number; max: number };
  private readonly ambiguousNames: Set<string>;
  /** Name column sized to the widest row label; capped to the available width at render time. */
  private readonly naturalNameCol: number;

  private effort: Record<ModelKey, EffortLevel>;
  private readonly dirtyEffort = new Set<ModelKey>();
  /** Fusion-row efforts — deliberately NOT stored in the per-model map. */
  private fusionLeadEffort: EffortLevel;
  private fusionSidekickEffort: EffortLevel;
  private lead: ModelKey | undefined;
  private sidekick: ModelKey | undefined;
  private search = "";
  private selected = 0;
  private focus: FusionFocus = "effort";
  private dropdownIndex = 0;
  private done = false;

  constructor(options: PickerOptions) {
    this.state = options.state;
    this.theme = options.theme;
    this.onDone = options.onDone;
    this.onRenderRequest = options.onRenderRequest;
    this.visibleRows = normalizeWidth(options.visibleRows ?? DEFAULT_VISIBLE_ROWS);
    this.modelsByKey = new Map(options.state.models.map((m) => [m.key, m]));
    this.ambiguousNames = ambiguousNamesOf(options.state.models);
    const widestLabel = options.state.models.reduce(
      (max, m) => Math.max(max, visibleWidth(labelOf(m, this.ambiguousNames))),
      0,
    );
    this.naturalNameCol = Math.max(NAME_COL_MIN, widestLabel + 2);
    const prices = options.state.models.map((m) => (hasPricing(m.cost) ? blendedPrice(m.cost) : undefined)).filter((p): p is number => p !== undefined && p > 0);
    this.priceRange = prices.reduce((range, price) => ({ min: Math.min(range.min, price), max: Math.max(range.max, price) }),
      { min: prices.length > 0 ? Infinity : 0, max: 0 });
    this.effort = Object.assign(Object.create(null) as Record<ModelKey, EffortLevel>, options.state.effort);
    const active = options.state.active;
    this.lead = this.resolveFusionKey("lead", active?.kind === "fusion" ? active.lead : undefined);
    this.sidekick = this.resolveFusionKey("sidekick", active?.kind === "fusion" ? active.sidekick : undefined);
    this.fusionLeadEffort =
      (active?.kind === "fusion" && active.lead === this.lead ? active.leadEffort : undefined) ??
      this.effortFor(this.lead);
    this.fusionSidekickEffort =
      (active?.kind === "fusion" && active.sidekick === this.sidekick ? active.sidekickEffort : undefined) ??
      this.effortFor(this.sidekick);
    this.selected = 0; // pinned active row
  }

  // ── Row model ────────────────────────────────────────────────────────────

  private isCurated(key: ModelKey | undefined, role: "lead" | "sidekick"): key is ModelKey {
    const source = role === "lead" ? this.state.fusionLeads : this.state.fusionSidekicks;
    return key !== undefined && source.includes(key) && this.modelsByKey.has(key) && this.state.models.some((m) => m.key === key);
  }

  private resolveFusionKey(role: "lead" | "sidekick", preferred: ModelKey | undefined): ModelKey | undefined {
    const source = role === "lead" ? this.state.fusionLeads : this.state.fusionSidekicks;
    return [preferred, this.state.fusionDefault[role], ...source].find((key) => this.isCurated(key, role));
  }

  private fusionAvailable(): boolean {
    return this.isCurated(this.lead, "lead") && this.isCurated(this.sidekick, "sidekick");
  }

  private effortUpdates(): Record<ModelKey, EffortLevel> {
    return Object.fromEntries([...this.dirtyEffort].map((key) => [key, this.effortFor(key)]));
  }

  private matchesSearch(key: ModelKey): boolean {
    if (this.search.length === 0) return true;
    const m = this.modelsByKey.get(key);
    const hay = `${key} ${m?.name ?? ""}`.toLowerCase();
    const q = Array.from(this.search.toLowerCase());
    // subsequence match, cheap and forgiving
    let i = 0;
    for (const ch of hay) {
      if (ch === q[i]) i++;
      if (i === q.length) return true;
    }
    return q.length === 0;
  }

  rows(): Row[] {
    const out: Row[] = [];
    const seen = new Set<ModelKey>();
    const active = this.state.active;
    const pinnedFusion = active?.kind === "fusion" && this.fusionAvailable();

    if (pinnedFusion) out.push({ kind: "fusion" });
    else if (active?.kind === "single" && this.modelsByKey.has(active.model)) {
      out.push({ kind: "model", key: active.model });
      seen.add(active.model);
    }
    if (!pinnedFusion) out.push({ kind: "fusion" });

    const ordered: ModelKey[] = [
      ...this.state.recent,
      ...this.state.fusionLeads,
      ...this.state.fusionSidekicks,
    ];
    // The whole catalogue always follows; the preset only controls ordering.
    ordered.push(...this.state.models.map((m) => m.key));
    for (const key of ordered) {
      if (seen.has(key) || !this.modelsByKey.has(key)) continue;
      if (!this.matchesSearch(key)) continue;
      seen.add(key);
      out.push({ kind: "model", key });
    }
    return out;
  }

  private effortFor(key: ModelKey | undefined): EffortLevel {
    if (key === undefined) return this.state.fallbackEffort;
    return this.effort[key] ?? this.state.fallbackEffort;
  }

  private selectedRow(): Row | undefined {
    const rows = this.rows();
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    return rows[this.selected];
  }

  private dropdownItems(): ModelKey[] {
    const source = this.focus === "lead" ? this.state.fusionLeads : this.state.fusionSidekicks;
    return [...new Set(source)].filter((k) => this.isCurated(k, this.focus === "lead" ? "lead" : "sidekick"));
  }

  // ── Input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.done) return;
    const row = this.selectedRow();
    const inDropdown = row?.kind === "fusion" && this.focus !== "effort";
    const reverseTab = matchesKey(data, "shift+tab");
    const isTab = matchesKey(data, Key.tab) || reverseTab;

    if (matchesKey(data, Key.escape)) {
      if (inDropdown) {
        this.focus = "effort";
        this.changed();
        return;
      }
      this.finish({ type: "cancelled" });
      return;
    }

    const disabledFusion = row?.kind === "fusion" && !this.fusionAvailable();
    if (
      disabledFusion &&
      (isTab || matchesKey(data, Key.left) || matchesKey(data, Key.right))
    ) {
      return;
    }

    if (inDropdown) {
      const items = this.dropdownItems();
      this.dropdownIndex = Math.min(this.dropdownIndex, Math.max(0, items.length - 1));
      if (matchesKey(data, Key.up)) {
        this.dropdownIndex = Math.max(0, this.dropdownIndex - 1);
      } else if (matchesKey(data, Key.down)) {
        this.dropdownIndex = Math.min(Math.max(0, items.length - 1), this.dropdownIndex + 1);
      } else if (isTab) {
        this.applyDropdown(items);
        this.cycleFocus(reverseTab);
      } else if (this.focus === "sidekick" && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
        this.fusionSidekickEffort = stepEffort(this.fusionSidekickEffort, matchesKey(data, Key.left) ? -1 : 1);
      } else if (matchesKey(data, Key.enter) || data === "\r") {
        this.applyDropdown(items);
        this.focus = "effort";
      } else {
        return;
      }
      this.changed();
      return;
    }

    if (matchesKey(data, Key.up)) {
      const n = this.rows().length;
      this.selected = n === 0 ? 0 : (this.selected - 1 + n) % n;
      this.focus = "effort";
    } else if (matchesKey(data, Key.down)) {
      const n = this.rows().length;
      this.selected = n === 0 ? 0 : (this.selected + 1) % n;
      this.focus = "effort";
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta: -1 | 1 = matchesKey(data, Key.left) ? -1 : 1;
      if (row?.kind === "fusion") {
        // Fusion-row effort is its own state: never touches per-model memory.
        if (this.focus === "effort") this.fusionLeadEffort = stepEffort(this.fusionLeadEffort, delta);
      } else if (row?.key !== undefined) {
        this.effort[row.key] = stepEffort(this.effortFor(row.key), delta);
        this.dirtyEffort.add(row.key);
      }
    } else if (isTab) {
      if (row?.kind === "fusion") this.cycleFocus(reverseTab);
    } else if (matchesKey(data, Key.enter) || data === "\r") {
      this.confirm(row);
      return;
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.search = Array.from(this.search).slice(0, -1).join("");
      this.selected = 0;
    } else {
      const ch = printable(data);
      if (ch === undefined) return;
      this.search += ch;
      this.selected = 0;
    }
    this.changed();
  }

  private cycleFocus(reverse = false): void {
    const order: FusionFocus[] = ["effort", "lead", "sidekick"];
    const dir = reverse ? -1 : 1;
    const next = order[(order.indexOf(this.focus) + dir + order.length) % order.length] ?? "effort";
    this.focus = next;
    if (this.focus !== "effort") {
      const items = this.dropdownItems();
      const current = this.focus === "lead" ? this.lead : this.sidekick;
      const idx = current === undefined ? -1 : items.indexOf(current);
      this.dropdownIndex = idx >= 0 ? idx : 0;
    }
  }

  private applyDropdown(items: ModelKey[]): void {
    const pick = items[this.dropdownIndex];
    if (pick === undefined) return;
    if (this.focus === "lead") this.lead = pick;
    else this.sidekick = pick;
  }

  private confirm(row: Row | undefined): void {
    if (row === undefined) return;
    if (row.kind === "fusion") {
      const lead = this.resolveFusionKey("lead", this.lead);
      const sidekick = this.resolveFusionKey("sidekick", this.sidekick);
      if (lead !== this.lead) this.fusionLeadEffort = this.effortFor(lead);
      if (sidekick !== this.sidekick) this.fusionSidekickEffort = this.effortFor(sidekick);
      this.lead = lead;
      this.sidekick = sidekick;
      if (lead === undefined || sidekick === undefined) return;
      this.finish({
        type: "fusion",
        lead,
        sidekick,
        leadEffort: this.fusionLeadEffort,
        sidekickEffort: this.fusionSidekickEffort,
        effortMap: { ...this.effort },
        effortUpdates: this.effortUpdates(),
      });
      return;
    }
    if (!this.modelsByKey.has(row.key) || !this.state.models.some((m) => m.key === row.key)) return;
    this.finish({
      type: "single",
      model: row.key,
      effort: this.effortFor(row.key),
      effortMap: { ...this.effort },
      effortUpdates: this.effortUpdates(),
    });
  }

  private finish(result: PickerResult): void {
    this.done = true;
    this.onDone(result);
  }

  private changed(): void {
    this.onRenderRequest?.();
  }

  invalidate(): void {
    /* stateless render */
  }

  // ── Render ───────────────────────────────────────────────────────────────

  /**
   * Marker for the working model. Only a SINGLE active selection gets a ✓ —
   * when Fusion is selected, the selection lives on the Fusion row itself and
   * plain model rows stay unmarked.
   */
  private markerFor(key: ModelKey | undefined): string {
    if (key === undefined) return " ";
    const active = this.state.active;
    if (active?.kind === "single" && key === active.model) return this.theme.fg("success", "✓");
    return " ";
  }

  private bar(level: EffortLevel, highlighted: boolean): string {
    const index = Math.max(0, EFFORT_LEVELS.indexOf(level));
    const filled = Math.ceil((index / (EFFORT_LEVELS.length - 1)) * BAR_SEGMENTS);
    const on = this.theme.fg(highlighted ? "text" : "muted", "▰".repeat(filled));
    const off = this.theme.fg("dim", "▱".repeat(BAR_SEGMENTS - filled));
    return `${on}${off}`;
  }

  private nameOf(key: ModelKey | undefined, max: number): string {
    if (key === undefined) return "—";
    const m = this.modelsByKey.get(key);
    return shortName(m?.name ?? key, max);
  }

  private isAmbiguous(model: PickerModel): boolean {
    return needsProvider(model, this.ambiguousNames);
  }

  private renderRow(row: Row, highlighted: boolean, width: number, nameCol: number): string {
    const t = this.theme;
    const pointer = highlighted ? t.fg("accent", "❭") : t.fg("dim", "·");
    const disabledFusion = row.kind === "fusion" && !this.fusionAvailable();
    // The Fusion composite gets the check when it is the active selection —
    // same affordance a single active model gets on its own row.
    const marker =
      row.kind === "fusion"
        ? !disabledFusion && this.state.active?.kind === "fusion"
          ? t.fg("success", "✓")
          : " "
        : this.markerFor(row.key);
    const working = row.kind === "model" && row.key === this.state.currentModelKey;
    const model = row.kind === "model" ? this.modelsByKey.get(row.key) : undefined;
    // Qualify ambiguous names when there is room, but reserve name cells first.
    const prefixRaw = model !== undefined && this.isAmbiguous(model) ? `${model.provider} · ` : "";
    const providerPrefix = nameCol >= 12 ? t.fg("dim", shortName(prefixRaw, nameCol - 6)) : "";
    const nameBudget = Math.max(0, nameCol - visibleWidth(providerPrefix) - (model?.badge === undefined ? 0 : 2));
    const nameRaw = row.kind === "fusion" ? shortName("Fusion", nameBudget) : this.nameOf(row.key, nameBudget);
    const styled =
      row.kind === "fusion"
        ? disabledFusion
          ? highlighted
            ? t.fg("muted", t.bold(nameRaw))
            : t.fg("dim", nameRaw)
          : highlighted
            ? t.fg("accent", t.bold(nameRaw))
            : t.fg("text", nameRaw)
        : working
          ? t.fg("accent", t.bold(nameRaw))
          : highlighted
            ? t.fg("accent", nameRaw)
            : t.fg("text", nameRaw);
    const name = `${providerPrefix}${styled}`;
    const badge = model?.badge;
    const badgeGlyph = badge === undefined ? "" : ` ${t.fg(badge === "new" ? "success" : badge === "promotion" ? "accent" : "warning", "✱")}`;

    const level = row.kind === "fusion" ? this.fusionLeadEffort : this.effortFor(row.key);
    const arrowsOn = !disabledFusion && highlighted && this.focus === "effort";
    const left = arrowsOn ? t.fg("accent", "←") : " ";
    const right = arrowsOn ? t.fg("accent", "→") : " ";
    const label = disabledFusion
      ? t.fg("dim", effortLabel(level))
      : highlighted
        ? t.fg("accent", effortLabel(level))
        : t.fg("muted", effortLabel(level));

    const suffix = ` ${left} ${label} ${right}`;
    let line = width >= FIXED_COLS + 4
      ? `${pointer} ${marker} ${pad(`${name}${badgeGlyph}`, nameCol)} ${left} ${this.bar(level, !disabledFusion && highlighted)} ${right} ${pad(label, 8)}`
      : `${pointer} ${marker} ${pad(`${name}${badgeGlyph}`, Math.max(0, width - 4 - visibleWidth(suffix)))}${suffix}`;

    if (row.kind === "fusion") {
      if (disabledFusion) {
        line += `   ${t.fg("dim", "not configured — run /unipi:fusion-preset")}`;
      } else {
        const leadName = this.nameOf(this.lead, 14);
        const sideName = this.nameOf(this.sidekick, 14);
        const leadFocused = highlighted && this.focus === "lead";
        const sideFocused = highlighted && this.focus === "sidekick";
        const leadText = leadFocused
          ? `${t.fg("accent", t.bold("Lead"))} ${t.fg("accent", leadName)} ${t.fg("accent", "▾")}`
          : `${t.fg("dim", "Lead")} ${t.fg("text", leadName)} ${t.fg("dim", "▾")}`;
        const sideText = sideFocused
          ? `${t.fg("accent", t.bold("Sidekick"))} ${t.fg("accent", sideName)} ${t.fg("accent", "▾")}`
          : `${t.fg("dim", "Sidekick")} ${t.fg("text", sideName)} ${t.fg("dim", "▾")}`;
        line += `   ${leadText}   ${sideText} ${t.fg(sideFocused ? "accent" : "muted", effortLabel(this.fusionSidekickEffort))}`;
      }
    }
    return truncateToWidth(line, width, "");
  }

  private renderDropdown(width: number, nameCol: number): string[] {
    const t = this.theme;
    const items = this.dropdownItems();
    // Never indent the pointer/name off-screen, even with a huge catalogue label.
    const indent = " ".repeat(Math.min(MARKER_COL + nameCol + 5, Math.max(0, width - 18)));
    const heading = this.focus === "sidekick"
      ? [truncateToWidth(t.fg("accent", `Sidekick effort ← ${effortLabel(this.fusionSidekickEffort)} →`), width, "")]
      : [];
    if (items.length === 0) {
      return [...heading, truncateToWidth(`${indent}${t.fg("warning", `no ${this.focus} models in preset — run /unipi:fusion-preset`)}`, width, "")];
    }
    const win = 6;
    const start = Math.max(0, Math.min(this.dropdownIndex - Math.floor(win / 2), items.length - win));
    const slice = items.slice(start, start + win);
    const lines = slice.map((key, i) => {
      const idx = start + i;
      const isCur = idx === this.dropdownIndex;
      const isSet = key === (this.focus === "lead" ? this.lead : this.sidekick);
      const glyph = isCur ? t.fg("accent", "▸") : " ";
      const star = isSet ? t.fg("dim", " *") : "";
      const name = this.nameOf(key, Math.min(28, Math.max(0, width - visibleWidth(indent) - 2 - visibleWidth(star))));
      const label = isCur ? t.fg("accent", t.bold(name)) : t.fg("text", name);
      return truncateToWidth(`${indent}${glyph} ${label}${star}`, width, "");
    });
    return [...heading, ...lines];
  }

  private renderPricePanel(row: Row | undefined, width: number): string[] {
    const t = this.theme;
    if (row === undefined) return [];
    const disabledFusion = row.kind === "fusion" && !this.fusionAvailable();
    const primaryKey = row.kind === "fusion" ? this.lead : row.key;
    const primary = primaryKey === undefined ? undefined : this.modelsByKey.get(primaryKey);
    const side = row.kind === "fusion" && this.sidekick !== undefined ? this.modelsByKey.get(this.sidekick) : undefined;
    const primaryCost = primary?.cost;
    const sideCost = side?.cost;
    const cols: Array<[string, string]> = [];
    if (hasPricing(primaryCost)) {
      cols.push(["Input", money(primaryCost.input)]);
      cols.push(["Cached input", money(primaryCost.cachedInput)]);
      if (primaryCost.cacheWrite !== undefined) cols.push(["Cache write", money(primaryCost.cacheWrite)]);
      cols.push(["Output", money(primaryCost.output)]);
    } else {
      cols.push(["Input", "—"], ["Cached input", "—"], ["Output", "—"]);
    }
    if (row.kind === "fusion") {
      if (hasPricing(sideCost)) {
        cols.push(["Sidekick input", money(sideCost.input)]);
        cols.push(["Sidekick cached input", money(sideCost.cachedInput)]);
        if (sideCost.cacheWrite !== undefined) cols.push(["Sidekick cache write", money(sideCost.cacheWrite)]);
        cols.push(["Sidekick output", money(sideCost.output)]);
      } else {
        cols.push(["Sidekick input", "—"], ["Sidekick cached input", "—"], ["Sidekick output", "—"]);
      }
    }
    const need = Math.max(...cols.map(([h, v]) => Math.max(visibleWidth(h), visibleWidth(v)))) + 3;
    const colWidth = need;
    const head = cols.map(([h]) => pad(t.fg("dim", h), colWidth)).join("");
    const vals = cols.map(([, v]) => pad(t.fg("text", v), colWidth)).join("");
    const desc =
      disabledFusion
        ? t.fg("warning", "Run /unipi:fusion-preset to enable Fusion — a powerful lead model plans and reviews while a cheaper sidekick executes, for frontier performance at lower cost")
        : row.kind === "fusion"
          ? t.fg("dim", "Pairs frontier intelligence with cost-efficient execution")
          : primary?.reasoning
            ? t.fg("dim", "Reasoning model · ←/→ adjusts thinking effort")
            : t.fg("dim", "Non-reasoning model · effort is ignored by the provider");
    const badges = this.state.models.some((m) => m.badge !== undefined)
      ? `${t.fg("success", "✱")} ${t.fg("dim", "New")}  ${t.fg("accent", "✱")} ${t.fg("dim", "Promotion")}  ${t.fg("warning", "✱")} ${t.fg("dim", "Beta")} ${t.fg("dim", "·")}`
      : "";
    const noPricing = row.kind === "fusion"
      ? !hasPricing(primaryCost) || !hasPricing(sideCost)
      : !hasPricing(primaryCost);
    const pricing = !disabledFusion && noPricing ? t.fg("dim", " · no pricing data from provider") : "";
    const description = `${badges}${badges.length > 0 ? " " : ""}${desc}${pricing}`;
    // The row label may be a friendly name; spell out the exact registry key so
    // the highlighted model is unambiguous (`openrouter/deepseek/...`).
    const keys = row.kind === "fusion"
      ? [this.lead, this.sidekick].filter((k): k is ModelKey => k !== undefined)
      : primaryKey === undefined
        ? []
        : [primaryKey];
    const out = width >= 2 + cols.length * colWidth
      ? [truncateToWidth(`  ${head}`, width, ""), truncateToWidth(`  ${vals}`, width, "")]
      : cols.map(([h, v]) => truncateToWidth(`  ${t.fg("dim", width < 50 ? h.replace(/^Sidekick /u, "S ") : h)}: ${t.fg("text", v)}`, width, ""));
    if (keys.length > 0) {
      const keyText = keys.map((k) => t.fg("text", k)).join(t.fg("dim", " · "));
      out.push(truncateToWidth(`  ${t.fg("dim", "Model key")}  ${keyText}`, width, ""));
    }
    out.push(truncateToWidth(`  ${description}`, width, ""));
    return out;
  }

  private hintLine(row: Row | undefined): string {
    const t = this.theme;
    const parts: string[] = [];
    if (row?.kind === "fusion" && !this.fusionAvailable()) {
      parts.push("↑↓ select", "esc cancel");
    } else if (row?.kind === "fusion" && this.focus !== "effort") {
      if (this.focus === "sidekick") parts.push("←→ sidekick effort");
      parts.push("↑↓ select", `tab ${this.focus === "lead" ? "sidekick" : "effort"}`, "shift-tab back", "↵ apply", "esc collapse");
    } else {
      parts.push("↑↓ select");
      if (row?.kind === "fusion") parts.push("tab lead", "shift-tab sidekick");
      parts.push("←→ effort", "↵ confirm", "esc cancel");
    }
    return t.fg("dim", parts.join(" · "));
  }

  render(width: number): string[] {
    const w = normalizeWidth(width);
    return frameOverlay(this.renderBody(adaptiveInnerWidth(w)), w, { title: "Model" });
  }

  private renderBody(width: number): string[] {
    const t = this.theme;
    const rows = this.rows();
    // Reserve the full effort block first; shrink names rather than the controls.
    const maxNameCol = Math.max(1, width - FIXED_COLS);
    const nameCol = Math.min(this.naturalNameCol, maxNameCol);
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const row = rows[this.selected];
    const lines: string[] = [];

    const searchText = this.search.length > 0 ? t.fg("text", this.search) : t.fg("dim", "Type to search");
    lines.push(truncateToWidth(`${t.fg("accent", "/")} ${searchText}`, width, ""));
    lines.push(t.fg("dim", "─".repeat(Math.max(1, width - 2))));

    if (rows.length === 0) {
      lines.push(t.fg("warning", "  No matching models."));
    } else {
      const win = this.visibleRows;
      const start = Math.max(0, Math.min(this.selected - Math.floor(win / 2), rows.length - win));
      const end = Math.min(rows.length, start + win);
      if (start > 0) lines.push(t.fg("dim", "  ↑ more above"));
      for (let i = start; i < end; i++) {
        const r = rows[i];
        if (r === undefined) continue;
        const highlighted = i === this.selected;
        const rowNameCol = r.kind === "fusion" ? Math.min(NAME_COL_MIN, nameCol) : nameCol;
        lines.push(this.renderRow(r, highlighted, width, rowNameCol));
        if (highlighted && r.kind === "fusion" && this.focus !== "effort") {
          lines.push(...this.renderDropdown(width, rowNameCol));
        }
      }
      if (end < rows.length) lines.push(t.fg("dim", `  ↓ more below (${String(rows.length - end)})`));
    }

    lines.push("");
    const sliderCells = Math.min(48, Math.max(1, width - 6));
    const sliderKey = row?.kind === "fusion" ? this.lead : row?.key;
    const sliderModel = sliderKey === undefined ? undefined : this.modelsByKey.get(sliderKey);
    const sliderCost = sliderModel?.cost;
    const sliderPrice = hasPricing(sliderCost) ? blendedPrice(sliderCost) : undefined;
    const marker = this.priceRange.max <= 0 || sliderPrice === undefined ? undefined : sliderPosition(sliderPrice, this.priceRange.min, this.priceRange.max, sliderCells);
    lines.push(truncateToWidth(`  ${renderSlider(sliderCells, marker)}`, width, ""));
    lines.push(...this.renderPricePanel(row, width));
    lines.push("");
    lines.push(this.hintLine(row));
    return lines;
  }
}
