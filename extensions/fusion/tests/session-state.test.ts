import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionState, createWorkScope, FUSION_SESSION_STATE, FUSION_WORK_SCOPE, readSessionSelection, readWorkScope } from "../src/session-state.js";

const pair = { kind: "fusion" as const, lead: "test/lead", sidekick: "test/side", leadEffort: "high" as const, sidekickEffort: "low" as const };
const manager = (id: string, branch: unknown[]) => ({ getSessionId: () => id, getBranch: () => branch });
const entry = (sessionId: string, selection: unknown = pair, schema = 1) => ({
  type: "custom", customType: FUSION_SESSION_STATE, data: { schema, sessionId, selection },
});

test("empty/missing session state cannot authorize Fusion", () => {
  assert.equal(readSessionSelection(undefined), undefined);
  assert.equal(readSessionSelection(manager("A", [])), undefined);
  assert.equal(readSessionSelection(manager("", [entry("")])), undefined);
  assert.equal(readSessionSelection({ getSessionId: () => "A" }), undefined);
  assert.equal(readSessionSelection({ getSessionId() { throw new Error("disposed"); } }), undefined);
  assert.equal(readSessionSelection({ getSessionId: () => "A", getBranch() { throw new Error("disposed"); } }), undefined);
});

test("only an exact current-session custom entry authorizes its pair", () => {
  assert.deepEqual(readSessionSelection(manager("A", [entry("A")])), pair);
  const data = createSessionState(manager("A", []), pair);
  assert.deepEqual(data, { schema: 1, sessionId: "A", selection: pair });
  assert.equal(readSessionSelection(manager("A", [{ type: "message", customType: FUSION_SESSION_STATE, data }])), undefined);
  assert.equal(readSessionSelection(manager("A", [{ type: "custom", customType: "other-plugin", data }])), undefined);
});

test("new/forked/cloned sessions do not inherit the parent's authorization", () => {
  const parent = [entry("A")];
  assert.deepEqual(readSessionSelection(manager("A", parent)), pair);
  for (const id of ["B", "fork-of-A", "clone-of-A"]) assert.equal(readSessionSelection(manager(id, parent)), undefined);
});

test("latest off marker wins over an older enabled marker", () => {
  const off = { kind: "single", model: "test/lead" };
  assert.deepEqual(readSessionSelection(manager("A", [entry("A"), entry("A", off)])), off);
});

test("latest malformed current-session marker fails closed, never revives old on", () => {
  for (const malformed of [null, {}, { kind: "fusion", lead: "", sidekick: "test/side" }, { ...pair, leadEffort: "invalid" }]) {
    assert.equal(readSessionSelection(manager("A", [entry("A"), entry("A", malformed)])), undefined);
  }
  assert.equal(readSessionSelection(manager("A", [entry("A"), entry("A", pair, 2)])), undefined);
  for (const data of [undefined, {}, { schema: 1, selection: pair }, { schema: 1, sessionId: "", selection: pair }]) {
    assert.equal(readSessionSelection(manager("A", [entry("A"), { type: "custom", customType: FUSION_SESSION_STATE, data }])), undefined);
  }
});

test("foreign markers never change the current session's selection", () => {
  assert.deepEqual(readSessionSelection(manager("A", [entry("A"), entry("B", { kind: "single", model: "other/model" })])), pair);
});

test("native model switch after the marker revokes authorization even if switched back", () => {
  const same = { type: "model_change", provider: "test", modelId: "lead" };
  const other = { type: "model_change", provider: "test", modelId: "other" };
  assert.deepEqual(readSessionSelection(manager("A", [entry("A"), same])), pair);
  assert.equal(readSessionSelection(manager("A", [entry("A"), other])), undefined);
  assert.equal(readSessionSelection(manager("A", [entry("A"), other, same])), undefined);
  assert.deepEqual(readSessionSelection(manager("A", [entry("A"), other, same, entry("A")])), pair);
});

test("tree work-scope boundaries revoke old consent and isolate child history", () => {
  const m = manager("A", []);
  const scope = createWorkScope(m);
  const boundary = { type: "custom", customType: FUSION_WORK_SCOPE, data: scope };
  assert.equal(readSessionSelection(manager("A", [entry("A"), boundary])), undefined);
  assert.equal(readWorkScope(manager("A", [entry("A"), boundary])), scope.scopeId);
  assert.deepEqual(readSessionSelection(manager("A", [entry("A"), boundary, entry("A")])), pair);
  assert.equal(readWorkScope(manager("B", [boundary])), undefined);
  assert.equal(readSessionSelection(manager("A", [entry("A"), { ...boundary, data: {} }])), undefined);
});

test("confirmation requires a real session storage API before changing model/tools", () => {
  assert.throws(() => createSessionState(undefined, pair), /valid current session/);
  assert.throws(() => createSessionState({ getSessionId: () => "A" }, pair), /valid current session/);
  assert.throws(() => createSessionState(manager("A", []), { ...pair, lead: "" }), /valid current session/);
});
