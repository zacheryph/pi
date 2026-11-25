// Dependency direction from AGENTS.md: packages never depend on or import
// extensions. Extensions build on packages; a package that reached back into an
// extension would tie every consumer of that package to the extension's
// internals (the way pi-presentation once knew pi-todo, pi-stash, pi-git,
// pi-subagent and pi-ask). The two clients outside Pi follow the same rule: the
// bb plugin and the dashboard's standalone hub reach the repository only
// through pi-surface's portable models.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const MANIFEST_DEPENDENCIES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Plain string order, the same in every locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `a\b` and `a/b` both become `a/b`, relative to `root`. */
const rel = (root, path) => relative(root, path).split(sep).join("/");

/** The package name a bare specifier names: `pi-todo/src/x` -> `pi-todo`, `@a/b/c` -> `@a/b`. */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Every module specifier a source file names: static imports and re-exports
 * (type-only ones included: a type is a dependency too), side-effect imports,
 * dynamic `import()` and `require()`.
 * @param {string} text
 * @returns {string[]}
 */
export function importSpecifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const patterns = [
    /^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Every string inside a manifest field, however deeply nested (conditional exports and imports). */
function strings(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Source files under `dir`, skipping dependencies. */
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const subdirectories = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(dir, entry.name))
    : [];

/**
 * The repository's workspaces by package name: every directory with a package.json under
 * `extensions/` and `packages/`, registered or not.
 * @param {string} root
 * @returns {Map<string, { dir: string, kind: "extension" | "package", manifest: any }>}
 */
export function readWorkspaceMap(root) {
  const map = new Map();
  for (const [parent, kind] of [
    ["extensions", "extension"],
    ["packages", "package"],
  ]) {
    for (const dir of subdirectories(join(root, parent))) {
      const path = join(dir, "package.json");
      if (!existsSync(path)) continue;
      const manifest = readJson(path);
      map.set(manifest.name ?? rel(root, dir), { dir, kind, manifest });
    }
  }
  return map;
}

/**
 * Problems with packages reaching into extensions, as messages; empty when none.
 * Checks each package's manifest (dependency fields, `imports`, `exports`) for an
 * extension's name or a path into `extensions/`, and each of its source files for a
 * bare import of an extension or a relative import that lands in `extensions/`.
 * @param {string} root
 * @returns {string[]}
 */
export function packageBoundaryProblems(root) {
  const workspaces = readWorkspaceMap(root);
  const extensions = new Set(
    [...workspaces].filter(([, ws]) => ws.kind === "extension").map(([name]) => name),
  );
  const extensionRoot = join(root, "extensions") + sep;
  const intoExtensions = (from, target) =>
    (target.startsWith(".") || target.startsWith("file:")) &&
    resolve(from, target.replace(/^file:/, "")).startsWith(extensionRoot);
  const problems = [];
  for (const [name, ws] of workspaces) {
    if (ws.kind !== "package") continue;
    const where = rel(root, join(ws.dir, "package.json"));
    for (const field of MANIFEST_DEPENDENCIES) {
      for (const [dependency, version] of Object.entries(ws.manifest[field] ?? {})) {
        if (extensions.has(dependency) || intoExtensions(ws.dir, String(version)))
          problems.push(`${where}: ${field} names extension ${dependency}`);
      }
    }
    for (const field of ["imports", "exports"]) {
      for (const target of strings(ws.manifest[field])) {
        if (extensions.has(packageName(target)) || intoExtensions(ws.dir, target))
          problems.push(`${where}: ${field} maps to extension ${target}`);
      }
    }
    for (const file of sourceFiles(ws.dir)) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (
          extensions.has(packageName(specifier)) ||
          (specifier.startsWith(".") && resolve(dirname(file), specifier).startsWith(extensionRoot))
        )
          problems.push(`${rel(root, file)}: package ${name} imports extension code ${specifier}`);
      }
    }
  }
  return problems;
}

/**
 * Follows every import from `entries`, resolving relative paths, `#` import maps (from the
 * nearest package.json), `aliases` and this repository's workspaces by name through their
 * `exports`. Other bare names are outside the repository and end the walk.
 * @param {string} root
 * @param {string[]} entries absolute paths
 * @param {{ aliases?: Record<string, string> }} [options] prefix -> absolute directory
 * @returns {{ files: string[], external: string[], problems: string[] }}
 */
