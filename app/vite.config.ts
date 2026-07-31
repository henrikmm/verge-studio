import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// @ts-expect-error - plain ESM plugin, no type declarations
import { localApi } from "./vite-plugins/local-api.mjs";

// Fixtures live at repo root; expose them to the dev server as /fixtures/*.
export default defineConfig({
  plugins: [react(), localApi()],
  publicDir: fileURLToPath(new URL("../fixtures", import.meta.url)),
  server: { port: 5173, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
