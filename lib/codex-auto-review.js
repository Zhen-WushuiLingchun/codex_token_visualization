const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ALIAS = "codex-auto-review";
const QUOTA_BASIS = "codex-chatgpt-auto-review-excluded-v1";
const FIELDS = ["inputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
const fileCache = new Map();
const number = (value) => Math.max(0, Number(value) || 0);

function emptyUsage() {
  return Object.fromEntries(FIELDS.map((key) => [key, 0]));
}

function normalizeUsage(raw) {
  const input = number(raw.input_tokens);
  const cached = number(raw.cached_input_tokens);
  const written = number(raw.cache_write_input_tokens ?? raw.cache_creation_tokens);
  const output = number(raw.output_tokens);
  return {
    inputTokens: Math.max(0, input - cached - written),
    cacheReadTokens: cached,
    cacheCreationTokens: written,
    outputTokens: output,
    reasoningOutputTokens: number(raw.reasoning_output_tokens),
    totalTokens: number(raw.total_tokens) || input + output,
  };
}

// This is a provenance check, not a replacement for ccusage's accounting.
// Repeated cumulative notifications are ignored; response records are not added
// a second time alongside the token_count stream.
function parseReviewEvents(text) {
  let guardian = false;
  let model = null;
  let previous = null;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/session_meta|turn_context|token_count/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    const payload = entry.payload || {};
    if (entry.type === "session_meta") guardian = payload.source?.subagent?.other === "guardian";
    if (entry.type === "turn_context") model = payload.model;
    if (entry.type !== "event_msg" || payload.type !== "token_count") continue;
    const cumulative = payload.info?.total_token_usage;
    const advanced = !cumulative || !previous || Object.keys(cumulative).some((key) => cumulative[key] !== previous[key]);
    let raw = advanced ? payload.info?.last_token_usage : null;
    if (!raw && cumulative) raw = Object.fromEntries(Object.entries(cumulative)
      .map(([key, value]) => [key, Math.max(0, number(value) - number(previous?.[key]))]));
    if (cumulative) previous = cumulative;
    if (!guardian || model !== ALIAS || !raw || !advanced) continue;
    const timestamp = Date.parse(entry.timestamp);
    if (Number.isFinite(timestamp)) events.push({ timestamp, ...normalizeUsage(raw) });
  }
  return events;
}

function reviewDaily(events, timezone, cutoff) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const daily = new Map();
  for (const event of events) {
    if (event.timestamp > cutoff) continue;
    const parts = Object.fromEntries(formatter.formatToParts(event.timestamp).map(({ type, value }) => [type, value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const usage = daily.get(date) || emptyUsage();
    for (const key of FIELDS) usage[key] += event[key];
    daily.set(date, usage);
  }
  return daily;
}

function annotateAutoReview(snapshot, daily, { chatgpt = false } = {}) {
  if (!Array.isArray(snapshot?.daily)) return snapshot;
  let confirmedTokens = 0;
  const days = snapshot.daily.map((day) => {
    if (!day.models || Array.isArray(day.models)) return day;
    const existing = Object.values(day.models).filter((usage) => usage.usageRole === "auto-review");
    if (existing.length) {
      confirmedTokens += existing.reduce((sum, usage) => sum + number(usage.totalTokens), 0);
      return { ...day, models: Object.fromEntries(Object.entries(day.models).map(([name, usage]) => [name,
        usage.usageRole === "auto-review" ? { ...usage, planQuotaExempt: chatgpt } : usage])) };
    }
    const review = daily.get(String(day.date || day.period || "").slice(0, 10));
    const candidates = Object.entries(day.models).filter(([name, usage]) => name === ALIAS
      || (name === "gpt-5.6-luna" && usage.isFallback === true));
    const exact = review ? candidates.filter(([, usage]) => FIELDS.every((key) => number(usage[key]) === review[key])) : [];
    const candidate = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
    if (!candidate) return day;
    const [name, usage] = candidate;
    const identified = name === ALIAS ? usage : review;
    // A fallback flag alone cannot prove review origin. Split a mixed Luna bucket
    // only when every component is covered by the independently read guardian log.
    if (!identified || !number(identified.totalTokens) || FIELDS.some((key) => number(identified[key]) > number(usage[key]))) return day;
    const wholeBucket = number(identified.totalTokens) === number(usage.totalTokens);
    if (!wholeBucket && (usage.costUSD !== undefined || usage.totalCost !== undefined)) return day;
    const models = { ...day.models };
    if (wholeBucket) delete models[name];
    else models[name] = { ...usage, ...Object.fromEntries(FIELDS.map((key) => [key, number(usage[key]) - number(identified[key])])) };
    const estimatedModel = name === ALIAS ? null : name;
    models[estimatedModel ? `${ALIAS}@${estimatedModel}` : ALIAS] = {
      ...(wholeBucket ? usage : identified),
      usageRole: "auto-review",
      rawModel: ALIAS,
      estimatedModel,
      displayName: estimatedModel ? `自动审批（${estimatedModel} 估算）` : "自动审批",
      planQuotaExempt: chatgpt,
    };
    confirmedTokens += number(identified.totalTokens);
    return { ...day, models };
  });
  return { ...snapshot, daily: days, autoReview: {
    confirmedTokens,
    quotaExempt: chatgpt,
    quotaBasis: chatgpt ? QUOTA_BASIS : "local-token-v1",
    policySource: "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan",
  } };
}

function enrichCodexUsage(snapshot, { cutoff = Date.now(), home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  let chatgpt = false;
  try {
    const auth = JSON.parse(fs.readFileSync(process.env.CODEX_AUTH_PATH || path.join(home, "auth.json"), "utf8").replace(/^\uFEFF/, ""));
    chatgpt = auth.auth_mode === "chatgpt" || (!auth.auth_mode && Boolean(auth.tokens?.access_token));
  } catch (_) { /* Authentication is unknown, so no quota exemption is assumed. */ }
  const events = [];
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(path.join(home, "state_5.sqlite"), { readOnly: true });
    const files = db.prepare("SELECT DISTINCT rollout_path FROM threads WHERE source LIKE '%guardian%'").all();
    for (const { rollout_path: file } of files) {
      try {
        const stat = fs.statSync(file);
        const version = `${stat.mtimeMs}:${stat.size}`;
        let cached = fileCache.get(file);
        if (cached?.version !== version) {
          cached = { version, events: parseReviewEvents(fs.readFileSync(file, "utf8")) };
          fileCache.set(file, cached);
        }
        events.push(...cached.events);
      } catch (_) { /* Missing local logs never become invented usage. */ }
    }
  } catch (_) { /* Without provenance, keep the original estimated model label. */ }
  finally { db?.close(); }
  try {
    return annotateAutoReview(snapshot, reviewDaily(events, snapshot.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, Number(cutoff)), { chatgpt });
  } catch (_) { return snapshot; }
}

module.exports = { QUOTA_BASIS, parseReviewEvents, reviewDaily, annotateAutoReview, enrichCodexUsage };
