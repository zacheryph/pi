// Registration checks for the root manifest. A new extension or package is wired in
// three places (a directory, a workspace entry, and for extensions the root
// pi.extensions/pi.skills entries); these checks keep them in agreement, so a
// missing step fails CI instead of silently leaving code out of the bundle.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { workspaceRunner } from "./workspaces.mjs";

const WORKSPACE_ROOTS = ["extensions", "packages"];

/**
 * @typedef {{ name?: string, workspaces?: string[], scripts?: Record<string, string>,
 *   pi?: { extensions?: string[], skills?: string[] } }} Manifest
 * @typedef {{
 *   manifest: Manifest,
 *   directories: string[],
 *   workspaces: Record<string, Manifest | undefined>,
 *   exists: (path: string) => boolean,
 * }} Repository
 */

/** `./a/b/` and `a/b` both become `a/b`. */
const normal = (path) => posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\/|\/$/g, "");

/**
 * Problems with how workspaces are registered, as messages; empty when consistent.
 * @param {Repository} repo
 * @returns {string[]}
 */
export function registrationProblems({ manifest, directories, workspaces, exists }) {
  const problems = [];
  const declared = (manifest.workspaces ?? []).map(normal);
  const rootEntries = (manifest.pi?.extensions ?? []).map(normal);
  const rootSkills = (manifest.pi?.skills ?? []).map(normal);

  for (const dir of directories) {
    if (!declared.includes(dir)) problems.push(`${dir} is not listed in package.json workspaces`);
  }
  const expectedEntries = new Set();
  const expectedSkills = new Set(["skills"]);
  for (const dir of declared) {
    const workspace = workspaces[dir];
    if (!workspace) {
      problems.push(`workspace ${dir} has no package.json`);
      continue;
    }
    const base = posix.basename(dir);
    if (workspace.name !== base) {
      problems.push(`${dir}/package.json name is "${workspace.name}", expected "${base}"`);
    }
    if (!workspaceRunner(dir)) problems.push(`workspace ${dir} has no supported test runner`);
    const entries = (workspace.pi?.extensions ?? []).map((entry) => normal(join(dir, entry)));
    const skills = (workspace.pi?.skills ?? []).map((entry) => normal(join(dir, entry)));
    if (dir.startsWith("packages/") && (entries.length || skills.length)) {
      problems.push(`${dir} is a shared package; move its pi entries to an extension`);
      continue;
    }
    if (dir.startsWith("extensions/") && entries.length === 0) {
      problems.push(`${dir}/package.json declares no pi.extensions entry point`);
    }
    for (const entry of entries) expectedEntries.add(entry);
    for (const skill of skills) expectedSkills.add(skill);
  }

  for (const entry of expectedEntries) {
    if (!rootEntries.includes(entry)) {
      problems.push(`root pi.extensions is missing ./${entry}`);
    }
  }
  for (const entry of rootEntries) {
    if (!expectedEntries.has(entry)) {
      problems.push(`root pi.extensions has ./${entry}, which no extension workspace declares`);
    }
    if (!exists(entry)) problems.push(`root pi.extensions entry ./${entry} does not exist`);
  }
  for (const skill of expectedSkills) {
    if (!rootSkills.includes(skill)) problems.push(`root pi.skills is missing ./${skill}`);
  }
  for (const skill of rootSkills) {
    if (!expectedSkills.has(skill)) {
      problems.push(`root pi.skills has ./${skill}, which no workspace declares`);
    }
  }
  return problems;
}

/**
 * Read the repository at `root` into the shape `registrationProblems` checks.
 * @param {string} root
 * @returns {Repository}
 */
export function readRepository(root) {
  /** @param {string} path @returns {Manifest | undefined} */
  const readManifest = (path) =>
    existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), "utf8")) : undefined;
  const manifest = readManifest("package.json") ?? {};
  const directories = WORKSPACE_ROOTS.flatMap((parent) =>
    existsSync(join(root, parent))
      ? readdirSync(join(root, parent), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${parent}/${entry.name}`)
      : [],
  ).sort();
  /** @type {Record<string, Manifest | undefined>} */
  const workspaces = {};
  for (const dir of (manifest.workspaces ?? []).map(normal)) {
    workspaces[dir] = readManifest(`${dir}/package.json`);
  }
  return { manifest, directories, workspaces, exists: (path) => existsSync(join(root, path)) };
}
