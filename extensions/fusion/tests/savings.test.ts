import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSavings } from "../src/savings.js";

test("manual price overrides make savings non-zero", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 100_000, cacheWrite: 50_000, cost: 0 };
  const lead = { input: 10, cachedInput: 0.25, output: 50 };
  const side = { input: 0.2, cachedInput: 0.02, output: 1.2 };
  assert.deepEqual(estimateSavings(usage, lead, side), {
    sidekickUsd: 1.412,
    atLeadUsd: 60.525,
    savedUsd: 59.113,
  });
});

const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4 };
const rates = { input: 1, cachedInput: 0.1, output: 2 };

test("unknown lead rates never reuse sidekick actual cost", () => {
  assert.deepEqual(estimateSavings(usage, undefined, rates), { sidekickUsd: 1 });
  assert.deepEqual(estimateSavings(usage, undefined, undefined), { sidekickUsd: 4 });
  assert.deepEqual(estimateSavings(usage, { ...rates, input: 10 }, undefined), { sidekickUsd: 4, atLeadUsd: 10, savedUsd: 6 });
});

test("only absent side rates fall back to finite nonnegative actual cost", () => {
  for (const cost of [NaN, Infinity, -Infinity, -1]) {
    assert.deepEqual(estimateSavings({ ...usage, cost }, undefined, undefined), {});
  }
  assert.deepEqual(estimateSavings({ ...usage, cost: 0 }, undefined, undefined), { sidekickUsd: 0 });
  assert.deepEqual(estimateSavings(usage, undefined, { ...rates, input: NaN }), {});
});

test("invalid token usage fails unknown, including when actual cost is known", () => {
  assert.deepEqual(estimateSavings(null as any, rates, rates), {});
  assert.deepEqual(estimateSavings(undefined as any, rates, rates), {});
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      assert.deepEqual(estimateSavings({ ...usage, [field]: value }, rates, undefined), {});
    }
  }
});

test("invalid rate fields fail unknown without poisoning the other side", () => {
  for (const field of ["input", "cachedInput", "output", "cacheWrite"] as const) {
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      const bad = { ...rates, [field]: value };
      assert.deepEqual(estimateSavings(usage, bad, rates), { sidekickUsd: 1 });
      assert.deepEqual(estimateSavings(usage, rates, bad), { atLeadUsd: 1 });
    }
  }
});

test("explicit all-zero manual pricing is known free and savings may be negative", () => {
  const free = { input: 0, cachedInput: 0, output: 0, cacheWrite: 0 };
  assert.deepEqual(estimateSavings(usage, free, free), { sidekickUsd: 0, atLeadUsd: 0, savedUsd: 0 });
  assert.deepEqual(estimateSavings(usage, free, rates), { sidekickUsd: 1, atLeadUsd: 0, savedUsd: -1 });
});

test("cache-write uses its independent rate or a documented input-rate estimate", () => {
  const cached = { ...usage, input: 0, cacheWrite: 1_000_000, cost: 1.25 };
  assert.deepEqual(estimateSavings(cached, { ...rates, cacheWrite: 2 }, { ...rates, cacheWrite: 1.25 }),
    { sidekickUsd: 1.25, atLeadUsd: 2, savedUsd: 0.75 });
  assert.deepEqual(estimateSavings(cached, rates, rates), { sidekickUsd: 1, atLeadUsd: 1, savedUsd: 0 });
});

test("scale before multiplication; genuine overflow is unknown not NaN/Infinity", () => {
  const huge = { input: 1e308, cachedInput: 0, output: 0 };
  assert.deepEqual(estimateSavings(usage, huge, huge), { sidekickUsd: 1e308, atLeadUsd: 1e308, savedUsd: 0 });
  assert.deepEqual(estimateSavings({ ...usage, input: 1e308 }, huge, huge), {});
  assert.deepEqual(estimateSavings({ ...usage, output: 1_000_000 }, { ...huge, output: 1e308 }, rates),
    { sidekickUsd: 3 });
});
