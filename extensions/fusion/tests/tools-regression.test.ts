import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerFusionTools, MODEL_CONTENT_MAX_BYTES } from "../src/tools.js";
import type { HandoffReport } from "../src/sidekick-runtime.js";

const hostPi = process.argv[2];
const { runAgentLoop } = await import(pathToFileURL(join(hostPi, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js")).href);
const { wrapToolDefinition } = await import(pathToFileURL(join(hostPi, "dist/core/tools/tool-definition-wrapper.js")).href);
const { ExtensionRunner } = await import(pathToFileURL(join(hostPi, "dist/core/extensions/runner.js")).href);
const { setThemeInstance } = await import(pathToFileURL(join(hostPi, "dist/modes/interactive/theme/theme.js")).href);

const report: HandoffReport = {
  id: "h1", status: "completed", text: "implemented", events: [], toolCalls: 2, durationMs: 1200,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
};
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: HandoffReport) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<HandoffReport>((res, rej) => { resolve = res; reject = rej; });
  return { done, resolve, reject };
}
function fakeClock() {
  const originalNow = Date.now, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let now = 0, next = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = ++next; timers.set(id, { due: now + ms, fn }); return id;
  }) as any;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
  return {
    pending: () => timers.size,
    tick(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    },
    restore() { Date.now = originalNow; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; },
  };
}
function setup(runtime: any, callbacks: any = {}, sender?: (message: any) => void) {
  const tools = new Map<string, any>(), renderers = new Map<string, any>(), handlers = new Map<string, any[]>();
  const sent: any[] = [], callbackReports: any[] = [], diagnostics: string[] = [];
  const state = { pending: false };
  const ctx: any = { hasPendingMessages: () => state.pending, hasUI: true, ui: { notify: (text: string) => diagnostics.push(text) } };
  const pi: any = {
    on: (name: string, handler: any) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => undefined; },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: (name: string, fn: any) => renderers.set(name, fn),
    sendMessage: (message: any, options: any) => { sender?.(message); sent.push({ message, options }); },
  };
  registerFusionTools(pi, { getRuntime: () => runtime, onReport: (_: any, r: any) => callbackReports.push(r), ...callbacks });
  const invoke = (name: string, params: any, signal?: AbortSignal, update?: any) => tools.get(name).execute("call", params, signal, update, ctx);
  return { tools, renderers, handlers, sent, callbackReports, diagnostics, state, ctx, invoke };
}
function runtimeFor(d: ReturnType<typeof deferred>, extras: any = {}) {
  return {
    isBusy: () => true,
    handoff: () => ({ id: report.id, done: d.done }),
    latest: () => ({ id: report.id, done: d.done }),
    reports: new Map(),
    progress: () => ({ toolCalls: 1, recentTools: [], textTail: "", startedAt: 0, events: [], droppedEvents: 0 }),
    abort: async () => undefined,
    ...extras,
  };
}
async function hostLoop(h: ReturnType<typeof setup>, calls: any[], signal?: AbortSignal) {
  // Real Pi tool adapter, result-hook runner, and core loop; only the stream/context are fake.
  const runner = new ExtensionRunner([{ path: "/tmp/fusion-tools-test", handlers: h.handlers }], {}, "/tmp", {}, {});
  runner.createContext = () => h.ctx;
  const assistant: any = {
    role: "assistant", content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
    api: "mock", provider: "mock", model: "mock", stopReason: "toolUse", timestamp: 0,
  };
  const events: any[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "mock prompt", timestamp: 0 }],
    { messages: [], tools: [...h.tools.values()].map((tool) => wrapToolDefinition(tool, () => h.ctx)) },
    {
      model: { provider: "mock", id: "mock" }, convertToLlm: (msgs: any) => msgs,
      afterToolCall: ({ toolCall, args, result, isError }: any) => runner.emitToolResult({
        type: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name,
        input: args, content: result.content, details: result.details, usage: result.usage, isError,
      }),
      finishTurn: () => ({ action: "end" }),
    } as any,
    async (event: any) => { events.push(event); }, signal,
    (() => ({ async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message: assistant }; }, result: async () => assistant })) as any,
  );
  return { events, messages, results: messages.filter((message: any) => message.role === "toolResult") };
}

