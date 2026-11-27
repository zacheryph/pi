#!/usr/bin/env node
// `rails stats` for this repository: code and test lines per workspace.
// Counts non-blank, non-comment lines of source files (ts, tsx, mts, js, mjs).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readWorkspaces, repositoryRoot } from "./workspaces.mjs";

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP = new Set(["node_modules", "dist", "coverage", ".git"]);
const isTest = (rel) => /(?:^|\/)test\//.test(rel) || /\.(?:test|spec)\.[^/]+$/.test(rel);

/** Count lines that are neither blank nor entirely comment. */
export function countLines(text) {
  let count = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    while (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end === -1) {
        inBlock = true;
        line = "";
      } else line = line.slice(end + 2).trim();
    }
    if (line && !line.startsWith("//")) count++;
  }
  return count;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

export function collect(root = repositoryRoot) {
  const targets = [...readWorkspaces(root).map(({ path }) => path), "bb-plugin", "scripts"];
  return targets.map((path) => {
    const row = { path, code: 0, test: 0, files: 0, testFiles: 0 };
    for (const file of walk(join(root, path))) {
      const lines = countLines(readFileSync(file, "utf8"));
      if (isTest(relative(join(root, path), file)) || path === "test") {
        row.test += lines;
        row.testFiles++;
      } else {
        row.code += lines;
        row.files++;
      }
    }
    return row;
  });
}

export function render(rows) {
  const groups = [
    ["extensions/", "Extensions"],
    ["packages/", "Packages"],
    ["", "Other"],
  ];
  const nameWidth = Math.max(...rows.map((r) => r.path.length), 5);
  const num = (n) => String(n).padStart(8);
  const ratio = (r) => (r.code ? (r.test / r.code).toFixed(2) : "-").padStart(7);
  const header = `${"".padEnd(nameWidth)}${"Code".padStart(8)}${"Test".padStart(8)}${"Files".padStart(8)}${"Tests".padStart(8)}${"T:C".padStart(7)}`;
  const rule = "-".repeat(header.length);
  const line = (name, r) =>
    `${name.padEnd(nameWidth)}${num(r.code)}${num(r.test)}${num(r.files)}${num(r.testFiles)}${ratio(r)}`;
  const sum = (list) =>
    list.reduce(
      (a, r) => ({
        code: a.code + r.code,
        test: a.test + r.test,
        files: a.files + r.files,
        testFiles: a.testFiles + r.testFiles,
      }),
      { code: 0, test: 0, files: 0, testFiles: 0 },
    );

  const out = [header, rule];
  const seen = new Set();
  for (const [prefix, title] of groups) {
    const list = rows.filter((r) => !seen.has(r) && (prefix ? r.path.startsWith(prefix) : true));
    if (!list.length) continue;
    list.forEach((r) => seen.add(r));
    out.push(title);
    for (const r of list) out.push(line(`  ${r.path}`, r));
    out.push(line(`  ${title} total`, sum(list)), "");
  }
  out.push(rule, line("Total", sum(rows)));
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(render(collect()));
