#!/usr/bin/env node
/**
 * Regenerate the README screenshots in docs/images/ from the scenarios in
 * scenarios/docs/. Every image is taken in a demo repository (`~/acme-api`, on
 * `main`) under a throwaway HOME, so no path, branch or session of yours shows.
 *
 *   node docs-images.mjs                 # every image
 *   node docs-images.mjs todo-browser ask  # just these
 *   node docs-images.mjs --list
 *
 * Options: --out-dir <dir> (default docs/images), --symbols-font <file>,
 * --jobs <n> (default 4).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const scenarios = resolve(here, "../scenarios/docs");
const PROMPT = "Add retries to the queue worker";
const DASHBOARD = "http://127.0.0.1:7317/";

/**
 * One entry per image: the scenario, then the driver's actions and options in
 * order (nested lists only group them). Wait on text that appears only once the
 * state you want is on screen.
 */
const SHOTS = {
  ask: ["ask.ts", "--prompt", PROMPT, "--wait-for", "Type something"],
  "todo-widget": ["todo.ts", "--prompt", PROMPT, "--wait-for", "Backoff is next"],
  "todo-browser": [
    "todo.ts",
    ["--prompt", PROMPT, "--wait-for", "Backoff is next"],
    ["--prompt", "/todo", "--wait-for", "Read-only task snapshot"],
  ],
  "stash-browser": [
    "stash.ts",
    ["--prompt", PROMPT, "--wait-for", "two failure points"],
    ["--prompt", "/stash", "--wait-for", "queue-failures"],
    ["--keys", "Enter", "--wait-for", "Every place"],
  ],
  job: ["job.ts", "--prompt", PROMPT, "--wait-for", "148 tests pass"],
  "git-worktrees": [
    "git.ts",
    ["--prompt", PROMPT, "--wait-for", "ready for the workers"],
    ["--prompt", "/git:worktrees", "--wait-for", "dead-letter"],
  ],
  attention: [
    "attention.ts",
    ["--prompt", PROMPT, "--wait-for", "armed a watch"],
    ["--prompt", "/attention", "--wait-for", "Esc close"],
  ],
  "system-tools": ["insights.ts", "--prompt", "/system:tools", "--wait-for", "tools ──"],
  tldr: [
    "tldr.ts",
    ["--prompt", PROMPT, "--wait-for", "backoff next"],
    ["--prompt", "/tldr", "--wait-for", "dead-letter queue"],
  ],
  "subagent-widget": ["subagent.ts", "--prompt", PROMPT, "--wait-for", "3 running agents"],
  "subagent-watch": [
    "subagent.ts",
    ["--prompt", PROMPT, "--wait-for", "3 running agents"],
    ["--keys", "C-M-s", "--sleep", "1500"],
  ],
  dashboard: [
    "dashboard.ts",
    ["--prompt", PROMPT, "--wait-for", "Type something"],
    ["--url", DASHBOARD, "--url-wait", "article.card", "--viewport", "760x500"],
    ["--settle", "1500"],
  ],
  "dashboard-detail": [
    "dashboard.ts",
    ["--prompt", PROMPT, "--wait-for", "Type something"],
    ["--url", DASHBOARD, "--url-wait", "article.card", "--url-click", "article.card"],
    ["--viewport", "1280x1000", "--settle", "1500"],
  ],
};
// Both open the dashboard's fixed port, so they cannot run at the same time.
const EXCLUSIVE = new Set(["dashboard", "dashboard-detail"]);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: "boolean", default: false },
    "out-dir": { type: "string", default: join(root, "docs/images") },
    "symbols-font": { type: "string" },
    jobs: { type: "string", default: "4" },
  },
});

if (values.list) {
  console.log(Object.keys(SHOTS).join("\n"));
  process.exit(0);
}
const names = positionals.length ? positionals : Object.keys(SHOTS);
const unknown = names.filter((name) => !SHOTS[name]);
if (unknown.length) {
  console.error(`unknown image: ${unknown.join(", ")} (see --list)`);
  process.exit(2);
}

// A short HOME keeps the paths tools print (job logs, worktrees) readable.
const work = mkdtempSync(join(tmpdir(), "pi-docs-"));
const home = join(work, "home");
const repo = join(home, "acme-api");
const files = {
  "README.md": "# acme-api\n\nOrders service.\n",
  "package.json": '{ "name": "acme-api", "scripts": { "test": "vitest" } }\n',
  "src/auth/token.ts": "export function verify(token: string) {\n  return token.length > 0;\n}\n",
  "src/queue/worker.ts":
    "export async function retry(job: () => Promise<void>) {\n  return job();\n}\n",
  "test/worker.test.ts": "// TODO: cover a failing job\n",
};
for (const [file, content] of Object.entries(files)) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
}
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git(
  "-c",
  "user.name=demo",
  "-c",
  "user.email=demo@example.com",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-qm",
  "Initial commit",
);

// Pi warns in the transcript when `fd` is missing; Debian names it fdfind.
const bin = join(work, "bin");
mkdirSync(bin);
const which = (cmd) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
if (!which("fd") && which("fdfind")) symlinkSync(which("fdfind"), join(bin, "fd"));
if (!which("fd") && !which("fdfind"))
  console.warn("fd is not installed: Pi will warn in each image.");

mkdirSync(values["out-dir"], { recursive: true });
const driver = join(here, "screenshot.mjs");

function shoot(name) {
  const [scenario, ...args] = SHOTS[name].flat();
  const out = join(values["out-dir"], `${name}.png`);
  const argv = [
    driver,
    "--scenario",
    join(scenarios, scenario),
    "--cwd",
    repo,
    "--out",
    out,
    "--cols",
    "100",
    "--rows",
    "30",
    ...(values["symbols-font"] ? ["--symbols-font", values["symbols-font"]] : []),
    ...args,
  ];
  return new Promise((done) => {
    let log = "";
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    child.on("close", (code) => {
      console.log(code === 0 ? `ok    ${out}` : `FAIL  ${name}\n${log}`);
      done(code === 0);
    });
  });
}

let failed = 0;
try {
  const parallel = names.filter((name) => !EXCLUSIVE.has(name));
  const queue = [...parallel];
  const workers = Array.from({ length: Math.max(1, Number(values.jobs)) }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) if (!(await shoot(name))) failed++;
  });
  await Promise.all(workers);
  for (const name of names.filter((n) => EXCLUSIVE.has(n))) if (!(await shoot(name))) failed++;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