test("real host marks ordinary thrown errors in final events and messages", async () => {
  const h = setup(undefined);
  const { events, results } = await hostLoop(h, [["call", "sidekick", { message: "work" }], ["read", "read_subagent", {}]]);
  for (const end of events.filter((event: any) => event.type === "tool_execution_end")) {
    assert.equal(end.isError, true);
    assert.match(end.result.content[0].text, /Fusion is not active/);
  }
  assert.equal(results.length, 2);
  assert.ok(results.every((message: any) => message.isError === true));
});

test("real host result hook preserves full failed/aborted/interrupted reports and marks only own results", async () => {
  for (const status of ["error", "aborted", "interrupted", "completed"] as const) {
    const selected = { ...report, status, text: `report ${status}`, error: "full failure evidence" };
    const d = deferred(); d.resolve(selected);
    const h = setup(runtimeFor(d, { reports: new Map([[report.id, selected]]) }));
    const { events, results } = await hostLoop(h, [["call", "sidekick", { message: "work" }], ["read", "read_subagent", {}]]);
    assert.equal(results.length, 2);
    for (const message of results) {
      assert.equal(message.isError, status !== "completed");
      assert.equal(message.details.status, status);
      assert.equal(message.details.text, selected.text);
      assert.equal(message.details.error, selected.error);
      assert.deepEqual(message.details.usage, selected.usage);
      assert.equal(message.usage, undefined, "sidekick report metadata must not be double billed as tool usage");
    }
    assert.ok(events.filter((event: any) => event.type === "tool_execution_end").every((event: any) => event.isError === (status !== "completed")));
  }
  for (const name of ["sidekick", "read_subagent", "ordinary_tool"]) {
    const h = setup(undefined);
    const schema = h.tools.get("read_subagent").parameters;
    h.tools.set(name, { name, label: name, description: "unrelated", parameters: schema, execute: async () => ({ content: [{ type: "text", text: "ordinary output" }], details: { ...report, status: "error" } }) });
    const { results } = await hostLoop(h, [["other", name, {}]]);
    assert.equal(results[0].isError, false, "a same-name tool or normal report-shaped details has no private marker");
    assert.equal(results[0].content[0].text, "ordinary output");
  }
});

test("real host default parallel batch produces inline report without a duplicate notification", async () => {
  const d = deferred();
  const h = setup(runtimeFor(d), { onDetach: () => d.resolve(report) });
  const { results } = await hostLoop(h, [
    ["wait", "sidekick", { message: "work", block: true }],
    ["interrupt", "sidekick", { message: "update", block: false }],
  ]);
  assert.match(results.find((message: any) => message.toolCallId === "wait").content[0].text, /implemented/);
  await flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.callbackReports.length, 1);
});

test("two concurrent blocking reads and a nonblocking detach do not notify inline consumption", async () => {
  const d = deferred(), h = setup(runtimeFor(d));
  const first = h.invoke("sidekick", { message: "work" });
  const second = h.invoke("read_subagent", { block: true });
  await h.invoke("sidekick", { message: "update", block: false });
  d.resolve(report);
  const results = await Promise.all([first, second]);
  assert.ok(results.every((output) => output.details.status === "completed"));
  await flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.callbackReports.length, 1);
});

test("abort event wakes immediately, aborts runtime once, and never accepts a racing success", async () => {
  const clock = fakeClock();
  try {
    const d = deferred(); let aborts = 0;
    const h = setup(runtimeFor(d, { abort: async () => { aborts++; } }));
    const controller = new AbortController();
    const running = h.invoke("sidekick", { message: "work" }, controller.signal);
    const rejected = assert.rejects(running, /aborted/);
    controller.abort();
    await rejected;
    assert.equal(aborts, 1);
    assert.equal(clock.pending(), 0);
    d.resolve(report); await flush();
    assert.equal(h.sent.length, 1, "aborted waiter released its token so an eventual report remains visible");
  } finally { clock.restore(); }
});

