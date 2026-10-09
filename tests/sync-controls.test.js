const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const registry = require("../providers/registry.js");
const { writeDisplaySettings } = require("../lib/display-settings.js");

test("paused sources skip manual, global, quota, reset and scheduled collectors without losing history", { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-sync-controls-"));
  const settingsPath = path.join(directory, "display-settings.json");
  writeDisplaySettings(settingsPath, { disabledSyncProviders: registry.PROVIDERS.map(p => p.id) }, registry.PROVIDERS);
  const dailyPath = path.join(directory, "codex", "daily", "codex-usage.json");
  fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
  const original = JSON.stringify({ timezone: "Asia/Shanghai", daily: [{ date: "2026-10-07", totalTokens: 42,
    models: { "codex-auto-review": { inputTokens: 32, outputTokens: 10, totalTokens: 42 } } }], totals: { totalTokens: 42 } });
  fs.writeFileSync(dailyPath, original);
  const env = { ...process.env, USAGE_LOG_ROOT: directory, DISPLAY_SETTINGS_PATH: settingsPath,
    FORECAST_SETTINGS_PATH: path.join(directory, "forecast-settings.json"), QUOTA_SNAPSHOT_DIR: path.join(directory, "quotas"),
    QUOTA_OBSERVATION_DIR: path.join(directory, "observations"), CODEX_AUTH_PATH: path.join(directory, "missing-auth.json") };
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["server.js", "--port", String(port)], { env, windowsHide: true });
  const closed = once(child, "exit");
  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", data => { if (data.toString().includes("AI token dashboard")) resolve(); });
      child.on("exit", code => reject(new Error(`test server exited ${code}`)));
    });
    const request = async (url, method = "GET", body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await request("/api/export?source=codex", "POST")).skipped, true);
    const all = await request("/api/export?source=everything", "POST");
    assert.equal(all.ok, true);
    assert.equal(all.partial, false);
    assert.ok(all.results.length > 5);
    assert.ok(all.results.every(r => r.skipped === true));
    assert.ok((await request("/api/account-sync", "POST")).results.every(r => r.skipped));
    for (const source of ["codex", "grok-build"]) {
      const reset = await request(`/api/reset-credits?source=${source}`);
      assert.equal(reset.paused, true);
      assert.equal(reset.available_count, null);
    }
    assert.equal((await request("/api/usage?source=codex")).totals.totalTokens, 42);
    assert.equal((await request("/api/usage?source=codex")).timezone, "Asia/Shanghai");
    const usage = await request("/api/usage?source=codex");
    assert.equal(usage.daily[0].models["codex-auto-review"].displayName, "自动审批");
    assert.equal(usage.autoReview.confirmedTokens, 42);
    assert.equal(usage.autoReview.quotaExempt, false);
    assert.ok((await request("/api/forecast-settings")).settings.agents);
    assert.deepEqual((await request("/api/forecast-settings")).settings.agents.codex.capacityPlan,
      { baselineMultiplier: 1, changes: [] });
    const claudePlan = { baselineMultiplier: 5, changes: [] };
    await request("/api/forecast-settings", "PUT", { agents: { claude: { capacityPlan: claudePlan, cycleDays: 14 } } });
    const capacityPlan = { baselineMultiplier: 5,
      changes: [{ effectiveAt: "2026-10-04T00:00:00+08:00", multiplier: 10 }] };
    const configured = (await request("/api/forecast-settings", "PUT", { agents: { codex: { capacityPlan } } })).settings;
    assert.equal(configured.agents.codex.capacityPlan.changes[0].effectiveAt, "2026-10-03T16:00:00.000Z");
    assert.deepEqual(configured.agents.claude.capacityPlan, claudePlan);
    assert.equal(configured.agents.claude.cycleDays, 14);
    const bad = await fetch(`http://127.0.0.1:${port}/api/forecast-settings`, { method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: { codex: { capacityPlan: { baselineMultiplier: 0 } } } }) });
    assert.equal(bad.status, 400);
    assert.deepEqual((await request("/api/forecast-settings")).settings, configured);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.FORECAST_SETTINGS_PATH, "utf8")), configured);
    const config = spawnSync(process.execPath, ["scripts/provider-config.mjs", "--ccusage-sources"], { env, encoding: "utf8", windowsHide: true });
    assert.equal(config.status, 0);
    assert.deepEqual(JSON.parse(config.stdout), []);
    if (process.platform === "win32") {
      for (const script of ["export-daily.ps1", "export-all-daily.ps1"]) {
        const scheduled = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `scripts/${script}`],
          { env, encoding: "utf8", windowsHide: true, timeout: 8000 });
        assert.equal(scheduled.status, 0, scheduled.stderr);
      }
    }
    assert.equal(fs.readFileSync(dailyPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(directory, "quotas")), false);
  } finally {
    child.kill();
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
