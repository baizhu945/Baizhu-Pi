import { test } from "node:test";
import assert from "node:assert/strict";
import { blendedPrice, renderSlider, sliderPosition } from "../src/slider.js";

test("slider positions use a clamped logarithmic scale", () => {
  assert.equal(sliderPosition(1, 1, 100, 9), 0);
  assert.equal(sliderPosition(100, 1, 100, 9), 8);
  assert.equal(sliderPosition(10, 1, 100, 9), 4);
  assert.equal(sliderPosition(10, 10, 10, 9), 0);
});

test("blended price averages input and output", () => {
  assert.equal(blendedPrice({ input: 10, output: 50 }), 30);
  assert.equal(blendedPrice(undefined), undefined);
});

test("renderSlider emits the requested visible cells and marker", () => {
  const rendered = renderSlider(10, 3);
  assert.equal(rendered.replace(/\x1b\[[0-9;]*m/gu, "").length, 10);
  assert.equal((rendered.match(/●/gu) ?? []).length, 1);
  assert.match(rendered, /^\x1b\[/u);
  assert.ok(rendered.endsWith("\x1b[39m"));
});

test("non-finite/negative prices and invalid ranges stay unknown", () => {
  for (const price of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(blendedPrice({ input: price, output: 1 }), undefined);
    assert.equal(blendedPrice({ input: 1, output: price }), undefined);
    assert.equal(sliderPosition(price, 1, 10, 9), undefined);
    assert.equal(sliderPosition(1, price, 10, 9), undefined);
    assert.equal(sliderPosition(1, 0, price, 9), undefined);
  }
  assert.equal(sliderPosition(1, 10, 1, 9), undefined);
  assert.equal(sliderPosition(0, 0, 0, 9), 0);
  assert.equal(sliderPosition(1, 0, 10, 9), 8);
});

test("blended price avoids both MAX overflow and equal subnormal underflow", () => {
  assert.equal(blendedPrice({ input: Number.MAX_VALUE, output: Number.MAX_VALUE }), Number.MAX_VALUE);
  assert.equal(blendedPrice({ input: 0, output: Number.MAX_VALUE }), Number.MAX_VALUE / 2);
  assert.equal(blendedPrice({ input: Number.MIN_VALUE, output: Number.MIN_VALUE }), Number.MIN_VALUE);
  assert.equal(sliderPosition(Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_VALUE, 9), 8);
  const min = 1e308;
  const price = min * (1 + Number.EPSILON);
  const max = min * (1 + 2 * Number.EPSILON);
  assert(min < price && price < max);
  const position = sliderPosition(price, min, max, 9);
  assert(position !== undefined && Number.isInteger(position) && position >= 0 && position <= 8);
});

test("slider cell budgets are finite positive integers and out-of-range markers stay absent", () => {
  for (const cells of [NaN, Infinity, -Infinity, 0, -1, 1.9]) {
    assert.equal(renderSlider(cells, undefined).replace(/\x1b\[[0-9;]*m/gu, "").length, 1);
    assert.equal(sliderPosition(5, 1, 10, cells), 0);
  }
  assert.equal(renderSlider(3.9, 2).replace(/\x1b\[[0-9;]*m/gu, "").length, 3);
  for (const marker of [NaN, Infinity, -1, 1.5, 3]) {
    assert.doesNotMatch(renderSlider(3, marker), /●/u);
  }
});