test("abort/pending are rechecked when done wins and after the wait resolves", async () => {
  for (const afterMicrotask of [false, true]) {
    const d = deferred(), h = setup(runtimeFor(d));
    const running = h.invoke("sidekick", { message: "work" });
    d.resolve(report);
    if (afterMicrotask) { await Promise.resolve(); await Promise.resolve(); }
    h.state.pending = true;
    const output = await running;
    assert.match(output.content[0].text, /user message arrived/);
    assert.equal(output.details.status, undefined);
    await flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.callbackReports.length, 1, "the current report is still published by the background completion");
  }
  const d = deferred(); let aborts = 0;
  const h = setup(runtimeFor(d, { abort: async () => { aborts++; } }));
  const controller = new AbortController();
  const running = h.invoke("sidekick", { message: "work" }, controller.signal);
  const rejected = assert.rejects(running, /aborted/);
  d.resolve(report); controller.abort();
  await rejected;
  assert.equal(aborts, 1);
});

test("winning report and timeout both clear progress/deadline timers with one done subscription", async () => {
  const clock = fakeClock();
  try {
    const d = deferred(); let reactions = 0;
    const then = d.done.then.bind(d.done);
    d.done.then = ((...args: any[]) => { reactions++; return then(...args); }) as any;
    const h = setup(runtimeFor(d));
    const running = h.invoke("read_subagent", { block: true, timeout: 2700 });
    for (let n = 0; n < 5400; n++) { clock.tick(500); await flush(); }
    const output = await running;
    assert.match(output.content[0].text, /still running/);
    assert.equal(reactions, 1, "5400 ticks retain one original done subscription, not 5400 promise reactions");
    assert.equal(clock.pending(), 0);
    const resume = h.invoke("read_subagent", { block: true });
    d.resolve(report); await resume;
    assert.equal(clock.pending(), 0, "done clears both losing timers");
    assert.equal(reactions, 1, "resuming reuses cached observation");
  } finally { clock.restore(); }
});

test("onUpdate/onReport/onAttach/onDetach exceptions are diagnostic and cannot lose a report", async () => {
  const clock = fakeClock();
  try {
    const d = deferred();
    const h = setup(runtimeFor(d), {
      onReport: () => { throw new Error("publish failed"); },
      onAttach: () => { throw new Error("attach display failed"); },
      onDetach: () => { throw new Error("detach display failed"); },
    });
    await h.invoke("sidekick", { message: "work", block: false });
    const running = h.invoke("read_subagent", { block: true }, undefined, () => { throw new Error("UI update failed"); });
    clock.tick(500); await flush();
    d.resolve(report);
    const output = await running;
    assert.equal(output.details.status, "completed");
    assert.match(output.content[0].text, /implemented/);
    assert.equal(clock.pending(), 0);
    assert.equal(h.sent.length, 0);
    assert.match(h.diagnostics.join("\n"), /UI update failed/);
    assert.match(h.diagnostics.join("\n"), /publish failed/);
    assert.match(h.diagnostics.join("\n"), /attach display failed/);
    assert.match(h.diagnostics.join("\n"), /detach display failed/);
  } finally { clock.restore(); }
});

test("abort rejection is visible and releases waiter/listener/timers", async () => {
  const clock = fakeClock();
  try {
    const d = deferred();
    const h = setup(runtimeFor(d, { abort: async () => { throw new Error("abort failed"); } }));
    const controller = new AbortController(); let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: any[]) => { listeners++; return add(...args); }) as any;
    controller.signal.removeEventListener = ((...args: any[]) => { listeners--; return remove(...args); }) as any;
    const running = h.invoke("sidekick", { message: "work" }, controller.signal);
    const rejected = assert.rejects(running, /aborted/);
    controller.abort(); await rejected; await flush();
    assert.equal(listeners, 0);
    assert.equal(clock.pending(), 0);
    assert.match(h.diagnostics.join("\n"), /abort failed/);
    d.resolve(report); await flush();
    assert.equal(h.sent.length, 1);
  } finally { clock.restore(); }
});

