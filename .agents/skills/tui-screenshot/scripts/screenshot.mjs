#!/usr/bin/env node
/**
 * Screenshot Pi's TUI with this repository's bundle loaded and a scripted model.
 *
 * Runs Pi in a private tmux server with a throwaway agent directory, so the
 * user's settings, sessions and credentials are never read or written. The
 * scenario extension is passed with `-e` and enabled with PI_TUI_SCREENSHOT=1;
 * nothing here is in the bundle manifest.
 *
 *   node screenshot.mjs --scenario <file.ts> --out <file.png> \
 *     [--prompt <text> | --keys <tmux keys> | --wait-for <regex> | --sleep <ms>]... \
 *     [--cols 120] [--rows 40] [--cwd <dir>] [--agent-file <file>]... \
 *     [--symbols-font <file>] [--ansi <file>] [--html <file>] [--keep] [-- <pi args>]
 *
 * Actions run in the order given, after Pi shows the scripted model in its footer.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findSymbolsFont, renderPng } from "./render-ansi.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODEL = "pi-screenshot/screenshot-model";
const ACTIONS = ["prompt", "keys", "wait-for", "sleep"];

const { values, positionals, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    scenario: { type: "string" },
    out: { type: "string" },
    prompt: { type: "string", multiple: true },
    keys: { type: "string", multiple: true },
    "wait-for": { type: "string", multiple: true },
    sleep: { type: "string", multiple: true },
    cols: { type: "string", default: "120" },
    rows: { type: "string", default: "40" },
    cwd: { type: "string", default: root },
    "agent-file": { type: "string", multiple: true },
    timeout: { type: "string", default: "30000" },
    settle: { type: "string", default: "500" },
    scale: { type: "string", default: "2" },
    "symbols-font": { type: "string" },
    ansi: { type: "string" },
    html: { type: "string" },
    pi: { type: "string", default: join(root, "node_modules/.bin/pi") },
    keep: { type: "boolean", default: false },
  },
});

if (!values.scenario || !values.out) {
  console.error(
    "usage: screenshot.mjs --scenario <file.ts> --out <file.png> [actions] [-- pi args]",
  );
  process.exit(2);
}
if (!existsSync(values.pi)) {
  console.error(`Pi not found at ${values.pi}. Run npm install in ${root}.`);
  process.exit(2);
}

const actions = tokens
  .filter((t) => t.kind === "option" && ACTIONS.includes(t.name))
  .map((t) => ({ name: t.name, value: t.value }));
const timeout = Number(values.timeout);
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), "pi-screenshot-"));
const agentDir = join(work, "agent");
mkdirSync(agentDir);
const cwd = realpathSync(resolve(values.cwd));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }, null, 2));
// Answer the project trust prompt up front; this agent directory is deleted afterwards.
writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }, null, 2));
for (const file of values["agent-file"] ?? []) copyFileSync(file, join(agentDir, basename(file)));

writeFileSync(
  join(work, "tmux.conf"),
  [
    "set -g status off",
    "set -g remain-on-exit on",
    "set -g extended-keys on",
    'set -g default-terminal "tmux-256color"',
  ].join("\n"),
);
const KEEP_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "NODE_PATH"];
mkdirSync(join(work, "tmp"));
const env = [
  ...KEEP_ENV.filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`),
  "TERM=tmux-256color",
  // Subagent transcripts and other scratch files land here and are removed with it.
  `TMPDIR=${join(work, "tmp")}`,
  `PI_CODING_AGENT_DIR=${agentDir}`,
  "PI_TUI_SCREENSHOT=1",
  "PI_OFFLINE=1",
];
const piArgs = ["-e", resolve(values.scenario), "--model", MODEL, "--no-session", ...positionals];
writeFileSync(
  join(work, "launch.sh"),
  [
    "#!/bin/sh",
    // A clean environment: no API keys or tokens, so no real provider is available.
    `exec env -i ${env.map(quote).join(" ")} ${quote(values.pi)} ${piArgs.map(quote).join(" ")}`,
  ].join("\n"),
  { mode: 0o755 },
);

const socket = `pi-screenshot-${process.pid}`;
const tmux = (...args) =>
  execFileSync("tmux", ["-L", socket, "-f", join(work, "tmux.conf"), ...args], {
    encoding: "utf8",
  });
const pane = (escapes = false) =>
  tmux("capture-pane", "-p", ...(escapes ? ["-e"] : []), "-t", "pi");

async function waitFor(pattern) {
  const re = new RegExp(pattern);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (re.test(pane())) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeout}ms waiting for /${pattern}/`);
}

let failed = false;
try {
  tmux(
    "new-session",
    "-d",
    "-s",
    "pi",
    "-x",
    values.cols,
    "-y",
    values.rows,
    "-c",
    cwd,
    join(work, "launch.sh"),
  );
  await waitFor("screenshot-model");
  for (const { name, value } of actions) {
    if (name === "prompt") {
      tmux("send-keys", "-t", "pi", "-l", value);
      tmux("send-keys", "-t", "pi", "Enter");
    } else if (name === "keys") tmux("send-keys", "-t", "pi", ...value.split(/\s+/));
    else if (name === "wait-for") await waitFor(value);
    else await sleep(Number(value));
  }
  await sleep(Number(values.settle));
  const capture = pane(true);
  if (values.ansi) writeFileSync(values.ansi, capture);
  await renderPng(capture, values.out, {
    scale: Number(values.scale),
    html: values.html,
    symbolsFont: values["symbols-font"] ?? findSymbolsFont(),
  });
  console.log(values.out);
} catch (error) {
  failed = true;
  console.error(String(error instanceof Error ? error.message : error));
  try {
    console.error(`--- pane ---\n${pane()}`);
  } catch {}
} finally {
  if (values.keep) {
    console.error(`kept: tmux -L ${socket} attach -t pi   (agent dir ${agentDir})`);
  } else {
    try {
      tmux("kill-server");
    } catch {}
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
