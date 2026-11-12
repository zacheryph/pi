#!/usr/bin/env node
// Import a third-party Pi extension into extensions/<name>/.
//
// 1. Commits upstream's tree exactly as it is at one commit, and refuses to
//    commit unless the imported directory's Git tree hash equals upstream's.
// 2. Applies the mechanical part of the integration commit and leaves it
//    uncommitted for review: removes upstream CI and lockfiles, marks the
//    package private, writes UPSTREAM.md and CHANGELOG.md, and registers the
//    extension in the root package.json.
//
//   node .agents/skills/import-extension/scripts/import.mjs <pi-name> \
//     --source <git url or local repository> [--ref <commit, tag or branch>] \
//     [--subdir <package directory>] [--after <pi-name>] [--allow-license] \
//     [--trailer "<Key: value>"]... [--no-install]
//
// Run from the repository root with nothing staged. Every check runs before
// anything is written.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(skillDir, "../../..");

/** Licenses that allow copying and modifying without further review. */
const PERMISSIVE = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);
/** Top-level upstream files the integration removes. */
const REMOVED = [
  "tsconfig.json",
  "vitest.config.ts",
  ".github",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];
/** Top-level upstream files worth a look before the integration commit. */
const REVIEW = [
  "AGENTS.md",
  "CLAUDE.md",
  ".agents",
  ".claude",
  ".pi",
  ".husky",
  ".changeset",
  ".npmignore",
  ".vscode",
];
const LICENSE_FILE = /^(licen[cs]e|copying)(\.[a-z]+)?$/i;

function fail(message) {
  console.error(`import: ${message}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    subdir: { type: "string" },
    after: { type: "string" },
    "allow-license": { type: "boolean", default: false },
    trailer: { type: "string", multiple: true, default: [] },
    "no-install": { type: "boolean", default: false },
  },
});

const [name] = positionals;
if (!name || positionals.length > 1) fail("give exactly one extension name, e.g. pi-notes");
if (!/^pi-[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
  fail(`"${name}" must look like pi-<topic> (lowercase, hyphenated)`);
const source = values.source?.trim();
if (!source) fail("--source is required (a git URL or a local repository path)");
const subdir = values.subdir?.replace(/^\/+|\/+$/g, "") || undefined;
for (const trailer of values.trailer)
  if (!/^[A-Za-z-]+: \S/.test(trailer)) fail(`--trailer "${trailer}" must look like "Key: value"`);

/** @param {string[]} args @param {string} [cwd] */
const git = (args, cwd = root) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitBytes = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });

// ---- Checks on this repository ----

const dir = `extensions/${name}`;
if (existsSync(join(root, dir))) fail(`${dir} already exists`);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.workspaces.includes(dir)) fail(`${dir} is already a workspace`);
if (
  values.after &&
  !manifest.pi.extensions.some((entry) => entry.startsWith(`./extensions/${values.after}/`))
)
  fail(`--after ${values.after} is not in pi.extensions`);
try {
  git(["diff", "--cached", "--quiet"]);
} catch {
  fail("something is staged; commit or unstage it so the import commit holds only the import");
}
const formatter = join(root, "node_modules/oxfmt/bin/oxfmt");
if (!existsSync(formatter)) fail("run npm install --ignore-scripts before importing");

// ---- Read upstream ----

const scratch = mkdtempSync(join(tmpdir(), "pi-import-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const upstream = join(scratch, "upstream.git");
try {
  execFileSync("git", ["clone", "--bare", "--quiet", source, upstream], { stdio: "pipe" });
} catch (error) {
  fail(`could not clone ${source}: ${String(error.stderr ?? error).trim()}`);
}
const up = (args) => git(args, upstream);

let sha;
try {
  sha = up(["rev-parse", "--verify", `${values.ref}^{commit}`]);
} catch {
  fail(`${values.ref} is not a commit in ${source}`);
}
const [date, subject] = up(["log", "-1", "--format=%cs%x00%s", sha]).split("\0");
let tree;
try {
  tree = up(["rev-parse", "--verify", subdir ? `${sha}:${subdir}` : `${sha}^{tree}`]);
} catch {
  fail(`${subdir} does not exist at ${sha}`);
}
if (up(["cat-file", "-t", tree]) !== "tree") fail(`${subdir} is a file, not a directory`);

/** @type {Array<{ mode: string, type: string, oid: string, path: string }>} */
const files = up(["ls-tree", "-r", "-z", tree])
  .split("\0")
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split("\t");
    const [mode, type, oid] = meta.split(" ");
    return { mode, type, oid, path };
  });
const submodules = files.filter((file) => file.type === "commit").map((file) => file.path);
if (submodules.length)
  fail(`upstream has submodules, which cannot be copied: ${submodules.join(", ")}`);

const top = (path) => files.find((file) => file.path === path);
const packageFile = top("package.json");
if (!packageFile) fail(`no package.json at ${subdir ?? "the repository root"}`);
const pkg = JSON.parse(gitBytes(["cat-file", "blob", packageFile.oid], upstream).toString("utf8"));
const entries = pkg.pi?.extensions;
if (!Array.isArray(entries) || entries.length === 0)
  fail("upstream package.json has no pi.extensions, so this is not a Pi extension package");

// The package's own license file, or the repository's when a monorepo package has none.
const ownLicense = files.find((file) => !file.path.includes("/") && LICENSE_FILE.test(file.path));
const rootLicense =
  !ownLicense && subdir
    ? up(["ls-tree", "-z", sha])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split("\t");
          return { oid: meta.split(" ")[2], type: meta.split(" ")[1], path };
        })
        .find((file) => file.type === "blob" && LICENSE_FILE.test(file.path))
    : undefined;
if (!ownLicense && !rootLicense) fail("upstream has no license file; it cannot be copied");
const license = typeof pkg.license === "string" ? pkg.license : undefined;
if (!values["allow-license"] && !(license && PERMISSIVE.has(license))) {
  fail(
    `package.json license is ${license ?? "missing"}. Read the license file; if it allows copying and modifying, rerun with --allow-license`,
  );
}

// ---- 1. Verbatim import commit ----

for (const file of files) {
  const target = join(root, dir, file.path);
  mkdirSync(dirname(target), { recursive: true });
  const blob = gitBytes(["cat-file", "blob", file.oid], upstream);
  if (file.mode === "120000") symlinkSync(blob.toString("utf8"), target);
  else {
    writeFileSync(target, blob);
    chmodSync(target, file.mode === "100755" ? 0o755 : 0o644);
  }
}
git(["add", "-f", "--", dir]);
const imported = git(["write-tree", `--prefix=${dir}/`]);
if (imported !== tree) {
  git(["rm", "-r", "-q", "--cached", "--", dir]);
  rmSync(join(root, dir), { recursive: true, force: true });
  fail(
    `the staged copy's tree ${imported} differs from upstream's ${tree}; nothing was committed. A .gitattributes filter in this repository can cause this.`,
  );
}

const web = webUrl(source);
const label = web ? new URL(web).pathname.replace(/^\//, "") : source;
const short = sha.slice(0, 7);
const pkgLabel = `${pkg.name ?? name}${pkg.version ? ` ${pkg.version}` : ""}`;
const message = [
  `chore(${name}): import ${label}@${short} verbatim`,
  "",
  `Unmodified copy of ${web ?? source}${subdir ? ` (${subdir}/)` : ""} at commit ${sha}`,
  `(${pkgLabel}, ${license ?? "see LICENSE"}). Tree ${tree} equals upstream's.`,
  "Not yet registered in the bundle.",
  ...(values.trailer.length ? ["", ...values.trailer] : []),
].join("\n");
execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-F", "-"], {
  cwd: root,
  input: message,
  stdio: ["pipe", "inherit", "inherit"],
});
const importCommit = git(["rev-parse", "--short", "HEAD"]);