test("isReportCurrent rejects background, blocking and cached stale reports before onReport/inline", async () => {
  const stale = { ...report, text: "secret old branch" };
  const d1 = deferred(), background = setup(runtimeFor(d1), { isReportCurrent: () => false });
  await background.invoke("sidekick", { message: "work", block: false });
  d1.resolve(stale); await flush();
  assert.equal(background.sent.length, 0);
  assert.equal(background.callbackReports.length, 0);
  const d2 = deferred(), blocking = setup(runtimeFor(d2), { isReportCurrent: () => false });
  const running = blocking.invoke("sidekick", { message: "work" });
  const rejected = assert.rejects(running, /inactive session or branch/);
  d2.resolve(stale); await rejected; await flush();
  assert.equal(blocking.sent.length, 0);
  assert.equal(blocking.callbackReports.length, 0);
  const cached = setup(runtimeFor(d2, { reports: new Map([[report.id, stale]]) }), { isReportCurrent: () => false });
  await assert.rejects(cached.invoke("read_subagent", {}), /inactive session or branch/);
  assert.equal(cached.callbackReports.length, 0);
});

test("sender failure stays readable, diagnostic, and only explicitly retried", async () => {
  let attempts = 0;
  const d = deferred(), runtime = runtimeFor(d);
  const h = setup(runtime, {}, () => { attempts++; if (attempts === 1) throw new Error("send failed"); });
  await h.invoke("sidekick", { message: "work", block: false });
  d.resolve(report); await flush();
  assert.equal(attempts, 1);
  assert.equal(h.sent.length, 0);
  assert.match(h.diagnostics.join("\n"), /delivery failed.*send failed/);
  await flush(); assert.equal(attempts, 1);
  await h.invoke("read_subagent", { block: false }); await flush();
  assert.equal(attempts, 2);
  assert.equal(h.sent.length, 1);
  runtime.reports.set(report.id, report);
  const output = await h.invoke("read_subagent", {});
  assert.equal(output.details.text, "implemented");
});

test("background done.reject sends a visible error follow-up; inline rejection is a host error", async () => {
  const d = deferred(), h = setup(runtimeFor(d));
  await h.invoke("sidekick", { message: "work", block: false });
  d.reject(new Error("handoff promise rejected")); await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.status, "error");
  assert.match(h.sent[0].message.content, /handoff promise rejected/);
  assert.equal(h.sent[0].options.triggerTurn, true);
  const d2 = deferred(), blocking = setup(runtimeFor(d2));
  const loop = hostLoop(blocking, [["read", "read_subagent", { block: true }]]);
  await flush(); d2.reject(new Error("rpc rejected"));
  const { events, results } = await loop;
  assert.equal(results[0].isError, true);
  assert.match(results[0].content[0].text, /rpc rejected/);
  assert.equal(events.find((event: any) => event.type === "tool_execution_end").isError, true);
  assert.equal(blocking.sent.length, 0, "inline failure is not duplicated as a background notification");
});

test("background rejection from a replaced runtime does not notify the new session", async () => {
  const d = deferred(), runtime = runtimeFor(d);
  let active: any = runtime;
  const h = setup(runtime, { getRuntime: () => active });
  await h.invoke("sidekick", { message: "work", block: false });
  active = undefined;
  d.reject(new Error("old session")); await flush();
  assert.equal(h.sent.length, 0);
});

test("model content is capped at 32 KiB UTF-8, keeps fullTextPath and complete report details", async () => {
  const text = "中文🙂".repeat(10000);
  const large = { ...report, text, fullTextPath: "/tmp/runtime-full-report.txt" };
  const d = deferred(); d.resolve(large);
  const h = setup(runtimeFor(d, { reports: new Map([[report.id, large]]) }));
  const inline = await h.invoke("read_subagent", {});
  assert.ok(Buffer.byteLength(inline.content[0].text) <= MODEL_CONTENT_MAX_BYTES);
  assert.match(inline.content[0].text, /Full report: \/tmp\/runtime-full-report.txt/);
  assert.equal(inline.content[0].text.includes("�"), false);
  assert.equal(inline.details.text, text);
  assert.equal(inline.usage, undefined);
  const background = setup(runtimeFor(d));
  await background.invoke("sidekick", { message: "work", block: false }); await flush();
  const notification = background.sent[0].message;
  assert.ok(Buffer.byteLength(notification.content) <= MODEL_CONTENT_MAX_BYTES);
  assert.match(notification.content, /Full report: \/tmp\/runtime-full-report.txt/);
  assert.match(notification.content, /<\/subagent_completion_notification>$/);
  assert.equal(notification.details.text, text);
  const gap = { ...report, text: "中".repeat(14000) };
  const dg = deferred(); dg.resolve(gap);
  const fallback = setup(runtimeFor(dg, { reports: new Map([[report.id, gap]]) }));
  const output = await fallback.invoke("read_subagent", {});
  assert.ok(Buffer.byteLength(output.content[0].text) <= MODEL_CONTENT_MAX_BYTES);
  assert.ok(output.details.fullTextPath);
  assert.equal(readFileSync(output.details.fullTextPath, "utf8"), gap.text, "32–64 KiB reports also have a recoverable full artifact");
});

