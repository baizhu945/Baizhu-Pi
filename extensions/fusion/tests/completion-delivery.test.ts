import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompletionDelivery } from "../src/tools.js";
import type { HandoffReport } from "../src/sidekick-runtime.js";

const report: HandoffReport = {
  id: "h1", status: "completed", text: "done", toolCalls: 0, durationMs: 1, events: [],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
};
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function deferred() {
  let resolve!: (report: HandoffReport) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<HandoffReport>((res, rej) => { resolve = res; reject = rej; });
  return { done, resolve, reject };
}

test("block:false does not release a different live wait token", async () => {
  const d = deferred(), sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  const token = delivery.attach(report.id);
  delivery.detach(report.id, d.done);
  d.resolve(report);
  await flush();
  assert.equal(sent.length, 0);
  delivery.consume(report.id);
  delivery.detach(report.id, d.done, token);
  await flush();
  assert.equal(sent.length, 0);
});

test("detach → attach → resolve → final detach re-evaluates cached completion", async () => {
  const d = deferred(), sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  delivery.detach(report.id, d.done);
  const token = delivery.attach(report.id);
  d.resolve(report);
  await flush();
  assert.equal(sent.length, 0);
  delivery.detach(report.id, d.done, token);
  await flush();
  assert.deepEqual(sent, [report]);
  delivery.detach(report.id, d.done, token);
  await flush();
  assert.equal(sent.length, 1);
});

test("two waiters own independent tokens and only the last detach sends", async () => {
  const d = deferred(), sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  const first = delivery.attach(report.id), second = delivery.attach(report.id);
  delivery.detach(report.id, d.done, first);
  d.resolve(report);
  await flush();
  assert.equal(sent.length, 0);
  delivery.detach(report.id, d.done, first);
  await flush();
  assert.equal(sent.length, 0, "releasing an old token cannot decrement another wait");
  delivery.detach(report.id, d.done, second);
  await flush();
  assert.equal(sent.length, 1);
});

test("one inline consume suppresses delivery without releasing another waiter's token", async () => {
  const sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  const first = delivery.attach(report.id), second = delivery.attach(report.id);
  const done = Promise.resolve(report);
  delivery.observe(report.id, done);
  await flush();
  delivery.consume(report.id);
  delivery.detach(report.id, done, first);
  delivery.detach(report.id, done, second);
  await flush();
  assert.equal(sent.length, 0);
});

test("re-detaching subscribes to done exactly once", async () => {
  const d = deferred();
  let subscriptions = 0;
  const then = d.done.then.bind(d.done);
  d.done.then = ((...args: any[]) => { subscriptions++; return then(...args); }) as any;
  const sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  delivery.detach(report.id, d.done);
  delivery.detach(report.id, d.done);
  delivery.observe(report.id, d.done);
  d.resolve(report);
  await flush();
  assert.equal(subscriptions, 1);
  assert.equal(sent.length, 1);
});

test("a resolved report still sends once; synchronous inline consume wins the microtask", async () => {
  const sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => { sent.push(report); });
  const done = Promise.resolve(report);
  await flush();
  delivery.detach(report.id, done);
  await flush();
  assert.equal(sent.length, 1);
  const consumed = { ...report, id: "consumed" };
  delivery.detach(consumed.id, Promise.resolve(consumed));
  delivery.consume(consumed.id);
  await flush();
  assert.equal(sent.length, 1);
});

test("sync sender failure is diagnostic, not permanently delivered or automatically retried", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const delivery = createCompletionDelivery(() => {
    attempts++;
    if (attempts === 1) throw new Error("send failed");
  }, { onDiagnostic: (_id, error) => { errors.push(error); } });
  const done = Promise.resolve(report);
  delivery.detach(report.id, done);
  await flush();
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ["send failed"]);
  await flush();
  assert.equal(attempts, 1, "no infinite automatic retry");
  delivery.detach(report.id, done);
  await flush();
  assert.equal(attempts, 2);
  delivery.detach(report.id, done);
  await flush();
  assert.equal(attempts, 2);
});

test("done.reject notifies once after the last waiter leaves", async () => {
  const d = deferred(), failures: string[] = [];
  const delivery = createCompletionDelivery(() => { assert.fail("not a report"); }, {
    onFailure: (id, error) => { failures.push(`${id}: ${error}`); },
  });
  const token = delivery.attach(report.id);
  delivery.observe(report.id, d.done);
  d.reject(new Error("rpc failed"));
  await flush();
  assert.deepEqual(failures, []);
  delivery.detach(report.id, d.done, token);
  await flush();
  assert.deepEqual(failures, ["h1: rpc failed"]);
  delivery.detach(report.id, d.done);
  await flush();
  assert.equal(failures.length, 1);
});
