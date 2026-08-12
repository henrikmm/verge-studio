/**
 * Load the three non-secret cloud resource identifiers from the repository's ignored
 * `.env.local`. Explicit process variables win, so CI and one-off commands can still override
 * the saved local choice without editing the file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOCAL_CLOUD_ENV_KEYS = ["PROJECT_ID", "REGION", "VERGE_OUTPUT_BUCKET"];

const DEFAULT_PATH = fileURLToPath(new URL("../../.env.local", import.meta.url));

function valueFrom(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseLocalCloudEnv(text) {
  const parsed = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const equals = line.indexOf("=");
    if (equals <= 0) {
      throw new Error(`invalid .env.local line ${index + 1}: expected NAME=value`);
    }
    const key = line.slice(0, equals).trim();
    if (!LOCAL_CLOUD_ENV_KEYS.includes(key)) continue;
    parsed[key] = valueFrom(line.slice(equals + 1));
  }
  return parsed;
}

export function loadLocalCloudEnv({ env = process.env, path = DEFAULT_PATH } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }

  const loaded = [];
  for (const [key, value] of Object.entries(parseLocalCloudEnv(text))) {
    if (Object.hasOwn(env, key)) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
