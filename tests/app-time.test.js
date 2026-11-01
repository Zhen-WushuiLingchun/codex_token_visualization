const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const Time = require("../web/app-time.js");

test("Beijing date boundaries and datetime inputs are explicit and validated", () => {
  assert.equal(Time.dateKey("2026-11-01T15:59:59Z"), "2026-11-01");
  assert.equal(Time.dateKey("2026-11-01T16:00:00Z"), "2026-11-02");
  assert.equal(Time.input("2026-10-30T04:01:19Z"), "2026-10-30T12:01:19");
  assert.equal(Time.parseInput("2026-10-30T12:01:19"), "2026-10-30T04:01:19.000Z");
  assert.equal(Time.parseInput("2026-10-30T12:01"), "2026-10-30T04:01:00.000Z");
  assert.throws(() => Time.parseInput("2026-02-30T12:00"));
  assert.throws(() => Time.parseInput("bad"));
  assert.equal(Time.dayStart("2026-11-02") - Time.dayStart("2026-11-01"), 86400000);
  assert.equal(Time.shiftDay("2026-11-01", 1), "2026-11-02");
  assert.equal(Time.dateKey("October 07, 2026"), "2026-10-07");
});

test("exported day keys and forecast rates remain identical under multiple host timezones", () => {
  const script = `
    const Time = require('./web/app-time.js');
    const Demand = require('./web/forecast-demand.js');
    (async () => {
      const {aggregateKimiUsageRecords} = await import('./scripts/sync-account-quotas.mjs');
      const {mergeUsageSnapshotHistory} = await import('./scripts/usage-storage.mjs');
      const now=Date.parse('2026-11-01T16:00:00Z');
      const usage=aggregateKimiUsageRecords([now,'2026-11-02T00:00:00'].map(time=>({type:'usage.record',usageScope:'turn',time,model:'test',usage:{input_tokens:10,output_tokens:2}})));
      const merged=mergeUsageSnapshotHistory([], {daily:[{date:'2026-11-01T23:00:00Z',totalTokens:12}]});
      const rate=Demand.estimate({days:[{date:'2026-10-31',totalTokens:24e6},{date:'2026-11-01',totalTokens:24e6}],now});
      console.log(JSON.stringify({day:Time.dateKey(now),input:Time.input(now),parsed:Time.parseInput('2026-11-02T00:00'),
        formatted:Time.format(now),usage:usage.daily,zone:usage.timezone,legacy:Time.dateKey('October 07, 2026'),merged:merged.daily,rate:rate.weightedRate,hours:rate.demand.availableHours}));
    })().catch(e=>{console.error(e);process.exitCode=1});`;
  let baseline;
  for (const TZ of ["Asia/Shanghai", "UTC", "America/New_York", "Pacific/Honolulu", "Pacific/Auckland"]) {
    const result = spawnSync(process.execPath, ["--no-warnings", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.day, "2026-11-02");
    assert.equal(actual.merged[0].date, "2026-11-02");
    assert.equal(actual.usage[0].date, "2026-11-02");
    assert.equal(actual.usage[0].totalTokens, 24);
    assert.equal(actual.zone, "Asia/Shanghai");
    assert.equal(actual.legacy, "2026-10-07");
    baseline ||= actual;
    assert.deepEqual(actual, baseline, TZ);
  }
});
