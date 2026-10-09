const test = require("node:test");
const assert = require("node:assert/strict");
const { select, level, accountSeries } = require("../web/trend-data.js");
test("trend presets select calendar days rather than the last populated records", () => {
  const days = [{ date: "2026-01-01", totalTokens: 90 }, { date: "2026-09-22", totalTokens: 10 }];
  const result = select(days, { range: "30" }, "2026-09-22");
  assert.equal(result.rows.length, 30);
  assert.equal(result.start, "2026-08-24");
  assert.equal(result.total, 10);
  assert.equal(result.recordedDays, 1);
});
test("all and custom preserve history, zero records and missing days distinctly", () => {
  const days = [{ date: "2024-02-28", totalTokens: 0 }, { date: "2024-03-01", totalTokens: 8 },
    { date: "2024-03-01", totalTokens: 2 }];
  const all = select(days, { range: "all" }, "2024-03-01");
  assert.deepEqual(all.rows.map(row => row.totalTokens), [0, null, 10]);
  assert.equal(all.offset, 2);
  const custom = select(days, { range: "custom", start: "2024-02-29", end: "2024-03-01" }, "2024-03-01");
  assert.equal(custom.total, 10);
  assert.equal(custom.rows.length, 2);
});
test("invalid and reversed dates fail without changing data", () => {
  for (const [start, end] of [["2026-02-30", "2026-03-02"], ["", ""], ["2026-09-23", "2026-09-22"]]) {
    assert.ok(select([], { range: "custom", start, end }, "2026-09-22").error);
  }
});
test("heat levels have a documented linear scale and handle empty records", () => {
  assert.deepEqual([null, 0, 1, 25, 26, 50, 51, 75, 76, 100].map(n => level(n, 100)),
    ["missing", "0", "1", "1", "2", "2", "3", "3", "4", "4"]);
  assert.equal(select([], { range: "365" }, "2026-09-22").rows.length, 365);
});

test("official account buckets are independent, validated and never invent model or cost data", () => {
  const account = { daily: [
    { date: "2026-10-07", tokens: 1051970288, privateId: "do-not-copy" },
    { date: "2026-10-06", tokens: 0 },
    { date: "2026-10-07", tokens: 1051970288 },
    { date: "2026-02-30", tokens: 50 },
    { date: "2026-10-08", tokens: null },
    { date: "2026-10-09", tokens: -2 },
  ] };
  const before = JSON.stringify(account);
  const days = accountSeries(account);
  assert.deepEqual(days, [{ date: "2026-10-06", totalTokens: 0 }, { date: "2026-10-07", totalTokens: 1051970288 }]);
  assert.equal(JSON.stringify(account), before);
  const range = select(days, { range: "custom", start: "2026-10-06", end: "2026-10-08" }, "2026-10-08");
  assert.deepEqual(range.rows.map(row => row.totalTokens), [0, 1051970288, null]);
  assert.deepEqual(accountSeries(null), []);
});
