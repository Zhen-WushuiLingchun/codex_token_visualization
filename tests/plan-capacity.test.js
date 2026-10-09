const test = require("node:test");
const assert = require("node:assert/strict");
const Capacity = require("../web/plan-capacity.js");
const ForecastModel = require("../web/forecast-model.js");
const ForecastDemand = require("../web/forecast-demand.js");

const upgrade = { baselineMultiplier: 5,
  changes: [{ effectiveAt: "2026-10-04T00:00:00+08:00", multiplier: 10 }] };
const asOf = "2026-10-09T12:00:00Z";
function interval(day, tokens, percent, segmentIndex = 0, model = "gpt") {
  return { segmentIndex, startedAt: `2026-10-${day}T00:00:00Z`, endedAt: `2026-10-${day}T01:00:00Z`,
    deltaTokens: tokens, deltaPercent: percent, modelDeltas: { [model]: tokens } };
}

test("capacity timestamps use explicit timezone, including the Shanghai October 4 boundary", () => {
  const plan = Capacity.normalizePlan(upgrade);
  assert.equal(plan.changes[0].effectiveAt, "2026-10-03T16:00:00.000Z");
  assert.equal(Capacity.multiplierAt(plan, "2026-10-03T15:59:59Z"), 5);
  assert.equal(Capacity.multiplierAt(plan, "2026-10-03T16:00:00Z"), 10);
  assert.equal(Capacity.multiplierAt(plan, asOf), 10);
});

test("capacity settings reject invalid multipliers, ambiguous dates and duplicate instants", () => {
  for (const value of [0, -1, null, true, [], {}, "", " ", "Infinity", 1001]) {
    assert.throws(() => Capacity.normalizePlan({ changes: [{ effectiveAt: "2026-10-04T00:00:00Z", multiplier: value }] }));
  }
  for (const effectiveAt of ["2026-10-04", "2026-10-04T00:00", "2026-02-30T00:00:00Z", "bad", null]) {
    assert.throws(() => Capacity.normalizePlan({ changes: [{ effectiveAt, multiplier: 10 }] }));
  }
  assert.throws(() => Capacity.normalizePlan({ changes: [upgrade.changes[0],
    { effectiveAt: "2026-10-03T16:00:00Z", multiplier: 20 }] }));
  assert.throws(() => Capacity.normalizePlan({ changes: Array(101).fill(upgrade.changes[0]) }));
});

test("no configured change preserves existing regression targets and counters", () => {
  const raw = [interval("01", 1e6, 2), interval("02", 2e6, 4)];
  const result = Capacity.normalizeIntervals(raw, undefined, asOf);
  assert.equal(result.convertedCount, 0);
  assert.equal(result.excludedCount, 0);
  assert.equal(ForecastModel.fitSegmentedQuota(result.intervals).model.slope,
    ForecastModel.fitSegmentedQuota(raw).model.slope);
  assert.deepEqual(Capacity.normalizePlan(), { baselineMultiplier: 1, changes: [] });
});

test("5x historical slopes transfer to 10x without waiting for fresh quota consumption", () => {
  const raw = [interval("01", 1e6, 10), interval("02", 2e6, 20), interval("03", 3e6, 30)];
  const original = structuredClone(raw);
  const result = Capacity.normalizeIntervals(raw, upgrade, asOf);
  assert.equal(result.convertedCount, 3);
  assert.equal(result.intervals.length, 3);
  assert.equal(ForecastModel.fitSegmentedQuota(result.intervals).model.slope,
    ForecastModel.fitSegmentedQuota(raw).model.slope / 2);
  assert.equal(ForecastModel.assessModelCalibration(result.intervals,
    [{ totalTokens: 1e6, models: { gpt: { totalTokens: 1e6 } } }], { active: false }).ready, true);
  assert.deepEqual(raw, original);
  assert.deepEqual(result.intervals.map(x => x.deltaTokens), raw.map(x => x.deltaTokens));
});

test("old and new capacity intervals describe one common slope, without double scaling", () => {
  const raw = [interval("01", 1e6, 10), interval("02", 2e6, 20),
    interval("04", 1e6, 5, 1), interval("05", 3e6, 15, 1)];
  const result = Capacity.normalizeIntervals(raw, upgrade, asOf);
  const fit = ForecastModel.fitSegmentedQuota(result.intervals);
  assert.equal(result.convertedCount, 2);
  assert.ok(Math.abs(fit.model.slope - 5e-6) < 1e-12);
  assert.equal(fit.model.rSquared, 1);
  assert.deepEqual(Capacity.normalizeIntervals(result.intervals, upgrade, asOf).intervals, result.intervals);
});

test("intervals crossing a capacity change are excluded rather than prorated or treated as refunds", () => {
  const raw = [{ ...interval("03", 1e6, 10), endedAt: "2026-10-04T01:00:00Z" },
    interval("05", 1e6, 5)];
  const result = Capacity.normalizeIntervals(raw, upgrade, asOf);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.intervals.length, 1);
  assert.equal(result.intervals[0].deltaPercent, 5);
  const plan = Capacity.normalizePlan(upgrade);
  assert.equal(Capacity.crossesChange(plan, "2026-10-03T15:00:00Z", "2026-10-03T16:00:00Z"), true);
  assert.equal(Capacity.crossesChange(plan, "2026-10-03T16:00:00Z", "2026-10-03T17:00:00Z"), false);
});

