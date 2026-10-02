import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundJobTracker, MAX_RECENT_BACKGROUND_IDS } from "../src/background-jobs.js";

const result = (id: string, state = "running") => ({ content: [{ type: "text", text: `${id} ${state} 0s pid=123 stub` }] });
const notify = (tracker: BackgroundJobTracker, id: string) => tracker.onNotification({ customType: "background-command-result", details: { jobs: [{ id }] } });
const launch = (tracker: BackgroundJobTracker, callId: string, id: string) => {
  tracker.onToolStart("bg_run", callId, {});
  tracker.onToolEnd("bg_run", callId, result(id), false);
};

test("completed call IDs are reusable even while the previous job is still pending", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "reused", "aaaaaaaa");
  launch(tracker, "reused", "bbbbbbbb");
  assert.equal(tracker.pendingCount, 2);
  notify(tracker, "aaaaaaaa");
  assert.equal(tracker.pendingCount, 1);
  notify(tracker, "bbbbbbbb");
  launch(tracker, "reused", "cccccccc");
  assert.equal(tracker.pendingCount, 1);
  notify(tracker, "cccccccc");
  assert.equal(tracker.pendingCount, 0);
});

test("reused bg_run IDs do not misdispatch bash/bg_status/bg_kill tool ends", () => {
  const tracker = new BackgroundJobTracker();
  launch(tracker, "same", "aaaaaaaa");
  tracker.onToolStart("bash", "same", {});
  tracker.onToolEnd("bash", "same", result("bbbbbbbb"), false);
  assert.equal(tracker.pendingCount, 1);
  tracker.onToolStart("bg_status", "same", { id: "aaaaaaaa" });
  tracker.onToolEnd("bash", "same", result("aaaaaaaa", "stopped"), false);
  assert.equal(tracker.pendingCount, 1, "mismatched named end cannot dispatch active status");
  tracker.onToolEnd("bg_status", "same", result("aaaaaaaa", "stopped"), false);
  assert.equal(tracker.pendingCount, 0);
  launch(tracker, "same", "cccccccc");
  tracker.onToolStart("bg_kill", "same", { id: "cccccccc" });
  tracker.onToolEnd("", "same", { content: "cancellation accepted" }, false);
  assert.equal(tracker.pendingCount, 0);
});

for (const state of ["stopped", "killed", "aborted", "canceled", "cancelled"]) {
  test(`bg_run returned ${state} releases its hold, structured or text`, () => {
    for (const snapshot of [result("aaaaaaaa", state), { details: { task: { id: "aaaaaaaa", status: state } } }, { details: { id: "aaaaaaaa", state } }]) {
      const tracker = new BackgroundJobTracker();
      tracker.onToolStart("bg_run", "call", {});
      tracker.onToolEnd("bg_run", "call", snapshot, false);
      assert.equal(tracker.pendingCount, 0);
    }
  });
}

for (const state of ["running", "stopping", "exited", "failed"]) {
  test(`normal bg_run ${state} still owes its completion notification`, () => {
    const tracker = new BackgroundJobTracker();
    tracker.onToolStart("bg_run", "call", {});
    tracker.onToolEnd("bg_run", "call", result("aaaaaaaa", state), false);
    assert.equal(tracker.pendingCount, 1);
    notify(tracker, "aaaaaaaa");
    assert.equal(tracker.pendingCount, 0);
  });
}

test("early-notification overflow fails explicitly instead of silently losing binding evidence", () => {
  const tracker = new BackgroundJobTracker();
  tracker.onToolStart("bg_run", "pending", {});
  for (let i = 0; i < MAX_RECENT_BACKGROUND_IDS; i++) notify(tracker, `early-${i}`);
  assert.throws(() => notify(tracker, "overflow"), /early-notification cache exceeded 300/);
  tracker.onToolEnd("", "pending", { details: { id: "early-0" } }, false);
  assert.equal(tracker.pendingCount, 0, "oldest early evidence was retained");
});

test("completed launch/active-call state and unrelated IDs are bounded, retaining early-notify behavior", () => {
  const tracker = new BackgroundJobTracker();
  for (let i = 0; i < 1000; i++) {
    const id = i.toString(16).padStart(8, "0");
    launch(tracker, "reuse", id);
    notify(tracker, id);
    notify(tracker, `unrelated-${i}`);
  }
  const state = tracker as unknown as { launches: Set<unknown>; activeCalls: Map<string, unknown>; releasedJobs: Set<string> };
  assert.equal(state.launches.size, 0);
  assert.equal(state.activeCalls.size, 0);
  assert.ok(state.releasedJobs.size <= MAX_RECENT_BACKGROUND_IDS);
  tracker.onToolStart("bg_run", "early", {});
  notify(tracker, "aaaaaaaa");
  tracker.onToolEnd("", "early", result("aaaaaaaa"), false);
  assert.equal(tracker.pendingCount, 0);
});
