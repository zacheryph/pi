import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve beside this installed launcher, never via cwd or the pi name on PATH. */
export function resolvePi(): { entry: string; installation: string } {
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
