import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { repositoryRoot } from "./workspaces.mjs";

export async function buildLauncher(root = repositoryRoot, probe = false) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("The launcher requires macOS or Linux");
  const { resolvePi, launcherInstallation } = await createJiti(import.meta.url, {
    fsCache: false,
  }).import(join(root, "packages/pi-isolate/src/resolve.ts"));
  const { entry, installation } = resolvePi();
  const outfile = join(root, "packages/pi-isolate/dist", probe ? "pi-isolate-probe" : "pi-launch");
  mkdirSync(dirname(outfile), { recursive: true });
  const paths = {
    node: realpathSync(process.execPath),
    entry,
    installation,
    launcher: launcherInstallation(),
    srt: resolve(
      dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))),
      "..",
    ),
  };
  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--env=disable",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--define",
      `PI_ISOLATE_BUILD=${JSON.stringify(paths)}`,
      join(
        root,
        probe
          ? "packages/pi-isolate/test/fixtures/driver.mjs"
          : "packages/pi-isolate/bin/compiled.mjs",
      ),
      "--outfile",
      outfile,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT") throw new Error("Install Bun to build the native launcher");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bun build failed (${result.signal ?? result.status})`);
  console.log(`Built ${outfile}\nBound to Node ${paths.node} and this trusted checkout.`);
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const probe = process.argv[2] === "--probe";
    if (process.argv.length > (probe ? 3 : 2))
      throw new Error("Usage: npm run build:launcher or npm run probe:launcher");
    const binary = await buildLauncher();
    if (probe) {
      const driver = await buildLauncher(repositoryRoot, true);
      const result = spawnSync("npm", ["run", "probe", "--workspace=pi-isolate"], {
        cwd: repositoryRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          PI_ISOLATE_PROBE_BINARY: driver,
          PI_ISOLATE_LAUNCHER_BINARY: binary,
        },
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
