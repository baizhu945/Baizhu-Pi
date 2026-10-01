import { test } from "node:test";
import assert from "node:assert/strict";
import { createFusionToolGate, FUSION_TOOL_NAMES } from "../src/tool-gate.js";

function fixture(excluded: string[] = []) {
  let active = ["read", "bash", "edit", "write", "custom"];
  const all = new Set(active);
  let registrations = 0;
  const changes: string[][] = [];
  const api = {
    getAllTools: () => [...all].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
      changes.push([...names]);
    },
  };
  const gate = createFusionToolGate(api as never, () => {
    registrations++;
    // Model Pi's automatic activation when a new tool is registered.
    for (const name of FUSION_TOOL_NAMES) {
      if (excluded.includes(name)) continue;
      all.add(name);
      active.push(name);
    }
  });
  return { api, all, gate, changes, registrations: () => registrations };
}

test("cold disabled mode does not register tools or change the active set", () => {
  const f = fixture();
  const baseline = f.api.getActiveTools();
  f.gate.disable();
  f.gate.disable();
  assert.equal(f.registrations(), 0);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.api.getActiveTools(), baseline);
});

test("enable then disable restores exact tool order and registers only once", () => {
  const f = fixture();
  const baseline = f.api.getActiveTools();
  f.gate.enable();
  assert.deepEqual(f.api.getActiveTools(), [...baseline, ...FUSION_TOOL_NAMES]);
  f.gate.disable();
  assert.deepEqual(f.api.getActiveTools(), baseline);
  f.gate.enable();
  assert.equal(f.registrations(), 1);
  f.gate.disable();
  assert.deepEqual(f.api.getActiveTools(), baseline);
});

test("disable preserves unrelated changes made while Fusion was enabled", () => {
  const f = fixture();
  f.gate.enable();
  f.all.add("another_extension");
  f.api.setActiveTools(["another_extension", "sidekick", "read", "read_subagent", "custom"]);
  f.gate.disable();
  assert.deepEqual(f.api.getActiveTools(), ["another_extension", "read", "custom"]);
});

test("never shadows or removes another extension's same-named tool", () => {
  const f = fixture();
  f.all.add("sidekick");
  f.api.setActiveTools(["read", "sidekick"]);
  assert.throws(() => f.gate.enable(), /already belong/);
  f.gate.disable();
  assert.equal(f.registrations(), 0);
  assert.deepEqual(f.api.getActiveTools(), ["read", "sidekick"]);
});

test("tool allowlists cannot leave Fusion half-enabled", () => {
  const f = fixture(["read_subagent"]);
  const baseline = f.api.getActiveTools();
  assert.throws(() => f.gate.enable(), /excluded/);
  assert.deepEqual(f.api.getActiveTools(), baseline);
});
