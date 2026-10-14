import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sharedFiles = new Set(["package.json", "package-lock.json", "tsconfig.base.json"]);

export function selectExtensions(workspaces, changedFiles, all = false) {
  const runAll = all || changedFiles.some((path) =>
    sharedFiles.has(path) || path.startsWith(".github/workflows/") || path.startsWith("scripts/"),
  );
  return workspaces
    .filter((workspace) => /^extensions\/[^/]+$/.test(workspace))
    .filter((workspace) => runAll || changedFiles.some((path) => path.startsWith(`${workspace}/`)))
    .sort();
}

export function changedFiles(base, head, cwd = process.cwd()) {
  // Triple-dot compares the PR head with its merge base, excluding base-only changes.
  // Disabling rename detection includes both old and new paths when moving files.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
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
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\nhas-extensions=${extensions.length > 0}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