test("completion forwards expanded, tolerates missing usage/events and strips protocol fallbacks", () => {
  const h = setup(undefined);
  const renderer = h.renderers.get("sidekick-completion");
  const events = Array.from({ length: 12 }, (_, n) => ({ kind: "text", text: `event-${n}`, open: false }));
  const collapsed = renderer({ details: { ...report, events } }, { expanded: false }, theme).render(120).join("\n");
  const expanded = renderer({ details: { ...report, events } }, { expanded: true }, theme).render(120).join("\n");
  assert.doesNotMatch(collapsed, /event-0\b/);
  assert.match(collapsed, /4 earlier steps/);
  assert.match(expanded, /event-0\b/);
  const id = "ecff5344-4e60-4892-8a86-1f8e962caf1b";
  const malformed = { id, status: "completed", text: `legacy text <subagent_completion_notification agent_id="${id}">Use read_subagent to collect.</subagent_completion_notification>` };
  for (const card of [
    renderer({ details: malformed }, {}, theme),
    h.tools.get("sidekick").renderResult({ content: [{ type: "text", text: `Handoff ${id}; use read_subagent.` }], details: malformed }, {}, theme),
  ]) {
    const text = card.render(120).join("\n");
    assert.match(text, /legacy text/);
    assert.doesNotMatch(text, /ecff5344|subagent_completion|agent_id|Use read_subagent/);
  }
  assert.doesNotThrow(() => renderer({}, {}, theme).render(120));
});

test("read_subagent omitted block shows snapshot and returns without waiting", async () => {
  const h = setup(runtimeFor(deferred()));
  const call = h.tools.get("read_subagent").renderCall({}, theme).render(120).join("\n");
  assert.match(call, /snapshot/);
  const output = await h.invoke("read_subagent", {});
  assert.match(output.content[0].text, /is still running/);
});