// ---- 2. Mechanical integration changes (left uncommitted) ----

const changes = [];
const removed = REMOVED.filter((path) => existsSync(join(root, dir, path)));
for (const path of removed) rmSync(join(root, dir, path), { recursive: true, force: true });
if (removed.length) changes.push(`Removed upstream ${removed.map((p) => `\`${p}\``).join(", ")}.`);

if (rootLicense) {
  writeFileSync(
    join(root, dir, rootLicense.path),
    gitBytes(["cat-file", "blob", rootLicense.oid], upstream),
  );
  changes.push(`\`${rootLicense.path}\`: copied from the upstream repository root.`);
}

const pkgPath = join(root, dir, "package.json");
const local = JSON.parse(readFileSync(pkgPath, "utf8"));
local.private = true;
delete local.publishConfig;
delete local.scripts;
if (Array.isArray(local.files))
  for (const record of ["UPSTREAM.md", "CHANGELOG.md"])
    if (!local.files.includes(record)) local.files.push(record);
writeFileSync(pkgPath, `${JSON.stringify(local, null, 2)}\n`);
changes.push(
  "`package.json`: private, no development scripts or `publishConfig`, `UPSTREAM.md` and `CHANGELOG.md` in `files`.",
);

const today = new Date().toISOString().slice(0, 10);
const hadChangelog = Boolean(top("CHANGELOG.md"));
const sourceChangelog =
  hadChangelog && web ? `${web}/blob/${sha}/${subdir ? `${subdir}/` : ""}CHANGELOG.md` : undefined;
const loads = entries.map((entry) => `\`${entry}\``).join(", ");

