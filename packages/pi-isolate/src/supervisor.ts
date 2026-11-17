import { policyPath } from "./config.ts";
import { launch } from "./launch.ts";
import { exitWith } from "./lifecycle.ts";

const cancellation = new AbortController();
const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
const interrupt = (signal: NodeJS.Signals) => cancellation.abort(signal);
for (const signal of signals) process.on(signal, interrupt);
let result;
try {
  result = await launch(process.argv.slice(3), policyPath(), cancellation.signal, process.argv[2]);
} catch (error) {
  if (!cancellation.signal.aborted)
    console.error(`pi-launch: ${error instanceof Error ? error.message : "sandbox setup failed"}`);
  result = {
    code: 1,
    signal: cancellation.signal.aborted ? (cancellation.signal.reason as NodeJS.Signals) : null,
  };
} finally {
  for (const signal of signals) process.off(signal, interrupt);
}
exitWith(result);
