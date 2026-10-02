import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ModelPicker, type PickerModel, type PickerResult, type PickerState } from "../src/picker.js";
import { PresetEditor, type PresetEditorOptions, type PresetEditorResult } from "../src/preset-editor.js";
import { createSpinnerLine } from "../src/vendor/core/spinner-line.js";
import { frameOverlay } from "../src/vendor/core/tui-overlay.js";
import { MIN_BORDERED_WIDTH, normalizeWidth } from "../src/vendor/core/tui-width.js";

// Pure components only: no Pi session, real terminal, model registry or credentials.
const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const UP = "\x1b[A", DOWN = "\x1b[B", LEFT = "\x1b[D", RIGHT = "\x1b[C";
const TAB = "\t", ENTER = "\r", ESC = "\x1b";
const emoji = "\u{1f600}";
const widths = [-Infinity, -1, 0, NaN, Infinity, 1, 2, 3, 8, 11, 12, 15.9, 16, 17, 30, 40, 80, 160];
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);
const text = (component: { render(width: number): string[] }, width = 160) => plain(component.render(width)).join("\n");
function bounded(lines: readonly string[], width: number): void {
  for (const line of lines) {
    assert(visibleWidth(line) <= normalizeWidth(width), `width=${String(width)}, actual=${visibleWidth(line)}`);
    assert.doesNotMatch(stripTerminalSequences(line), /\p{Surrogate}/u);
  }
}
function state(over: Partial<PickerState> = {}): PickerState {
  return {
    models: [
      { key: "a/lead", name: "Lead Model", provider: "a", reasoning: true, cost: { input: 10, cachedInput: 0.25, output: 50 } },
      { key: "b/side", name: "Side Model", provider: "b", reasoning: true, cost: { input: 0.2, cachedInput: 0.02, output: 1.2 } },
      { key: "c/mini", name: "Mini", provider: "c", reasoning: false },
    ],
    fusionLeads: ["a/lead"], fusionSidekicks: ["b/side", "c/mini"],
    fusionDefault: { lead: "a/lead", sidekick: "b/side" },
    recent: [], active: undefined, currentModelKey: undefined,
    effort: { "a/lead": "medium", "b/side": "low", "c/mini": "off" }, fallbackEffort: "low",
    ...over,
  };
}
function picker(over: Partial<PickerState> = {}, visibleRows?: number) {
  const results: PickerResult[] = [];
  const s = state(over);
  const p = new ModelPicker({ state: s, theme, visibleRows, onDone: r => results.push(r) });
  return { p, s, results };
}
function editor(over: Partial<PresetEditorOptions> = {}) {
  const results: PresetEditorResult[] = [];
  const e = new PresetEditor({
    models: ["a/1", "b/2", "c/3"].map(key => ({ key, name: key })),
    initial: { lead: [], sidekick: [], default: {} }, active: undefined,
    initialTarget: "global", theme, onDone: r => results.push(r), ...over,
  });
  return { e, results };
}
function keys(component: { handleInput(data: string): void }, input: readonly string[]): void {
  for (const key of input) component.handleInput(key);
}

test("frameOverlay normalizes widths, drops narrow borders and bounds styled titles", () => {
  const title = `\x1b[31m长标题${emoji}非常长\x1b[0m`;
  for (const width of widths) {
    const lines = frameOverlay(["中文中文中文", `${emoji}e\u0301xyz`, "\x1b[32mstyled body\x1b[0m"], width, { title });
    bounded(lines, width);
    assert.equal(plain(lines)[0]?.startsWith("╭"), normalizeWidth(width) >= MIN_BORDERED_WIDTH);
    if (normalizeWidth(width) < MIN_BORDERED_WIDTH) {
      assert.doesNotMatch(plain(lines).join("\n"), /[╭╮╰╯│]/u);
    }
  }
});

