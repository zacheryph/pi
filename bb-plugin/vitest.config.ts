import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Own config, so vitest does not climb to the repository's workspace projects.
export default defineConfig({
  root,
  resolve: { alias: { "@/": `${root}/` } },
  test: { include: ["test/**/*.test.{ts,tsx}"] },
});
