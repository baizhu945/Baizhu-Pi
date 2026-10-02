import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SidekickRuntime, MAX_REPORTS, MAX_REPORT_TEXT_BYTES, MAX_RPC_RECORD_BYTES, MAX_TEXT_EVENT_BYTES, type SidekickSpawnConfig } from "../src/sidekick-runtime.js";

// In-memory children and isolated /tmp files only; never execute pi or a model.
type Wire = Record<string, unknown>;
function childStub() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    sent: [] as Wire[], signals: [] as NodeJS.Signals[],
  });
  child.stdin.on("data", (data) => {
    for (const line of String(data).split("\n")) if (line) child.sent.push(JSON.parse(line));
  });
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    child.signals.push(signal);
    child.killed = true;
    child.signalCode = signal;
    child.emit("close", null, signal);
    return true;
  };
  return Object.assign(child, { kill });
}
type Child = ReturnType<typeof childStub>;
function cleanup(directory: string): void {
  for (const file of readdirSync(directory)) {
    const path = join(directory, file);
    if (lstatSync(path).isDirectory()) cleanup(path);
    else unlinkSync(path);
  }
  rmdirSync(directory);
}
function setup(t: TestContext, options: Partial<SidekickSpawnConfig> = {}) {
  const directory = mkdtempSync("/tmp/fusion-runtime-safety-");
  const children: Child[] = [];
  const runtime = new SidekickRuntime({
    cwd: directory, model: "b/glm", thinking: "low", sessionFile: join(directory, "stub.jsonl"), systemPrompt: "stub",
    command: { command: "memory-only-stub", args: [] }, settleGraceMs: 2, reportTimeoutMs: 50, promptTimeoutMs: 25, abortTimeoutMs: 15,
    spawn: (() => { const child = childStub(); children.push(child); return child; }) as never, ...options,
  });
  t.after(() => { runtime.kill(); cleanup(directory); });
  return { runtime, children, directory, get child() { return children.at(-1)!; } };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const wire = (child: Child, value: Wire) => child.stdout.write(`${JSON.stringify(value)}\n`);
const last = (child: Child, type: string): Wire => {
  const request = child.sent.findLast((request) => request.type === type);
  assert.ok(request, `missing ${type}`);
  return request;
};
const ack = (child: Child, request = last(child, "prompt")) => wire(child, { type: "response", id: request.id, command: request.type, success: true });
const user = (child: Child, text: unknown = last(child, "prompt").message) => {
  for (const type of ["message_start", "message_end"]) wire(child, { type, message: { role: "user", content: [{ type: "text", text }] } });
};
const accept = (child: Child) => { ack(child); wire(child, { type: "agent_start" }); user(child); };
const settle = (child: Child) => wire(child, { type: "agent_settled" });
const answer = (child: Child, text: string, request = last(child, "get_last_assistant_text")) => wire(child, { type: "response", command: "get_last_assistant_text", id: request.id, success: true, data: { text } });
const queries = (child: Child) => child.sent.filter((request) => request.type === "get_last_assistant_text");

test("stream errors and async write callback errors report once and permit respawn", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("broken pipe");
  const oldChild = h.child;
  assert.ok(oldChild.stdin.listenerCount("error") > 0);
  assert.ok(oldChild.stdout.listenerCount("error") > 0);
  assert.ok(oldChild.stderr.listenerCount("error") > 0);
  oldChild.stdin.emit("error", new Error("async EPIPE"));
  assert.match((await first.done).error!, /EPIPE/);
  oldChild.emit("error", new Error("duplicate"));
  oldChild.stdout.emit("error", new Error("duplicate stdout"));
  assert.equal(h.runtime.totalHandoffs(), 1);
  const second = h.runtime.handoff("replacement");
  oldChild.stderr.emit("error", new Error("late old stderr"));
  assert.equal(h.children.length, 2);
  assert.equal(h.runtime.isBusy(), true);
  const child = h.child;
  let callback: ((error?: Error | null) => void) | undefined;
  child.stdin.write = ((_data: unknown, cb: (error?: Error | null) => void) => { callback = cb; return true; }) as never;
  h.runtime.handoff("redirect");
  callback!(new Error("callback EPIPE"));
  child.stdin.emit("error", new Error("same callback EPIPE"));
  assert.match((await second.done).error!, /callback EPIPE/);
  assert.equal(h.runtime.totalHandoffs(), 2);
});

