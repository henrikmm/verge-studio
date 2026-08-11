import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// @ts-expect-error - plain ESM plugin, no type declarations
import { localApi } from "./vite-plugins/local-api.mjs";

// Fixtures live at repo root; expose them to the dev server as /fixtures/*.
export default defineConfig({
  plugins: [react(), localApi()],
  publicDir: fileURLToPath(new URL("../fixtures", import.meta.url)),
  /**
   * 5173 by default, overridable with PORT.
   *
   * `strictPort` stays on: a dev server that silently drifts to another port is worse than one
   * that refuses, because the cloud proxy, the artifact URLs and the frame routes are all
   * same-origin and a half-loaded app on an unexpected port fails in confusing ways. What the
   * override adds is a way to run this beside another Vite project that has already taken 5173
   * — which happens on this Mac — instead of being unable to start at all.
   */
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
  // geometry/ lives outside app/ (it is the one piece with no browser dependency), but
  // the app imports it and it must be typechecked and tested by the same loop. scripts/ joins
  // it for the same reason: the inspector projects points onto frames using the project's own
  // camera convention, and a drift between the two would draw a plausible, wrong picture.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "../geometry/**/*.test.ts", "../scripts/**/*.test.mjs"],
    // Several real-data fixture suites each reconstruct the same million-point cloud.
    // Running them together makes their wall-clock time depend on worker contention and
    // can trip their correctness timeouts even when every assertion passes.
    fileParallelism: false,
  },
});
