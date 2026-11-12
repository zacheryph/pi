import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { it } from "vitest";

it("loads the barrel under node:test without resetting global state", () => {
  execFileSync(process.execPath, ["--test", join(import.meta.dirname, "fixtures/barrel.mjs")], {
    stdio: "pipe",
  });
});
