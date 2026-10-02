/**
 * Background job holds (BackgroundJobTracker).
 *
 * The runtime used to count one release per notification, so the local
 * `background-command-result` batch — and every job id it names — left a
 * permanent residue that pinned the handoff open for 45 minutes. These tests
 * pin the id-keyed behaviour: batch, dedupe, per-job binding, notification
 * races, and the cancellation paths that have no completion to wait for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundJobTracker } from "../src/background-jobs.js";

const run = (id: string, state = "running") => `${id} ${state} 0s pid=4711 npm test`;

function launchResult(id: string, state = "running"): unknown {
  return { content: [{ type: "text", text: `${run(id, state)}\ncommand: npm test\ncwd: /tmp` }], details: undefined, isError: false };
}

function launch(tracker: BackgroundJobTracker, callId: string, args?: Record<string, unknown>): void {
  tracker.onToolStart("bg_run", callId, args ?? { command: "npm test" });
}

function finish(tracker: BackgroundJobTracker, callId: string, result?: unknown, isError = false): void {
  tracker.onToolEnd("bg_run", callId, result, isError);
}

const commandResult = (id: string) => ({
  customType: "background-command-result",
  content: `Background command result (1).`,
  details: { jobs: [{ id, command: "npm test", state: "exited", exitCode: 0, signal: null, durationMs: 1000 }] },
});

test("every job releases its own hold when its own result arrives", () => {
  const tracker = new BackgroundJobTracker();
  const ids = ["ddabca17", "37d3581e", "8603993f", "fa80e8bd"];
  ids.forEach((id, index) => {
    launch(tracker, `bg-${index}`);
    finish(tracker, `bg-${index}`, launchResult(id));
  });
  assert.equal(tracker.pendingCount, 4);

  for (const id of ids) {
    assert.equal(tracker.onNotification(commandResult(id)), true);
  }
  assert.equal(tracker.pendingCount, 0, "four results for four jobs leave no residue");
});

test("one batch releases every job it names", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  launch(tracker, "bg-2");
  finish(tracker, "bg-2", launchResult("bbbbbbbb"));
  assert.equal(tracker.pendingCount, 2);

  const released = tracker.onNotification({
    customType: "background-command-result",
    details: { jobs: [{ id: "aaaaaaaa", state: "exited" }, { id: "bbbbbbbb", state: "failed" }] },
  });

  assert.equal(released, true);
  assert.equal(tracker.pendingCount, 0);
});

test("a repeated notification and an unrelated job change nothing", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  launch(tracker, "bg-2");
  finish(tracker, "bg-2", launchResult("bbbbbbbb"));

  assert.equal(tracker.onNotification(commandResult("aaaaaaaa")), true);
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.onNotification(commandResult("aaaaaaaa")), false, "duplicate delivery releases nothing");
  assert.equal(tracker.onNotification(commandResult("cccccccc")), false, "an unknown job id is never a neighbour's hold");
  assert.equal(tracker.pendingCount, 1, "the other job keeps holding the handoff");
  assert.equal(tracker.onNotification(commandResult("bbbbbbbb")), true);
  assert.equal(tracker.pendingCount, 0);
});

test("a notification that beats tool_execution_end still frees the launch", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.onNotification(commandResult("aaaaaaaa")), false, "nothing is bound yet");
  assert.equal(tracker.pendingCount, 1);

  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  assert.equal(tracker.pendingCount, 0, "the id binds to an already-delivered job");
});

test("a failed bg_run releases its hold immediately", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  assert.equal(tracker.pendingCount, 1);
  finish(tracker, "bg-1", { content: [{ type: "text", text: "spawn ENOENT" }], isError: true }, true);
  assert.equal(tracker.pendingCount, 0);
});

test("a successful bg_kill stops the hold although no completion is coming", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));

  tracker.onToolStart("bg_kill", "kill-1", { id: "aaaaaaaa" });
  tracker.onToolEnd("bg_kill", "kill-1", { content: [{ type: "text", text: "aaaaaaaa stopping 1s pid=4711 npm test" }] }, false);
  assert.equal(tracker.pendingCount, 0, "cancellation is accepted, so no completion notification is awaited");
});

test("a failed bg_kill keeps the hold", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  tracker.onToolStart("bg_kill", "kill-1", { id: "aaaaaaaa" });
  tracker.onToolEnd("bg_kill", "kill-1", { content: [{ type: "text", text: "Unknown background job: aaaaaaaa" }] }, true);
  assert.equal(tracker.pendingCount, 1);
});

test("bg_status releases a confirmed stop but keeps waiting for a normal exit", () => {
  const stopped = new BackgroundJobTracker();
  launch(stopped, "bg-1");
  finish(stopped, "bg-1", launchResult("aaaaaaaa"));
  stopped.onToolStart("bg_status", "st-1", { id: "aaaaaaaa" });
  stopped.onToolEnd("bg_status", "st-1", { content: [{ type: "text", text: "aaaaaaaa stopped 3s exit=0 npm test" }] }, false);
  assert.equal(stopped.pendingCount, 0);

  const exited = new BackgroundJobTracker();
  launch(exited, "bg-1");
  finish(exited, "bg-1", launchResult("bbbbbbbb"));
  exited.onToolStart("bg_status", "st-1", { id: "bbbbbbbb" });
  exited.onToolEnd("bg_status", "st-1", { content: [{ type: "text", text: "bbbbbbbb exited 3s exit=0 npm test" }] }, false);
  assert.equal(exited.pendingCount, 1, "an exited job still owes its automatic notification");
});

test("the legacy UniPi protocol stays compatible", () => {
  const task = new BackgroundJobTracker();
  task.onToolStart("bg_run", "bg-1", { command: "x" });
  task.onToolEnd("bg_run", "bg-1", { content: [{ type: "text", text: "started" }], details: { task: { id: "task-77" } } }, false);
  assert.equal(task.pendingCount, 1);
  assert.equal(task.onNotification({ customType: "background-task-notification", details: { id: "task-77" } }), true);
  assert.equal(task.pendingCount, 0);

  const legacy = new BackgroundJobTracker();
  legacy.onToolStart("bg_run", "bg-1", { command: "x" });
  legacy.onToolEnd("bg_run", "bg-1", undefined, false);
  assert.equal(legacy.pendingCount, 1);
  assert.equal(legacy.onNotification({ customType: "background-task-notification", content: "done" }), true);
  assert.equal(legacy.pendingCount, 0, "the id-less single-job fixture still resolves");
});

test("an id-less notification never releases a job we can already name", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  assert.equal(tracker.onNotification({ customType: "background-task-notification" }), false);
  assert.equal(tracker.pendingCount, 1);
});

test("the job id is parsed from the full tool output, not the truncated tail", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  const noise = "x".repeat(9000);
  finish(tracker, "bg-1", { content: [{ type: "text", text: `${run("aaaaaaaa")}\n${noise}` }] });
  assert.equal(tracker.onNotification(commandResult("aaaaaaaa")), true);
  assert.equal(tracker.pendingCount, 0);
});

test("notifyOnCompletion:false and triggerOnCompletion:false never hold", () => {
  const notify = new BackgroundJobTracker();
  notify.onToolStart("bg_run", "bg-1", { command: "x", notifyOnCompletion: false });
  notify.onToolEnd("bg_run", "bg-1", launchResult("aaaaaaaa"), false);
  assert.equal(notify.pendingCount, 0);

  const trigger = new BackgroundJobTracker();
  trigger.onToolStart("bg_run", "bg-1", { command: "x", triggerOnCompletion: false });
  trigger.onToolEnd("bg_run", "bg-1", launchResult("aaaaaaaa"), false);
  assert.equal(trigger.pendingCount, 0);
});

for (const key of ["notifyOnCompletion", "triggerOnCompletion"] as const) {
  test(`producer task snapshot ${key}:false releases an implicit hold`, () => {
    const tracker = new BackgroundJobTracker();
    launch(tracker, "bg-1");
    assert.equal(tracker.pendingCount, 1);
    finish(tracker, "bg-1", { details: { task: { id: "task-77", [key]: false } } });
    assert.equal(tracker.pendingCount, 0);
    assert.equal(tracker.onNotification({ customType: "background-task-notification", details: { id: "task-77" } }), false);
  });
}

test("unrelated custom messages are ignored", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  assert.equal(tracker.onNotification({ customType: "sidekick-completion", details: { jobs: [{ id: "aaaaaaaa" }] } }), false);
  assert.equal(tracker.onNotification({}), false);
  assert.equal(tracker.pendingCount, 1);
});

for (const key of ["id", "jobId", "taskId", "task"] as const) {
  test(`legacy launch and notification details.${key} correlate by id`, () => {
    const tracker = new BackgroundJobTracker();
    const details = key === "task" ? { task: { id: "task-77" } } : { [key]: "task-77" };
    launch(tracker, "bg-1");
    finish(tracker, "bg-1", { details });
    assert.equal(tracker.onNotification({ customType: "background-task-notification", details }), true);
    assert.equal(tracker.pendingCount, 0);
    assert.equal(tracker.onNotification({ customType: "background-task-notification", details }), false);
  });
}

test("an explicit unrelated legacy id cannot clear an unbound launch", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", undefined);
  assert.equal(tracker.onNotification({ customType: "background-task-notification", details: { id: "other" } }), false);
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.onNotification({ customType: "background-task-notification" }), true);
});

test("anonymous legacy notifications do not guess between multiple launches", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  launch(tracker, "bg-2");
  assert.equal(tracker.onNotification({ customType: "background-task-notification" }), false);
  assert.equal(tracker.pendingCount, 2);
});

test("a malformed local result is not an anonymous legacy completion", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  for (const details of [undefined, { jobs: [] }, { jobs: [{ state: "exited" }] }]) {
    assert.equal(tracker.onNotification({ customType: "background-command-result", details }), false);
    assert.equal(tracker.pendingCount, 1);
  }
});

test("result.isError also releases a failed launch and preserves a failed cancellation", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "failed-run");
  finish(tracker, "failed-run", { isError: true }, false);
  assert.equal(tracker.pendingCount, 0);
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  tracker.onToolStart("bg_kill", "kill-1", { taskId: "aaaaaaaa" });
  tracker.onToolEnd("bg_kill", "kill-1", { isError: true }, false);
  assert.equal(tracker.pendingCount, 1);
});

test("cancellation by taskId can precede launch id binding", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  tracker.onToolStart("bg_kill", "kill-1", { taskId: "task-77" });
  tracker.onToolEnd("", "kill-1", { content: "cancellation accepted" }, false);
  assert.equal(tracker.pendingCount, 1);
  tracker.onToolEnd("", "bg-1", { details: { task: { id: "task-77" } } }, false);
  assert.equal(tracker.pendingCount, 0);
});

for (const state of ["stopped", "killed", "aborted"]) {
  test(`bg_status confirms ${state} from text or structured details`, () => {
    for (const result of [
      { content: [{ type: "text", text: run("aaaaaaaa", state) }] },
      { details: { task: { id: "aaaaaaaa", status: state } } },
      { details: { jobs: [{ id: "aaaaaaaa", state }] } },
    ]) {
      const tracker = new BackgroundJobTracker();
      launch(tracker, "bg-1");
      finish(tracker, "bg-1", launchResult("aaaaaaaa"));
      tracker.onToolStart("bg_status", "status-1", { id: "aaaaaaaa" });
      tracker.onToolEnd("", "status-1", result, false);
      assert.equal(tracker.pendingCount, 0);
    }
  });
}

test("bg_status cannot release the requested job when a different id was stopped", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  tracker.onToolStart("bg_status", "status-1", { id: "aaaaaaaa" });
  tracker.onToolEnd("bg_status", "status-1", { details: { id: "bbbbbbbb", state: "stopped" } }, false);
  assert.equal(tracker.pendingCount, 1);
});

test("bg_status listing releases only confirmed stops, not normal exits", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  launch(tracker, "bg-2");
  finish(tracker, "bg-2", launchResult("bbbbbbbb"));
  tracker.onToolStart("bg_status", "status-1", {});
  tracker.onToolEnd("", "status-1", { content: `${run("aaaaaaaa", "stopped")}\n${run("bbbbbbbb", "exited")}` }, false);
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.onNotification(commandResult("bbbbbbbb")), true);
});

test("duplicate tool starts do not multiply the hold", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "bg-1");
  launch(tracker, "bg-1");
  assert.equal(tracker.pendingCount, 1);
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  assert.equal(tracker.onNotification(commandResult("aaaaaaaa")), true);
  finish(tracker, "bg-1", launchResult("aaaaaaaa"));
  assert.equal(tracker.pendingCount, 0, "late tool ends never revive released launches");
});