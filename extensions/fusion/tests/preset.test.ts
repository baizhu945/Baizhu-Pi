import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortLabel,
  loadPreset,
  parsePreset,
  pushRecent,
  saveCuration,
  saveRuntimeState,
  stepEffort,
  globalPresetPath,
  projectPresetPath,
  splitModelKey,
} from "../src/preset.js";

test("parsePreset drops junk and keeps qualified keys", () => {
  const p = parsePreset({
    lead: ["a/b", "nope", 3, "a/b"],
    sidekick: ["c/d"],
    default: { lead: "a/b", sidekick: 7 },
    effort: { "a/b": "high", "c/d": "bogus" },
    recent: ["x/1", "x/2", "x/3", "x/4", "x/5", "x/6"],
    badges: { "a/b": "new", "c/d": "invalid", "e/f": "beta" },
    prices: { "a/b": { input: 1, cachedInput: 0.1, output: 2 }, "c/d": { input: -1, cachedInput: 0, output: 1 }, "e/f": { input: 0, cachedInput: 0, output: 0 } },
    active: { kind: "fusion", lead: "a/b", sidekick: "c/d" },
  });
  assert.deepEqual(p.lead, ["a/b"]);
  assert.deepEqual(p.sidekick, ["c/d"]);
  assert.deepEqual(p.default, { lead: "a/b" });
  assert.deepEqual(p.effort, { "a/b": "high" });
  assert.equal(p.recent?.length, 5);
  assert.deepEqual(p.badges, { "a/b": "new", "e/f": "beta" });
  assert.deepEqual(p.prices, { "a/b": { input: 1, cachedInput: 0.1, output: 2 }, "e/f": { input: 0, cachedInput: 0, output: 0 } });
  assert.deepEqual(p.active, { kind: "fusion", lead: "a/b", sidekick: "c/d" });
});

test("project layer overrides lists but merges effort", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fusion-cwd-"));
  mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
  writeFileSync(
    globalPresetPath(home),
    JSON.stringify({ lead: ["g/lead"], sidekick: ["g/side"], effort: { "g/lead": "low" }, recent: ["g/lead"], prices: { "g/lead": { input: 1, cachedInput: 0.1, output: 2 } } }),
  );
  mkdirSync(join(cwd, ".unipi"), { recursive: true });
  writeFileSync(projectPresetPath(cwd), JSON.stringify({ lead: ["p/lead"], effort: { "p/lead": "high" }, prices: { "p/lead": { input: 0.2, cachedInput: 0.02, output: 1.2 } } }));
  const { preset, hasProjectLayer } = loadPreset(cwd, home);
  assert.equal(hasProjectLayer, true);
  assert.deepEqual(preset.lead, ["p/lead"]);
  assert.deepEqual(preset.sidekick, ["g/side"]);
  assert.deepEqual(preset.effort, { "g/lead": "low", "p/lead": "high" });
  assert.deepEqual(preset.recent, ["g/lead"]);
  assert.deepEqual(preset.prices, { "g/lead": { input: 1, cachedInput: 0.1, output: 2 }, "p/lead": { input: 0.2, cachedInput: 0.02, output: 1.2 } });
});

test("saveCuration + saveRuntimeState round-trip without clobbering each other", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-home-"));
  const path = globalPresetPath(home);
  saveCuration(path, { lead: ["a/b"], sidekick: ["c/d"], default: { lead: "a/b", sidekick: "c/d" } });
  saveRuntimeState(path, { effort: { "a/b": "xhigh" }, recent: ["a/b"], active: { kind: "single", model: "a/b" } });
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw["lead"], ["a/b"]);
  assert.deepEqual(raw["effort"], { "a/b": "xhigh" });
  assert.deepEqual(raw["active"], { kind: "single", model: "a/b" });
  saveCuration(path, { lead: ["a/b", "e/f"], sidekick: ["c/d"], default: { lead: "e/f" } });
  const { preset } = loadPreset(mkdtempSync(join(tmpdir(), "cwd-")), home);
  assert.deepEqual(preset.lead, ["a/b", "e/f"]);
  assert.deepEqual(preset.effort, { "a/b": "xhigh" });
  assert.deepEqual(preset.active, { kind: "single", model: "a/b" });
});

test("effort helpers", () => {
  assert.equal(stepEffort("off", -1), "off");
  assert.equal(stepEffort("off", 1), "minimal");
  assert.equal(stepEffort("xhigh", 1), "max");
  assert.equal(effortLabel("max"), "Max");
  assert.equal(stepEffort("medium", 1), "high");
  assert.equal(effortLabel("off"), "None");
  assert.equal(effortLabel("xhigh"), "XHigh");
  assert.equal(effortLabel("medium"), "Medium");
  assert.deepEqual(pushRecent(["p/b", "p/a"], "p/a"), ["p/a", "p/b"]);
  assert.deepEqual(pushRecent(["p/1", "p/2", "p/3", "p/4", "p/5"], "p/6"), ["p/6", "p/1", "p/2", "p/3", "p/4"]);
  assert.throws(() => pushRecent([], "/bad"), /invalid recent model key/);
});

