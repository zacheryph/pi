import { resolve } from "node:path";
import { childEnvironment, loadPolicy, policyPath } from "./config.ts";
import {
  compiledPaths,
  nodeExecutable,
  resolvePi,
  splitArguments,
  supervisorInvocation,
} from "./resolve.ts";

try {
  if (!process.execve) throw new Error("pi-launch requires Node 24+ on macOS or Linux");
  const { isolated, args } = splitArguments(process.argv.slice(2));
  const node = nodeExecutable();
  if (!isolated) {
    const { entry } = resolvePi();
    process.execve(node, [node, entry, ...args], process.env);
  } else {
    const policy = loadPolicy(policyPath());
    // Re-exec before loading SRT so its host-side helper processes see only this env.
    const env = childEnvironment(policy, process.env, node);
    const shim = compiledPaths() ? process.execPath : resolve(process.argv[1]);
    const supervisor = supervisorInvocation(shim, args);
    process.execve(supervisor.file, supervisor.argv, env);
  }
} catch (error) {
  console.error(`pi-launch: ${error instanceof Error ? error.message : "launch failed"}`);
  process.exitCode = 1;
}