test("obsolete write callbacks do not poison the next handoff or generation", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("first");
  accept(h.child);
  let callback: ((error?: Error | null) => void) | undefined;
  const write = h.child.stdin.write.bind(h.child.stdin);
  h.child.stdin.write = ((data: string, cb: (error?: Error | null) => void) => { callback = cb; return write(data); }) as never;
  settle(h.child);
  answer(h.child, "done");
  assert.equal((await first.done).status, "completed");
  const oldCallback = callback!;
  const next = h.runtime.handoff("next");
  oldCallback(new Error("late old callback"));
  assert.equal(h.runtime.isBusy(), true);
  const nextCallback = callback!;
  h.runtime.handoff("new generation");
  nextCallback(new Error("late prior generation callback"));
  assert.equal(h.runtime.isBusy(), true);
  h.runtime.kill();
  await next.done;
});

test("non-writable idle child is replaced rather than permanently reused", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("first");
  accept(h.child); settle(h.child); answer(h.child, "done"); await first.done;
  h.child.stdin.end();
  assert.equal(h.runtime.isAlive(), false);
  const second = h.runtime.handoff("second");
  assert.equal(h.children.length, 2);
  accept(h.child); settle(h.child); answer(h.child, "respawned");
  assert.equal((await second.done).status, "completed");
});

for (const name of ["stdout", "stderr"] as const) {
  test(`${name} stream error fails only its own child once`, async (t) => {
    const h = setup(t);
    const handoff = h.runtime.handoff("stream");
    const old = h.child;
    old[name].emit("error", new Error(`${name} failed`));
    assert.match((await handoff.done).error!, new RegExp(name));
    const next = h.runtime.handoff("next");
    old[name].emit("error", new Error("late old error"));
    assert.equal(h.runtime.isBusy(), true);
    assert.equal(h.runtime.totalHandoffs(), 1);
    accept(h.child); settle(h.child); answer(h.child, "ok"); await next.done;
  });
}

test("signal close with null exitCode clears child and permits respawn", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("first");
  const old = h.child;
  old.signalCode = "SIGKILL";
  old.emit("close", null, "SIGKILL");
  assert.equal((await first.done).status, "error");
  assert.equal(old.exitCode, null);
  assert.equal(h.runtime.isAlive(), false);
  const second = h.runtime.handoff("second");
  assert.equal(h.children.length, 2);
  old.emit("close", null, "SIGKILL");
  accept(h.child); settle(h.child); answer(h.child, "new child");
  assert.equal((await second.done).text, "new child");
});

test("UTF-8 split across Buffer chunks preserves stdout and stderr", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("unicode");
  accept(h.child); settle(h.child);
  const bytes = Buffer.from(JSON.stringify({ type: "response", command: "get_last_assistant_text", id: last(h.child, "get_last_assistant_text").id, success: true, data: { text: "中文🙂" } }) + "\n");
  for (const byte of bytes) h.child.stdout.write(Buffer.from([byte]));
  assert.equal((await first.done).text, "中文🙂");
  const second = h.runtime.handoff("stderr");
  for (const byte of Buffer.from("中文🙂")) h.child.stderr.write(Buffer.from([byte]));
  h.child.emit("close", 1, null);
  assert.equal((await second.done).error, "中文🙂");
});

for (const afterAck of [false, true]) {
  test(`old settled cannot end a redirected brief (${afterAck ? "after" : "before"} ACK)`, async (t) => {
    const h = setup(t);
    const first = h.runtime.handoff("old brief");
    accept(h.child);
    const redirected = h.runtime.handoff("new brief");
    if (afterAck) ack(h.child);
    settle(h.child);
    assert.equal(queries(h.child).length, 0);
    if (!afterAck) ack(h.child);
    assert.equal(queries(h.child).length, 0, "ACK must not reuse previous settled");
    // An unrelated user/old answer/agent_start cannot activate the new brief.
    user(h.child, "old brief");
    wire(h.child, { type: "agent_start" });
    settle(h.child);
    assert.equal(queries(h.child).length, 0);
    user(h.child, "new  brief\n"); // normalized whitespace, no new agent_start required
    settle(h.child); answer(h.child, "new report");
    assert.equal(redirected.done, first.done);
    assert.equal((await first.done).text, "new report");
  });
}

