const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReviewEvents, reviewDaily, annotateAutoReview, QUOTA_BASIS } = require("../lib/codex-auto-review.js");
const ForecastModel = require("../web/forecast-model.js");

const review = { inputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 110 };
const date = "2026-10-08";
const usage = (models) => ({ timezone: "Asia/Shanghai", daily: [{ date, totalTokens: 110, costUSD: 1, models }], totals: { totalTokens: 110, costUSD: 1 } });
const fallback = () => ({ ...review, isFallback: true });
const ledger = () => new Map([[date, review]]);
const reviewKey = "codex-auto-review@gpt-5.6-luna";

test("only proven Guardian alias usage gets the auto-review label, without rewriting totals or costs", () => {
  const original = usage({ "gpt-5.6-luna": fallback() });
  const result = annotateAutoReview(original, ledger(), { chatgpt: true });
  assert.deepEqual(result.totals, original.totals);
  assert.equal(result.daily[0].totalTokens, 110);
  assert.equal(result.daily[0].costUSD, 1);
  assert.equal(result.daily[0].models[reviewKey].displayName, "自动审批（gpt-5.6-luna 估算）");
  assert.equal(result.daily[0].models[reviewKey].rawModel, "codex-auto-review");
  assert.equal(result.daily[0].models[reviewKey].planQuotaExempt, true);
  assert.equal(result.autoReview.quotaBasis, QUOTA_BASIS);
  assert.ok(original.daily[0].models["gpt-5.6-luna"]);
  assert.deepEqual(annotateAutoReview(result, ledger(), { chatgpt: true }), result);
});

test("a fallback marker alone, ordinary Luna calls and other inferred models are not relabeled", () => {
  for (const [model, details, evidence] of [
    ["gpt-5.6-luna", fallback(), new Map()],
    ["gpt-5.6-luna", { ...review, isFallback: false }, ledger()],
    ["gpt-6-astra", fallback(), ledger()],
  ]) {
    const result = annotateAutoReview(usage({ [model]: details }), evidence, { chatgpt: true });
    assert.deepEqual(result.daily[0].models, { [model]: details });
    assert.equal(result.autoReview.confirmedTokens, 0);
  }
});

test("mixed Luna buckets split only confirmed components; all token components remain conserved", () => {
  const mixed = Object.fromEntries(Object.entries(review).map(([key, value]) => [key, value * 2]));
  const original = usage({ "gpt-5.6-luna": { ...mixed, isFallback: true } });
  original.daily[0].totalTokens = 220;
  const result = annotateAutoReview(original, ledger(), { chatgpt: true });
  assert.equal(result.daily[0].models["gpt-5.6-luna"].totalTokens, 110);
  for (const key of Object.keys(review)) assert.equal(Object.values(result.daily[0].models).reduce((sum, model) => sum + model[key], 0), mixed[key]);
  const forecast = ForecastModel.quotaUsageDay(result.daily[0]);
  assert.equal(forecast.totalTokens, 110);
  assert.deepEqual([...ForecastModel.dayModelTokens(forecast)], [["gpt-5.6-luna", 110]]);
});

test("incompatible components and unmatched timestamps cannot consume an estimated model bucket", () => {
  const wrong = new Map([[date, { ...review, cacheReadTokens: 90 }]]);
  const result = annotateAutoReview(usage({ "gpt-5.6-luna": fallback() }), wrong, { chatgpt: true });
  assert.equal(result.autoReview.confirmedTokens, 0);
  assert.ok(result.daily[0].models["gpt-5.6-luna"]);
});

test("API-key or unknown authentication never implies a free subscription exemption", () => {
  const result = annotateAutoReview(usage({ "gpt-5.6-luna": fallback() }), ledger());
  assert.equal(result.daily[0].models[reviewKey].usageRole, "auto-review");
  assert.equal(result.daily[0].models[reviewKey].planQuotaExempt, false);
  assert.equal(ForecastModel.quotaUsageDay(result.daily[0]).totalTokens, 110);
});

