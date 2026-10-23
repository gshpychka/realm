import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localBenchPlugin } from "./local-bench";

// React + Tailwind v4 single-page app. The runner writes results to
// public/data/results.json, served at /data/results.json and fetched at runtime.
//
// The package scripts load this file with `--configLoader runner`: the dev bridge
// imports @probabench/domain, which is TypeScript source with extensionless
// imports. Vite's default bundling loader leaves bare imports to Node, which
// cannot load that source.
export default defineConfig({
  plugins: [react(), tailwindcss(), localBenchPlugin()],
  server: { host: "127.0.0.1" },
});
