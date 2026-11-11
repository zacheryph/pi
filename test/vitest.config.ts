import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["scenarios/**/*.test.ts"],
    // Each scenario loads the whole bundle and runs real subagents and jobs.
    testTimeout: 30_000,
  },
});
