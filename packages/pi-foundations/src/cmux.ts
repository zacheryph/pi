import { execFile } from "node:child_process";

const TIMEOUT_MS = 1_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a notification says. Plain text; the caller sanitizes and bounds it. */
export interface CmuxMessage {
  title: string;
  body: string;
}

/**
 * Optional native notifications through cmux's public CLI, owned by one extension session.
 * Outside cmux, or with `CMUX_PI_HOOKS_DISABLED=1`, every method is a silent no-op.
 */
export class CmuxNotifications {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly active = new Set<() => void>();
  private stopped = false;

  /**
   * Show a notification that stays until the user clears it: for something they act on later,
   * after this session has ended its turn. Resolves true when cmux accepted it.
   */
  send(message: CmuxMessage): Promise<boolean> {
    const target = this.target();
    if (!target) return Promise.resolve(false);
    const sent = target
      .run(["notify", "--title", message.title, "--body", message.body, ...target.where])
      .then((output) => output !== undefined);
    this.track(sent);
    return sent;
  }

  /**
   * Show a notification for as long as something is open on screen; the returned function
   * dismisses exactly that one. Never waits for the CLI on the open/close path.
   */
  open(message: CmuxMessage): () => void {
    const target = this.target();
    if (!target) return () => {};
    const run = (args: string[]) => target.run(args);
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
          message.title,
          "--body",
          message.body,
          ...target.where,
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

  /** The CLI and the pane to notify, or nothing when this process is not in cmux. */
  private target():
    | { run(args: string[]): Promise<string | undefined>; where: string[] }
    | undefined {
    const env = { ...process.env };
    const surface = env.CMUX_SURFACE_ID || env.CMUX_PANEL_ID;
    if (this.stopped || !surface || env.CMUX_PI_HOOKS_DISABLED === "1") return undefined;
    const cli = env.CMUX_BUNDLED_CLI_PATH || "cmux";
    const workspace = env.CMUX_WORKSPACE_ID || env.CMUX_TAB_ID;
    return {
      run: (args) => runCli(cli, args, env),
      where: ["--surface", surface, ...(workspace ? ["--workspace", workspace] : [])],
    };
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