test("all own call/result/completion render paths fit widths 1/2/3 with real Markdown and ANSI", () => {
  const h = setup(undefined);
  const ansiTheme = {
    fg: (_: string, text: string) => `\u001b[32m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    bg: (_: string, text: string) => `\u001b[44m${text}\u001b[49m`,
    underline: (text: string) => `\u001b[4m${text}\u001b[24m`,
    italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
  };
  setThemeInstance(ansiTheme as any); // In-memory fake only: no terminal, config or watcher.
  const text = "# 中文\n\n| 列 | 值 |\n| --- | --- |\n| 汉字 | 宽字 |\n\n```ts\n// 中文输出\n```";
  const details = { ...report, text, events: [{ kind: "text", text, open: false }] };
  const components = [
    h.tools.get("sidekick").renderCall({ message: "中文消息" }, ansiTheme),
    h.tools.get("read_subagent").renderCall({}, ansiTheme),
    h.tools.get("sidekick").renderResult({ content: [{ type: "text", text: "中文错误" }], details: {} }, {}, ansiTheme),
    h.tools.get("sidekick").renderResult({ details: { background: true } }, {}, ansiTheme),
    h.tools.get("sidekick").renderResult({ details }, {}, ansiTheme),
    h.renderers.get("sidekick-completion")({ details }, { expanded: true }, ansiTheme),
    h.renderers.get("sidekick-completion")({}, {}, ansiTheme),
  ];
  for (const width of [1, 2, 3]) for (const component of components) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
  }
});

test("onReport changing authorization cannot send or return a report into the new branch", async () => {
  for (const mode of ["background", "blocking", "cached"]) {
    const d = deferred();
    let current = true;
    const h = setup(runtimeFor(d, mode === "cached" ? { reports: new Map([[report.id, report]]) } : {}), {
      isReportCurrent: () => current,
      onReport: () => { current = false; },
    });
    if (mode === "background") {
      await h.invoke("sidekick", { message: "work", block: false });
      d.resolve(report); await flush();
    } else {
      const running = mode === "cached" ? h.invoke("read_subagent", {}) : h.invoke("sidekick", { message: "work" });
      const rejected = assert.rejects(running, /inactive session or branch/);
      d.resolve(report); await rejected; await flush();
    }
    assert.equal(h.sent.length, 0);
  }
});

test("last-moment pending/abort in an onReport callback cannot consume the report inline", async () => {
  for (const cached of [false, true]) {
    const d = deferred();
    let h!: ReturnType<typeof setup>;
    h = setup(runtimeFor(d, cached ? { reports: new Map([[report.id, report]]) } : {}), { onReport: () => { h.state.pending = true; } });
    const running = cached ? h.invoke("read_subagent", {}) : h.invoke("sidekick", { message: "work" });
    d.resolve(report);
    const output = await running;
    assert.match(output.content[0].text, /user message arrived/);
    assert.equal(output.details.status, undefined);
  }
  const d = deferred(), controller = new AbortController();
  const h = setup(runtimeFor(d), { onReport: () => controller.abort() });
  const running = h.invoke("sidekick", { message: "work" }, controller.signal);
  const rejected = assert.rejects(running, /aborted/);
  d.resolve(report); await rejected; await flush();
  assert.equal(h.sent.length, 1, "report was not consumed when onReport aborted the wait");
});

test("abort of an old wait never cancels a newer shared-runtime handoff", async () => {
  const d = deferred(); let aborts = 0, latestId = report.id;
  const h = setup(runtimeFor(d, { latest: () => ({ id: latestId, done: d.done }), abort: async () => { aborts++; } }));
  const controller = new AbortController();
  const running = h.invoke("sidekick", { message: "work" }, controller.signal);
  const rejected = assert.rejects(running, /aborted/);
  latestId = "newer-handoff";
  controller.abort(); await rejected;
  assert.equal(aborts, 0);
  d.resolve(report); await flush();
});

test("aborting one waiter does not release a peer; the peer can consume the aborted report inline", async () => {
  const d = deferred(), aborted = { ...report, status: "aborted" as const };
  const h = setup(runtimeFor(d, { abort: async () => { d.resolve(aborted); } }));
  const controller = new AbortController();
  const first = h.invoke("sidekick", { message: "work" }, controller.signal);
  const second = h.invoke("read_subagent", { block: true });
  const rejected = assert.rejects(first, /aborted/);
  controller.abort(); await rejected;
  const output = await second; await flush();
  assert.equal(output.details.status, "aborted");
  assert.equal(h.sent.length, 0);
});

test("already-aborted attached read releases its token and sends a settled aborted report", async () => {
  const d = deferred();
  const h = setup(runtimeFor(d, { abort: async () => d.resolve({ ...report, status: "aborted" }) }));
  await h.invoke("sidekick", { message: "work", block: false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.invoke("read_subagent", { block: true }, controller.signal), /aborted/);
  await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.status, "aborted");
});

test("status failure diagnostics are visible in non-UI mode without losing host report details", async () => {
  const d = deferred(); d.resolve({ ...report, status: "error", error: "report failure" });
  const h = setup(runtimeFor(d), { onReport: () => { throw new Error("status display failed"); } });
  h.ctx.hasUI = false;
  const { results, events } = await hostLoop(h, [["call", "sidekick", { message: "work" }]]);
  assert.equal(results[0].isError, true);
  assert.equal(results[0].details.text, report.text);
  assert.equal(results[0].details.error, "report failure");
  assert.equal(events.find((event: any) => event.type === "tool_execution_end").isError, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "sidekick-diagnostic");
  assert.equal(h.sent[0].message.display, true);
  assert.equal(h.sent[0].options.triggerTurn, false);
  assert.match(h.sent[0].message.content, /status display failed/);
});
