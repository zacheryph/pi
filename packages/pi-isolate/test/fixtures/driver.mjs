// Separate, filtered host process: the test policy path is never a production CLI flag.
import { launch } from "../../src/launch.ts";
import { exitWith } from "../../src/lifecycle.ts";
import { compiledPaths, supervisorArgv0, supervisorInvocation } from "../../src/resolve.ts";
if (compiledPaths() && process.argv0 !== supervisorArgv0) {
  const supervisor = supervisorInvocation(process.argv[2], process.argv.slice(3));
  process.execve(supervisor.file, supervisor.argv, process.env);
}
const abort = new AbortController();
const interrupt = (sig) => abort.abort(sig);
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
let result;
try {
  result = await launch(
    process.argv.slice(3),
    process.argv[2],
    abort.signal,
    compiledPaths() ? process.execPath : undefined,
  );
} catch (error) {
  console.error(error.message);
  result = { code: 1, signal: null };
} finally {
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
}
exitWith(result);
