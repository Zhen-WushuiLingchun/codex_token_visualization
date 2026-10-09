const test = require("node:test");
const assert = require("node:assert/strict");

test("quota history keeps one latest snapshot per local day", async () => {
  const { mergeQuotaSnapshotHistory } = await import("../scripts/sync-account-quotas.mjs");
  const history = [
    { fetchedAt: "2026-08-04T02:00:00.000Z", marker: "day-one" },
    { fetchedAt: "2026-08-05T01:00:00.000Z", marker: "older-same-day" },
    { fetchedAt: "2026-08-05T08:00:00.000Z", marker: "newer-same-day" },
  ];
  const current = { fetchedAt: "2026-08-06T03:00:00.000Z", marker: "current" };

  const merged = mergeQuotaSnapshotHistory(history, current, {
    now: new Date("2026-08-06T12:00:00+08:00"),
  });

  assert.deepEqual(merged.map((entry) => entry.marker), ["day-one", "newer-same-day", "current"]);
});

test("usage history replaces the current day without double-counting lifetime totals", async () => {
  const { mergeUsageSnapshotHistory } = await import("../scripts/usage-storage.mjs");
  const prior = {
    rangeDays: 2,
    daily: [
      { date: "2026-08-05", inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      { date: "August 06, 2026", inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    ],
    totals: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  };
  const current = {
    rangeDays: 2,
    daily: [
      { date: "2026-08-06", inputTokens: 60, outputTokens: 15, totalTokens: 75 },
      { date: "2026-08-07", inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    ],
    totals: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
  };

  const merged = mergeUsageSnapshotHistory([prior], current);

  assert.equal(merged.daily.length, 3);
  assert.equal(merged.daily[1].totalTokens, 75);
  assert.deepEqual(merged.totals, { inputTokens: 160, outputTokens: 40, totalTokens: 200 });
  assert.equal(merged.rangeDays, 3);
});

test("usage history accepts aggregate period dates", async () => {
  const { mergeUsageSnapshotHistory } = await import("../scripts/usage-storage.mjs");
  const merged = mergeUsageSnapshotHistory([], {
    daily: [{ period: "2026-08-06", totalTokens: 25 }],
    totals: { totalTokens: 25 },
  });

  assert.equal(merged.daily.length, 1);
  assert.equal(merged.daily[0].period, "2026-08-06");
  assert.equal(merged.totals.totalTokens, 25);
});

test("timezone changes rebuild dates without adding overlapping history or discarding the old ledger", async () => {
  const { mergeUsageSnapshotHistory } = await import("../scripts/usage-storage.mjs");
  const old = { timezone: "Asia/Tokyo", daily: [{ date: "2026-10-08", totalTokens: 100 }], totals: { totalTokens: 100 } };
  const current = { timezone: "Asia/Shanghai", daily: [
    { date: "October 07, 2026", totalTokens: 20 }, { date: "2026-10-08", totalTokens: 80 },
  ], totals: { totalTokens: 100 }, rangeDays: 2 };
  const before = JSON.stringify(old);
  const merged = mergeUsageSnapshotHistory([old], current);
  assert.deepEqual(merged.daily.map(day => [day.date, day.totalTokens]), [["2026-10-07", 20], ["2026-10-08", 80]]);
  assert.equal(merged.totals.totalTokens, 100);
  assert.deepEqual(merged.timezoneHistory, [old]);
  assert.equal(JSON.stringify(old), before);
  const refreshed = mergeUsageSnapshotHistory([old, merged], current);
  assert.deepEqual(refreshed, merged);
  const next = mergeUsageSnapshotHistory([merged], { ...current,
    daily: [{ date: "2026-10-08", totalTokens: 90 }], totals: { totalTokens: 90 } });
  assert.equal(next.totals.totalTokens, 110);
  assert.equal(next.daily[0].totalTokens, 20);
  assert.deepEqual(next.timezoneHistory, [old]);
});

test("explicit legacy timezone migrates unlabelled storage and retains the old ledger in the same file", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { writeConsolidatedUsageSnapshot } = await import("../scripts/usage-storage.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-timezone-"));
  try {
    const output = path.join(root, "codex-usage.json");
    fs.writeFileSync(output, JSON.stringify({ daily: [{ date: "2026-10-08", totalTokens: 100 }], totals: { totalTokens: 100 } }));
    const incoming = { timezone: "Asia/Shanghai", daily: [{ date: "2026-10-07", totalTokens: 90 }], totals: { totalTokens: 90 } };
    const merged = writeConsolidatedUsageSnapshot({ output, prefix: "codex-usage", roots: [root], incoming, legacyTimezone: "Asia/Tokyo" });
    assert.equal(merged.totals.totalTokens, 90);
    assert.equal(merged.daily.length, 1);
    assert.equal(merged.timezoneHistory[0].totals.totalTokens, 100);
    assert.deepEqual(fs.readdirSync(root), ["codex-usage.json"]);
    assert.deepEqual(writeConsolidatedUsageSnapshot({ output, prefix: "codex-usage", roots: [root], incoming }), merged);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("optional Codex account RPC failure retains dated cached stats without replacing fresh quota or other providers", async () => {
  const { retainCodexAccountUsage } = await import("../scripts/sync-account-quotas.mjs");
  const accountUsage = { fetchedAt: "2026-10-07T01:00:00Z", summary: { lifetimeTokens: 123 }, daily: [{ date: "2026-10-06", tokens: 123 }] };
  const previous = { source: "codex", fetchedAt: "2026-10-07T01:00:00Z", accountUsage };
  const freshQuota = { source: "codex", fetchedAt: "2026-10-08T01:00:00Z", windows: [{ usedPercent: 30 }] };
  const retained = retainCodexAccountUsage(freshQuota, [previous]);
  assert.deepEqual(retained.windows, freshQuota.windows);
  assert.equal(retained.fetchedAt, freshQuota.fetchedAt);
  assert.equal(retained.accountUsage.fetchedAt, accountUsage.fetchedAt);
  assert.equal(retained.accountUsage.stale, true);
  assert.equal(previous.accountUsage.stale, undefined);
  assert.equal(freshQuota.accountUsage, undefined);
  const fresh = { ...freshQuota, accountUsage: { ...accountUsage, fetchedAt: freshQuota.fetchedAt } };
  assert.equal(retainCodexAccountUsage(fresh, [previous]), fresh);
  const claude = { ...freshQuota, source: "claude" };
  assert.equal(retainCodexAccountUsage(claude, [previous]), claude);
  assert.equal(retainCodexAccountUsage(freshQuota, []), freshQuota);
});

test("quota history removes entries outside the rolling retention window", async () => {
  const { mergeQuotaSnapshotHistory } = await import("../scripts/sync-account-quotas.mjs");
  const merged = mergeQuotaSnapshotHistory(
    [
      { fetchedAt: "2026-03-01T04:00:00.000Z", marker: "expired" },
      { fetchedAt: "2026-07-01T04:00:00.000Z", marker: "retained" },
    ],
    null,
    { now: new Date("2026-08-06T12:00:00+08:00"), retentionDays: 120 },
  );

  assert.deepEqual(merged.map((entry) => entry.marker), ["retained"]);
});

test("observation consolidation deduplicates exact points and preserves reset boundaries", async () => {
  const { mergeObservationHistory } = await import("../scripts/sync-account-quotas.mjs");
  const first = {
    fetchedAt: "2026-08-05T01:00:00.000Z",
    windowName: "weekly",
    segment: 1,
    usedPercent: 70,
    totalTokens: 700,
    resetAt: "2026-08-07T00:00:00.000Z",
  };
  const beforeReset = { ...first, fetchedAt: "2026-08-05T02:00:00.000Z", usedPercent: 80, totalTokens: 800 };
  const reset = {
    ...first,
    fetchedAt: "2026-08-05T03:00:00.000Z",
    segment: 2,
    usedPercent: 5,
    totalTokens: 850,
    resetAt: "2026-08-14T00:00:00.000Z",
    resetDetected: true,
  };

  const merged = mergeObservationHistory([first, beforeReset, reset], [reset], {
    now: new Date("2026-08-06T12:00:00+08:00"),
    maxEntries: 3,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].usedPercent, 80);
  assert.equal(merged[2].segment, 2);
  assert.equal(merged[2].resetDetected, true);
});