test("stale settled before redirect rejection cannot query the old report", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("old");
  accept(h.child);
  h.runtime.handoff("denied redirect");
  settle(h.child);
  const request = last(h.child, "prompt");
  wire(h.child, { type: "response", id: request.id, command: "prompt", success: false, error: "denied" });
  assert.equal((await first.done).error, "denied");
  assert.equal(queries(h.child).length, 0);
});

test("prompt without ACK and abort without ACK both have independent bounded deadlines", async (t) => {
  const h = setup(t, { promptTimeoutMs: 15, abortTimeoutMs: 10 });
  const first = h.runtime.handoff("no ACK");
  await wait(25);
  assert.match((await first.done).error!, /prompt ACK.*15ms/);
  const second = h.runtime.handoff("abort");
  await h.runtime.abort();
  settle(h.child);
  await wait(20);
  assert.match((await second.done).error!, /abort ACK.*10ms/);
  assert.equal(h.runtime.isBusy(), false);
  assert.equal(queries(h.child).length, 0);
});

for (const brief of ["consumed by input handler", "/extension-command"]) {
  test(`ACK without a run fails after idle confirmation: ${brief}`, async (t) => {
    const h = setup(t, { promptTimeoutMs: 10 });
    const handoff = h.runtime.handoff(brief);
    ack(h.child);
    settle(h.child); // stale/irrelevant settle must not satisfy the acceptance gate
    await wait(15);
    const state = last(h.child, "get_state");
    wire(h.child, { type: "response", id: state.id, command: "get_state", success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    assert.match((await handoff.done).error!, /acknowledged but no matching user activity/);
  });
}

test("queued steer during a long silent tool remains pending until its matching user activity", async (t) => {
  const h = setup(t, { promptTimeoutMs: 15 });
  const handoff = h.runtime.handoff("original");
  accept(h.child);
  h.runtime.handoff("queued brief");
  ack(h.child);
  await wait(20);
  let state = last(h.child, "get_state");
  wire(h.child, { type: "response", id: state.id, command: "get_state", success: true, data: { isStreaming: true, pendingMessageCount: 1 } });
  await wait(20);
  assert.equal(h.runtime.isBusy(), true);
  state = last(h.child, "get_state");
  wire(h.child, { type: "response", id: state.id, command: "get_state", success: true, data: { isStreaming: true, pendingMessageCount: 1 } });
  settle(h.child);
  assert.equal(queries(h.child).length, 0);
  user(h.child); // no new agent_start: steer incorporated in the existing run
  settle(h.child); answer(h.child, "queued final");
  assert.equal((await handoff.done).status, "completed");
});

test("stale old starts cannot extend the initial prompt ACK deadline", async (t) => {
  const h = setup(t, { promptTimeoutMs: 15 });
  const handoff = h.runtime.handoff("unaccepted");
  await wait(10);
  wire(h.child, { type: "agent_start" });
  await wait(10);
  assert.equal(h.runtime.isBusy(), false);
  assert.match((await handoff.done).error!, /prompt ACK/);
});

test("new user activity invalidates an in-flight idle state snapshot", async (t) => {
  const h = setup(t, { promptTimeoutMs: 10 });
  const handoff = h.runtime.handoff("queued");
  ack(h.child);
  await wait(15);
  const stale = last(h.child, "get_state");
  user(h.child);
  wire(h.child, { type: "response", id: stale.id, command: "get_state", success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
  assert.equal(h.runtime.isBusy(), true);
  settle(h.child); answer(h.child, "new active report");
  assert.equal((await handoff.done).status, "completed");
});

test("missing state ACK and active-but-idle missing settle cannot hang", async (t) => {
  const h = setup(t, { promptTimeoutMs: 10 });
  const first = h.runtime.handoff("silent");
  ack(h.child);
  await wait(30);
  assert.match((await first.done).error!, /state query timed out/);
  const second = h.runtime.handoff("active");
  accept(h.child);
  await wait(15);
  const state = last(h.child, "get_state");
  wire(h.child, { type: "response", id: state.id, command: "get_state", success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
  assert.match((await second.done).error!, /idle without a final agent_settled/);
});

test("redirect clears obsolete abort, acceptance, and state timers", async (t) => {
  const h = setup(t, { promptTimeoutMs: 10, abortTimeoutMs: 10 });
  const handoff = h.runtime.handoff("initial");
  ack(h.child);
  await wait(15);
  const oldState = last(h.child, "get_state");
  await h.runtime.abort();
  const oldAbort = last(h.child, "abort");
  h.runtime.handoff("redirect");
  accept(h.child);
  wire(h.child, { type: "response", id: oldState.id, command: "get_state", success: true, data: { isStreaming: false } });
  ack(h.child, oldAbort);
  settle(h.child); answer(h.child, "redirect final");
  await wait(30);
  assert.equal((await handoff.done).status, "completed");
  assert.equal(h.runtime.totalHandoffs(), 1);
});

test("recovered 429 retry completes successfully while diagnostic history remains", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("retry");
  accept(h.child);
  wire(h.child, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limited" } });
  wire(h.child, { type: "auto_retry_start", errorMessage: "429 rate limited", attempt: 1 });
  wire(h.child, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  wire(h.child, { type: "auto_retry_end", success: true });
  settle(h.child); answer(h.child, "recovered");
  const report = await handoff.done;
  assert.equal(report.status, "completed");
  assert.equal(report.error, undefined);
  assert.deepEqual(report.transientErrors, ["429 rate limited"]);
});

test("unrecovered assistant failure remains terminal", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("fail"); accept(h.child);
  wire(h.child, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "permanent failure" } });
  settle(h.child); answer(h.child, "partial");
  assert.equal((await handoff.done).error, "permanent failure");
});

test("parse noise is isolated; UI cancellation write and handler failures are explicit", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("UI");
  h.child.stdout.write("not-json\n");
  assert.equal(h.runtime.isBusy(), true);
  h.child.stdin.write = (() => { throw new Error("UI cancellation write failed"); }) as never;
  wire(h.child, { type: "extension_ui_request", id: "ui-1", method: "input" });
  assert.match((await handoff.done).error!, /RPC handler failed: UI cancellation write failed/);
  assert.equal(h.runtime.isAlive(), false);
  const second = h.runtime.handoff("bad object");
  h.child.stdout.write("null\n");
  assert.match((await second.done).error!, /Invalid sidekick RPC object/);
});

for (const newline of [false, true]) {
  test(`RPC record exceeding 10MiB ${newline ? "with" : "without"} newline closes only its child`, async (t) => {
    const h = setup(t);
    const handoff = h.runtime.handoff("record limit");
    const ownChild = h.child;
    ownChild.stdout.write("x".repeat(MAX_RPC_RECORD_BYTES + 1) + (newline ? "\n" : ""));
    assert.match((await handoff.done).error!, /record exceeded 10MiB/);
    assert.deepEqual(ownChild.signals, ["SIGTERM"]);
    assert.equal(h.runtime.isAlive(), false);
    const next = h.runtime.handoff("next");
    ownChild.stdout.write("x".repeat(MAX_RPC_RECORD_BYTES + 1));
    assert.equal(h.runtime.isBusy(), true);
    h.runtime.kill(); await next.done;
  });
}

test("many valid records in a large chunk are allowed while display text is bounded", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("text"); accept(h.child);
  const line = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "中文🙂".repeat(1000) } }) + "\n";
  h.child.stdout.write(line.repeat(1100)); // >10MiB overall, each record remains small
  const event = h.runtime.progress()!.events[0]!;
  assert.ok(event.kind === "text");
  assert.equal(event.truncated, true);
  assert.ok(Buffer.byteLength(event.text) <= MAX_TEXT_EVENT_BYTES);
  assert.match(event.text, /Display text truncated/);
  assert.equal(event.text.includes("�"), false);
  settle(h.child); answer(h.child, "final");
  assert.equal((await handoff.done).status, "completed");
});

