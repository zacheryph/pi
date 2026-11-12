import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { repositoryRoot } from "./workspaces.mjs";

for (const file of globSync("extensions/pi-job/e2e/*.mjs", { cwd: repositoryRoot })) {
  execFileSync(process.execPath, ["--check", file], { cwd: repositoryRoot, stdio: "inherit" });
}
