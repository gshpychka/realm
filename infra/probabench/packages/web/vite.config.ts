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
  // devBridgePlugin's isLocalRequest guard assumes this loopback-only bind.
  server: { host: "127.0.0.1" },
  // Effect and React make up most of the entry chunk; recharts, the other heavy
  // dependency, loads with the charts.
  build: { chunkSizeWarningLimit: 600 },
});
