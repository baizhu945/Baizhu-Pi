import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { SidekickRuntime, type HandoffReport } from "../src/sidekick-runtime.js";

// In-memory RPC child only: no pi binary, credentials, sessions or model calls.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    killed: boolean;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("close");
    return true;
  };
  return child;
}

type Command = Record<string, unknown>;
type Handoff = { id: string; done: Promise<HandoffReport> };

function setup(t: TestContext, options: { settleGraceMs?: number; reportTimeoutMs?: number; spawnError?: string; autoAccept?: boolean } = {}) {
  const dir = mkdtempSync("/tmp/fusion-runtime-compat-");
  const child = fakeChild();
  const sent: Command[] = [];
  child.stdin.on("data", (data) => {
    for (const line of String(data).split("\n")) if (line) {
      const request = JSON.parse(line) as Command;
      sent.push(request);
      // Model real native initial preflight ACK followed by matching user
      // activity. Steering and rejection tests control their own ACKs.
      if (request.type === "prompt" && request.streamingBehavior === undefined && options.autoAccept !== false) {
        child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true })}\n`);
        for (const type of ["message_start", "message_end"]) child.stdout.write(`${JSON.stringify({ type, message: { role: "user", content: [{ type: "text", text: request.message }] } })}\n`);
      }
    }
  });
  let spawns = 0;
  const runtime = new SidekickRuntime({
    cwd: dir,
    model: "b/glm",
    thinking: "low",
    sessionFile: join(dir, "stub.jsonl"),
    systemPrompt: "stub",
    command: { command: "in-memory-stub", args: [] },
    spawn: (() => {
      spawns += 1;
      if (options.spawnError) throw new Error(options.spawnError);
      return child;
    }) as never,
    settleGraceMs: options.settleGraceMs ?? 5,
    reportTimeoutMs: options.reportTimeoutMs ?? 1000,
  });
  t.after(() => {
    runtime.kill();
    rmdirSync(dir);
  });
  return { child, sent, runtime, spawns: () => spawns };
}

type Harness = ReturnType<typeof setup>;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const emit = (h: Harness, value: unknown) => h.child.stdout.write(`${JSON.stringify(value)}\n`);
const queries = (h: Harness) => h.sent.filter((command) => command.type === "get_last_assistant_text");
const last = (h: Harness, type: string): Command => {
  const request = h.sent.findLast((command) => command.type === type);
  assert.ok(request, `expected ${type} request`);
  assert.equal(typeof request.id, "string", "native RPC requests are correlated by unique ids");
  return request;
};
const ack = (h: Harness, request: Command, error?: string) => {
  emit(h, { type: "response", id: request.id, command: request.type, success: error === undefined, ...(error === undefined ? {} : { error }) });
  if (request.type === "prompt" && error === undefined && typeof request.message === "string") {
    for (const type of ["message_start", "message_end"]) emit(h, { type, message: { role: "user", content: [{ type: "text", text: request.message }] } });
  }
};
const answer = (h: Harness, request: Command, text: string) => emit(h, {
  type: "response", id: request.id, command: "get_last_assistant_text", success: true, data: { text },
});
const start = (h: Harness, name: string, callId: string, args: Command = {}) => emit(h, {
  type: "tool_execution_start", toolName: name, toolCallId: callId, args,
});
const end = (h: Harness, callId: string, result?: unknown, isError = false) => emit(h, {
  type: "tool_execution_end", toolCallId: callId, result, isError,
});
const bgResult = (id: string, tail = "") => ({
  content: [{ type: "text", text: `${id} running 0s pid=123 stub command\n${tail}` }], details: undefined,
});
const launch = (h: Harness, callId: string, id: string, tail = "") => {
  start(h, "bg_run", callId, { command: "stub command" });
  end(h, callId, bgResult(id, tail));
};
const notification = (h: Harness, ids: string[]) => emit(h, {
  type: "message_end", message: {
    role: "custom", customType: "background-command-result", content: "stub results",
    details: { jobs: ids.map((id) => ({ id, state: "exited", exitCode: 0 })) },
  },
});
const settled = (h: Harness) => emit(h, { type: "agent_settled" });
async function completed(h: Harness, handoff: Handoff, text = "stub final") {
  answer(h, last(h, "get_last_assistant_text"), text);
  const report = await handoff.done;
  assert.equal(report.status, "completed");
  assert.equal(report.text, text);
  assert.equal(h.runtime.isBusy(), false);
  return report;
}

// A: the exact local protocol, four single-job notifications and a stopped final turn.
test("four local background jobs release after four notifications and automatically complete", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("four stub jobs");
  ack(h, last(h, "prompt"));
  const ids = ["ddabca17", "37d3581e", "8603993f", "fa80e8bd"];
  ids.forEach((id, i) => launch(h, `bg-${i}`, id, i === 0 ? "x".repeat(9000) : ""));
  const first = h.runtime.progress()?.events[0];
  assert.ok(first?.kind === "tool");
  assert.equal(first.output.length, 4000);
  assert.equal(first.output.includes(ids[0]!), false, "display truncation discarded the id, tracking did not");
  emit(h, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  settled(h);
  assert.equal(queries(h).length, 0);
  for (const id of ids.slice(0, 3)) notification(h, [id]);
  await wait(15);
  assert.equal(queries(h).length, 0);
  notification(h, [ids[3]!]);
  await wait(15);
  assert.equal(queries(h).length, 1);
  const query = last(h, "get_last_assistant_text");
  const report = await completed(h, handoff);
  notification(h, ids);
  settled(h);
  answer(h, query, "duplicate stub response");
  assert.equal(h.runtime.reports.size, 1);
  assert.equal(h.runtime.reports.get(handoff.id), report);
  assert.equal(queries(h).length, 1, "report delivery is once-only");
});

// B/C: batched IDs, duplicates and unrelated IDs must not act like a bare counter.
test("a local batch of two results releases two holds", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("batch");
  launch(h, "bg-1", "aaaaaaaa");
  launch(h, "bg-2", "bbbbbbbb");
  settled(h);
  notification(h, ["aaaaaaaa", "bbbbbbbb", "aaaaaaaa"]);
  await wait(15);
  assert.equal(queries(h).length, 1);
  await completed(h, handoff);
});

test("duplicates and unrelated notifications never clear another known job", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("dedupe");
  launch(h, "bg-1", "aaaaaaaa");
  launch(h, "bg-2", "bbbbbbbb");
  settled(h);
  notification(h, ["aaaaaaaa"]);
  notification(h, ["aaaaaaaa", "cccccccc"]);
  emit(h, { type: "message_end", message: { role: "custom", customType: "background-task-notification", details: { id: "other" } } });
  emit(h, { type: "message_end", message: { role: "custom", customType: "background-task-notification" } });
  await wait(15);
  assert.equal(h.runtime.isBusy(), true);
  assert.equal(queries(h).length, 0);
  notification(h, ["bbbbbbbb"]);
  await wait(15);
  await completed(h, handoff);
});

// D: remember the completed ID until the launch's full result binds it.
for (const settleBeforeEnd of [false, true]) {
  test(`notification before launch end (settled first: ${settleBeforeEnd})`, async (t) => {
    const h = setup(t);
    const handoff = h.runtime.handoff("early result");
    start(h, "bg_run", "bg-1", { command: "stub" });
    if (settleBeforeEnd) settled(h);
    notification(h, ["aaaaaaaa"]);
    assert.equal(queries(h).length, 0);
    end(h, "bg-1", bgResult("aaaaaaaa"));
    if (settleBeforeEnd) await wait(15);
    else {
      assert.equal(queries(h).length, 0, "completion alone is not a final turn");
      settled(h);
    }
    assert.equal(queries(h).length, 1);
    await completed(h, handoff);
  });
}

// E: both failures and successful binding survive the 300-entry display cache.
test("evicted bg_run events still release failures and bind full launch output", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("eviction");
  start(h, "bg_run", "failed", { command: "stub failure" });
  start(h, "bg_run", "success", { command: "stub success" });
  for (let i = 0; i < 301; i++) start(h, "bash", `display-${i}`);
  assert.equal(h.runtime.progress()?.droppedEvents, 3);
  end(h, "failed", { content: [{ type: "text", text: "spawn ENOENT" }] }, true);
  end(h, "success", bgResult("aaaaaaaa", "x".repeat(9000)));
  settled(h);
  assert.equal(queries(h).length, 0, "the successful job still owes its notification");
  notification(h, ["aaaaaaaa"]);
  await wait(15);
  const report = await completed(h, handoff);
  assert.equal(report.toolCalls, 303);
  assert.equal(report.events.length, 300);
});

test("failed bg_run never hangs a settled handoff", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("launch failure");
  start(h, "bg_run", "bg-1");
  end(h, "bg-1", { isError: true, content: [{ type: "text", text: "spawn failed" }] }, true);
  settled(h);
  assert.equal(queries(h).length, 1);
  await completed(h, handoff);
});

// F: stopping means accepted cancellation, not that the process has already exited.
test("accepted bg_kill stopping releases the hold without requiring a notification", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("cancel stub job");
  launch(h, "bg-1", "aaaaaaaa");
  settled(h);
  start(h, "bg_kill", "kill-1", { id: "aaaaaaaa" });
  end(h, "kill-1", { content: [{ type: "text", text: "aaaaaaaa stopping 1s pid=123 stub" }] });
  await wait(15);
  const report = await completed(h, handoff);
  assert.ok(report.events.some((event) => event.kind === "tool" && event.output.includes("stopping")));
});

for (const state of ["stopped", "killed", "aborted", "exited"]) {
  test(`bg_status ${state} ${state === "exited" ? "still waits for notification" : "releases cancellation hold"}`, async (t) => {
    const h = setup(t);
    const handoff = h.runtime.handoff("status stub job");
    launch(h, "bg-1", "aaaaaaaa");
    start(h, "bg_status", "status-1", { id: "aaaaaaaa" });
    end(h, "status-1", { content: [{ type: "text", text: `aaaaaaaa ${state} 1s exit=0 stub` }] });
    settled(h);
    if (state === "exited") {
      assert.equal(queries(h).length, 0);
      notification(h, ["aaaaaaaa"]);
      await wait(15);
    }
    await completed(h, handoff);
  });
}

// G: preserve old UniPi and anonymous single-job fixtures, not blind-ID clearing.
for (const kind of ["task.id", "id", "anonymous"]) {
  test(`legacy ${kind} completion remains compatible`, async (t) => {
    const h = setup(t);
    const handoff = h.runtime.handoff("legacy");
    const details = kind === "task.id" ? { task: { id: "task-77" } } : kind === "id" ? { id: "task-77" } : undefined;
    start(h, "bg_run", "bg-1");
    end(h, "bg-1", details === undefined ? undefined : { details });
    settled(h);
    assert.equal(queries(h).length, 0);
    emit(h, { type: "message_end", message: { role: "custom", customType: "background-task-notification", details, content: "stub done" } });
    await wait(15);
    await completed(h, handoff);
  });
}

// H: a follow-up's agent_start cancels both the grace timer and any checkpoint query.
test("notification followed by a turn waits for that turn's actual final settle", async (t) => {
  const h = setup(t, { settleGraceMs: 25 });
  const handoff = h.runtime.handoff("follow-up");
  launch(h, "bg-1", "aaaaaaaa");
  settled(h);
  notification(h, ["aaaaaaaa"]);
  emit(h, { type: "agent_start" });
  await wait(40);
  assert.equal(queries(h).length, 0);
  emit(h, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  assert.equal(queries(h).length, 0);
  settled(h);
  await completed(h, handoff, "follow-up final");
});

test("agent_start invalidates an in-flight checkpoint and its timeout", async (t) => {
  const h = setup(t, { reportTimeoutMs: 25 });
  const handoff = h.runtime.handoff("checkpoint");
  launch(h, "bg-1", "aaaaaaaa");
  settled(h);
  notification(h, ["aaaaaaaa"]);
  await wait(15);
  const checkpoint = last(h, "get_last_assistant_text");
  emit(h, { type: "agent_start" });
  answer(h, checkpoint, "obsolete checkpoint");
  await wait(40);
  assert.equal(h.runtime.isBusy(), true);
  assert.equal(h.runtime.reports.size, 0);
  settled(h);
  assert.equal(queries(h).length, 2);
  await completed(h, handoff, "actual final");
});

// I: native prompt/steer can wake an idle child; correlate retries to the new brief.
test("busy idle handoff sends prompt steer, preserves the child/promise and retries only the newest brief", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("old brief");
  const initial = last(h, "prompt");
  launch(h, "bg-1", "aaaaaaaa");
  settled(h);
  let starts = 0;
  h.child.stdin.on("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as Command;
    // An idle RPC child ignores bare steer, but prompt/steer starts it.
    if (command.type === "prompt" && command.streamingBehavior === "steer") {
      starts += 1;
      emit(h, { type: "agent_start" });
    }
  });
  const second = h.runtime.handoff("new brief");
  const redirect = last(h, "prompt");
  assert.deepEqual(redirect, { id: redirect.id, type: "prompt", message: "new brief", streamingBehavior: "steer" });
  assert.notEqual(redirect.id, initial.id);
  assert.equal(starts, 1);
  assert.equal(h.spawns(), 1);
  assert.equal(second.id, first.id);
  assert.equal(second.done, first.done);
  const count = h.sent.length;
  ack(h, initial, "Agent is already processing old brief");
  assert.equal(h.sent.length, count, "superseded ACK cannot retry the old message");
  ack(h, redirect, "Agent is already processing");
  assert.deepEqual(last(h, "prompt"), { id: redirect.id, type: "prompt", message: "new brief", streamingBehavior: "followUp" });
  ack(h, redirect);
  ack(h, redirect, "late failure after successful ACK");
  assert.equal(h.runtime.isBusy(), true);
  notification(h, ["aaaaaaaa"]);
  await wait(15);
  assert.equal(queries(h).length, 0, "new turn has not settled");
  settled(h);
  await completed(h, second, "new brief final");
});

test("steer invalidates report query and timeout, ignoring all obsolete native ACK ids", async (t) => {
  const h = setup(t, { reportTimeoutMs: 25 });
  const first = h.runtime.handoff("old brief");
  const initial = last(h, "prompt");
  settled(h);
  const oldQuery = last(h, "get_last_assistant_text");
  const second = h.runtime.handoff("new brief");
  assert.equal(second.done, first.done);
  answer(h, oldQuery, "obsolete final");
  ack(h, initial, "old prompt failed");
  ack(h, { id: "unknown-request", type: "prompt" }, "unknown failure");
  ack(h, { id: 42, type: "prompt" }, "invalid native id");
  await wait(40);
  assert.equal(h.runtime.isBusy(), true, "obsolete report timeout was cleared");
  ack(h, last(h, "prompt"));
  settled(h);
  const newQuery = last(h, "get_last_assistant_text");
  assert.notEqual(newQuery.id, oldQuery.id);
  settled(h);
  assert.equal(queries(h).length, 2, "only one current query is in flight");
  answer(h, oldQuery, "late obsolete final");
  answer(h, { id: 42 }, "invalid native id");
  assert.equal(h.runtime.isBusy(), true);
  await completed(h, second, "new final");
});

test("new brief already-processing retry is limited to once", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("old brief");
  h.runtime.handoff("new brief");
  const request = last(h, "prompt");
  ack(h, request, "Agent is already processing");
  ack(h, request, "Agent is already processing again");
  const report = await first.done;
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /already processing again/);
  assert.equal(h.sent.filter((command) => command.streamingBehavior === "followUp").length, 1);
  assert.equal(h.runtime.isBusy(), false);
});

// J: even an idle child with held jobs must finish through the correlated abort ACK.
test("idle abort ACK immediately queries and finishes aborted despite held jobs", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("idle held child");
  launch(h, "bg-1", "aaaaaaaa");
  settled(h);
  await h.runtime.abort();
  const request = last(h, "abort");
  ack(h, { id: "old-abort", type: "abort" });
  assert.equal(queries(h).length, 0);
  ack(h, request);
  assert.equal(queries(h).length, 1, "ACK does not wait for another agent_settled");
  const query = last(h, "get_last_assistant_text");
  answer(h, query, "aborted stub final");
  const report = await handoff.done;
  assert.equal(report.status, "aborted");
  assert.equal(report.text, "aborted stub final");
  assert.equal(h.runtime.isBusy(), false);
  ack(h, request, "duplicate old abort failure");
  assert.equal(h.runtime.reports.size, 1);
});

test("abort waits for ACK, invalidates prior query, and rejects explicitly", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("abort rejection");
  settled(h);
  const prior = last(h, "get_last_assistant_text");
  await h.runtime.abort();
  settled(h);
  answer(h, prior, "prior checkpoint");
  assert.equal(queries(h).length, 1, "a settle before abort ACK must not query");
  ack(h, last(h, "abort"), "abort denied");
  const report = await handoff.done;
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /abort denied/);
  assert.equal(h.runtime.isBusy(), false);
});

test("old abort ACK cannot abort a newer brief on the same handoff", async (t) => {
  const h = setup(t);
  const first = h.runtime.handoff("first");
  await h.runtime.abort();
  const obsolete = last(h, "abort");
  const second = h.runtime.handoff("redirect after abort");
  ack(h, obsolete, "old abort failed");
  ack(h, obsolete);
  assert.equal(queries(h).length, 0);
  ack(h, last(h, "prompt"));
  settled(h);
  assert.equal(second.done, first.done);
  await completed(h, second);
});

// K/L: failed or missing report responses are errors, never permanent pending.
test("get_last_assistant_text rejection returns an error report", async (t) => {
  const h = setup(t);
  const handoff = h.runtime.handoff("query rejected");
  settled(h);
  ack(h, last(h, "get_last_assistant_text"), "report unavailable");
  const report = await handoff.done;
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /report unavailable/);
  assert.equal(h.runtime.isBusy(), false);
});

test("25ms report timeout releases pending; a late old query/ACK cannot finish the next handoff", async (t) => {
  const h = setup(t, { reportTimeoutMs: 25 });
  const first = h.runtime.handoff("timeout");
  const oldPrompt = last(h, "prompt");
  settled(h);
  const oldQuery = last(h, "get_last_assistant_text");
  await wait(40); // Referenced foreground timer keeps the unref'd report timeout test alive.
  const failed = await first.done;
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /final report.*25ms/);
  assert.equal(h.runtime.isBusy(), false);
  const second = h.runtime.handoff("next handoff");
  assert.notEqual(second.id, first.id);
  settled(h);
  const newQuery = last(h, "get_last_assistant_text");
  assert.notEqual(newQuery.id, oldQuery.id);
  answer(h, oldQuery, "late old text");
  ack(h, oldQuery, "late old failure");
  ack(h, oldPrompt, "late old prompt failure");
  ack(h, { type: "abort", id: "old-abort" }, "late old abort failure");
  assert.equal(h.runtime.isBusy(), true);
  const report = await completed(h, second, "next handoff final");
  answer(h, oldQuery, "even later old text");
  answer(h, newQuery, "duplicate current text");
  assert.equal(h.runtime.reports.size, 2);
  assert.equal(h.runtime.reports.get(second.id), report);
});

for (const operation of ["initial prompt", "steer", "followUp", "query", "abort"]) {
  test(`send exception during ${operation} finishes error and releases pending`, async (t) => {
    const h = setup(t, { autoAccept: operation !== "followUp" });
    const rejectWrites = () => { h.child.stdin.write = (() => { throw new Error(`stub ${operation} write failed`); }) as never; };
    if (operation === "initial prompt") rejectWrites();
    const handoff = h.runtime.handoff("first brief");
    if (operation !== "initial prompt") {
      rejectWrites();
      if (operation === "steer") h.runtime.handoff("new brief");
      else if (operation === "followUp") ack(h, last(h, "prompt"), "Agent is already processing");
      else if (operation === "query") settled(h);
      else await h.runtime.abort();
    }
    const report = await handoff.done;
    assert.equal(report.status, "error");
    assert.match(report.error ?? "", /write failed/);
    assert.equal(h.runtime.isBusy(), false);
    assert.equal(h.runtime.reports.size, 1);
  });
}

test("synchronous stub spawn failure also resolves an error report", async (t) => {
  const h = setup(t, { spawnError: "stub spawn failed" });
  const handoff = h.runtime.handoff("first brief");
  const report = await handoff.done;
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /stub spawn failed/);
  assert.equal(h.runtime.isBusy(), false);
});

for (const pendingTimer of ["settle", "report"]) {
  test(`kill clears pending ${pendingTimer} timer and returns only one error report`, async (t) => {
    const h = setup(t, { settleGraceMs: 25, reportTimeoutMs: 25 });
    const handoff = h.runtime.handoff("kill stub only");
    if (pendingTimer === "settle") launch(h, "bg-1", "aaaaaaaa");
    settled(h);
    if (pendingTimer === "settle") notification(h, ["aaaaaaaa"]);
    const queryCount = queries(h).length;
    h.runtime.kill();
    const report = await handoff.done;
    assert.equal(report.status, "error");
    await wait(40);
    assert.equal(queries(h).length, queryCount);
    assert.equal(h.runtime.reports.size, 1);
    assert.equal(h.runtime.isBusy(), false);
  });
}