test("spinner uses terminal columns and keeps CJK, code points and combining graphemes intact", () => {
  for (const body of ["中文中文中文", `${emoji}xyz`, "e\u0301xyz"]) {
    const component = createSpinnerLine({ text: () => body, frames: [], padLeft: 0 })({ requestRender() {} }, null);
    for (const width of widths) bounded(component.render(width), width);
    component.dispose();
  }
  const combining = createSpinnerLine({ text: () => "e\u0301xyz", frames: [], padLeft: 0 })({ requestRender() {} }, null);
  assert.equal(stripTerminalSequences(combining.render(2)[0]!), "e\u0301");
  combining.dispose();
});

test("spinner delegates SGR and OSC truncation to the host instead of consuming escape payloads", () => {
  const link = "\x1b]8;;https://example.invalid\x1b\\中文abcdef\x1b]8;;\x1b\\";
  for (const body of ["\x1b[31mabcdef\x1b[0m", link]) {
    const component = createSpinnerLine({ text: () => body, frames: [], padLeft: 0 })({ requestRender() {} }, null);
    const line = component.render(5)[0]!;
    assert.equal(line, truncateToWidth(body, 4, ""));
    assert(stripTerminalSequences(line).length > 0);
    bounded([line], 5);
    component.dispose();
  }
});

test("spinner hides while loading, normalizes options and disposes its mocked timer once", () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  let renders = 0, cleared = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert(Number.isFinite(delay) && Number.isInteger(delay) && delay >= 1);
    tick = callback;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => { cleared++; }) as typeof clearInterval;
  try {
    let body: string | undefined;
    const component = createSpinnerLine({ text: () => body, intervalMs: Infinity, padLeft: NaN })({ requestRender() { renders++; } }, null);
    assert.deepEqual(component.render(80), []);
    tick!();
    assert.equal(renders, 1);
    body = "中文";
    bounded(component.render(NaN), NaN);
    component.dispose();
    component.dispose();
    tick!(); // A queued callback must not request renders after disposal.
    assert.equal(renders, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});

test("picker/editor normalize widths and invalid visibleRows without hiding the selected row", () => {
  for (const visibleRows of [-1, 0, NaN, Infinity, 1.9]) {
    const { p } = picker({}, visibleRows);
    const { e } = editor({ visibleRows });
    assert.match(text(p), /❭/u);
    assert.match(text(e), /›/u);
    for (const width of widths) {
      bounded(p.render(width), width);
      bounded(e.render(width), width);
    }
    p.handleInput(TAB);
    for (const width of widths) bounded(p.render(width), width);
  }
});

test("long CJK and styled model names do not displace standalone effort controls", () => {
  const names = ["模型".repeat(25), `\x1b[32m${emoji}e\u0301${"Long".repeat(30)}\x1b[0m`];
  for (const name of names) {
    const { p } = picker({
      models: [{ key: "a/wide", name, provider: "a", reasoning: true, badge: "new" }],
      active: { kind: "single", model: "a/wide" },
      fusionLeads: [], fusionSidekicks: [], fusionDefault: {},
    });
    for (const width of [30, 40, 80]) {
      const lines = p.render(width);
      bounded(lines, width);
      const row = plain(lines).find(line => line.includes("✓"));
      assert(row);
      assert.match(row, /←.*→.*Low/u);
    }
  }
});

test("30/40-column lead and sidekick dropdowns keep a pointer and readable candidate name", () => {
  for (const width of [30, 40]) {
    const { p } = picker();
    p.handleInput(TAB);
    assert.match(text(p, width), /▸ Lead Model/u);
    p.handleInput(TAB);
    assert.match(text(p, width), /▸ Side Model/u);
    assert.match(text(p, width), /Sidekick effort ← Low →/u);
    assert.match(text(p, width), /←→ sidekick effort/u);
    bounded(p.render(width), width);
  }
  const { p } = picker({ models: state().models.map(m => m.key === "a/lead" ? { ...m, name: "A".repeat(200) } : m) });
  p.handleInput(TAB);
  assert.match(text(p, 40), /▸ A+…/u);
});

