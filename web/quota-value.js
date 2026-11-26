(function (root, factory) {
  const common = typeof module === "object" && module.exports;
  const api = factory(common ? require("./app-time.js") : root.AppTime,
    common ? require("./forecast-model.js") : root.ForecastModel,
    common ? require("./plan-capacity.js") : root.PlanCapacity);
  if (common) module.exports = api;
  else root.QuotaValue = api;
})(globalThis, function (time, forecast, capacities) {
  "use strict";

  const WEEK_MINUTES = 7 * 24 * 60;
  const MIN_INTERVALS = 2;
  const MIN_COVERAGE = 10;
  const MAX_PAIR_SKEW = 10 * 60_000;
  const RESET_JITTER = 5 * 60_000;
  const USD_EPSILON = 0.000001;
  const LOCAL_BASIS = "local-token-v1";

  function nonnegative(value) {
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function dollars(day) {
    return nonnegative(day?.costUSD ?? day?.totalCost ?? day?.cost);
  }

  function dayDate(day) {
    const value = String(day?.date ?? day?.period ?? "");
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : time.dateKey(value);
  }

  function breakdown(day) {
    return day.models && !Array.isArray(day.models) ? Object.values(day.models) : day.modelBreakdowns || [];
  }

  function priceDay(day) {
    const date = dayDate(day);
    const eligible = forecast.quotaUsageDay(day);
    const tokens = nonnegative(eligible.totalTokens);
    if (!Number.isFinite(time.dayStart(date)) || tokens === null) return null;
    const exemptCosts = breakdown(day).filter((row) => row.usageRole === "auto-review" && row.planQuotaExempt === true)
      .map(dollars);
    const gross = dollars(day);
    const net = gross === null || exemptCosts.includes(null) ? null : gross - exemptCosts.reduce((sum, usd) => sum + usd, 0);
    const fallbackTokens = Math.min(tokens, breakdown(eligible).reduce((sum, row) => sum
      + (row.isFallback === true ? nonnegative(row.totalTokens) ?? tokens : 0), 0));
    return { date, tokens, usd: tokens === 0 ? 0 : net > 0 ? net : null, fallbackTokens };
  }

  function priceDays(daily) {
    return new Map((daily || []).map(priceDay).filter(Boolean).map((row) => [row.date, row]));
  }

  function captureCostDays(daily, at) {
    const end = time.dateKey(at);
    const start = time.shiftDay(end, -7);
    return [...priceDays(daily).values()].filter(({ date }) => date >= start && date <= end);
  }

  function calendarSpend(daily, now) {
    const today = time.dateKey(now);
    const month = today.slice(0, 7);
    const records = new Map((daily || []).map((day) => [dayDate(day), day]));
    let usd = 0;
    let pricedDays = 0;
    let unpricedDays = 0;
    let fallback = false;
    for (const [date, day] of records) {
      if (!date.startsWith(month) || date > today) continue;
      const cost = dollars(day);
      if (cost === null || (cost === 0 && Number(day.totalTokens) > 0)) {
        unpricedDays++;
      } else {
        usd += cost;
        pricedDays++;
        fallback ||= breakdown(day).some((row) => row.isFallback === true);
      }
    }
    return { month, usd: pricedDays ? usd : null, pricedDays, unpricedDays, fallback };
  }

  function sample(point) {
    const at = Date.parse(point.fetchedAt);
    const usageAt = Date.parse(point.usageFetchedAt);
    const reset = Date.parse(point.resetAt);
    const used = nonnegative(point.usedPercent);
    const tokens = nonnegative(point.totalTokens);
    if (!Number.isFinite(usageAt) || Math.abs(usageAt - at) > MAX_PAIR_SKEW
      || !(at < reset && at >= reset - 7 * time.DAY) || used === null || used >= 100 || tokens === null) return null;
    return { ...point, at, usageAt, reset, used, tokens, basis: point.usageBasis || LOCAL_BASIS };
  }

  function matching(a, b, plan, resetAnchor) {
    return a.segment === b.segment && a.basis === b.basis && b.at > a.at
      && Math.abs(a.reset - b.reset) <= RESET_JITTER && Math.abs(resetAnchor - b.reset) <= RESET_JITTER
      && b.used >= a.used && b.tokens >= a.tokens && !b.resetDetected
      && Array.isArray(a.apiCostDays) === Array.isArray(b.apiCostDays)
      && !capacities.crossesChange(plan, a.fetchedAt, b.fetchedAt);
  }

  function costDelta(a, b, history) {
    if (!(b.usageAt > a.usageAt)) return null;
    const start = time.dateKey(a.usageAt);
    const end = time.dateKey(b.usageAt);
    const paired = Array.isArray(b.apiCostDays);
    const priced = paired ? new Map(b.apiCostDays.map((day) => [day.date, day])) : history;
    const zero = { tokens: 0, usd: 0, fallbackTokens: 0 };
    const baseline = paired ? a.apiCostDays.find((day) => day.date === start) || zero : zero;
    let tokens = 0;
    let usd = 0;
    let fallback = false;
    for (let date = start; date && date <= end; date = time.shiftDay(date, 1)) {
      const day = priced.get(date) || zero;
      const before = date === start ? baseline : zero;
      const diff = day.tokens - before.tokens;
      if (diff < 0 || day.fallbackTokens < before.fallbackTokens) return null;
      if (day.usd === null || before.usd === null) {
        if (diff !== 0) return null;
      } else {
        const cost = day.usd - before.usd;
        if (cost < -USD_EPSILON || (diff === 0 && Math.abs(cost) > USD_EPSILON) || (diff > 0 && cost <= 0)) return null;
        usd += Math.max(0, cost);
      }
      tokens += diff;
      fallback ||= day.fallbackTokens > before.fallbackTokens;
    }
    const observed = b.tokens - a.tokens;
    if (!(observed > 0 && usd > 0) || (paired ? tokens !== observed : tokens < observed)) return null;
    return { usd: paired ? usd : usd * observed / tokens, tokens: observed, fallback };
  }

  function appendModels(row, a, b, tokens) {
    let modeled = 0;
    const deltas = new Map();
    for (const name of new Set([...Object.keys(a.models || {}), ...Object.keys(b.models || {})])) {
      const delta = (nonnegative(b.models?.[name]) ?? 0) - (nonnegative(a.models?.[name]) ?? 0);
      if (delta < 0) return;
      modeled += delta;
      if (delta) deltas.set(name, delta);
    }
    if (modeled !== tokens) return;
    row.modeledTokens += modeled;
    for (const [name, delta] of deltas) row.models.set(name, (row.models.get(name) || 0) + delta);
  }

  function mixDistance(a, b) {
    if (a.modeledTokens !== a.tokens || b.modeledTokens !== b.tokens || !a.tokens || !b.tokens) return Infinity;
    if ((a.models.get("unattributed") || 0) > a.tokens * 0.2
      || (b.models.get("unattributed") || 0) > b.tokens * 0.2) return Infinity;
    let delta = 0;
    for (const name of new Set([...a.models.keys(), ...b.models.keys()])) {
      delta += Math.abs((a.models.get(name) || 0) / a.tokens - (b.models.get(name) || 0) / b.tokens);
    }
    return delta / 2;
  }

  function analyze({ daily, observations, capacityPlan, basis, now = Date.now() }) {
    const plan = capacities.normalizePlan(capacityPlan);
    const history = priceDays(daily);
    const spend = calendarSpend(daily, now);
    const allowed = new Set(forecast.quotaObservationsForBasis(observations || [], basis));
    const windows = new Map();
    for (const point of observations || []) {
      if (Number(point.windowDurationMins) !== WEEK_MINUTES || point.modelScoped
        || point.windowKind === "model" || point.modelPatterns?.length || !point.windowName
        || !Number.isFinite(Date.parse(point.fetchedAt)) || Date.parse(point.fetchedAt) > Number(now)) continue;
      if (!windows.has(point.windowName)) windows.set(point.windowName, []);
      windows.get(point.windowName).push(point);
    }

    const rows = [];
    for (const [windowName, points] of windows) {
      let prior = null;
      let anchor = null;
      let row = null;
      for (const point of points.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))) {
        const next = allowed.has(point) ? sample(point) : null;
        if (!next) {
          prior = anchor = null;
          // An exhausted/stale point stops interval attribution, but not necessarily the cycle.
          if (row && (point.segment !== row.segment || point.resetDetected
            || Math.abs(Date.parse(point.resetAt) - row.reset) > RESET_JITTER
            || (nonnegative(point.usedPercent) ?? Infinity) < row.lastUsed
            || capacities.crossesChange(plan, row.lastAt, point.fetchedAt))) row = null;
          continue;
        }
        const paired = Array.isArray(next.apiCostDays);
        const sameRow = row && next.segment === row.segment && next.basis === row.basis && paired === row.paired
          && Math.abs(next.reset - row.reset) <= RESET_JITTER && !next.resetDetected
          && next.used >= row.lastUsed
          && !capacities.crossesChange(plan, row.lastAt, next.fetchedAt)
          && (!prior || matching(prior, next, plan, row.reset));
        if (!sameRow) {
          row = { windowName, segment: next.segment, basis: next.basis, reset: next.reset, paired, percent: 0,
            usd: 0, tokens: 0, fallback: false, intervalCount: 0, sampleCount: 0, models: new Map(), modeledTokens: 0,
            multiplier: capacities.multiplierAt(plan, next.at), firstAt: next.at, lastAt: next.at };
          rows.push(row);
          anchor = null;
        }
        row.lastAt = next.at;
        row.lastUsed = next.used;
        row.sampleCount++;
        prior = next;
        if (!anchor) {
          anchor = next;
          continue;
        }
        if (next.used === anchor.used) continue;
        const interval = costDelta(anchor, next, history);
        if (interval) {
          row.usd += interval.usd;
          row.tokens += interval.tokens;
          row.fallback ||= interval.fallback;
          row.percent += next.used - anchor.used;
          row.intervalCount++;
          appendModels(row, anchor, next, interval.tokens);
        }
        anchor = next;
      }
    }

    rows.sort((a, b) => b.lastAt - a.lastAt);
    const latestPoint = [...windows.values()].map((points) => points.at(-1))
      .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
    const current = latestPoint && rows.find((row) => row.windowName === latestPoint.windowName
      && row.segment === latestPoint.segment && Math.abs(row.reset - Date.parse(latestPoint.resetAt)) <= RESET_JITTER
      && row.reset > now && !capacities.crossesChange(plan, row.lastAt, now)) || null;
    for (const row of rows) {
      row.weeklyUsd = row.intervalCount >= MIN_INTERVALS && row.percent >= MIN_COVERAGE
        ? row.usd * 100 / row.percent : null;
      row.monthlyUsd = row.weeklyUsd === null ? null : row.weeklyUsd * 30 / 7;
      row.leadingModel = row.modeledTokens === row.tokens
        ? [...row.models].sort((a, b) => b[1] - a[1])[0]?.[0] || null : null;
      row.change = null;
    }
    const completed = rows.filter((row) => row.reset <= now && row.weeklyUsd !== null);
    for (const [index, row] of completed.entries()) {
      const previous = completed.slice(index + 1).find((older) => older.windowName === row.windowName
        && older.reset + RESET_JITTER < row.reset);
      if (previous && Math.abs(row.reset - previous.reset - 7 * time.DAY) <= RESET_JITTER
        && row.paired === previous.paired && row.basis === previous.basis
        && !capacities.crossesChange(plan, previous.firstAt, row.lastAt)
        && !row.fallback && !previous.fallback && mixDistance(row, previous) <= 0.2) {
        row.change = (row.weeklyUsd / previous.weeklyUsd - 1) * 100;
      }
    }
    const observationStart = windows.size
      ? Math.min(...[...windows.values()].map((points) => Date.parse(points[0].fetchedAt))) : null;
    return { rows: rows.filter((row) => row.weeklyUsd !== null || row === current), current, spend, observationStart };
  }

  function trendSeries(rows, capacityPlan, observationStart) {
    const plan = capacities.normalizePlan(capacityPlan);
    const ordered = rows.filter((row) => Number.isFinite(row.lastAt))
      .sort((a, b) => a.lastAt - b.lastAt || a.reset - b.reset);
    if (!ordered.some((row) => Number.isFinite(row.weeklyUsd))) return null;
    const first = ordered[0].lastAt;
    const last = ordered.at(-1).lastAt;
    // Keep some observed history before a registered change, even when that era has no estimate.
    const earlierChange = Number.isFinite(observationStart) && plan.changes.find((change) =>
      Date.parse(change.effectiveAt) > observationStart && Date.parse(change.effectiveAt) <= first
      && change.multiplier !== capacities.multiplierAt(plan, Date.parse(change.effectiveAt) - 1));
    const start = earlierChange ? Math.max(observationStart, Date.parse(earlierChange.effectiveAt) - 7 * time.DAY)
      : first === last ? first - time.DAY : first;
    const end = last;
    const eras = [{ start, multiplier: capacities.multiplierAt(plan, start) }];
    for (const change of plan.changes) {
      const at = Date.parse(change.effectiveAt);
      if (at > start && at <= end && change.multiplier !== eras.at(-1).multiplier) {
        eras.push({ start: at, multiplier: change.multiplier });
      }
    }
    eras.forEach((era, index) => { era.end = eras[index + 1]?.start ?? end; });

    const groups = [];
    let previous = null;
    for (const row of ordered) {
      if (!Number.isFinite(row.weeklyUsd)) {
        previous = null;
        continue;
      }
      if (!previous || row.paired !== previous.paired || row.basis !== previous.basis
        || row.windowName !== previous.windowName || row.reset <= previous.reset + RESET_JITTER
        || row.reset - previous.reset > 8 * time.DAY
        || capacities.crossesChange(plan, previous.lastAt, row.lastAt)) {
        groups.push([]);
      }
      groups.at(-1).push(row);
      previous = row;
    }
    return { start, end, eras, groups };
  }

  return { WEEK_MINUTES, MIN_INTERVALS, MIN_COVERAGE, captureCostDays, analyze, trendSeries };
});
