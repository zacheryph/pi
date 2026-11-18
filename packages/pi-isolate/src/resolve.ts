import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Replaced by the local Bun build. Paths bind the binary to its trusted install.
declare const PI_ISOLATE_BUILD:
  | { node: string; entry: string; installation: string; launcher: string; srt: string }
  | undefined;

export function compiledPaths() {
  return typeof PI_ISOLATE_BUILD === "undefined" ? undefined : PI_ISOLATE_BUILD;
}

export const supervisorArgv0 = "pi-isolate:supervisor";

export function supervisorInvocation(shim: string, args: string[]) {
  if (compiledPaths()) return { file: process.execPath, argv: [supervisorArgv0, shim, ...args] };
  const node = nodeExecutable();
  const supervisor = fileURLToPath(new URL("../bin/supervisor.mjs", import.meta.url));
  return { file: node, argv: [node, supervisor, shim, ...args] };
}

/** Pi continues using Node even when the host launcher is compiled with Bun. */
export function nodeExecutable(): string {
  return realpathSync(compiledPaths()?.node ?? process.execPath);
}

/** Resolve beside this installed launcher, never via cwd or the pi name on PATH. */
export function resolvePi(): { entry: string; installation: string } {
  const compiled = compiledPaths();
  if (compiled)
    return {
      entry: realpathSync(compiled.entry),
      installation: realpathSync(compiled.installation),
    };
  let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (typeof bin !== "string") throw new Error("Installed Pi has no pi bin entry");
        const entry = realpathSync(resolve(directory, bin));
        if (!entry.startsWith(`${realpathSync(directory)}/`))
          throw new Error("Pi bin escapes its package");
        return { entry, installation: realpathSync(directory) };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot resolve installed Pi package metadata");
    directory = parent;
  }
}

/** Protect the complete dependency tree, including workspace installations. */
export function launcherInstallation(): string {
  const compiled = compiledPaths();
  if (compiled) return realpathSync(compiled.launcher);
  let directory = dirname(fileURLToPath(import.meta.url));
  while (dirname(directory) !== directory) {
    if (existsSync(join(directory, "node_modules"))) return realpathSync(directory);
    directory = dirname(directory);
  }
  throw new Error("Cannot locate trusted launcher dependency tree");
}

export function quoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function splitArguments(argv: string[]): { isolated: boolean; args: string[] } {
  const isolated = argv[0] === "--isolate";
  return { isolated, args: isolated ? argv.slice(1) : argv };
}

/** Host helpers may be symlinks outside their PATH directory. Protect their real files too. */
export function helperPaths(path: string): string[] {
  const found: string[] = [];
  for (const command of ["bash", "sh", "rg", "socat", "bwrap", "ps", "uname", "which", "log"]) {
    for (const directory of path.split(":")) {
      const candidate = join(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        const real = realpathSync(candidate);
        found.push(real, dirname(real));
        break;
      } catch {
        /* SRT reports missing required helpers. */
      }
    }
  }
  return found;
}
