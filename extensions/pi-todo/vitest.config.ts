import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "#src": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["test/**/*.test.ts"] },
});