test("review parser ignores repeated notifications, other roles and duplicate response telemetry", () => {
  const header = { type: "session_meta", payload: { source: { subagent: { other: "guardian" } } } };
  const context = { type: "turn_context", payload: { model: "codex-auto-review" } };
  const raw = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 };
  const count = { type: "event_msg", timestamp: "2026-10-07T15:44:00Z", payload: { type: "token_count", info: { last_token_usage: raw, total_token_usage: raw } } };
  const response = { type: "token_usage_record", timestamp: count.timestamp, payload: { response_id: "fixture-private-id", usage: raw } };
  const text = [header, context, count, count, response].map(JSON.stringify).join("\n") + "\n{unfinished";
  const events = parseReviewEvents(text);
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("fixture-private-id"), false);
  assert.deepEqual(reviewDaily(events, "Asia/Shanghai", Date.parse("2026-10-07T16:00:00Z")).get("2026-10-07"), review);
  assert.deepEqual(reviewDaily(events, "Asia/Tokyo", Date.parse("2026-10-07T16:00:00Z")).get(date), review);
  assert.equal(reviewDaily(events, "Asia/Shanghai", Date.parse("2026-10-07T15:43:59Z")).size, 0);
  assert.equal(parseReviewEvents(text.replace('"other":"guardian"', '"other":"regular"')).length, 0);
});

test("quota-only transforms remove free reviews without reintroducing them as unknown models", async () => {
  const { aggregateUsage } = await import("../scripts/sync-account-quotas.mjs");
  const result = annotateAutoReview(usage({ "gpt-5.6-luna": fallback() }), ledger(), { chatgpt: true });
  const day = ForecastModel.quotaUsageDay(result.daily[0]);
  assert.equal(day.totalTokens, 0);
  assert.equal(ForecastModel.dayModelTokens(day).size, 0);
  assert.deepEqual(aggregateUsage(result), { totalTokens: 0, models: {}, usageBasis: QUOTA_BASIS });
  const prefixed = { totalTokens: 110, modelBreakdowns: [{ modelName: "Codex · review", ...result.daily[0].models[reviewKey] }] };
  assert.equal(ForecastModel.quotaUsageDay(prefixed).totalTokens, 0);
  assert.equal(result.daily[0].totalTokens, 110);
});

test("changing accounting basis starts a separate segment, not a fake banked reset", async () => {
  const { detectObservationSegment } = await import("../scripts/sync-account-quotas.mjs");
  const prior = { windowName: "weekly", totalTokens: 110, usedPercent: 20, resetAt: "2026-10-14T01:00:00Z" };
  const result = detectObservationSegment(prior, { ...prior, totalTokens: 0, usageBasis: QUOTA_BASIS });
  assert.deepEqual(result, { newSegment: true, resetDetected: false, reason: "usage-basis-changed" });
});

test("unambiguous historical intervals remain reusable while mixed old review observations stay archived", () => {
  const points = [
    { marker: "clean-legacy", models: { "gpt-6-astra": 100 } },
    { marker: "clean-explicit", usageBasis: "local-token-v1", models: { "gpt-6-astra": 200 } },
    { marker: "ambiguous-luna", models: { "gpt-5.6-luna": 110 } },
    { marker: "current-free", usageBasis: QUOTA_BASIS, models: { "gpt-6-astra": 300 } },
    { marker: "different-basis", usageBasis: "future-accounting", models: {} },
  ];
  assert.deepEqual(ForecastModel.quotaObservationsForBasis(points, QUOTA_BASIS).map((p) => p.marker),
    ["clean-legacy", "clean-explicit", "current-free"]);
  assert.equal(points.length, 5);
  assert.equal(ForecastModel.quotaObservationsForBasis(points, "local-token-v1"), points);
});
