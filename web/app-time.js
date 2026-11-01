(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AppTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const ZONE = "Asia/Shanghai";
  const OFFSET = 8 * 3600000;
  const DAY = 86400000;
  function date(value) {
    if (typeof value === "string" && /^[A-Za-z]+ \d{1,2},? \d{4}$/.test(value)) {
      return new Date(`${value} 00:00:00 GMT+0800`);
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
      return new Date(`${value.replace(" ", "T")}+08:00`);
    }
    return new Date(value);
  }
  function input(value) {
    const time = date(value).getTime();
    return Number.isFinite(time) ? new Date(time + OFFSET).toISOString().slice(0, 19) : "";
  }
  function dateKey(value = Date.now()) { return input(value).slice(0, 10); }
  function parseInput(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value || "")) throw new Error("北京时间无效");
    const parsed = date(value);
    if (!input(parsed).startsWith(value)) throw new Error("北京时间无效");
    return parsed.toISOString();
  }
  function dayStart(key) {
    const time = Date.parse(`${key}T00:00:00+08:00`);
    return /^\d{4}-\d{2}-\d{2}$/.test(key || "") && dateKey(time) === key ? time : NaN;
  }
  function shiftDay(key, count) { return dateKey(dayStart(key) + Number(count) * DAY); }
  function format(value, options = {}) {
    return date(value).toLocaleString("zh-CN", { ...options, timeZone: ZONE });
  }
  return { ZONE, OFFSET, DAY, date, input, dateKey, parseInput, dayStart, shiftDay, format };
});
