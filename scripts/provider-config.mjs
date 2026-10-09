import registry from "../providers/registry.js";
import settings from "../lib/display-settings.js";
import { resolve, join } from "node:path";

const root = process.env.USAGE_LOG_ROOT || join(resolve(import.meta.dirname, ".."), "usage-logs");
const settingsPath = process.env.DISPLAY_SETTINGS_PATH || join(root, "display-settings.json");
const syncEnabled = (id) => settings.sourceSyncEnabled(settingsPath, registry.PROVIDERS, id);

function output(value) {
  const json = JSON.stringify(value);
  if (process.argv.includes("--base64")) {
    process.stdout.write(Buffer.from(json, "utf8").toString("base64"));
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (process.argv.includes("--ccusage-sources")) {
  output(registry.ALL_SOURCES.filter((entry) => entry.usage.adapter === "ccusage" && syncEnabled(entry.id)).map((entry) => entry.id));
} else {
  const sourceIndex = process.argv.indexOf("--source");
  const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
  const provider = registry.getProvider(source);
  if (!provider || provider.usage.adapter !== "ccusage") {
    process.stderr.write(`No ccusage provider is registered for ${source || "(missing)"}\n`);
    process.exitCode = 1;
  } else {
    output({
      id: provider.id,
      syncEnabled: syncEnabled(provider.id),
      filePrefix: provider.usage.filePrefix,
      ccusageArgs: provider.usage.ccusageArgs,
      logRoot: provider.usage.logRoot,
      legacyRoots: provider.usage.legacyRoots || [],
    });
  }
}
