import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { childEnvironment, loadPolicy, policyPath } from "./config.ts";
import { resolvePi, splitArguments } from "./resolve.ts";

try {
  if (!process.execve) throw new Error("pi-launch requires Node 24+ on macOS or Linux");
  const { isolated, args } = splitArguments(process.argv.slice(2));
  const node = realpathSync(process.execPath);
  if (!isolated) {
    const { entry } = resolvePi();
    process.execve(node, [node, entry, ...args], process.env);
  } else {
    const policy = loadPolicy(policyPath());
    // Re-exec before loading SRT so its host-side helper processes see only this env.
    const supervisor = fileURLToPath(new URL("../bin/supervisor.mjs", import.meta.url));
    process.execve(
      node,
      [node, supervisor, resolve(process.argv[1]), ...args],
      childEnvironment(policy, process.env, node),
    );
  }
} catch (error) {
  console.error(`pi-launch: ${error instanceof Error ? error.message : "launch failed"}`);
  process.exitCode = 1;
}
