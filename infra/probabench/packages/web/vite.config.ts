import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devBridgePlugin } from "./dev-bridge/plugin";

// React single-page app; the dev bridge exists only in dev.
//
// The package scripts load this file with `--configLoader runner`: the dev bridge
// imports @probabench/domain, which is TypeScript source with extensionless
// imports. Vite's default bundling loader leaves bare imports to Node, which
// cannot load that source.
export default defineConfig({
  plugins: [react(), devBridgePlugin()],
  // Vite serves the workspace's benchmark history, data/results.json, at /results.json.
  publicDir: "../../data",
  // Effect, React and recharts form the one entry chunk (~0.9 MB minified).
  build: { chunkSizeWarningLimit: 1000 },
});