test("large display arguments are bounded without truncating cancellation tracking", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("args"); accept(h.child);
  wire(h.child, { type: "tool_execution_start", toolCallId: "run", toolName: "bg_run", args: {} });
  wire(h.child, { type: "tool_execution_end", toolCallId: "run", toolName: "bg_run", result: { details: { id: "aaaaaaaa" } } });
  wire(h.child, { type: "tool_execution_start", toolCallId: "status", toolName: "bg_status", args: { noise: " ".repeat(20000), id: "aaaaaaaa" } });
  const event = h.runtime.progress()!.events.at(-1)!;
  assert.equal(event.kind, "tool");
  if (event.kind === "tool") {
    assert.equal(event.args?.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(event.args)) <= MAX_TEXT_EVENT_BYTES);
  }
  wire(h.child, { type: "tool_execution_end", toolCallId: "status", toolName: "bg_status", result: { details: { state: "stopped" } } });
  settle(h.child); answer(h.child, "canceled");
  assert.equal((await handoff.done).status, "completed");
});

test("recent reports evict at 20 without shrinking cumulative counters or usage", async (t) => {
  const h = setup(t);
  let firstId = "";
  for (let i = 0; i < 25; i++) {
    const handoff = h.runtime.handoff(`brief-${i}`);
    if (i === 0) firstId = handoff.id;
    accept(h.child);
    wire(h.child, { type: "tool_execution_start", toolCallId: `tool-${i}`, toolName: "bash" });
    wire(h.child, { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 2 } } });
    settle(h.child); answer(h.child, "done"); await handoff.done;
  }
  assert.equal(h.runtime.reports.size, MAX_REPORTS);
  assert.equal(h.runtime.reports.has(firstId), false);
  assert.equal(h.runtime.totalHandoffs(), 25);
  assert.equal(h.runtime.totalToolCalls(), 25);
  assert.equal(h.runtime.usage.input, 50);
});

