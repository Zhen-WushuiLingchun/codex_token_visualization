const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  defaultDisplaySettings,
  normalizeDisplaySettings,
  readDisplaySettings,
  writeDisplaySettings,
  sourceSyncEnabled,
} = require("../lib/display-settings.js");

const providers = [
  { id: "codex", navigation: true },
  { id: "claude", navigation: true },
  { id: "opencode", navigation: true },
  { id: "all", navigation: false },
];

test("display settings default to every navigable provider", () => {
  assert.deepEqual(defaultDisplaySettings(providers), {
    version: 2,
    visibleProviders: ["codex", "claude", "opencode"],
    hiddenProviders: [],
    disabledSyncProviders: [],
  });
});

test("display settings discard unknown and duplicate provider ids", () => {
  assert.deepEqual(normalizeDisplaySettings({
    visibleProviders: ["opencode", "unknown", "opencode", "codex"],
  }, providers).visibleProviders, ["codex", "opencode"]);
});

test("display settings keep at least one provider visible", () => {
  assert.deepEqual(
    normalizeDisplaySettings({ visibleProviders: [] }, providers).visibleProviders,
    ["codex"],
  );
});

test("newly registered providers become visible without changing saved settings", () => {
  const stored = normalizeDisplaySettings({ visibleProviders: ["codex"] }, providers.slice(0, 2));
  assert.deepEqual(
    normalizeDisplaySettings(stored, providers).visibleProviders,
    ["codex", "opencode"],
  );
});

test("display settings persist without exposing non-provider values", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "token-ledger-display-"));
  const filePath = path.join(directory, "display-settings.json");
  try {
    writeDisplaySettings(filePath, { visibleProviders: ["opencode", "bad-id"] }, providers);
    assert.deepEqual(readDisplaySettings(filePath, providers), {
      version: 2,
      visibleProviders: ["opencode"],
      hiddenProviders: ["codex", "claude"],
      disabledSyncProviders: [],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sync pauses are independent of visibility and reject malformed ids", () => {
  const settings = normalizeDisplaySettings({ visibleProviders: ["codex"], disabledSyncProviders: ["codex", "unknown", "all", "codex"] }, providers);
  assert.deepEqual(settings.visibleProviders, ["codex"]);
  assert.deepEqual(settings.disabledSyncProviders, ["codex"]);
  assert.deepEqual(normalizeDisplaySettings({ disabledSyncProviders: "codex" }, providers).disabledSyncProviders, []);
});

test("partial settings updates preserve sync pauses and all paused sources skip the legacy aggregate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "token-ledger-sync-"));
  const file = path.join(directory, "display-settings.json");
  try {
    writeDisplaySettings(file, { visibleProviders: ["codex"], disabledSyncProviders: ["claude"] }, providers);
    writeDisplaySettings(file, { visibleProviders: ["opencode"] }, providers);
    assert.deepEqual(readDisplaySettings(file, providers).disabledSyncProviders, ["claude"]);
    assert.equal(sourceSyncEnabled(file, providers, "codex"), true);
    assert.equal(sourceSyncEnabled(file, providers, "claude"), false);
    assert.equal(sourceSyncEnabled(file, providers, "all"), false);
    assert.equal(sourceSyncEnabled(file, providers, "unknown"), false);
    writeDisplaySettings(file, { disabledSyncProviders: ["codex", "claude", "opencode"] }, providers);
    assert.deepEqual(readDisplaySettings(file, providers).visibleProviders, ["opencode"]);
    assert.equal(sourceSyncEnabled(file, providers, "opencode"), false);
    writeDisplaySettings(file, { disabledSyncProviders: [] }, providers);
    assert.equal(sourceSyncEnabled(file, providers, "all"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
