import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fusionExtension from "../src/index.js";
import { globalPresetPath } from "../src/preset.js";
import { registerFusionTools } from "../src/tools.js";

const baseline = ["read", "bash", "edit", "write", "existing_custom"];
const models = ["lead", "side", "other"].map((id) => ({ provider: "test", id, name: id, cost: { input: 1, cacheRead: 0.1, output: 2 } }));
const fusion = { type: "fusion", lead: "test/lead", sidekick: "test/side", leadEffort: "medium", sidekickEffort: "low", effortMap: {} };
const single = { type: "single", model: "test/lead", effort: "medium", effortMap: {} };

async function fixture(saved?: unknown, extraTools: string[] = []) {
  const home = mkdtempSync("/tmp/fusion-neutral-home-");
  const cwd = mkdtempSync("/tmp/fusion-neutral-cwd-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  if (saved !== undefined) {
    mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
    writeFileSync(globalPresetPath(home), JSON.stringify({ active: saved }));
  }
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let active = [...baseline, ...extraTools];
  let nextResult: any;
  const calls = { toolSets: [] as string[][], models: [] as any[], thinking: [] as string[], notices: [] as string[] };
  const ctx: any = {
    cwd, hasUI: true, model: models[0],
    modelRegistry: { getAvailable: () => models },
    ui: {
      notify: (text: string) => calls.notices.push(text),
      addAutocompleteProvider: () => undefined,
      custom: async () => nextResult,
    },
  };
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: () => undefined,
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...new Set([...baseline, ...extraTools, ...tools.keys()])].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; calls.toolSets.push([...names]); },
    setModel: async (model: any) => {
      calls.models.push(model);
      ctx.model = model;
      handlers.get("model_select")?.({ model }, ctx);
      return true;
    },
    setThinkingLevel: (level: string) => calls.thinking.push(level),
    getThinkingLevel: () => "medium",
  };
  fusionExtension(pi);
  await handlers.get("session_start")({}, ctx);
  return {
    handlers, tools, pi, calls, ctx,
    async select(value: any) {
      nextResult = value;
      await commands.get("unipi:model").handler("", ctx);
    },
    close() {
      handlers.get("session_shutdown")?.({}, ctx);
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    },
  };
}

for (const [label, saved] of [["fresh settings", undefined], ["persisted single model", { kind: "single", model: "test/lead" }]] as const) {
  test(`disabled ${label}: no registration, tool selection, model, thinking or prompt edits`, async () => {
    const f = await fixture(saved);
    try {
      assert.equal(f.tools.size, 0);
      assert.deepEqual(f.pi.getActiveTools(), baseline);
      assert.deepEqual(f.calls.toolSets, []);
      assert.deepEqual(f.calls.models, []);
      assert.deepEqual(f.calls.thinking, []);
      assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "unchanged prompt" }, f.ctx), undefined);
      for (const toolName of ["edit", "write", "bash", "existing_custom"]) {
        const event = { toolName, input: { command: "build && test" }, content: [{ type: "text", text: "original" }] };
        const before = structuredClone(event);
        assert.equal(f.handlers.get("tool_result")(event, f.ctx), undefined);
        assert.deepEqual(event, before);
      }
    } finally { f.close(); }
  });
}

test("picker enables tools and lead policy, selecting the same lead as single removes both", async () => {
  const f = await fixture();
  try {
    await f.select(fusion);
    assert.deepEqual(f.pi.getActiveTools(), [...baseline, "sidekick", "read_subagent"]);
    assert.equal(f.tools.size, 2);
    const on = f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
    assert.match(on.systemPrompt, /base\n\nYou are powered by Fusion/);
    await f.select(single);
    assert.deepEqual(f.pi.getActiveTools(), baseline);
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
    await f.select(fusion);
    assert.equal(f.tools.size, 2, "no duplicate registration after re-enabling");
    f.handlers.get("model_select")({ model: models[2] }, f.ctx);
    assert.deepEqual(f.pi.getActiveTools(), baseline);
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
  } finally { f.close(); }
});

test("disabled startup never hides an unrelated tool with a Fusion name", async () => {
  const f = await fixture(undefined, ["sidekick"]);
  try {
    assert.deepEqual(f.pi.getActiveTools(), [...baseline, "sidekick"]);
    await f.select(fusion);
    assert.equal(f.tools.size, 0);
    assert.deepEqual(f.calls.models, [], "collision must be detected before changing model");
    assert.deepEqual(f.pi.getActiveTools(), [...baseline, "sidekick"]);
    assert.match(f.calls.notices.at(-1) ?? "", /already belong/);
  } finally { f.close(); }
});

test("cancelling the picker cannot revive a Fusion selection rejected at startup", async () => {
  const f = await fixture({ kind: "fusion", lead: "test/lead", sidekick: "test/side" }, ["sidekick"]);
  try {
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
    await f.select({ type: "cancelled" });
    assert.equal(f.tools.size, 0);
    assert.deepEqual(f.pi.getActiveTools(), [...baseline, "sidekick"]);
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
  } finally { f.close(); }
});

test("late completion cannot inject a prompt or wake a disabled/replaced Fusion mode", async () => {
  const tools = new Map<string, any>();
  const sent: any[] = [];
  let resolve!: (value: any) => void;
  let current = true;
  const runtime: any = {
    isBusy: () => false,
    handoff: () => ({ id: "late", done: new Promise((done) => { resolve = done; }) }),
  };
  registerFusionTools({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
    sendMessage: (...args: any[]) => sent.push(args),
  } as never, { getRuntime: () => runtime, isReportCurrent: () => current });
  await tools.get("sidekick").execute("call", { message: "work", block: false }, undefined, undefined, {});
  current = false;
  resolve({ id: "late", status: "aborted", text: "must not enter model context" });
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(sent, []);
});
