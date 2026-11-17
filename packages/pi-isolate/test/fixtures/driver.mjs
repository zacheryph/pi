// Separate, filtered host process: the test policy path is never a production CLI flag.
import { launch } from "../../src/launch.ts";
import { exitWith } from "../../src/lifecycle.ts";
const abort = new AbortController();
const interrupt = (sig) => abort.abort(sig);
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
let result;
try {
  result = await launch(process.argv.slice(3), process.argv[2], abort.signal);
} catch (error) {
  console.error(error.message);
  result = { code: 1, signal: null };
} finally {
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
}
exitWith(result);
