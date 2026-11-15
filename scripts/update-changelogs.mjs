import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkpoint = /<!-- changelog:through ([0-9a-f]{40}) -->/;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function escapeMarkdown(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replace(/[\\`*_{}[\]()#!|>~]/g, "\\$&");
}

export function findPullRequest(pulls, sha, repository, branch) {
  const merged = pulls.filter(
    (pr) => pr.merged_at && pr.base.repo.full_name === repository && pr.base.ref === branch,
  );
  return merged.find((pr) => pr.merge_commit_sha === sha) ?? merged[0];
}

export function lookupPullRequests(repository, sha) {
  return JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repository}/commits/${sha}/pulls?per_page=100`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  ).flat();
}

function initialImport(previous) {
  const start = previous.search(/^## Initial import\s*$/m);
  return start < 0 ? "" : `\n${previous.slice(start).trimEnd()}\n`;
}

function historicalPaths(cwd, workspace, head) {
  // Follow the manifest across directory renames (pi-jobs → pi-job, etc.).
  const records = git(
    cwd,
    "log",
    "--follow",
    "--format=",
    "--name-status",
    "-z",
    head,
    "--",
    `${workspace}/package.json`,
  ).split("\0");
  const paths = new Set([workspace]);
  for (let i = 0; i < records.length;) {
    const status = records[i++].trim();
    const source = records[i++];
    // --follow also detects copied manifests. A scaffold copied from another
    // package is a new workspace, not that package's earlier history.
    if (status.startsWith("C")) break;
    if (status.startsWith("R")) {
      i++;
      if (/^(extensions|packages)\/[^/]+\/package\.json$/.test(source)) {
        paths.add(source.slice(0, -"/package.json".length));
      }
    }
  }
  return [...paths];
}

// Build every update before writing anything: failed GitHub lookups must not
// advance a checkpoint and silently lose PR links on the next run.
export function generateChangelogs({
  cwd = process.cwd(),
  repository,
  branch = "main",
  ref = "HEAD",
  rebuild = false,
  lookup = (sha) => lookupPullRequests(repository, sha),
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("Set GITHUB_REPOSITORY to owner/repo.");
  }
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("Changelogs require full Git history (fetch-depth: 0).");
  }
  const head = git(cwd, "rev-parse", ref);
  const { workspaces } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const entries = new Map();
  const updates = [];
  for (const workspace of workspaces
    .filter((path) => /^(extensions|packages)\/[^/]+$/.test(path))
    .sort()) {
    const path = `${workspace}/CHANGELOG.md`;
    const previous = existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : "";
    const marker = previous.match(checkpoint);
    if (previous.includes("<!-- changelog:through") && !marker) {
      throw new Error(`Invalid changelog checkpoint in ${path}.`);
    }
    // Logs without a checkpoint are fully rebuilt; retain only provenance.
    const base = rebuild ? undefined : marker?.[1];
    if (base) git(cwd, "merge-base", "--is-ancestor", base, head);
    const paths = historicalPaths(cwd, workspace, head);
    const commits = git(
      cwd,
      "log",
      "--full-history",
      "--no-merges",
      "--no-renames",
      "--format=%H",
      base ? `${base}..${head}` : head,
      "--",
      ...paths.map((path) => `${path}/`),
      ...paths.map((path) => `:(exclude)${path}/CHANGELOG.md`),
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0) continue;

    const lines = commits.map((sha) => {
      if (!entries.has(sha)) {
        const [timestamp, message] = git(cwd, "show", "-s", "--format=%cI%x00%B", sha).split("\0");
        const subject = message.split("\n")[0];
        const date = new Date(timestamp).toISOString().slice(0, 10);
        const pr = findPullRequest(lookup(sha), sha, repository, branch);
        const url = `https://github.com/${repository}`;
        // Squash subjects often already end in (#123); turn that into the link.
        const title = pr ? subject.replace(new RegExp(` \\(#${pr.number}\\)$`), "") : subject;
        const link = pr
          ? `[#${pr.number}](${url}/pull/${pr.number})`
          : `[${sha.slice(0, 7)}](${url}/commit/${sha})`;
        entries.set(sha, `- ${date}: ${escapeMarkdown(title)} (${link})`);
      }
      return entries.get(sha);
    });
    const block = `<!-- changelog:through ${head} -->\n\n${lines.join("\n")}\n\n`;
    let content;
    if (marker && !rebuild) {
      content = previous.replace(`${marker[0]}\n\n`, block);
      if (content === previous)
        throw new Error(`Expected a blank line after checkpoint in ${path}.`);
    } else {
      const provenance = initialImport(previous);
      content = `# Changelog\n\nChanges recorded automatically from Git history, newest first.\n\n${block.trimEnd()}\n${provenance}`;
    }
    if (content !== previous) updates.push({ path, content, count: commits.length });
  }
  return updates;
}

function main() {
  const updates = generateChangelogs({
    repository: process.env.GITHUB_REPOSITORY,
    branch: process.env.CHANGELOG_BASE_BRANCH ?? "main",
    rebuild: process.argv.includes("--rebuild"),
  });
  for (const { path, content, count } of updates) {
    writeFileSync(path, content);
    console.log(`${path}: ${count} new entries`);
  }
  if (updates.length === 0) console.log("Changelogs are up to date.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
