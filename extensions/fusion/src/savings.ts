import type { SidekickUsage } from "./sidekick-runtime.js";

export interface SavingsRates {
  input: number;
  cachedInput: number;
  output: number;
  /** Absent cache-write pricing uses input as a backwards-compatible estimate. */
  cacheWrite?: number;
}

export interface SavingsEstimate {
  sidekickUsd?: number;
  atLeadUsd?: number;
  savedUsd?: number;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Unknown/invalid amounts are omitted, never represented as NaN or Infinity. */
export function estimateSavings(
  usage: SidekickUsage,
  lead: SavingsRates | undefined,
  side: SavingsRates | undefined,
): SavingsEstimate {
  if (!usage || typeof usage !== "object" ||
      ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(finiteNonnegative)) return {};
  const sidekickUsd = side === undefined
    ? (finiteNonnegative(usage.cost) ? usage.cost : undefined)
    : priceUsage(usage, side);
  // Actual sidekick dollars cannot stand in for an unknown counterfactual lead rate.
  const atLeadUsd = lead === undefined ? undefined : priceUsage(usage, lead);
  const difference = sidekickUsd === undefined || atLeadUsd === undefined ? undefined : atLeadUsd - sidekickUsd;
  const savedUsd = difference !== undefined && Number.isFinite(difference) ? difference : undefined;
  return {
    ...(sidekickUsd === undefined ? {} : { sidekickUsd }),
    ...(atLeadUsd === undefined ? {} : { atLeadUsd }),
    ...(savedUsd === undefined ? {} : { savedUsd }),
  };
}

function priceUsage(usage: SidekickUsage, cost: SavingsRates): number | undefined {
  if (!cost || ![cost.input, cost.cachedInput, cost.output].every(finiteNonnegative) ||
      (cost.cacheWrite !== undefined && !finiteNonnegative(cost.cacheWrite))) return undefined;
  const amount = (
    (usage.input / 1_000_000) * cost.input +
    (usage.cacheRead / 1_000_000) * cost.cachedInput +
    (usage.cacheWrite / 1_000_000) * (cost.cacheWrite ?? cost.input) +
    (usage.output / 1_000_000) * cost.output
  );
  return finiteNonnegative(amount) ? amount : undefined;
}
