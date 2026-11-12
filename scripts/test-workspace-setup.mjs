import { inject } from "vitest";

// Match npm's former per-workspace cwd before test modules and SDKs initialize.
process.chdir(inject("workspaceRoot"));
