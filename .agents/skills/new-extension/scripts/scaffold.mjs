#!/usr/bin/env node
// Scaffold a first-party extension from ../templates and register it in the
// bundle: root package.json, scripts/verify-bundle.mjs, README layout and section.
//
//   node .agents/skills/new-extension/scripts/scaffold.mjs <pi-name> \
//     --description "<one line>" [--tool <name>]... [--command <name>]... \
//     [--after <pi-name>] [--no-tui] [--no-install]
//
// Run from the repository root. It refuses to touch anything when a check fails.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templates = join(skillDir, "templates");
const root = resolve(skillDir, "../../..");
// The smallest first-party extension; its pins are the bundle's current ones.
const PIN_SOURCE = "extensions/pi-tldr/package.json";
const TYPEBOX_SOURCE = "extensions/pi-todo/package.json";

function fail(message) {
  console.error(`scaffold: ${message}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: "string" },
    tool: { type: "string", multiple: true, default: [] },
    command: { type: "string", multiple: true, default: [] },
    after: { type: "string" },
    "no-tui": { type: "boolean", default: false },
    "no-install": { type: "boolean", default: false },
  },
});

const [name] = positionals;
if (!name || positionals.length > 1) fail("give exactly one extension name, e.g. pi-notes");
if (!/^pi-[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(`"${name}" must look like pi-<topic> (lowercase, hyphenated)`);
const description = values.description?.trim();
if (!description) fail("--description is required");
if (/[\r\n]|\*\//.test(description)) fail("--description must be one line and must not contain */");
for (const tool of values.tool) if (!/^[a-z][a-z0-9_]*$/.test(tool)) fail(`tool "${tool}" must be snake_case`);
for (const command of values.command) if (!/^[a-z][a-z0-9:-]*$/.test(command)) fail(`command "${command}" must be lowercase (a-z, 0-9, ':' and '-')`);

const dir = `extensions/${name}`;
const entry = `./${dir}/src/index.ts`;
const read = (path) => readFileSync(join(root, path), "utf8");
if (existsSync(join(root, dir))) fail(`${dir} already exists`);

const manifest = JSON.parse(read("package.json"));
if (manifest.workspaces.includes(dir)) fail(`${dir} is already a workspace`);
if (values.after && !manifest.pi.extensions.includes(`./extensions/${values.after}/src/index.ts`)) {
  fail(`--after ${values.after} is not in pi.extensions`);
}

const verify = read("scripts/verify-bundle.mjs");
const TOOL_ANCHOR = "  ]) {\n    assert.ok(tools.includes(name), `Missing tool: ${name}`);";
const COMMAND_ANCHOR = "  ]) {\n    assert.ok(commands.includes(name), `Missing command: ${name}`);";
if (!verify.includes(TOOL_ANCHOR) || !verify.includes(COMMAND_ANCHOR)) {
  fail("scripts/verify-bundle.mjs no longer has the tool/command lists this script edits; update the script");
}
for (const tool of values.tool) if (verify.includes(`"${tool}",`)) fail(`tool "${tool}" is already asserted by another extension`);
for (const command of values.command) if (verify.includes(`"${command}",`)) fail(`command "${command}" is already asserted by another extension`);

const readme = read("README.md");
const TREE_ROW = /^│   ([├└])── (pi-[a-z0-9-]+)\/.*$/;
if (!readme.split("\n").some((line) => TREE_ROW.test(line))) fail("README.md layout tree not found");
if (!readme.includes("\n## Extensions\n") || !readme.includes("\n## Skills\n")) fail("README.md Extensions section not found");

// ---- Render templates ----

const tsx = values.tool.length > 0;
const factory = name.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
  if (!(key in vars)) fail(`template variable {{${key}}} has no value`);
  return vars[key];
});
const template = (path) => readFileSync(join(templates, `${path}.tmpl`), "utf8");
const each = (items, path, key, extra = () => ({})) =>
  items.map((item) => fill(template(path), { [key]: item, ...extra(item) })).join("");
const label = (tool) => tool.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");

const surface = [
  values.tool.length ? `Tools: ${values.tool.map((t) => `\`${t}\``).join(", ")}.` : "",
  values.command.length ? `Commands: ${values.command.map((c) => `\`/${c}\``).join(", ")}.` : "",
].filter(Boolean).join(" ") || "No tools or commands yet.";

const vars = {
  name,
  description,
  factory,
  surface,
  imports: tsx
    ? 'import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";\nimport { Type } from "typebox";'
    : 'import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";',
  registrations:
    each(values.tool, "snippets/tool.ts", "tool", (tool) => ({ toolLabel: label(tool) })) +
    each(values.command, "snippets/command.ts", "command"),
  registrationTests:
    each(values.tool, "snippets/tool.test.ts", "tool") +
    each(values.command, "snippets/command.test.ts", "command"),
};

const pins = JSON.parse(read(PIN_SOURCE)).devDependencies;
const typeboxPin = JSON.parse(read(TYPEBOX_SOURCE)).devDependencies.typebox;
const piPackages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", ...(values["no-tui"] ? [] : ["@earendil-works/pi-tui"])];
const peer = Object.fromEntries([...piPackages, ...(tsx ? ["typebox"] : [])].map((pkg) => [pkg, "*"]));
const dev = Object.fromEntries([
  ...piPackages.map((pkg) => [pkg, pins[pkg]]),
  ...(tsx ? [["typebox", typeboxPin]] : []),
  ["@types/node", pins["@types/node"]],
  ["typescript", pins.typescript],
  ["vitest", pins.vitest],
]);
for (const [pkg, version] of Object.entries(dev)) if (!version) fail(`no pin for ${pkg} in ${PIN_SOURCE}`);

const files = {
  "package.json": `${JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    description,
    keywords: ["pi-package", "pi-extension"],
    files: ["src", "README.md"],
    peerDependencies: peer,
    engines: { node: manifest.engines?.node ?? ">=24" },
    scripts: { check: "tsc --noEmit", test: "vitest run", "test:watch": "vitest" },
    devDependencies: dev,
    pi: { extensions: ["./src/index.ts"] },
  }, null, 2)}\n`,
};
const walk = (sub = "") => readdirSync(join(templates, sub), { withFileTypes: true }).flatMap((item) => {
  const path = sub ? `${sub}/${item.name}` : item.name;
  if (item.isDirectory()) return path === "snippets" ? [] : walk(path);
  return [path.replace(/\.tmpl$/, "")];
});
for (const path of walk()) files[path] = fill(template(path), vars);

// ---- Edit the repository files (all checks passed above) ----

for (const [path, text] of Object.entries(files)) {
  const target = join(root, dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

manifest.workspaces.push(dir);
const at = values.after ? manifest.pi.extensions.indexOf(`./extensions/${values.after}/src/index.ts`) + 1 : manifest.pi.extensions.length;
manifest.pi.extensions.splice(at, 0, entry);
writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const asserted = (names) => names.map((n) => `    "${n}",\n`).join("");
writeFileSync(join(root, "scripts/verify-bundle.mjs"), verify
  .replace(TOOL_ANCHOR, `${asserted(values.tool)}${TOOL_ANCHOR}`)
  .replace(COMMAND_ANCHOR, `${asserted(values.command)}${COMMAND_ANCHOR}`));

writeFileSync(join(root, "README.md"), addSection(addTreeRow(readme)));

if (!values["no-install"]) {
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
}

console.log(`
Created ${dir}/ (${Object.keys(files).join(", ")}).
Registered it in package.json, scripts/verify-bundle.mjs and README.md${values["no-install"] ? "" : ", and updated package-lock.json"}.
Changed: ${["package.json", "scripts/verify-bundle.mjs", "README.md", ...(values["no-install"] ? [] : ["package-lock.json"])].join(", ")}.

