import { execFile } from "node:child_process";

const TIMEOUT_MS = 1_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional public-CLI notifications, owned by one extension session. */
export class CmuxNotifications {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly active = new Set<() => void>();
  private stopped = false;

  /** Never wait for the CLI on the question's open/close path. */
  open(): () => void {
    const env = { ...process.env };
    const surface = env.CMUX_SURFACE_ID || env.CMUX_PANEL_ID;
    if (this.stopped || !surface || env.CMUX_PI_HOOKS_DISABLED === "1") return () => {};
    const cli = env.CMUX_BUNDLED_CLI_PATH || "cmux";
    const workspace = env.CMUX_WORKSPACE_ID || env.CMUX_TAB_ID;
    const run = (args: string[]) => runCli(cli, args, env);
    let closed = false;
    let id: string | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      this.active.delete(close);
      if (id) this.track(run(["dismiss-notification", "--id", id]));
    };
    this.active.add(close);
    this.track(
      (async () => {
        const output = await run([
          "notify",
          "--json",
          "--id-format",
          "uuids",
          "--title",
          "Pi needs your input",
          "--body",
          "Answer the questions in your terminal.",
          "--surface",
          surface,
          ...(workspace ? ["--workspace", workspace] : []),
        ]);
        if (!output) return;
        try {
          // Public `notify --json` returns { id, surface_id, workspace_id }.
          const receipt: unknown = JSON.parse(output);
          if (!receipt || typeof receipt !== "object" || !("id" in receipt)) return;
          if (typeof receipt.id !== "string" || !UUID.test(receipt.id)) return;
          id = receipt.id;
        } catch {
          return;
        }
        // Do not abort creation on close: its late receipt is needed for exact cleanup.
        if (closed) await run(["dismiss-notification", "--id", id]);
      })(),
    );
    return close;
  }

  /** Reload/exit closes active notices and gives bounded CLI work time to finish. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const close of this.active) close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TIMEOUT_MS * 2 + 100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
  }
}

/** Missing CLI, socket errors, timeouts and oversized output are all silent no-ops. */
async function runCli(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return await new Promise((resolve) => {
      execFile(
        cli,
        args,
        {
          env,
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024,
        },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
  } catch {
    return undefined;
  }
}
