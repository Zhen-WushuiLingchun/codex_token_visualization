const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze, captureCostDays, trendSeries } = require("../web/quota-value.js");

const day = (date, tokens, costUSD, model = "sol", fallback = false) => ({
  date, totalTokens: tokens, costUSD, models: { [model]: { totalTokens: tokens, isFallback: fallback } },
});
const quota = (fetchedAt, usedPercent, totalTokens, options = {}) => ({
  windowName: "weekly", windowDurationMins: 10080, segment: 1,
  resetAt: "2026-11-08T08:00:00Z", fetchedAt, usageFetchedAt: fetchedAt,
  usedPercent, totalTokens, models: { sol: totalTokens }, ...options,
});
const pair = (point, daily) => ({ ...point, apiCostDays: captureCostDays(daily, point.usageFetchedAt) });
const now = Date.parse("2026-11-06T00:00:00Z");

test("pairs only spend after the anchor and weights by covered percentage across Beijing midnight", () => {
  const first = day("2026-11-02", 100, 30);
  const more = day("2026-11-02", 140, 50);
  const next = day("2026-11-03", 60, 40);
  const observations = [
    pair(quota("2026-11-02T14:00:00Z", 10, 100), [first]),
    pair(quota("2026-11-02T15:00:00Z", 10, 120), [day(first.date, 120, 40)]),
    pair(quota("2026-11-02T15:30:00Z", 15, 140), [more]),
    pair(quota("2026-11-02T16:15:00Z", 30, 200), [more, next]),
  ];
  const { current, spend } = analyze({ daily: [more, next], observations, now });
  assert.equal(current.intervalCount, 2);
  assert.equal(current.percent, 20);
  assert.equal(current.usd, 60);
  assert.equal(current.weeklyUsd, 300);
  assert.equal(current.monthlyUsd, 300 * 30 / 7);
  assert.equal(spend.usd, 90);
});

test("rejects saturated, stale, reset-crossing, and mixed raw/paired intervals", () => {
  const daily = [day("2026-11-02", 600, 60)];
  const observations = [
    quota("2026-11-02T00:00:00Z", 5, 0),
    quota("2026-11-02T01:00:00Z", 15, 100),
    quota("2026-11-02T02:00:00Z", 100, 200),
    quota("2026-11-02T03:00:00Z", 25, 300, { segment: 2, resetDetected: true }),
    quota("2026-11-02T04:00:00Z", 26, 310, { segment: 2, usageFetchedAt: "2026-11-02T03:59:00Z" }),
    quota("2026-11-02T04:30:00Z", 40, 450, { segment: 2, usageFetchedAt: "2026-11-02T04:00:00Z" }),
    pair(quota("2026-11-02T05:00:00Z", 55, 600, { segment: 2 }), daily),
  ];
  const result = analyze({ daily, observations, now });
  assert.equal(result.current.paired, true);
  assert.equal(result.current.intervalCount, 0);
  assert.equal(result.rows.length, 1);
});

test("does not substitute historical cost for paired samples after a ledger revision", () => {
  const daily = [day("2026-11-02", 1000, 100)];
  const observations = [
    pair(quota("2026-11-02T00:00:00Z", 10, 100), [day("2026-11-02", 100, 10)]),
    pair(quota("2026-11-02T01:00:00Z", 30, 220), [day("2026-11-02", 200, 20)]),
    pair(quota("2026-11-02T02:00:00Z", 50, 350), [day("2026-11-02", 300, 30)]),
  ];
  const { current } = analyze({ daily, observations, now });
  assert.equal(current.weeklyUsd, null);
  assert.equal(current.intervalCount, 0);
});

test("keeps calendar spend gross and only matches quota spend when exempt review can be priced", () => {
  const input = day("2026-11-02", 100, 20);
  input.models.sol.totalTokens = 80;
  input.models.review = { totalTokens: 20, usageRole: "auto-review", planQuotaExempt: true };
  assert.deepEqual(captureCostDays([input], now), [{ date: input.date, tokens: 80, usd: null, fallbackTokens: 0 }]);
  input.models.review.costUSD = 3;
  assert.equal(captureCostDays([input], now)[0].usd, 17);
  assert.equal(analyze({ daily: [input], now }).spend.usd, 20);
});

test("backfills separately and compares only consecutive completed comparable windows", () => {
  const firstDay = day("2026-11-02", 200, 20);
  let secondDay = day("2026-11-09", 200, 30);
  const points = (date, resetAt, segment, offset, model = "sol") => [0, 100, 200].map((tokens, index) =>
    quota(`${date}T0${index}:00:00Z`, index * 10, offset + tokens, { resetAt, segment, models: { [model]: offset + tokens } }));
  const first = points(firstDay.date, "2026-11-08T08:00:00Z", 1, 0);
  const second = points(secondDay.date, "2026-11-15T08:00:00Z", 2, 200);
  const analyzeWeeks = (options) => analyze({
    daily: [firstDay, secondDay], observations: [...first, ...second], now: Date.parse("2026-11-18T00:00:00Z"), ...options,
  }).rows;
  const rows = analyzeWeeks();
  assert.deepEqual(rows.map((row) => [row.weeklyUsd, row.change, row.paired]), [[150, 50, false], [100, null, false]]);
  assert.equal(analyzeWeeks({ capacityPlan: { changes: [{ effectiveAt: "2026-11-08T00:00:00Z", multiplier: 2 }] } })[0].change, null);
  assert.equal(analyzeWeeks({ observations: [...first, ...points(secondDay.date, second[0].resetAt, 2, 200, "other")] })[0].change, null);
  assert.equal(analyzeWeeks({ observations: [...first, ...second.map((point) => ({ ...point, modelScoped: true }))] }).length, 1);
  secondDay = day(secondDay.date, 200, 30, "sol", true);
  assert.equal(analyzeWeeks()[0].change, null);
});

test("trend uses sample dates and separates capacity eras, missing weeks and price methods", () => {
  const date = (day) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T00:00:00+08:00`);
  const make = (day, options = {}) => ({ lastAt: date(day), reset: date(day) + 86_400_000,
    weeklyUsd: 150, monthlyUsd: 150 * 30 / 7, paired: false, windowName: "weekly", ...options });
  const rows = [make(1), make(8), make(10), make(15), make(16, { paired: true }),
    make(17, { weeklyUsd: null }), make(19, { paired: true }), make(29, { paired: true })];
  const series = trendSeries([...rows].reverse(), { baselineMultiplier: 5,
    changes: [{ effectiveAt: "2026-11-09T12:00:00+08:00", multiplier: 10 },
      { effectiveAt: "2026-11-10T00:00:00+08:00", multiplier: 5 }] });
  assert.deepEqual(series.eras.map((era) => era.multiplier), [5, 10, 5]);
  assert.equal(series.eras[1].end, date(10));
  assert.deepEqual(series.groups.map((group) => group.map((row) => rows.indexOf(row))), [[0, 1], [2, 3], [4], [6], [7]]);
  assert.equal(trendSeries([{ ...make(29), weeklyUsd: null }]), null);

  const noEarlyEstimate = trendSeries([make(20), make(27)], { baselineMultiplier: 5,
    changes: [{ effectiveAt: "2026-11-15T00:00:00+08:00", multiplier: 10 }] }, date(1));
  assert.deepEqual(noEarlyEstimate.eras.map((era) => [era.start, era.multiplier]), [[date(8), 5], [date(15), 10]]);
  assert.equal(noEarlyEstimate.groups.flat().length, 2);
});
