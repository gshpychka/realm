import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc emits web project references into .tsbuild/. Run each source test
    // once, independent of whether a developer has typechecked beforehand.
    include: ["packages/*/src/**/*.test.{ts,tsx}", "packages/web/local-bench.test.ts"],
  },
});
