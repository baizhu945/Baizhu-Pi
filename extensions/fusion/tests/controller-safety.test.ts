import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import fusionExtension, { sidekickSessionPath } from "../src/index.js";
import { SidekickRuntime } from "../src/sidekick-runtime.js";

const pair = { type: "fusion", lead: "test/lead", sidekick: "test/side", leadEffort: "medium", sidekickEffort: "low", effortMap: {} };
function model(id: string) { return { provider: "test", id, name: id, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }; }
async function fixture() {
  const previousHome = process.env.HOME;
  process.env.HOME = mkdtempSync("/tmp/fusion-controller-home-");
  const branch: any[] = [];
  let id = "controller-A", models = [model("lead"), model("side")], choice: any;
  let activeTools = ["read", "bash", "edit", "write"];
  const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>();
  const notices: string[] = [], changedModels: string[] = [];
  let rejectAppend = false;
  const ctx: any = { cwd: mkdtempSync("/tmp/fusion-controller-cwd-"), mode: "tui", hasUI: true, model: models[0],
    sessionManager: { getSessionId: () => id, getBranch: () => branch },
    modelRegistry: { getAvailable: () => models },
    ui: { notify: (text: string) => notices.push(text), addAutocompleteProvider() {},
      custom: async () => typeof choice === "function" ? choice() : choice } };
  const pi: any = { on: (key: string, fn: any) => handlers.set(key, fn),
    registerCommand: (key: string, command: any) => commands.set(key, command), registerMessageRenderer() {},
    getAllTools: () => [...new Set([...activeTools, ...tools.keys()])].map(name => ({ name })),
    getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names]; },
    registerTool: (tool: any) => { tools.set(tool.name, tool); if (!activeTools.includes(tool.name)) activeTools.push(tool.name); },
    appendEntry: (customType: string, data: any) => { if (rejectAppend) throw new Error("fixture session write failed"); branch.push({ type: "custom", id: `entry-${branch.length}`, customType, data }); },
    setModel: async (next: any) => { changedModels.push(next.id); const previousModel = ctx.model; ctx.model = next;
      await handlers.get("model_select")?.({ model: next, previousModel, source: "set" }, ctx); return true; },
    setThinkingLevel() {}, getThinkingLevel: () => "medium", events: { emit() {} }, sendMessage() {},
  };
  fusionExtension(pi);
  await handlers.get("session_start")({}, ctx);
  return { ctx, pi, tools, handlers, commands, notices, changedModels, branch,
    rejectAppend: () => { rejectAppend = true; },
    setModels: (next: any[]) => { models = next; },
    async select(value: any) { choice = value; await commands.get("unipi:model").handler("", ctx); },
    async switchSession() { id = "controller-B"; branch.length = 0; await handlers.get("session_start")({}, ctx); },
    close() { handlers.get("session_shutdown")?.({}, ctx); if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; },
  };
}

test("RPC mode cannot open unsupported custom TUI or alter the loadout", async () => {
  const f = await fixture();
  try {
    f.ctx.mode = "rpc";
    let customCalls = 0;
    f.ctx.ui.custom = async () => { customCalls++; return undefined; };
    await f.commands.get("unipi:model").handler("", f.ctx);
    await f.commands.get("unipi:fusion-preset").handler("", f.ctx);
    assert.equal(customCalls, 0);
    assert.deepEqual(f.changedModels, []);
    assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "edit", "write"]);
  } finally { f.close(); }
});

test("a registry model added after the first picker is immediately selectable", async () => {
  const f = await fixture();
  try {
    await f.select({ type: "single", model: "test/lead", effort: "medium", effortMap: {} });
    f.setModels([model("lead"), model("side"), model("added")]);
    await f.select({ type: "single", model: "test/added", effort: "medium", effortMap: {} });
    assert.equal(f.changedModels.at(-1), "added");
  } finally { f.close(); }
});

test("changing sidekick effort replaces an instantiated runtime with the new effort", async () => {
  const f = await fixture();
  const captured: any[] = [];
  const original = SidekickRuntime.prototype.latest;
  SidekickRuntime.prototype.latest = function () { captured.push(this); return undefined; };
  try {
    await f.select(pair);
    await assert.rejects(f.tools.get("read_subagent").execute("first", {}, undefined, undefined, f.ctx), /No sidekick handoff/);
    await f.select({ ...pair, sidekickEffort: "high" });
    await assert.rejects(f.tools.get("read_subagent").execute("second", {}, undefined, undefined, f.ctx), /No sidekick handoff/);
    assert.notEqual(captured[0], captured[1]);
    assert.equal(captured[1].cfg.thinking, "high");
  } finally { SidekickRuntime.prototype.latest = original; f.close(); }
});

test("failed session-state persistence rolls back active Fusion tools", async () => {
  const f = await fixture();
  try {
    f.rejectAppend();
    await f.select(pair);
    assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "edit", "write"]);
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
  } finally { f.close(); }
});

test("a picker result from a previous session cannot enable the replacement session", async () => {
  const f = await fixture();
  try {
    await f.select(async () => { await f.switchSession(); return pair; });
    assert.deepEqual(f.changedModels, []);
    assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "edit", "write"]);
    assert.equal(f.branch.length, 0);
  } finally { f.close(); }
});

test("tree navigation revokes the active pair and starts a fresh child conversation after reconfirmation", async () => {
  const f = await fixture();
  const captured: any[] = [];
  const original = SidekickRuntime.prototype.latest;
  SidekickRuntime.prototype.latest = function () { captured.push(this); return undefined; };
  try {
    await f.select(pair);
    await assert.rejects(f.tools.get("read_subagent").execute("first", {}, undefined, undefined, f.ctx), /No sidekick handoff/);
    const previousPath = captured[0].cfg.sessionFile;
    f.handlers.get("session_tree")({ oldLeafId: "A", newLeafId: "B" }, f.ctx);
    assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "edit", "write"]);
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.ctx), undefined);
    await f.select(pair);
    await assert.rejects(f.tools.get("read_subagent").execute("second", {}, undefined, undefined, f.ctx), /No sidekick handoff/);
    assert.notEqual(captured[1].cfg.sessionFile, previousPath);
  } finally { SidekickRuntime.prototype.latest = original; f.close(); }
});

test("session identifiers never escape the sidekick storage directory", () => {
  const safe = sidekickSessionPath("normal-session");
  assert.match(safe, /normal-session\.jsonl$/);
  const traversal = sidekickSessionPath("../../../../escape");
  assert.equal(traversal.includes("/../"), false);
  assert.match(traversal, /\/fusion\/sidekick\/[^/]+\.jsonl$/);
});
