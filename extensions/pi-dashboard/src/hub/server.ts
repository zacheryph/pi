// Hub process entry. Pi sessions spawn it detached with plain Node, which
// strips the types; it must not import Pi packages.
import { DEFAULT_PORT, IDLE_GRACE_MS } from "../protocol.ts";
import { Hub } from "./hub.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    process.stderr.write(`invalid --${name}: ${raw}\n`);
    process.exit(2);
  }
  return value;
}

const log = (line: string) =>
  process.stderr.write(`${new Date().toISOString()} [hub ${process.pid}] ${line}\n`);
const dir = option("dir");
if (!dir) {
  process.stderr.write("usage: server.ts --dir <dir> [--port <n>] [--idle-grace-ms <n>]\n");
  process.exit(2);
}

const hub = new Hub({
  dir,
  port: integer("port", DEFAULT_PORT, 0, 65_535),
  idleGraceMs: integer("idle-grace-ms", IDLE_GRACE_MS, 0, 3_600_000),
  log,
});

try {
  if ((await hub.start()) === "already-running") {
    log("another hub owns the socket; exiting");
    process.exit(0);
  }
} catch (error) {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => void hub.stop(signal));
await hub.closed;
log("stopped");
process.exit(0);