test("multiple changes, same-day changes, downgrades and scheduled changes use their actual eras", () => {
  const plan = Capacity.normalizePlan({ baselineMultiplier: 5, changes: [
    { effectiveAt: "2026-10-10T00:00:00Z", multiplier: 20 },
    { effectiveAt: "2026-10-04T12:00:00Z", multiplier: 5 },
    { effectiveAt: "2026-10-04T00:00:00Z", multiplier: 10 },
  ] });
  assert.equal(Capacity.multiplierAt(plan, asOf), 5);
  assert.equal(Capacity.multiplierAt(plan, "2026-10-04T06:00:00Z"), 10);
  assert.equal(Capacity.crossesChange(plan, "2026-10-03T23:00:00Z", "2026-10-04T13:00:00Z"), true);
  const result = Capacity.normalizeIntervals([interval("01", 1e6, 10), interval("04", 1e6, 5),
    interval("05", 1e6, 10)], plan, asOf);
  assert.deepEqual(result.intervals.map(x => x.deltaPercent), [10, 10, 10]);
  assert.equal(result.targetMultiplier, 5);
  assert.equal(result.convertedCount, 1);
});

test("capacity transfer also preserves per-model relative cost calibration", () => {
  const raw = [...[1, 2, 3, 4].map(i => interval("02", i * 1e6, i * 10, i, "cheap")),
    ...[1, 2, 3, 4].map(i => interval("05", i * 1e6, i * 10, i + 4, "expensive"))];
  const normalized = Capacity.normalizeIntervals(raw, upgrade, asOf).intervals;
  const slope = ForecastModel.fitSegmentedQuota(normalized).model.slope;
  const fit = ForecastModel.fitModelWeightsFromIntervals(normalized, slope);
  assert.equal(fit.active, true);
  assert.ok(Math.abs(fit.weightMap.expensive / fit.weightMap.cheap - 2) < 0.05);
});

test("undated, reversed and future intervals are not silently assigned to an era", () => {
  const raw = [{ ...interval("01", 1e6, 10), startedAt: null },
    { ...interval("02", 1e6, 10), endedAt: "invalid" },
    { ...interval("02", 1e6, 10), startedAt: "2026-10-03T00:00:00Z" },
    interval("10", 1e6, 10), interval("05", 1e6, 5)];
  const result = Capacity.normalizeIntervals(raw, upgrade, asOf);
  assert.equal(result.excludedCount, 4);
  assert.equal(result.intervals.length, 1);
});

test("capacity eras preserve raw balances and separate a same-day return to the old multiplier", () => {
  const plan = { baselineMultiplier: 5, changes: [
    { effectiveAt: "2026-10-04T00:00:00Z", multiplier: 10 },
    { effectiveAt: "2026-10-04T12:00:00Z", multiplier: 5 },
  ] };
  const points = ["2026-10-03T23:00:00Z", "2026-10-04T06:00:00Z", "2026-10-04T13:00:00Z"]
    .map(fetchedAt => ({ fetchedAt, segment: 1, usedPercent: 100, totalTokens: 1e6 }));
  const before = structuredClone(points);
  const result = Capacity.observationEras(points, plan);
  assert.deepEqual(result.map(x => x.capacityEra), [0, 1, 2]);
  assert.equal(new Set(result.map(x => x.segment)).size, 3);
  assert.deepEqual(result.map(x => x.usedPercent), [100, 100, 100]);
  assert.deepEqual(points, before);
  assert.equal(Capacity.observationEras(points), points);
});

test("new capacity traffic cannot invalidate evidence of exhaustion in the old capacity era", () => {
  const changes = { baselineMultiplier: 5, changes: [{ effectiveAt: "2026-10-04T04:30:00Z", multiplier: 10 }] };
  const now = Date.parse("2026-10-04T05:00:00Z");
  const points = ["2026-10-04T03:00:00Z", "2026-10-04T04:00:00Z", "2026-10-04T05:00:00Z"]
    .map((fetchedAt, index) => ({ fetchedAt, usageFetchedAt: fetchedAt, segment: 1,
      usedPercent: 100, totalTokens: index < 2 ? 1e6 : 2e6,
      windowName: "weekly", resetAt: "2026-10-11T00:00:00Z" }));
  const input = { now, usageFetchedAt: new Date(now).toISOString(), windowName: "weekly",
    days: [{ date: "2026-10-04", totalTokens: 2e6 }],
    currentUsage: { fetchedAt: new Date(now).toISOString(), totalTokens: 2e6 } };
  const raw = ForecastDemand.estimate({ ...input, observations: points });
  const separated = ForecastDemand.estimate({ ...input, observations: Capacity.observationEras(points, changes) });
  assert.equal(raw.demand.nonBindingCycles, 1);
  assert.equal(separated.demand.nonBindingCycles, 0);
  assert.ok(separated.demand.removedHours >= 1);
});