test("Shift+Tab cycles all three existing focuses in reverse with legacy and CSI-u keys", () => {
  for (const reverse of ["\x1b[Z", "\x1b[9;2u"]) {
    const { p } = picker();
    p.handleInput(reverse);
    assert.match(text(p), /Sidekick effort ← Low →/u);
    p.handleInput(reverse);
    assert.match(text(p), /tab sidekick.*esc collapse/u);
    p.handleInput(reverse);
    assert.doesNotMatch(text(p), /esc collapse/u);
    keys(p, [TAB, TAB]);
    assert.match(text(p), /Sidekick effort ← Low →/u);
    p.handleInput(TAB);
    assert.doesNotMatch(text(p), /esc collapse/u);
  }
});

test("sidekick dropdown arrows change only its effort; Enter applies its model then confirms", () => {
  const { p, s, results } = picker();
  keys(p, [RIGHT, TAB, TAB, RIGHT, DOWN, ENTER, ENTER]);
  const result = results[0];
  assert(result?.type === "fusion");
  assert.equal(result.leadEffort, "high");
  assert.equal(result.sidekickEffort, "medium");
  assert.equal(result.sidekick, "c/mini");
  assert.deepEqual(result.effortMap, s.effort);
  assert.deepEqual(result.effortUpdates, {});
});

test("sidekick effort and dropdown selection clamp at both boundaries", () => {
  for (const [arrow, expected] of [[LEFT, "off"], [RIGHT, "max"]] as const) {
    const { p, results } = picker();
    keys(p, [TAB, TAB, ...Array<string>(20).fill(UP), ...Array<string>(20).fill(arrow), ENTER, ENTER]);
    const result = results[0];
    assert(result?.type === "fusion");
    assert.equal(result.sidekick, "b/side");
    assert.equal(result.sidekickEffort, expected);
  }
  const { p, results } = picker();
  keys(p, [TAB, TAB, ...Array<string>(20).fill(DOWN), ENTER, ENTER]);
  assert(results[0]?.type === "fusion" && results[0].sidekick === "c/mini");
});

test("effortUpdates is empty without standalone edits and retains reverted user edits", () => {
  const unchanged = picker({ active: { kind: "single", model: "b/side" } });
  unchanged.p.handleInput(ENTER);
  assert(unchanged.results[0]?.type === "single");
  assert.deepEqual(unchanged.results[0].effortUpdates, {});
  const edited = picker({ active: { kind: "single", model: "b/side" } });
  keys(edited.p, [RIGHT, LEFT, ENTER]);
  assert(edited.results[0]?.type === "single");
  assert.deepEqual(edited.results[0].effortUpdates, { "b/side": "low" });
  assert.deepEqual(edited.results[0].effortMap, edited.s.effort);
});

test("Fusion confirmation reports only edited standalone keys, not Fusion-row effort changes", () => {
  const { p, results } = picker({ active: { kind: "single", model: "c/mini" } });
  keys(p, [RIGHT, DOWN, RIGHT, "\x1b[Z", RIGHT, ENTER, ENTER]);
  const result = results[0];
  assert(result?.type === "fusion");
  assert.deepEqual(result.effortUpdates, { "c/mini": "minimal" });
  assert.equal(result.effortMap["a/lead"], "medium");
  assert.equal(result.effortMap["b/side"], "low");
});

test("missing active/default pairs fall back to available curated models, not their stale efforts", () => {
  const { p, results } = picker({
    active: { kind: "fusion", lead: "missing/lead", sidekick: "missing/side", leadEffort: "max", sidekickEffort: "max" },
    fusionDefault: { lead: "missing/default", sidekick: "missing/default" },
    fusionLeads: ["missing/lead", "a/lead"], fusionSidekicks: ["missing/side", "b/side"],
  });
  p.handleInput(ENTER);
  const result = results[0];
  assert(result?.type === "fusion");
  assert.equal(result.lead, "a/lead");
  assert.equal(result.sidekick, "b/side");
  assert.equal(result.leadEffort, "medium");
  assert.equal(result.sidekickEffort, "low");
});

