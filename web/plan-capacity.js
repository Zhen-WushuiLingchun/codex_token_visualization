(function attachPlanCapacity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlanCapacity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPlanCapacity() {
  "use strict";

  function multiplier(value) {
    if (!["number", "string"].includes(typeof value) || String(value).trim() === "") throw new Error("容量倍数必须在 0.01 到 1000 之间");
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0.01 || number > 1000) throw new Error("容量倍数必须在 0.01 到 1000 之间");
    return number;
  }

  function normalizePlan(value) {
    if (value === undefined || value === null) return { baselineMultiplier: 1, changes: [] };
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("套餐容量配置格式无效");
    const baselineMultiplier = multiplier(value.baselineMultiplier ?? 1);
    const entries = value.changes ?? [];
    if (!Array.isArray(entries) || entries.length > 100) throw new Error("容量变更记录最多 100 条");
    const changes = entries.map((entry) => {
      const effectiveAt = entry?.effectiveAt;
      if (typeof effectiveAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(effectiveAt)
        || !Number.isFinite(Date.parse(effectiveAt))) throw new Error("生效时间必须包含有效日期、时间和时区");
      const day = effectiveAt.slice(0, 10);
      if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error("生效日期无效");
      return { effectiveAt: new Date(effectiveAt).toISOString(), multiplier: multiplier(entry.multiplier) };
    }).sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
    if (changes.some((entry, index) => index > 0 && entry.effectiveAt === changes[index - 1].effectiveAt)) {
      throw new Error("同一生效时间不能登记两次容量变更");
    }
    return { baselineMultiplier, changes };
  }

  function multiplierAt(plan, at) {
    const time = new Date(at).getTime();
    let result = plan.baselineMultiplier;
    for (const entry of plan.changes) {
      if (Date.parse(entry.effectiveAt) > time) break;
      result = entry.multiplier;
    }
    return result;
  }

  function crossesChange(plan, startedAt, endedAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    let previous = plan.baselineMultiplier;
    return plan.changes.some((entry) => {
      const changed = entry.multiplier !== previous;
      previous = entry.multiplier;
      const time = Date.parse(entry.effectiveAt);
      return changed && time > start && time <= end;
    });
  }

  function observationEras(points, planValue) {
    const plan = normalizePlan(planValue);
    if (!plan.changes.length) return points;
    return (points || []).map((point) => {
      const time = Date.parse(point.fetchedAt);
      if (!Number.isFinite(time)) return point;
      let era = 0;
      let previous = plan.baselineMultiplier;
      for (const entry of plan.changes) {
        if (Date.parse(entry.effectiveAt) > time) break;
        if (entry.multiplier !== previous) era += 1;
        previous = entry.multiplier;
      }
      return { ...point, capacityEra: era, segment: `capacity:${era}:segment:${point.segment ?? "unknown"}` };
    });
  }

  // Only the regression target is rescaled. Official balances and Token counters stay raw.
  function normalizeIntervals(intervals, planValue, asOf = new Date().toISOString()) {
    const plan = normalizePlan(planValue);
    const reference = new Date(asOf).getTime();
    if (!Number.isFinite(reference)) throw new Error("预测参考时间无效");
    const targetMultiplier = multiplierAt(plan, reference);
    let excludedCount = 0;
    const normalized = [];
    for (const interval of intervals || []) {
      const start = new Date(interval.startedAt).getTime();
      const end = new Date(interval.endedAt).getTime();
      if (plan.changes.length && (!interval.startedAt || !interval.endedAt || !Number.isFinite(start)
        || !Number.isFinite(end) || end <= start || end > reference || crossesChange(plan, start, end))) {
        excludedCount += 1;
        continue;
      }
      const sourceMultiplier = multiplierAt(plan, start);
      const rawDeltaPercent = Number(interval.rawDeltaPercent ?? interval.deltaPercent);
      normalized.push({ ...interval, rawDeltaPercent, sourceMultiplier, targetMultiplier,
        deltaPercent: rawDeltaPercent * sourceMultiplier / targetMultiplier });
    }
    return { intervals: normalized, targetMultiplier, excludedCount,
      convertedCount: normalized.filter((entry) => entry.sourceMultiplier !== targetMultiplier).length };
  }

  return { normalizePlan, multiplierAt, crossesChange, observationEras, normalizeIntervals };
});