Next: implement src/index.ts, extend the tests, and expand the README section. Then:
  npm run check -w ${dir} && npm test -w ${dir} && npm run verify:bundle${values["no-install"] ? "\n  (run npm install --ignore-scripts first: the lockfile is not updated)" : ""}
`);

// ---- README helpers ----

/** Insert the extension into the layout tree, keeping its rows sorted. */
function addTreeRow(text) {
  const lines = text.split("\n");
  const rows = lines.flatMap((line, index) => {
    const match = TREE_ROW.exec(line);
    return match ? [{ index, last: match[1] === "└", name: match[2] }] : [];
  });
  const block = [
    `│   ├── ${name}/`,
    `│   │   ├── src/index.ts`,
    `│   │   └── test/`,
  ];
  const next = rows.find((row) => row.name > name);
  if (next) {
    lines.splice(next.index, 0, ...block);
    return lines.join("\n");
  }
  // New last entry: the old last row and its children gain a continuing rail.
  const last = rows[rows.length - 1];
  let end = last.index + 1;
  while (end < lines.length && lines[end].startsWith("│       ")) {
    lines[end] = `│   │   ${lines[end].slice("│       ".length)}`;
    end++;
  }
  lines[last.index] = lines[last.index].replace("│   └── ", "│   ├── ");
  lines.splice(end, 0, `│   └── ${name}/`, `│       ├── src/index.ts`, `│       └── test/`);
  return lines.join("\n");
}

/** Insert a `### <name>` section under ## Extensions, keeping sections sorted. */
function addSection(text) {
  const start = text.indexOf("\n## Extensions\n");
  const end = text.indexOf("\n## Skills\n", start);
  const section = `### ${name}\n\n${description} ${surface === "No tools or commands yet." ? "" : `${surface} `}See [extension docs](${dir}/README.md).\n\n`;
  const heading = /\n### (\S+)\n/g;
  heading.lastIndex = start;
  for (let match = heading.exec(text); match && match.index < end; match = heading.exec(text)) {
    if (match[1] > name) return text.slice(0, match.index + 1) + section + text.slice(match.index + 1);
  }
  return `${text.slice(0, end + 1)}${section}${text.slice(end + 1)}`;
}
