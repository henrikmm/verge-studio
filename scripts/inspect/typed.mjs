// Compiling `bridge.ts` on demand, so the inspector can call the project's own geometry.
//
// The geometry package imports its siblings without file extensions (`from "./types"`), which
// Node's own TypeScript support does not resolve — it requires full specifiers. esbuild does,
// and esbuild is already installed as one of Vite's dependencies, so this costs nothing new.
//
// The bundle is held in memory rather than written to disk. A cached build artefact would need
// invalidating whenever geometry changed, and a stale inspector reporting last week's floor fit
// is exactly the failure this tool exists to prevent. Measured 2026-08-07: ~40 ms per run, which
// is not worth risking that for.

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../app/package.json", import.meta.url));

let pending = null;

/**
 * The geometry, depth and colour-map exports listed in `bridge.ts`.
 *
 * Compiled once per process. Callers should hold the result rather than calling in a loop.
 */
export function typed() {
  pending ??= compile();
  return pending;
}

async function compile() {
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch {
    throw new Error(
      "the inspector needs the app's dependencies: run `npm install --prefix app` first",
    );
  }

  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("bridge.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
  });

  const source = Buffer.from(built.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}
