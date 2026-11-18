// Bun bundles both phases; SRT is evaluated only after the clean re-exec.
import { supervisorArgv0 } from "../src/resolve.ts";
if (process.argv0 === supervisorArgv0) await import("../src/supervisor.ts");
else await import("../src/cli.ts");
