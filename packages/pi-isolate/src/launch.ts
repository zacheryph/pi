import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Disposers, attachedChild, checkProcessTable } from "./lifecycle.ts";
import type { Exit } from "./lifecycle.ts";
import { contains, loadPolicy, PolicyError, preparePolicy } from "./config.ts";
import { helperPaths, launcherInstallation, quoteArg, resolvePi } from "./resolve.ts";

/** Run only in a dedicated supervisor with an already filtered host environment. */
export async function launch(
  args: string[],
  path: string,
  abort: AbortSignal,
  shim?: string,
): Promise<Exit> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("isolation requires macOS or Linux");
  abort.throwIfAborted();
  const node = realpathSync(process.execPath);
  const { entry, installation } = resolvePi();
  const policy = loadPolicy(path);
  const protectedPaths = [
    ...(shim ? [shim] : []),
    launcherInstallation(),
    installation,
    node,
    dirname(node),
    ...process.env.PATH!.split(":"),
    ...helperPaths(process.env.PATH!),
  ];
  const resources = new Disposers();
  const privateDir = mkdtempSync(join(realpathSync("/tmp"), "pi-isolate-"));
  resources.add(() => rmSync(privateDir, { recursive: true, force: true }));
  try {
    policy.sandbox.filesystem.allowWrite.push(privateDir);
    const config = preparePolicy(policy, path, process.cwd(), protectedPaths);
    if (
      [...config.filesystem.denyRead, ...config.filesystem.denyWrite].some((p) =>
        contains(p as string, privateDir),
      )
    ) {
      throw new PolicyError(
        path,
        "sandbox.filesystem",
        "denials prevent use of the private temporary directory",
      );
    }
    process.env.TMPDIR = privateDir;
    const {
      SandboxManager: manager,
      SandboxRuntimeConfigSchema,
      getDefaultWritePaths,
    } = await import("@anthropic-ai/sandbox-runtime");
    // SRT also grants a few convenience directories. Include them in layout checks.
    preparePolicy(
      {
        ...policy,
        sandbox: {
          ...policy.sandbox,
          filesystem: {
            ...policy.sandbox.filesystem,
            allowWrite: getDefaultWritePaths().filter((p) => !p.startsWith("/dev/")),
          },
        },
      },
      path,
      process.cwd(),
      protectedPaths,
    );
    const validated = SandboxRuntimeConfigSchema.safeParse(config);
    if (!validated.success) {
      // Zod messages can contain values. Only schema field paths are safe to show.
      const fields = validated.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`${path}: invalid sandbox fields: ${fields}`);
    }
    const deps = await manager.checkDependenciesAsync();
    if (deps.errors.length) throw new Error(`sandbox prerequisites: ${deps.errors.join("; ")}`);
    checkProcessTable();
    resources.add(() => manager.reset());
    const signals = ["SIGINT", "SIGTERM"] as const;
    const existing = new Map(signals.map((sig) => [sig, new Set(process.listeners(sig))]));
    try {
      await manager.initialize(validated.data, undefined, false);
    } finally {
      // SRT eagerly resets on signals. Stop Pi before resetting the boundary.
      for (const sig of signals)
        for (const handler of process.listeners(sig)) {
          if (!existing.get(sig)!.has(handler)) process.removeListener(sig, handler);
        }
    }
    abort.throwIfAborted();
    const command = ["/usr/bin/env", `TMPDIR=${privateDir}`, node, entry, ...args]
      .map(quoteArg)
      .join(" ");
    const wrapped = await manager.wrapWithSandbox(`exec ${command}`, "/bin/bash", undefined, abort);
    abort.throwIfAborted();
    const child = attachedChild(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", wrapped],
      { cwd: process.cwd(), env: process.env },
      abort,
    );
    resources.add(() => child.stop());
    return await child.done;
  } finally {
    await resources.close();
  }
}