test("missing-only or uncurated defaults cannot enable/confirm Fusion", () => {
  for (const fusionLeads of [["missing/lead"], []]) {
    const { p, results } = picker({ fusionLeads, fusionDefault: { lead: "a/lead", sidekick: "b/side" } });
    keys(p, [TAB, "\x1b[Z", RIGHT, ENTER]);
    assert.deepEqual(results, []);
    assert.doesNotMatch(text(p), /esc collapse/u);
    assert.match(text(p), /not configured/u);
    keys(p, [DOWN, ENTER]);
    assert.equal(results[0]?.type, "single");
  }
});

test("confirmation revalidates a removed catalogue member and repairs to another curated model", () => {
  const models = [...state().models];
  const { p, results } = picker({ models, fusionLeads: ["a/lead", "c/mini"] });
  models.splice(models.findIndex(m => m.key === "a/lead"), 1);
  p.handleInput(ENTER);
  const result = results[0];
  assert(result?.type === "fusion");
  assert.equal(result.lead, "c/mini");
});

test("preset double toggle and cross-column toggle stay on the same model key after sorting", () => {
  const once = editor();
  keys(once.e, [DOWN, " "]);
  assert.match(text(once.e), /› \[x\] \[ \]  b\/2/u);
  keys(once.e, [" ", ENTER]);
  assert(once.results[0]?.type === "saved");
  assert.deepEqual(once.results[0].curation.lead, []);
  const both = editor();
  keys(both.e, [DOWN, " ", RIGHT, " ", ENTER]);
  assert(both.results[0]?.type === "saved");
  assert.deepEqual(both.results[0].curation.lead, ["b/2"]);
  assert.deepEqual(both.results[0].curation.sidekick, ["b/2"]);
});

test("preset raw/CSI-u/modifyOtherKeys Space toggles with an empty query", () => {
  for (const space of [" ", "\x1b[32u", "\x1b[27;1;32~"]) {
    const { e, results } = editor();
    keys(e, [space, ENTER]);
    assert(results[0]?.type === "saved");
    assert.deepEqual(results[0].curation.lead, ["a/1"]);
  }
});

test("preset Space extends an existing query while Ctrl+Space toggles without changing it", () => {
  for (const ctrlSpace of ["\x00", "\x1b[32;5u"]) {
    const { e, results } = editor({ models: [{ key: "a/alpha", name: "Alpha Beta" }, { key: "b/other", name: "Other" }] });
    keys(e, ["Alpha", "\x1b[32u", "Beta"]);
    assert.match(text(e), /Search: Alpha Beta/u);
    assert.match(text(e), /space filter · ctrl-space toggle lead/u);
    e.handleInput(ctrlSpace);
    assert.match(text(e), /Search: Alpha Beta/u);
    e.handleInput(ENTER);
    assert(results[0]?.type === "saved");
    assert.deepEqual(results[0].curation.lead, ["a/alpha"]);
  }
});

test("preset preserves offline keys but chooses defaults only among visible curated models", () => {
  const { e, results } = editor({
    initial: { lead: ["missing/lead", "b/2"], sidekick: ["missing/side"], default: { lead: "missing/lead", sidekick: "missing/side" } },
    active: { kind: "fusion", lead: "missing/lead", sidekick: "missing/side" },
  });
  e.handleInput(ENTER);
  assert(results[0]?.type === "saved");
  assert.deepEqual(results[0].curation.lead, ["missing/lead", "b/2"]);
  assert.deepEqual(results[0].curation.sidekick, ["missing/side"]);
  assert.deepEqual(results[0].curation.default, { lead: "b/2" });
});

