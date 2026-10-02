import { test } from "node:test";
import assert from "node:assert/strict";
import { setHerdrWorking } from "../src/vendor/core/utils.js";
import { getSharedFusionStatus, setSharedFusionStatus } from "../src/vendor/core/fusion-status.js";

function bus() {
  const calls: unknown[][] = [];
  const events = { emit: (...args: unknown[]) => { calls.push(args); } };
  return { calls, events };
}
const status = { leadName: "lead", leadEffort: "high", sidekickName: "side", sidekickEffort: "low" };

test("herdr same keys are isolated by event-bus identity", () => {
  const a = bus();
  const b = bus();
  setHerdrWorking(a, "same", "handoff");
  setHerdrWorking(b, "same", "handoff");
  setHerdrWorking(b, "same", null);
  setHerdrWorking(a, "same", null);
  const expected = [
    ["herdr:working", { active: true, label: "handoff" }],
    ["herdr:working", { active: false, label: "handoff" }],
  ];
  assert.deepEqual(a.calls, expected);
  assert.deepEqual(b.calls, expected);
});

test("herdr retains idempotence, key independence and shared-bus wrapper identity", () => {
  const a = bus();
  setHerdrWorking(a, "one", null);
  setHerdrWorking(a, "one", "first");
  setHerdrWorking({ events: a.events }, "one", "first");
  setHerdrWorking(a, "two", "independent");
  setHerdrWorking(a, "one", "second");
  setHerdrWorking(a, "one", null);
  setHerdrWorking(a, "one", null);
  setHerdrWorking(a, "two", null);
  assert.deepEqual(a.calls, [
    ["herdr:working", { active: true, label: "first" }],
    ["herdr:working", { active: true, label: "independent" }],
    ["herdr:working", { active: false, label: "first" }],
    ["herdr:working", { active: true, label: "second" }],
    ["herdr:working", { active: false, label: "second" }],
    ["herdr:working", { active: false, label: "independent" }],
  ]);
});

test("status publication and getter return detached frozen snapshots", () => {
  const owner = Symbol("snapshot-owner");
  const input = { ...status, savedUsd: 1 };
  try {
    setSharedFusionStatus(input, owner);
    input.leadName = "external mutation";
    const first = getSharedFusionStatus()!;
    const second = getSharedFusionStatus()!;
    assert.notEqual(first, second);
    assert.equal(first.leadName, "lead");
    assert.equal(Object.isFrozen(first), true);
    assert.throws(() => { (first as { leadName: string }).leadName = "bad"; }, TypeError);
    assert.equal(getSharedFusionStatus()!.leadName, "lead");
  } finally { setSharedFusionStatus(undefined, owner); }
});

test("old or unowned cleanup cannot clear a newer owned status", () => {
  const oldOwner = Symbol("old-owner");
  const newOwner = Symbol("new-owner");
  try {
    setSharedFusionStatus({ ...status, leadName: "old" }, oldOwner);
    setSharedFusionStatus({ ...status, leadName: "new" }, newOwner);
    setSharedFusionStatus(undefined, oldOwner);
    setSharedFusionStatus(undefined);
    assert.equal(getSharedFusionStatus()!.leadName, "new");
    setSharedFusionStatus(undefined, newOwner);
    assert.equal(getSharedFusionStatus(), undefined);
  } finally { setSharedFusionStatus(undefined, newOwner); }
});

test("legacy unowned status API still publishes and clears", () => {
  setSharedFusionStatus({ ...status });
  assert.deepEqual(getSharedFusionStatus(), status);
  setSharedFusionStatus(undefined, Symbol("unrelated"));
  assert.deepEqual(getSharedFusionStatus(), status);
  setSharedFusionStatus(undefined);
  assert.equal(getSharedFusionStatus(), undefined);
});