test("large final report is preserved in a private exclusive file with an explicit preview", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("evidence"); accept(h.child); settle(h.child);
  const text = "中文🙂".repeat(9000);
  answer(h.child, text);
  const report = await handoff.done;
  assert.equal(report.status, "completed");
  assert.ok(report.fullTextPath);
  assert.equal(readFileSync(report.fullTextPath, "utf8"), text);
  assert.equal(lstatSync(report.fullTextPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(h.directory, "reports")).mode & 0o777, 0o700);
  assert.ok(Buffer.byteLength(report.text) <= MAX_REPORT_TEXT_BYTES);
  assert.match(report.text, /Report truncated at 64KiB; full evidence:/);
  assert.equal(report.text.includes("�"), false);
});

test("report directory symlink is rejected and evidence loss is explicit", async (t) => {
  const h = setup(t);
  symlinkSync(h.directory, join(h.directory, "reports"));
  const handoff = h.runtime.handoff("bad archive"); accept(h.child); settle(h.child);
  answer(h.child, "x".repeat(MAX_REPORT_TEXT_BYTES + 1));
  const report = await handoff.done;
  assert.equal(report.status, "error");
  assert.match(report.error!, /Could not preserve full sidekick report/);
  assert.match(report.text, /full evidence could not be saved/);
  assert.equal(report.fullTextPath, undefined);
});

test("shutdown sends EOF/SIGTERM, then only its own lingering child gets SIGKILL", async (t) => {
  const h = setup(t, { shutdownGraceMs: 10 });
  const handoff = h.runtime.handoff("shutdown");
  const old = h.child;
  let ended = false;
  old.stdin.on("finish", () => { ended = true; });
  old.kill = (signal: NodeJS.Signals = "SIGTERM") => { old.signals.push(signal); old.killed = true; return true; };
  h.runtime.kill();
  await handoff.done;
  const replacement = h.runtime.handoff("replacement");
  await wait(20);
  assert.equal(ended, true);
  assert.deepEqual(old.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(h.child.signals, []);
  h.runtime.kill(); await replacement.done;
});