export function importGraph(root, entries, options = {}) {
  const workspaces = readWorkspaceMap(root);
  const files = new Set();
  const external = new Set();
  const problems = [];
  const asFile = (path) => {
    // TypeScript sources may name their siblings by the emitted `.js`.
    const stem = path.replace(/\.[cm]?js$/, "");
    for (const candidate of [
      path,
      ...(stem !== path ? [`${stem}.ts`, `${stem}.tsx`] : []),
      `${path}.ts`,
      `${path}.tsx`,
      `${path}.mjs`,
      `${path}.js`,
      join(path, "index.ts"),
      join(path, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  };
  /** `pattern` with one `*` matched against `key`, or an exact key. */
  const mapped = (map, key) => {
    if (typeof map === "string") return key === "." ? map : undefined;
    for (const [pattern, target] of Object.entries(map ?? {})) {
      const value = strings(target)[0];
      if (value === undefined) continue;
      if (!pattern.includes("*")) {
        if (pattern === key) return value;
        continue;
      }
      const [head, tail] = pattern.split("*");
      if (key.startsWith(head) && key.endsWith(tail) && key.length >= head.length + tail.length)
        return value.replace("*", key.slice(head.length, key.length - tail.length));
    }
    return undefined;
  };
  const nearestManifest = (file) => {
    for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
      const path = join(dir, "package.json");
      if (existsSync(path)) return { dir, manifest: readJson(path) };
      if (dir === root) break;
    }
    return undefined;
  };
  const resolveSpecifier = (from, specifier) => {
    if (specifier.startsWith("node:")) return { external: specifier };
    if (specifier.startsWith(".") || specifier.startsWith("/"))
      return { file: asFile(resolve(dirname(from), specifier)) };
    for (const [prefix, dir] of Object.entries(options.aliases ?? {})) {
      if (specifier.startsWith(prefix))
        return { file: asFile(join(dir, specifier.slice(prefix.length))) };
    }
    if (specifier.startsWith("#")) {
      const owner = nearestManifest(from);
      const target = owner && mapped(owner.manifest.imports, specifier);
      if (target === undefined) return { file: undefined };
      if (target.startsWith(".")) return { file: asFile(resolve(owner.dir, target)) };
      return resolveSpecifier(from, target);
    }
    const name = packageName(specifier);
    const ws = workspaces.get(name);
    if (!ws) return { external: specifier };
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = mapped(ws.manifest.exports, subpath);
    return { file: target === undefined ? undefined : asFile(resolve(ws.dir, target)) };
  };
  const queue = entries.map((entry) => resolve(entry));
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const found = resolveSpecifier(file, specifier);
      if (found.external !== undefined) external.add(found.external);
      else if (found.file === undefined)
        problems.push(`${rel(root, file)}: cannot resolve ${specifier}`);
      else queue.push(found.file);
    }
  }
  return { files: [...files].sort(byCodeUnit), external: [...external].sort(byCodeUnit), problems };
}

/**
 * Problems with what a client outside Pi can reach, as messages: every file its
 * `entries` import, types included, must lie under one of `allowed` (absolute
 * directories or files), and an `externalAllowed` test, when given, limits what may
 * come from outside the repository.
 * @param {string} root
 * @param {{ name: string, entries: string[], allowed: string[],
 *   aliases?: Record<string, string>, externalAllowed?: (specifier: string) => boolean }} client
 * @returns {string[]}
 */
export function clientProblems(root, client) {
  const graph = importGraph(root, client.entries, { aliases: client.aliases });
  const inside = (file) =>
    client.allowed.some((path) => file === path || file.startsWith(path + sep));
  return [
    ...graph.problems.map((problem) => `${client.name}: ${problem}`),
    ...graph.files
      .filter((file) => !inside(file))
      .map((file) => `${client.name} reaches ${rel(root, file)}`),
    ...graph.external
      .filter((specifier) => client.externalAllowed && !client.externalAllowed(specifier))
      .map((specifier) => `${client.name} imports ${specifier} from outside the repository`),
  ];
}

/**
 * This repository's two clients outside Pi. bb's plugin builds against pi-surface's
 * models only; the dashboard hub runs under plain Node, so it reaches only its own
 * hub and protocol modules, pi-surface and Node's built-ins.
 * @param {string} root
 */
export function repositoryClients(root) {
  const surface = join(root, "packages", "pi-surface", "src");
  const plugin = join(root, "bb-plugin");
  const dashboard = join(root, "extensions", "pi-dashboard", "src");
  const pluginSources = sourceFiles(plugin).filter(
    (file) => !file.startsWith(join(plugin, "test") + sep),
  );
  return [
    {
      name: "bb-plugin",
      entries: pluginSources,
      allowed: [plugin, surface],
      aliases: { "@/": plugin },
    },
    {
      name: "dashboard hub",
      entries: [join(dashboard, "hub", "server.ts")],
      allowed: [join(dashboard, "hub"), join(dashboard, "protocol.ts"), surface],
      externalAllowed: (specifier) => specifier.startsWith("node:"),
    },
  ];
}

/**
 * Every boundary problem in the repository at `root`, as messages.
 * @param {string} root
 * @returns {string[]}
 */
export function boundaryProblems(root) {
  const plugin = join(root, "bb-plugin", "package.json");
  const workspaces = readWorkspaceMap(root);
  const pluginManifest = existsSync(plugin) ? readJson(plugin) : {};
  const pluginDependencies = MANIFEST_DEPENDENCIES.flatMap((field) =>
    Object.keys(pluginManifest[field] ?? {}).map((name) => ({ field, name })),
  )
    .filter(({ name }) => workspaces.has(name) && name !== "pi-surface")
    .map(({ field, name }) => `bb-plugin/package.json: ${field} names ${name}, not pi-surface`);
  return [
    ...packageBoundaryProblems(root),
    ...pluginDependencies,
    ...repositoryClients(root).flatMap((client) => clientProblems(root, client)),
  ];
}
