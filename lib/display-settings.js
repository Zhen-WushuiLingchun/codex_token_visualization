const fs = require("node:fs");
const path = require("node:path");

function availableProviderIds(providers) {
  return (providers || [])
    .filter((provider) => provider?.navigation !== false && provider?.id)
    .map((provider) => provider.id);
}

function defaultDisplaySettings(providers) {
  return {
    version: 2,
    visibleProviders: availableProviderIds(providers),
    hiddenProviders: [],
    disabledSyncProviders: [],
  };
}

function normalizeDisplaySettings(value, providers) {
  const available = availableProviderIds(providers);
  const availableSet = new Set(available);
  const requestedHidden = Array.isArray(value?.hiddenProviders)
    ? value.hiddenProviders
    : Array.isArray(value?.visibleProviders)
      ? available.filter((id) => !value.visibleProviders.map(String).includes(id))
      : [];
  const hiddenSet = new Set([...new Set(requestedHidden.map(String))].filter((id) => availableSet.has(id)));
  let visibleProviders = available.filter((id) => !hiddenSet.has(id));
  if (!visibleProviders.length && available.length) {
    visibleProviders = available.slice(0, 1);
    hiddenSet.delete(visibleProviders[0]);
  }

  return {
    version: 2,
    visibleProviders,
    hiddenProviders: available.filter((id) => hiddenSet.has(id)),
    disabledSyncProviders: available.filter((id) => Array.isArray(value?.disabledSyncProviders) && value.disabledSyncProviders.includes(id)),
  };
}

function readDisplaySettings(filePath, providers) {
  const defaults = defaultDisplaySettings(providers);
  if (!fs.existsSync(filePath)) return defaults;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return normalizeDisplaySettings(parsed, providers);
  } catch (_) {
    return defaults;
  }
}

function writeDisplaySettings(filePath, payload, providers) {
  const current = readDisplaySettings(filePath, providers);
  const merged = { ...current, ...payload };
  if (Array.isArray(payload?.visibleProviders) && !Array.isArray(payload?.hiddenProviders)) {
    delete merged.hiddenProviders;
  }
  const settings = normalizeDisplaySettings(merged, providers);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
  return settings;
}

function sourceSyncEnabled(filePath, providers, source) {
  const settings = readDisplaySettings(filePath, providers);
  // The legacy ccusage aggregate discovers sources itself and cannot honor per-source pauses.
  if (source === "all") return settings.disabledSyncProviders.length === 0;
  return availableProviderIds(providers).includes(source) && !settings.disabledSyncProviders.includes(source);
}

module.exports = {
  availableProviderIds,
  defaultDisplaySettings,
  normalizeDisplaySettings,
  readDisplaySettings,
  writeDisplaySettings,
  sourceSyncEnabled,
};
