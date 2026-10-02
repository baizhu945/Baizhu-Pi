import { normalizeWidth } from "./vendor/core/tui-width.js";

export interface SliderCost {
  input: number;
  output: number;
}

export function validPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0;
}

export function blendedPrice(cost: SliderCost | undefined): number | undefined {
  if (cost === undefined || !validPrice(cost.input) || !validPrice(cost.output)) return undefined;
  // Non-negative inputs make the difference finite, even at Number.MAX_VALUE.
  const low = Math.min(cost.input, cost.output);
  return low + (Math.max(cost.input, cost.output) - low) * 0.5;
}

export function sliderPosition(price: number, min: number, max: number, cells: number): number | undefined {
  if (!validPrice(price) || !validPrice(min) || !validPrice(max) || max < min) return undefined;
  const count = normalizeWidth(cells);
  if (count <= 1 || max === min) return 0;
  if (price <= min) return 0;
  if (price >= max) return count - 1;
  const value = Math.log10(Math.max(price, Number.MIN_VALUE));
  const low = Math.log10(Math.max(min, Number.MIN_VALUE));
  const high = Math.log10(Math.max(max, Number.MIN_VALUE));
  // Adjacent large finite prices can have identical rounded logarithms.
  const fraction = high > low ? (value - low) / (high - low) : (price - min) / (max - min);
  return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1))));
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function renderSlider(cells: number, markerIndex: number | undefined): string {
  const count = normalizeWidth(cells);
  let out = "";
  for (let i = 0; i < count; i++) {
    if (i === markerIndex) out += "\x1b[97m●";
    else {
      const [r, g, b] = hsvToRgb(count <= 1 ? 0 : (270 * i) / (count - 1), 0.85, 0.95);
      out += `\x1b[38;2;${String(r)};${String(g)};${String(b)}m━`;
    }
  }
  return `${out}\x1b[39m`;
}