writeFileSync(
  join(root, dir, "UPSTREAM.md"),
  `# Vendored ${name}

Imported from [\`${label}\`](${web ?? source})${pkg.description ? `: ${pkg.description.replace(/\.$/, "")}.` : "."}

| | |
| --- | --- |
| Source | ${web ?? source} |
| Directory | ${subdir ? `\`${subdir}\`` : "repository root"} |
| Commit | \`${sha}\` (${date}, "${subject.replaceAll("|", "\\|")}") |
| Tree | \`${tree}\`, equal to the import commit's |
| Version | \`${pkg.name ?? name}\` ${pkg.version ?? "unversioned"} |
| License | ${license ?? "see LICENSE"}; original notice retained in \`${(ownLicense ?? rootLicense).path}\` |
| Imported | ${today}, commit \`${importCommit}\` |

Plain source, not a submodule. The bundle loads ${loads}; do not install the
published \`${pkg.name ?? name}\` package as well.
`,
);

writeFileSync(
  join(root, dir, "CHANGELOG.md"),
  `# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## ${today}: Integration

${[...changes, "`UPSTREAM.md`, `CHANGELOG.md`: added; registered in the root `package.json`."].map((line) => `- ${line}`).join("\n")}

## ${today}: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md).${
    hadChangelog
      ? sourceChangelog
        ? ` Upstream's changelog was cleared at import; for earlier history see the\n[source changelog](${sourceChangelog}).`
        : " Upstream's changelog was cleared at import; its history stays in the source repository."
      : ""
  }
`,
);

manifest.workspaces.push(dir);
const rootEntries = entries.map((entry) => `./${dir}/${entry.replace(/^\.\//, "")}`);
const at = values.after
  ? manifest.pi.extensions.findLastIndex((entry) =>
      entry.startsWith(`./extensions/${values.after}/`),
    ) + 1
  : manifest.pi.extensions.length;
manifest.pi.extensions.splice(at, 0, ...rootEntries);
writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (!values["no-install"]) {
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  });
}
execFileSync(
  process.execPath,
  [
    formatter,
    "--write",
    "package.json",
    `${dir}/package.json`,
    `${dir}/UPSTREAM.md`,
    `${dir}/CHANGELOG.md`,
  ],
  { cwd: root, stdio: "ignore" },
);

// ---- Report what is left ----

const notes = [];
const review = REVIEW.filter((path) => existsSync(join(root, dir, path)));
if (review.length) notes.push(`Review upstream ${review.join(", ")}: keep or remove each.`);
notes.push(
  "Review removed upstream scripts/configs in the import commit; migrate necessary test setup to the shared root tooling.",
);
const monorepo = Object.entries({
  ...local.dependencies,
  ...local.devDependencies,
  ...local.peerDependencies,
})
  .filter(([, version]) => /^(catalog|workspace):/.test(String(version)))
  .map(([dep]) => dep);
if (monorepo.length) notes.push(`Replace catalog:/workspace: versions for ${monorepo.join(", ")}.`);
if (local.devDependencies)
  notes.push(
    "Drop devDependencies the root already provides (oxfmt, oxlint, typescript, Pi packages).",
  );
if (local.dependencies)
  notes.push(
    `Move the dependencies it needs at runtime (${Object.keys(local.dependencies).join(", ")}) to the root package.json; drop build-only ones.`,
  );
const built = entries.filter((entry) => !/\.[cm]?ts$/.test(entry));
if (built.length)
  notes.push(
    `pi.extensions points at ${built.join(", ")}. The bundle has no build step: point the root entry at the TypeScript source.`,
  );

console.log(`
Committed ${importCommit}: ${dir}/ is upstream ${short} verbatim (tree ${tree}).

Integration changes, not committed:
${[...changes, `Wrote ${dir}/UPSTREAM.md and ${dir}/CHANGELOG.md.`, `Registered ${rootEntries.join(", ")} in package.json${values["no-install"] ? "" : " and updated package-lock.json"}.`].map((line) => `  - ${line}`).join("\n")}

Still to do before committing the integration:
${[
  ...notes,
  "Use the root TypeScript project and Vitest projects; fix type errors and adapt tests to the shared conventions.",
  "Assert its tools and commands in scripts/verify-bundle.mjs.",
  "Add it to the root README (layout tree, a section linking UPSTREAM.md and CHANGELOG.md, a License line).",
  "Record anything else you change in the CHANGELOG.md integration entry.",
  `Run: npm run check && npm run test:workspace -- ${dir} && npm run verify:bundle`,
]
  .map((line) => `  - ${line}`)
  .join("\n")}
`);

/** A browsable https URL for a GitHub-style source, or undefined for a local path. */
function webUrl(value) {
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(value)) return value.replace(/\.git$/, "").replace(/\/$/, "");
  return undefined;
}
