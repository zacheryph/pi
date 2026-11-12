import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { readWorkspaces, repositoryRoot } from "./scripts/workspaces.mjs";

export default defineConfig({
  test: {
    pool: "forks",
    isolate: true,
    projects: readWorkspaces()
      .filter((workspace) => workspace.runner === "vitest")
      .map((workspace) => ({
        root: join(repositoryRoot, workspace.path),
        test: {
          name: workspace.name,
          environment: "node",
          provide: { workspaceRoot: join(repositoryRoot, workspace.path) },
          setupFiles: [join(repositoryRoot, "scripts/test-workspace-setup.mjs")],
          include: [workspace.path === "test" ? "scenarios/**/*.test.ts" : "test/**/*.test.ts"],
          ...(workspace.path === "test" ? { testTimeout: 30_000 } : {}),
        },
      })),
  },
});
