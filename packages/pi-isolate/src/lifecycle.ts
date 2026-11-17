import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type Exit = { code: number | null; signal: NodeJS.Signals | null };
export class Disposers {
  private stack: (() => void | Promise<void>)[] = [];
  add(dispose: () => void | Promise<void>) {
    this.stack.push(dispose);
  }
  async close() {
    const errors: unknown[] = [];
    for (const dispose of this.stack.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new Error("session cleanup failed");
  }
}

type ProcessRow = { pid: number; parent: number; started: string };
function processRows(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,stat="], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 1000,
  })
    .trim()
    .split("\n")
    .flatMap((row) => {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/);
      return match && !match[4].includes("Z")
        ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3] }]
        : [];
    });
}

export function checkProcessTable() {
  processRows();
}

/** Inherited terminal descriptors. Tracked descendants are also stopped after Pi exits. */
export function attachedChild(
  file: string,
  args: string[],
  options: SpawnOptions,
  abort: AbortSignal,
) {
  const child: ChildProcess = spawn(file, args, { ...options, stdio: "inherit", shell: false });
  let ended = false;
  let timer: NodeJS.Timeout | undefined;
  const known = new Map<number, string>();
  const scan = () => {
    const rows = processRows();
    const found = new Set(child.pid && !ended ? [child.pid] : []);
    for (const row of rows) if (known.get(row.pid) === row.started) found.add(row.pid);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (found.has(row.parent) && !found.has(row.pid)) {
          found.add(row.pid);
          changed = true;
        }
    }
    for (const row of rows)
      if (row.pid !== child.pid && found.has(row.pid)) known.set(row.pid, row.started);
    return rows.filter((row) => known.get(row.pid) === row.started).reverse();
  };
  const signal = (sig: NodeJS.Signals) => {
    try {
      for (const row of scan()) {
        try {
          process.kill(row.pid, sig);
        } catch {}
      }
    } catch {}
    // Only positive PIDs: never signal the invoking shell's foreground group.
    if (!ended) child.kill(sig);
  };
  const monitor = setInterval(() => {
    try {
      scan();
    } catch {}
  }, 100);
  const onAbort = () => {
    signal(typeof abort.reason === "string" ? (abort.reason as NodeJS.Signals) : "SIGTERM");
    timer ??= setTimeout(() => signal("SIGKILL"), 2000);
  };
  const done = new Promise<Exit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => {
      ended = true;
      resolve({ code, signal: sig });
    });
  }).finally(() => {
    ended = true;
    clearInterval(monitor);
    if (timer) clearTimeout(timer);
    abort.removeEventListener("abort", onAbort);
  });
  abort.addEventListener("abort", onAbort, { once: true });
  if (abort.aborted) onAbort();
  let stopping: Promise<void> | undefined;
  return {
    done,
    stop() {
      return (stopping ??= (async () => {
        signal("SIGTERM");
        const escalation = setTimeout(() => signal("SIGKILL"), 2000);
        try {
          await done.catch(() => {});
          const deadline = Date.now() + 2000;
          while (known.size && scan().length && Date.now() < deadline) await delay(50);
          if (known.size) signal("SIGKILL");
        } finally {
          clearTimeout(escalation);
        }
      })());
    },
  };
}

export function exitWith(result: Exit) {
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