test("all model-key fields reject empty/whitespace segments and permit nested IDs", () => {
  const invalid = ["/", "/id", "provider/", " /id", "provider/ ", "provider/ id", "provider /id", "provider/id "];
  for (const key of invalid) {
    assert.equal(splitModelKey(key), undefined, key);
    const parsed = parsePreset({
      lead: [key], sidekick: [key], recent: [key], default: { lead: key, sidekick: key },
      effort: { [key]: "high" }, badges: { [key]: "new" },
      prices: { [key]: { input: 0, cachedInput: 0, output: 0 } },
      active: { kind: "fusion", lead: key, sidekick: "p/valid" },
    });
    assert.deepEqual(parsed.lead, []);
    assert.deepEqual(parsed.sidekick, []);
    assert.deepEqual(parsed.recent, []);
    assert.deepEqual(parsed.default, {});
    assert.deepEqual(parsed.effort, {});
    assert.deepEqual(parsed.badges, {});
    assert.deepEqual(parsed.prices, {});
    assert.equal(parsed.active, undefined);
    assert.equal(parsePreset({ active: { kind: "single", model: key } }).active, undefined);
  }
  assert.deepEqual(splitModelKey("provider/org/model"), { provider: "provider", id: "org/model" });
});

test("prices preserve optional cache-write rate and reject invalid numbers", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, "1", null]) {
    assert.deepEqual(parsePreset({ prices: { "p/a": { input: value, cachedInput: 0, output: 0 } } }).prices, {});
    assert.deepEqual(parsePreset({ prices: { "p/a": { input: 0, cachedInput: 0, output: 0, cacheWrite: value } } }).prices, {});
  }
  assert.deepEqual(parsePreset({ prices: { "p/a": { input: 0, cachedInput: 0, output: 0, cacheWrite: 0 } } }).prices,
    { "p/a": { input: 0, cachedInput: 0, output: 0, cacheWrite: 0 } });
});

test("runtime PATCH retains unrelated effort, merges latest MRU and preserves omitted active", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-patch-"));
  const path = globalPresetPath(home);
  saveRuntimeState(path, { effort: { "p/a": "high" }, recent: ["p/a"], active: { kind: "single", model: "p/a" } });
  saveRuntimeState(path, { effort: { "p/b": "max" }, recent: ["p/b"] });
  saveRuntimeState(path, { effort: {}, recent: ["p/a", "p/c", "p/d", "p/e", "p/f", "p/c"] });
  const actual = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(actual.effort, { "p/a": "high", "p/b": "max" });
  assert.deepEqual(actual.recent, ["p/a", "p/c", "p/d", "p/e", "p/f"]);
  assert.deepEqual(actual.active, { kind: "single", model: "p/a" });
  saveRuntimeState(path, { effort: {}, recent: [], active: undefined });
  assert.equal("active" in JSON.parse(readFileSync(path, "utf8")), false);
});

test("project active/recent never override global memory; other objects stay layered", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-layer-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fusion-layer-cwd-"));
  mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
  mkdirSync(join(cwd, ".unipi"), { recursive: true });
  writeFileSync(globalPresetPath(home), JSON.stringify({
    default: { lead: "g/lead", sidekick: "g/side" }, effort: { "g/lead": "low" },
    active: { kind: "single", model: "g/lead" }, recent: ["g/lead"],
  }));
  writeFileSync(projectPresetPath(cwd), JSON.stringify({
    default: { lead: "p/lead" }, effort: { "g/lead": "max", "p/lead": "high" },
    active: { kind: "fusion", lead: "p/lead", sidekick: "p/side" }, recent: ["p/lead"],
  }));
  const loaded = loadPreset(cwd, home);
  assert.deepEqual(Object.keys(loaded).sort(), ["globalPath", "hasProjectLayer", "preset", "projectPath"]);
  assert.deepEqual(loaded.preset.default, { lead: "p/lead", sidekick: "g/side" });
  assert.deepEqual(loaded.preset.effort, { "g/lead": "max", "p/lead": "high" });
  assert.deepEqual(loaded.preset.active, { kind: "single", model: "g/lead" });
  assert.deepEqual(loaded.preset.recent, ["g/lead"]);
  saveRuntimeState(loaded.globalPath, { effort: { "p/edited": "medium" }, recent: ["p/edited"] });
  const other = loadPreset(mkdtempSync(join(tmpdir(), "fusion-other-cwd-")), home).preset;
  assert.deepEqual(other.effort, { "g/lead": "low", "p/edited": "medium" });
});