test("picker/editor accept Unicode and printable paste; emoji backspace removes a whole code point", () => {
  for (const input of [emoji, `\x1b[200~${emoji}\x1b[201~`]) {
    const { p } = picker({ models: [{ key: "a/unicode", name: `Model ${emoji}`, provider: "a", reasoning: true }] });
    p.handleInput(input);
    assert.deepEqual(p.rows(), [{ kind: "fusion" }, { kind: "model", key: "a/unicode" }]);
    assert.match(text(p), new RegExp(`/ ${emoji}`, "u"));
    p.handleInput("\x7f");
    assert.match(text(p), /Type to search/u);
    const { e } = editor({ models: [{ key: "a/unicode", name: `${emoji} Alpha Beta` }] });
    e.handleInput(input);
    assert.match(text(e), new RegExp(`Search: ${emoji}`, "u"));
    e.handleInput("\x7f");
    assert.match(text(e), /Search: \(type to filter\)/u);
    e.handleInput(`\x1b[200~${emoji} Alpha Beta\x1b[201~`);
    assert.match(text(e), new RegExp(`Search: ${emoji} Alpha Beta`, "u"));
  }
  const { p } = picker();
  p.handleInput("Lead Model");
  assert.deepEqual(p.rows(), [{ kind: "fusion" }, { kind: "model", key: "a/lead" }]);
  const csi = picker();
  keys(csi.p, ["Lead", "\x1b[32u", "Model"]);
  assert.deepEqual(csi.p.rows(), p.rows());
});

test("unknown escape/control input is not accepted as printable search text", () => {
  for (const input of ["\x1b[?999h", "hello\nworld", "\ud83d"]) {
    const { p } = picker();
    const { e } = editor();
    p.handleInput(input);
    e.handleInput(input);
    assert.match(text(p), /Type to search/u);
    assert.match(text(e), /Search: \(type to filter\)/u);
  }
});

test("invalid and partial pricing is unknown, never NaN/Infinity or a slider marker", () => {
  const valid = { input: 1, cachedInput: 0.1, output: 2 };
  const invalid: NonNullable<PickerModel["cost"]>[] = [
    { ...valid, input: NaN }, { ...valid, input: Infinity }, { ...valid, input: -1 },
    { ...valid, cachedInput: NaN }, { ...valid, output: -1 }, { ...valid, cacheWrite: Infinity },
  ];
  for (const cost of invalid) {
    const { p } = picker({ models: [{ key: "a/bad", name: "Bad pricing", provider: "a", reasoning: true, cost }], active: { kind: "single", model: "a/bad" } });
    const rendered = text(p);
    assert.doesNotMatch(rendered, /\$(?:NaN|Infinity)|●/u);
    assert.match(rendered, /no pricing data from provider/u);
  }
});

test("cache-write pricing remains optional and very large finite prices do not overflow", () => {
  const { p } = picker({
    models: [{ key: "a/price", name: "Priced", provider: "a", reasoning: true,
      cost: { input: Number.MAX_VALUE, cachedInput: 0.1, output: Number.MAX_VALUE, cacheWrite: 0.5 } }],
    active: { kind: "single", model: "a/price" },
  });
  assert.match(text(p), /Cache write/u);
  assert.match(text(p), /\$0\.5 \/ 1M/u);
  assert.doesNotMatch(text(p), /NaN|Infinity/u);
  assert.match(text(p), /●/u);
});

test("picker/editor completion is idempotent after confirm or cancel", () => {
  const { p, results } = picker();
  keys(p, [ENTER, ENTER, ESC, RIGHT]);
  assert.equal(results.length, 1);
  const { e, results: saved } = editor();
  keys(e, [ESC, ENTER, " "]);
  assert.deepEqual(saved, [{ type: "cancelled" }]);
});
