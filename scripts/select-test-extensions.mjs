import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sharedFiles = new Set([
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.hub.json",
  "vitest.config.ts",
  ".oxlintrc.json",
  ".oxfmtrc.json",
]);

// Scenario tests that run the whole bundle in-process, so they test every
// extension: select them whenever any workspace is selected.
const BUNDLE_TESTS = "test";

// Producer contracts are imported directly by the dashboard. Include all source
// changes because events also expose types from state, roster and PR modules.
const dashboardProducers = ["pi-todo", "pi-stash", "pi-git", "pi-subagent"];

// Extensions import shared libraries from packages/ through aliases, so a change
// there re-tests every workspace.
export function selectExtensions(workspaces, changedFiles, all = false) {
  const runAll =
    all ||
    changedFiles.some(
      (path) =>
        sharedFiles.has(path) ||
        path.startsWith(".github/workflows/") ||
        path.startsWith("scripts/") ||
        /^packages\/[^/]+\//.test(path),
    );
  const candidates = workspaces.filter(
    (workspace) => workspace === BUNDLE_TESTS || /^(extensions|packages)\/[^/]+$/.test(workspace),
  );
  const selected = candidates.filter(
    (workspace) => runAll || changedFiles.some((path) => path.startsWith(`${workspace}/`)),
  );
  if (
    candidates.includes("extensions/pi-dashboard") &&
    !selected.includes("extensions/pi-dashboard") &&
    changedFiles.some((path) =>
      dashboardProducers.some((name) => path.startsWith(`extensions/${name}/src/`)),
    )
  )
    selected.push("extensions/pi-dashboard");
  if (
    selected.length > 0 &&
    candidates.includes(BUNDLE_TESTS) &&
    !selected.includes(BUNDLE_TESTS)
  ) {
    selected.push(BUNDLE_TESTS);
  }
  return selected.sort();
}

export function changedFiles(base, head, cwd = process.cwd()) {
  // Triple-dot compares the PR head with its merge base, excluding base-only changes.
  // Disabling rename detection includes both old and new paths when moving files.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function main() {
  const { workspaces } = JSON.parse(readFileSync("package.json", "utf8"));
  const isPullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";
  let paths = [];
  if (isPullRequest) {
    const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    paths = changedFiles(pr.base.sha, pr.head.sha);
  }
  const extensions = selectExtensions(workspaces, paths, !isPullRequest);
  const matrix = JSON.stringify({ extension: extensions });
  console.log(`Extension test matrix: ${matrix}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${matrix}\nhas-extensions=${extensions.length > 0}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
