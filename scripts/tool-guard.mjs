#!/usr/bin/env node
// Stops coding agents from running formatters and linters this repository does
// not use. Oxfmt formats and Oxlint lints; Prettier, ESLint, Biome or dprint
// rewrite files to a different style and leave unrelated diffs behind.
//
// Shared by the Claude Code PreToolUse hook (.claude/settings.json runs this
// file) and the project-local Pi extension (.pi/extensions/tool-guard.ts).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Tools this repository does not use, and what to run instead. */
const FOREIGN_TOOLS = {
  prettier: "oxfmt",
  eslint: "oxlint",
  biome: "oxfmt and oxlint",
  dprint: "oxfmt",
};

/** Words that run the command after them: `npx prettier`, `env X=1 eslint`. */
const RUNNERS = new Set([
  "npx",
  "bunx",
  "pnpx",
  "xargs",
  "exec",
  "time",
  "sudo",
  "env",
  "command",
  "nice",
]);
/** Package managers whose subcommands run or install a package. */
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN_SUBCOMMANDS = new Set(["exec", "x", "dlx"]);
const INSTALL_SUBCOMMANDS = new Set(["i", "install", "add"]);

/** Drops heredoc bodies and quoted strings so prose inside them never matches. */
function stripLiterals(command) {
  return command
    .replace(/<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");
}

/** The foreign tool a word names: `./node_modules/.bin/eslint`, `prettier@3`. */
function foreignTool(word) {
  // basename also drops a scope: @biomejs/biome, @fsouza/prettierd.
  const name = basename(word).replace(/@.*$/, "").toLowerCase();
  if (name === "prettierd") return "prettier";
  return Object.hasOwn(FOREIGN_TOOLS, name) ? name : undefined;
}

/** The foreign tool one simple command runs or installs, if any. */
function segmentTool(words) {
  let index = 0;
  const skipFlags = () => {
    while (index < words.length && words[index].startsWith("-")) index += 1;
  };
  while (index < words.length) {
    const word = words[index];
    if (/^\w+=/.test(word) || word === "!" || word === "{") {
      index += 1;
    } else if (RUNNERS.has(word)) {
      index += 1;
      skipFlags();
    } else if (MANAGERS.has(word)) {
      index += 1;
      skipFlags();
      const subcommand = words[index];
      if (subcommand === undefined) return undefined;
      if (INSTALL_SUBCOMMANDS.has(subcommand)) {
        return words
          .slice(index + 1)
          .map(foreignTool)
          .find(Boolean);
      }
      if (RUN_SUBCOMMANDS.has(subcommand)) {
        index += 1;
        skipFlags();
      } else if (word !== "yarn") {
        // Only yarn runs a binary named straight after it: `yarn prettier`.
        return undefined;
      }
    } else {
      return foreignTool(word);
    }
  }
  return undefined;
}

/**
 * Why a shell command must not run here, or undefined when it may.
 * @param {string} command
 * @returns {string | undefined}
 */
export function foreignToolProblem(command) {
  const segments = stripLiterals(command).split(/&&|\|\||[;|&\n()`]|\$\(/);
  for (const segment of segments) {
    const tool = segmentTool(segment.trim().split(/\s+/).filter(Boolean));
    if (tool) return problemMessage(tool);
  }
  return undefined;
}

function problemMessage(tool) {
  return [
    `Blocked: this repository does not use ${tool}; it uses ${FOREIGN_TOOLS[tool]}.`,
    "Format and lint with the root scripts, which use the repository's pinned versions and config:",
    "  npm run fix            # oxfmt, safe oxlint fixes, oxfmt again",
    "  npm run check          # oxfmt --check, oxlint, tsc",
    "  npx oxfmt --write <paths>   # format only these files",
    "If node_modules is missing, run `npm install --ignore-scripts` first.",
    `If ${tool} already rewrote files, restore the ones you did not mean to change with`,
    "`git checkout -- <paths>`, then format your own changes with oxfmt.",
  ].join("\n");
}

/** Claude Code PreToolUse hook: exit 2 blocks the call and shows stderr to the model. */
function runHook() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return 0;
  const problem = foreignToolProblem(command);
  if (!problem) return 0;
  process.stderr.write(`${problem}\n`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runHook();
}
